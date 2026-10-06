import * as acp from '@agentclientprotocol/sdk';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import * as vscode from 'vscode';
import { installedServer, installServer, unpack, type Server } from './runtime.js';

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

/** The model picker Antigravity offers in a session, and its current pick. */
export function modelOption(options: acp.SessionConfigOption[] | null | undefined): { choices: ModelChoice[]; current?: string } {
  const option = options?.find((candidate) => candidate.category === 'model');
  if (option?.type !== 'select') return { choices: [] };
  const entries = option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
  return { choices: entries.map((entry) => ({ id: entry.value, name: entry.name })), current: option.currentValue };
}

/** What one ACP session hears from the server. */
export interface SessionHandler {
  update(update: acp.SessionUpdate): void;
  permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  exited(error: Error): void;
}

interface Running {
  child: ChildProcess;
  connection: acp.ClientSideConnection;
  server: Server;
  exited: Promise<never>;
}

/**
 * Google's ACP server, shared by every chat in this window; each session runs its own harness in it.
 * Launched from its unpacked files it is ready in seconds, and one warm process serves all chats.
 */
export class Agent implements vscode.Disposable {
  private running?: Promise<Running>;
  private live?: Running;
  private readonly handlers = new Map<string, SessionHandler>();

  constructor(
    private readonly storage: string,
    private readonly version: string,
    private readonly log: vscode.LogOutputChannel,
    /** The model new sessions open with, so they skip a switch (which restarts the harness). */
    private readonly defaultModel: () => string | undefined,
  ) {}

  get serverVersion(): string | undefined {
    return this.live?.server.version ?? installedServer(this.runtimeDir)?.version;
  }

  /** The server's own Antigravity home: its settings, sign-in and saved sessions. */
  get home(): string {
    return join(this.storage, 'home');
  }

  /** Starts the server if it isn't running; every call below goes through here. */
  warm(): Promise<Running> {
    this.running ??= this.start().catch((error: unknown) => {
      this.running = undefined;
      throw error;
    });
    return this.running;
  }

  async newSession(cwd: string, mcpServers: acp.McpServer[], handler: SessionHandler): Promise<acp.NewSessionResponse> {
    const { connection, exited } = await this.warm();
    const session = await settle(connection.newSession({ cwd, mcpServers }), exited);
    this.handlers.set(session.sessionId, handler);
    return session;
  }

  /** Hands a prepared session to the chat that takes it over. */
  adopt(sessionId: string, handler: SessionHandler): void {
    this.handlers.set(sessionId, handler);
  }

  /** Reopens a saved session, after it was closed or the server restarted; Antigravity keeps its full history. */
  async resumeSession(sessionId: string, cwd: string, mcpServers: acp.McpServer[], handler: SessionHandler): Promise<acp.ResumeSessionResponse> {
    const { connection, exited } = await this.warm();
    this.handlers.set(sessionId, handler);
    try {
      return await settle(connection.resumeSession({ sessionId, cwd, mcpServers }), exited);
    } catch (error) {
      this.handlers.delete(sessionId);
      throw error;
    }
  }

  /** The account's models, read from a throwaway session. */
  async models(cwd: string): Promise<ModelChoice[]> {
    const { connection, exited } = await this.warm();
    const session = await settle(connection.newSession({ cwd, mcpServers: [] }), exited);
    void connection.closeSession({ sessionId: session.sessionId }).catch(() => undefined);
    return modelOption(session.configOptions).choices;
  }

