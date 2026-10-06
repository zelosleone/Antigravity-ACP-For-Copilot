import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Agent, AgentError, type ModelChoice } from './agent.js';
import { Bridge } from './bridge.js';
import { charsOf, parseRequest } from './convert.js';
import { pickMode, pickVariant, toModels, type AgyModel } from './models.js';
import type { PermissionMode } from './permissions.js';
import { Sessions } from './session.js';

// The server's last model list and the context windows it reported, shown until it answers again.
const CATALOG_KEY = 'antigravityAcp.catalog';
const WINDOWS_KEY = 'antigravityAcp.windows';
const LAST_MODEL_KEY = 'antigravityAcp.lastModel';
const LAST_MODE_KEY = 'antigravityAcp.lastMode';
const CHARS_PER_TOKEN = 4;
const GOOGLE_SIGN_IN = 'oauth-personal';
// After VS Code has been in the background this long with no chat mid-turn, the server and its
// sessions stop to free their memory; they start again in the background when the window is focused.
const AWAY_MS = 15 * 60 * 1000;

type Options = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: { readonly reasoningEffort?: string; readonly permissionMode?: string };
  readonly configuration?: { readonly reasoningEffort?: string; readonly permissionMode?: string };
};

export class AntigravityChatProvider implements vscode.LanguageModelChatProvider<AgyModel>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private readonly agent: Agent;
  private readonly bridge = new Bridge();
  private readonly sessions: Sessions;
  private choices: ModelChoice[];
  private models: AgyModel[];
  private refreshing?: Promise<void>;
  private prompting = false;
  private awaySince?: number;
  private asleep = false;
  private readonly timer = setInterval(() => this.sleepIfAway(), 60_000);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const version = String(context.extension.packageJSON.version);
    this.agent = new Agent(context.globalStorageUri.fsPath, version, log, () => this.lastModel);
    this.sessions = new Sessions(context.globalState, this.agent, (choices) => this.setChoices(choices));
    this.choices = context.globalState.get<ModelChoice[]>(CATALOG_KEY, []);
    this.models = toModels(this.choices, this.windows);
    this.timer.unref();
  }

  /** Starts the server and makes a session for the first chat, which also reads the current models. */
  start(): void {
    void this.refresh();
  }

  focusChanged(focused: boolean): void {
    this.awaySince = focused ? undefined : Date.now();
    if (!focused || !this.asleep) return;
    this.asleep = false;
    if (this.choices.length === 0) return;
    this.log.info('VS Code is back in focus; starting the server again.');
    this.start();
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): Promise<AgyModel[]> {
    if (this.models.length > 0 || options.silent) return this.models;
    await this.refresh();
    return this.models;
  }

  async provideLanguageModelChatResponse(
    model: AgyModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: Options,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const request = parseRequest(messages);
    const config = options.modelConfiguration ?? options.configuration;
    const settings = { model: pickVariant(model, config?.reasoningEffort), tools: options.tools ?? [], mode: pickMode(config?.permissionMode) };
    this.remember(settings.model, settings.mode);
    const context = {
      agent: this.agent,
      bridge: this.bridge,
      cwd: this.workspaceDir(),
      system: request.system,
      conversation: conversationId(options),
      log: this.log,
      onWindow: (id: string, size: number) => this.learnWindow(id, size),
    };
    try {
      const session = await this.sessions.open(request, settings, context);
      await session.respond(progress, token);
    } catch (error) {
      if (!token.isCancellationRequested) throw this.explain(error);
    }
  }

  // Copilot calls this for every key and string of every tool schema, so round instead of ceil.
  async provideTokenCount(_model: AgyModel, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    const chars = typeof text === 'string' ? text.length : charsOf(text);
    return Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.load().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  /** Google's own sign-in page opens in the browser; the server keeps the tokens, never this extension. */
  async signIn(): Promise<void> {
    const title = 'Antigravity: finish signing in with Google in your browser';
    const done = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const cancel = token.onCancellationRequested(() => this.agent.restart());
      try {
        await this.agent.authenticate(await this.agent.signInMethod(GOOGLE_SIGN_IN));
        return true;
      } catch (error) {
        if (token.isCancellationRequested) return false;
        throw error;
      } finally {
        cancel.dispose();
      }
    });
    if (done) await this.refresh();
  }

  async signOut(): Promise<void> {
    await this.agent.logout().catch((error: unknown) => this.log.warn(`Sign-out failed: ${String(error)}`));
    this.restart();
    this.setChoices([]);
  }

  restart(): void {
    this.sessions.closeAll();
    this.agent.restart();
  }

  describe(): string {
    const signedIn = authType(this.agent.home) === GOOGLE_SIGN_IN;
    const version = this.agent.serverVersion;
    return [`Antigravity: ${signedIn ? 'signed in with Google' : 'signed out'}`, version && `ACP server ${version}`].filter(Boolean).join(' · ');
  }

  dispose(): void {
    clearInterval(this.timer);
    this.sessions.dispose();
    this.bridge.dispose();
    this.agent.dispose();
    this.changed.dispose();
  }

  private get lastModel(): string | undefined {
    return this.context.globalState.get<string>(LAST_MODEL_KEY);
  }

  private get lastMode(): PermissionMode {
    return pickMode(this.context.globalState.get<string>(LAST_MODE_KEY));
  }

  private get windows(): Record<string, number> {
    return this.context.globalState.get<Record<string, number>>(WINDOWS_KEY, {});
  }

  // The next chat's session is made with these, so it can start right away.
  private remember(model: string, mode: PermissionMode): void {
    if (model !== this.lastModel) void this.context.globalState.update(LAST_MODEL_KEY, model);
    if (mode !== this.lastMode) void this.context.globalState.update(LAST_MODE_KEY, mode);
  }

  // A new session made ahead of time brings the server's current models.
  private async load(): Promise<void> {
    try {
      await this.sessions.prepare({ bridge: this.bridge, cwd: this.workspaceDir(), model: this.lastModel, mode: this.lastMode }, true);
      this.log.info(`${this.describe()}: ${this.models.length} models`);
    } catch (error) {
      if (!(error instanceof AgentError && error.signedOut)) return this.log.warn(`Model refresh failed: ${String(error)}`);
      // Signing in starts it again.
      this.restart();
      this.setChoices([]);
      void this.promptSetup();
    }
  }

  private setChoices(choices: ModelChoice[]): void {
    if (JSON.stringify(choices) === JSON.stringify(this.choices)) return;
    this.choices = choices;
    void this.context.globalState.update(CATALOG_KEY, choices);
    this.render();
  }

  private learnWindow(model: string, size: number): void {
    if (this.windows[model] === size) return;
    void this.context.globalState.update(WINDOWS_KEY, { ...this.windows, [model]: size });
    this.render();
  }

  // Unchanged catalogs keep the same objects, so open picker menus stay put.
  private render(): void {
    const models = toModels(this.choices, this.windows);
    if (JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    this.changed.fire();
  }

  private sleepIfAway(): void {
    const away = this.awaySince !== undefined && Date.now() - this.awaySince > AWAY_MS;
    if (!away || !this.agent.started || this.sessions.running()) return;
    this.log.info('VS Code has been in the background for a while; stopping the server until it is back in focus.');
    this.asleep = true;
    this.restart();
  }

  private explain(error: unknown): Error {
    if (!(error instanceof AgentError && error.signedOut)) return error instanceof Error ? error : new Error(String(error));
    void this.promptSetup();
    return new Error('Antigravity is not signed in. Run "Antigravity: Sign In", then try again.');
  }

  private async promptSetup(): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    const choice = await vscode.window.showInformationMessage('Sign in with Google to use your Antigravity models in Copilot Chat.', 'Sign In');
    this.prompting = false;
    if (choice) await this.signIn();
  }

  // Remote folders don't exist on this machine, where the server runs.
  private workspaceDir(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return folder?.scheme === 'file' && existsSync(folder.fsPath) ? folder.fsPath : this.scratchDir();
  }

  private scratchDir(): string {
    const dir = join(this.context.globalStorageUri.fsPath, 'scratch');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

// The server records the chosen sign-in method (not the credentials) in its settings.
function authType(home: string): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')) as { auth?: { type?: string } };
    return settings.auth?.type;
  } catch {
    return undefined;
  }
}

// Copilot passes its conversation id in modelOptions; it keeps two chats from sharing a session.
function conversationId(options: Options): string | undefined {
  const id: unknown = options.modelOptions?._conversationId;
  return typeof id === 'string' ? id : undefined;
}
