import type * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { killTree, reapOrphans, stopHarness, trackServer, versionsInUse } from './processes.js';
import { Connection, METHOD_NOT_FOUND, RpcError } from './rpc.js';
import { fastStartEnv, installedServers, installServer, keepWorking, markFailed, unpack, type Server } from './runtime.js';

const PROTOCOL_VERSION = 1;
// From its unpacked files the server answers in seconds; unpacking itself takes about half a minute.
const FAST_START_MS = 45_000;
const START_MS = 120_000;
const AUTH_REQUIRED = -32000;
const SIGN_IN_LINK = /Open the following link to authenticate the ACP server: (https:\/\/\S+)/;
const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
const SESSION_DATA_DAYS = 7;

export class AgentError extends Error {
  constructor(
    message: string,
    readonly signedOut = false,
  ) {
    super(message);
  }
}

export interface ModelChoice {
  id: string;
  name: string;
}

// A server without a model picker still answers, with its own default model.
const SERVER_DEFAULT: ModelChoice = { id: '', name: 'Antigravity' };

/** The model picker Antigravity offers in a session, and its current pick; without one, the server's default. */
export function modelOption(options: acp.SessionConfigOption[] | null | undefined): { configId?: string; choices: ModelChoice[]; current?: string } {
  const option = options?.find((candidate) => candidate.category === 'model' && candidate.type === 'select');
  if (option?.type !== 'select' || option.options.length === 0) return { choices: [SERVER_DEFAULT], current: SERVER_DEFAULT.id };
  const entries = option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
  return { configId: option.id, choices: entries.map((entry) => ({ id: entry.value, name: entry.name })), current: option.currentValue };
}

/** What one ACP session hears from the server. */
export interface SessionHandler {
  update(update: acp.SessionUpdate): void;
  permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  exited(error: Error): void;
}

interface Running {
  child: ChildProcess;
  connection: Connection;
  server: Server;
  /** Whether the server can close a session itself (ACP's session/close); 1.3 can't. */
  closes: boolean;
  authMethods: acp.AuthMethod[];
}

/**
 * Google's ACP server, shared by every chat in this window; each session runs its own harness in it.
 * Launched from its unpacked files it is ready in seconds, and one warm process serves all chats.
 */
export class Agent implements vscode.Disposable {
  private running?: Promise<Running>;
  private live?: Running;
  private readonly handlers = new Map<string, SessionHandler>();
  // The id of the server's model picker, as its sessions name it.
  private modelConfig = 'model';

  constructor(
    private readonly storage: string,
    private readonly version: string,
    private readonly log: vscode.LogOutputChannel,
    /** The model new sessions open with, so they skip a switch (which restarts the harness). */
    private readonly defaultModel: () => string | undefined,
  ) {}

  get serverVersion(): string | undefined {
    return this.live?.server.version ?? installedServers(this.runtimeDir, this.version)[0]?.version;
  }

  /** The server's own Antigravity home: its settings, sign-in and saved sessions. */
  get home(): string {
    return join(this.storage, 'home');
  }

  /** Whether the server is running or starting. */
  get started(): boolean {
    return this.running !== undefined;
  }

  /** Starts the server if it isn't running; every call below goes through here. */
  warm(): Promise<Running> {
    this.running ??= this.start().catch((error: unknown) => {
      this.running = undefined;
      throw error;
    });
    return this.running;
  }

  /** `meta` carries the session's built-in tool filter. */
  async newSession(cwd: string, mcpServers: acp.McpServer[], handler: SessionHandler, meta: object): Promise<acp.NewSessionResponse> {
    const session = await this.request<acp.NewSessionResponse>('session/new', { cwd, mcpServers, _meta: meta });
    this.learn(session.configOptions);
    this.handlers.set(session.sessionId, handler);
    return session;
  }

  /** Hands a prepared session to the chat that takes it over. */
  adopt(sessionId: string, handler: SessionHandler): void {
    this.handlers.set(sessionId, handler);
  }

  /** Reopens a saved session, after it was closed or the server restarted; Antigravity keeps its full history. */
  async resumeSession(sessionId: string, cwd: string, mcpServers: acp.McpServer[], handler: SessionHandler, meta: object): Promise<acp.ResumeSessionResponse> {
    this.handlers.set(sessionId, handler);
    try {
      const resumed = await this.request<acp.ResumeSessionResponse>('session/resume', { sessionId, cwd, mcpServers, _meta: meta });
      this.learn(resumed.configOptions);
      return resumed;
    } catch (error) {
      this.handlers.delete(sessionId);
      throw error;
    }
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.request('session/prompt', { sessionId, prompt });
  }