  async prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const { connection, exited } = await this.warm();
    return settle(connection.prompt({ sessionId, prompt }), exited);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const { connection, exited } = await this.warm();
    await settle(connection.setSessionConfigOption({ sessionId, configId: 'model', value: model }), exited);
  }

  /** Stops whatever the session is doing and frees its harness. */
  closeSession(sessionId: string): void {
    this.handlers.delete(sessionId);
    const connection = this.live?.connection;
    if (!connection) return;
    void connection
      .cancel({ sessionId })
      .then(() => connection.closeSession({ sessionId }))
      .catch(() => undefined);
  }

  async authenticate(methodId: string): Promise<void> {
    const { connection, exited } = await this.warm();
    await settle(connection.authenticate({ methodId }), exited);
  }

  async logout(): Promise<void> {
    const { connection, exited } = await this.warm();
    await settle(connection.logout({}), exited);
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

  private get runtimeDir(): string {
    return join(this.storage, 'runtime');
  }

  private get pidDir(): string {
    return join(this.storage, 'servers');
  }

  private async start(): Promise<Running> {
    reapOrphans(this.pidDir);
    const server = installedServer(this.runtimeDir) ?? (await this.install());
    // A newer release, if any, is fetched in the background and used from the next start.
    void installServer(this.runtimeDir).catch((error: unknown) => this.log.warn(`Update check failed: ${String(error)}`));
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
    const exited = new Promise<never>((_resolve, reject) => {
      child.once('error', (error) => reject(new AgentError(`Antigravity's ACP server failed to start: ${error.message}`)));
      child.once('exit', (code) => reject(new AgentError(`Antigravity's ACP server stopped (exit code ${code}).`)));
    });
    exited.catch((error: Error) => this.onExit(child, error));
    child.stderr?.setEncoding('utf8').on('data', (text: string) => this.onStderr(text));
    const stdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const stdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const connection = new acp.ClientSideConnection(() => this.client(), acp.ndJsonStream(stdin, stdout));
    const clientInfo = { name: 'antigravity-acp-for-copilot', title: 'Antigravity for Copilot', version: this.version };
    const noLocalAccess = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
    try {
      await settle(connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: noLocalAccess, clientInfo }), exited);
    } catch (error) {
      this.stop(child);
      throw error;
    }
    this.track(child);
    this.log.info(`Antigravity ACP server ${server.version} is ready (${((Date.now() - started) / 1000).toFixed(1)} s${unpacked ? '' : ', unpacking itself'})`);
    this.live = { child, connection, server, exited };
    return this.live;
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
    if (unpacked) Object.assign(env, { _PYI_PARENT_PROCESS_LEVEL: '0', _PYI_APPLICATION_HOME_DIR: unpacked, _PYI_ARCHIVE_FILE: server.command });
    return env;
  }

  private client(): acp.Client {
    return {
      requestPermission: (request) => this.handlers.get(request.sessionId)?.permission(request) ?? CANCELLED,
      sessionUpdate: ({ sessionId, update }) => this.handlers.get(sessionId)?.update(update),
    };
  }

  private onStderr(text: string): void {
    // The server opens this page itself; logged in case no browser comes up.
    const link = SIGN_IN_LINK.exec(text)?.[1];
    if (link) this.log.info(`Google sign-in page: ${link}`);
    for (const line of text.split(/\r?\n/)) if (line.trim()) this.log.trace(line);
  }

  private onExit(child: ChildProcess, error: Error): void {
    rmSync(join(this.pidDir, `${child.pid}-${process.pid}`), { force: true });
    if (this.live?.child !== child) return;
    this.log.warn(error.message);
    this.live = undefined;
    this.running = undefined;
    const handlers = [...this.handlers.values()];
    this.handlers.clear();
    for (const handler of handlers) handler.exited(error);
  }

  // The server ignores a closed stdin, so a crashed editor would leave it running; each window
  // records the server it started (server pid, window pid) and the next start stops orphans.
  private track(child: ChildProcess): void {
    mkdirSync(this.pidDir, { recursive: true });
    writeFileSync(join(this.pidDir, `${child.pid}-${process.pid}`), '');
  }

  // Synchronous, so it is done before the extension host exits. Its harnesses go down with it.
  private stop(child: ChildProcess): void {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
    rmSync(join(this.pidDir, `${child.pid}-${process.pid}`), { force: true });
  }
}

/** The call's result, unless the server exits first; a sign-in error is marked as such. */
async function settle<T>(call: Promise<T>, exited: Promise<never>): Promise<T> {
  try {
    return await Promise.race([call, exited]);
  } catch (error) {
    if (error instanceof acp.RequestError && error.code === AUTH_REQUIRED) throw new AgentError(error.message, true);
    throw error;
  }
}

// Servers whose window is gone; the name check keeps a reused pid from being hit.
function reapOrphans(dir: string): void {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const [server, owner] = name.split('-').map(Number);
    if (alive(owner)) continue;
    if (alive(server) && isServer(server)) killQuietly(server);
    rmSync(join(dir, name), { force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isServer(pid: number): boolean {
  try {
    const name =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
        : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return name.includes('agy_acp_server');
  } catch {
    return false;
  }
}

function killQuietly(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid);
  } catch {
    // already gone
  }
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
