import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import * as vscode from 'vscode';
import { installedServer, installServer, type Server } from './runtime.js';

const AUTH_REQUIRED = -32000;
const SIGN_IN_LINK = /Open the following link to authenticate the ACP server: (https:\/\/\S+)/;
const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
const SESSION_DATA_DAYS = 1;

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
 * Google's ACP server, shared by every chat. It unpacks itself on each launch, which takes half a
 * minute or more, so one warm process hosts all sessions; each session runs its own harness in it.
 */
export class Agent implements vscode.Disposable {
  private running?: Promise<Running>;
  private live?: Running;
  private readonly handlers = new Map<string, SessionHandler>();

  constructor(
    private readonly storage: string,
    private readonly version: string,
    private readonly log: vscode.LogOutputChannel,
    private readonly extraEnv: () => Promise<Record<string, string>>,
  ) {}

  get serverVersion(): string | undefined {
    return this.live?.server.version ?? installedServer(this.runtimeDir)?.version;
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

  /** Stops the server; the next call starts a fresh one with the current environment. */
  restart(): void {
    const child = this.live?.child;
    this.live = undefined;
    this.running = undefined;
    if (child) killTree(child);
  }

  dispose(): void {
    this.restart();
  }

  private get runtimeDir(): string {
    return join(this.storage, 'runtime');
  }

  private async start(): Promise<Running> {
    const server = installedServer(this.runtimeDir) ?? (await this.install());
    // A newer release, if any, is fetched in the background and used from the next start.
    void installServer(this.runtimeDir).catch((error: unknown) => this.log.warn(`Update check failed: ${String(error)}`));
    const home = join(this.storage, 'home');
    mkdirSync(home, { recursive: true });
    pruneSessionData(home);
    const child = spawn(server.command, server.args, { cwd: home, env: await this.env(home), stdio: 'pipe', windowsHide: true });
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
      killTree(child);
      throw error;
    }
    this.log.info(`Antigravity ACP server ${server.version} is ready`);
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
  // server's bundled Python.
  private async env(home: string): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(await this.extraEnv()), GEMINI_HOME: home };
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
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
    if (this.live?.child !== child) return;
    this.log.warn(error.message);
    this.live = undefined;
    this.running = undefined;
    const handlers = [...this.handlers.values()];
    this.handlers.clear();
    for (const handler of handlers) handler.exited(error);
  }
}

// The server saves every session, but a lost session replays its transcript instead of reloading,
// so saved ones past a day are only taking space. Other windows share this home, hence the age.
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

/** The call's result, unless the server exits first; a sign-in error is marked as such. */
async function settle<T>(call: Promise<T>, exited: Promise<never>): Promise<T> {
  try {
    return await Promise.race([call, exited]);
  } catch (error) {
    if (error instanceof acp.RequestError && error.code === AUTH_REQUIRED) throw new AgentError(error.message, true);
    throw error;
  }
}

// The server is a self-unpacking bundle whose real process is a child of the one we start.
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill();
}