  /** Restarts the session's harness with another model; the same model again only reads the current models. */
  async setModel(sessionId: string, model: string): Promise<ModelChoice[]> {
    const response = await this.request<acp.SetSessionConfigOptionResponse>('session/set_config_option', { sessionId, configId: this.modelConfig, value: model });
    return modelOption(response.configOptions).choices;
  }

  /**
   * Stops whatever the session is doing and frees its harness. A server that can't close sessions
   * keeps every harness it started until it exits, so the session's own one is stopped instead; the
   * server starts a new one if the session is resumed later.
   */
  async closeSession(sessionId: string, harness?: Promise<number | undefined>): Promise<void> {
    this.handlers.delete(sessionId);
    const live = this.live;
    if (!live) return;
    live.connection.notify('session/cancel', { sessionId });
    if (live.closes) await live.connection.request('session/close', { sessionId }).catch(() => undefined);
    else await stopHarness(await harness, live.child.pid);
  }

  /** The sign-in method to use: the given one while the server offers it, else its Google one, else its first. */
  async signInMethod(preferred: string): Promise<string> {
    const { authMethods } = await this.warm();
    if (authMethods.some((method) => method.id === preferred)) return preferred;
    return (authMethods.find((method) => /google/i.test(method.name)) ?? authMethods[0])?.id ?? preferred;
  }

  async authenticate(methodId: string): Promise<void> {
    await this.request('authenticate', { methodId });
  }

  async logout(): Promise<void> {
    await this.request('logout', {});
  }

  /** Stops the server; the next call starts a fresh one. */
  restart(): void {
    const child = this.live?.child;
    this.live = undefined;
    this.running = undefined;
    if (child) this.stop(child);
  }

  dispose(): void {
    this.restart();
  }

  // A sign-in error is marked as such.
  private async request<T>(method: string, params: object): Promise<T> {
    const { connection } = await this.warm();
    try {
      return await connection.request<T>(method, params);
    } catch (error) {
      throw error instanceof RpcError && error.code === AUTH_REQUIRED ? new AgentError(error.message, true) : error;
    }
  }

  private get runtimeDir(): string {
    return join(this.storage, 'runtime');
  }

  private get pidDir(): string {
    return join(this.storage, 'servers');
  }

  private learn(options: acp.SessionConfigOption[] | null | undefined): void {
    this.modelConfig = modelOption(options).configId ?? this.modelConfig;
  }

  private async start(): Promise<Running> {
    await reapOrphans(this.pidDir);
    const servers = installedServers(this.runtimeDir, this.version);
    if (servers.length === 0) servers.push(await this.install());
    // A newer release, if any, is fetched in the background and tried first from the next start.
    void installServer(this.runtimeDir).catch((error: unknown) => this.log.warn(`Update check failed: ${String(error)}`));
    return this.startFirst(servers);
  }

  // A release that doesn't start, or speaks another protocol, falls back to the one before it.
  private async startFirst([server, ...older]: Server[]): Promise<Running> {
    try {
      const running = await this.startServer(server);
      keepWorking(this.runtimeDir, server.version, versionsInUse(this.pidDir));
      return running;
    } catch (error) {
      if (older.length === 0) throw error;
      markFailed(this.runtimeDir, server.version, this.version);
      this.log.warn(`Antigravity's ACP server ${server.version} didn't start, so ${older[0].version} runs instead: ${String(error)}`);
      return this.startFirst(older);
    }
  }

  private async startServer(server: Server): Promise<Running> {
    const unpacked = await this.unpacked(server);
    try {
      return await this.launch(server, unpacked);
    } catch (error) {
      if (!unpacked) throw error;
      this.log.warn(`Fast start failed, starting the usual way: ${String(error)}`);
      return this.launch(server, undefined);
    }
  }

  private async unpacked(server: Server): Promise<string | undefined> {
    const title = "Preparing Antigravity's server for fast starts";
    const work = () => unpack(server).catch((error: unknown) => void this.log.warn(`Unpacking failed: ${String(error)}`));
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, work);
  }

  private async launch(server: Server, unpacked: string | undefined): Promise<Running> {
    const started = Date.now();
    const home = this.home;
    mkdirSync(home, { recursive: true });
    pruneSessionData(home);
    const child = spawn(server.command, server.args, { cwd: home, env: this.env(home, server, unpacked), stdio: 'pipe', windowsHide: true });
    const connection = new Connection(child, (method, params) => this.receive(method, params));
    const exit = (error: Error) => this.onExit(child, connection, error);
    child.once('error', (error) => exit(new AgentError(`Antigravity's ACP server failed to start: ${error.message}`)));
    child.once('exit', (code) => exit(new AgentError(`Antigravity's ACP server stopped (exit code ${code}).`)));
    child.stderr?.setEncoding('utf8').on('data', (text: string) => this.onStderr(text));
    let initialized: acp.InitializeResponse;
    try {
      initialized = await this.initialize(connection, server, unpacked ? FAST_START_MS : START_MS);
    } catch (error) {
      this.stop(child);
      throw error;
    }
    this.log.info(`Antigravity ACP server ${server.version} is ready (${((Date.now() - started) / 1000).toFixed(1)} s${unpacked ? '' : ', unpacking itself'})`);
    return this.goLive(child, connection, server, initialized);
  }

  private goLive(child: ChildProcess, connection: Connection, server: Server, initialized: acp.InitializeResponse): Running {
    // The server ignores a closed stdin, so a crashed editor would leave it running; the next start stops orphans.
    if (child.pid !== undefined) trackServer(this.pidDir, child.pid, server.command, server.version);
    const closes = Boolean(initialized.agentCapabilities?.sessionCapabilities?.close);
    this.live = { child, connection, server, closes, authMethods: initialized.authMethods ?? [] };
    return this.live;
  }

  // ACP leaves it to the client to go when the server answers with a protocol version it doesn't speak.
  private async initialize(connection: Connection, server: Server, timeoutMs: number): Promise<acp.InitializeResponse> {
    const clientInfo = { name: 'antigravity-acp-for-copilot', title: 'Antigravity for Copilot', version: this.version };
    const noLocalAccess = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
    const answer = connection.request<acp.InitializeResponse>('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: noLocalAccess, clientInfo });
    const initialized = await within(answer, timeoutMs, `Antigravity's ACP server ${server.version} didn't answer within ${timeoutMs / 1000} s.`);
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new AgentError(`Antigravity's ACP server ${server.version} speaks ACP version ${initialized.protocolVersion}; this extension speaks version ${PROTOCOL_VERSION}.`);
    }
    return initialized;
  }

  private async install(): Promise<Server> {
    const title = "Downloading Google's Antigravity ACP server";
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (progress) => {
      let reported = 0;
      return installServer(this.runtimeDir, (fraction) => {
        const percent = Math.floor(fraction * 100);
        if (percent > reported) progress.report({ increment: percent - reported, message: `${percent}%` });
        reported = Math.max(reported, percent);
      });
    });
  }

  // Its own home keeps the user's global Antigravity MCP servers, rules and skills out of Copilot's
  // chats; Copilot passes its own. A Python setup from the editor's environment would leak into the
  // server's bundled Python. With its files unpacked, PyInstaller's own variables point the
  // unchanged executable at them instead of a fresh temp folder.
  private env(home: string, server: Server, unpacked: string | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_HOME: home };
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
    const model = this.defaultModel();
    if (model) env.AGY_ACP_DEFAULT_MODEL = model;
    if (unpacked) Object.assign(env, fastStartEnv(server, unpacked));
    return env;
  }

  // What the server sends the client: session updates, and permission requests it waits on.
  private receive(method: string, params: unknown): unknown {
    const handler = this.handlers.get((params as { sessionId?: string } | undefined)?.sessionId ?? '');
    if (method === 'session/update') return handler?.update((params as acp.SessionNotification).update);
    if (method === 'session/request_permission') return handler?.permission(params as acp.RequestPermissionRequest) ?? CANCELLED;
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  private onStderr(text: string): void {
    // The server opens this page itself; logged in case no browser comes up.
    const link = SIGN_IN_LINK.exec(text)?.[1];
    if (link) this.log.info(`Google sign-in page: ${link}`);
    for (const line of text.split(/\r?\n/)) if (line.trim()) this.log.trace(line);
  }

  private onExit(child: ChildProcess, connection: Connection, error: Error): void {
    connection.close(error);
    rmSync(join(this.pidDir, `${child.pid}-${process.pid}`), { force: true });
    if (this.live?.child !== child) return;
    this.log.warn(error.message);
    this.live = undefined;
    this.running = undefined;
    const handlers = [...this.handlers.values()];
    this.handlers.clear();
    for (const handler of handlers) handler.exited(error);
  }

  // Its harnesses go down with it.
  private stop(child: ChildProcess): void {
    if (child.exitCode !== null || child.pid === undefined) return;
    killTree(child.pid);
    rmSync(join(this.pidDir, `${child.pid}-${process.pid}`), { force: true });
  }
}

function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new AgentError(message)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The server saves every session so a chat can resume it; ones untouched for a week are dropped.
// Other windows share this home, hence going by age.
function pruneSessionData(home: string): void {
  const cutoff = Date.now() - SESSION_DATA_DAYS * 24 * 60 * 60 * 1000;
  for (const dir of ['brain', 'conversations'].map((name) => join(home, 'antigravity-acp', name))) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      try {
        if (statSync(join(dir, name)).mtimeMs < cutoff) rmSync(join(dir, name), { recursive: true, force: true });
      } catch {
        // in use
      }
    }
  }
}
