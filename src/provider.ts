import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Agent, AgentError } from './agent.js';
import { Bridge } from './bridge.js';
import { charsOf, parseRequest } from './convert.js';
import { pickVariant, toModels, type AgyModel } from './models.js';
import { Sessions } from './session.js';

const MODELS_KEY = 'antigravityAcp.models';
const API_KEY_SECRET = 'antigravityAcp.apiKey';
const CHARS_PER_TOKEN = 4;
const AUTH_LABELS: Record<string, string> = {
  'oauth-personal': 'Google account',
  'oauth-business': 'Gemini Enterprise',
  'gemini-api-key': 'Gemini API key',
  'agent-platform': 'Vertex AI',
};
const API_KEY_KINDS = [
  { label: 'Gemini API key', description: 'From Google AI Studio', method: 'gemini-api-key', env: 'GEMINI_API_KEY' },
  { label: 'Vertex AI API key', description: 'Gemini Enterprise Agent Platform', method: 'agent-platform', env: 'GOOGLE_API_KEY' },
];

type Options = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: { readonly reasoningEffort?: string };
  readonly configuration?: { readonly reasoningEffort?: string };
};

export class AntigravityChatProvider implements vscode.LanguageModelChatProvider<AgyModel>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private readonly agent: Agent;
  private readonly bridge = new Bridge();
  private readonly sessions = new Sessions();
  private models: AgyModel[];
  private refreshing?: Promise<void>;
  private prompting = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const version = String(context.extension.packageJSON.version);
    this.agent = new Agent(context.globalStorageUri.fsPath, version, log, () => this.apiKeyEnv());
    this.models = context.globalState.get<AgyModel[]>(MODELS_KEY, []);
  }

  /** Signed-in users get the server started right away, since it takes half a minute or more to come up. */
  start(): void {
    if (this.models.length === 0) return void this.refresh();
    this.agent.warm().catch((error: unknown) => this.log.warn(`Server start failed: ${String(error)}`));
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
    const settings = { model: pickVariant(model, configuredEffort(options)), tools: options.tools ?? [], builtInTools: allowBuiltInTools() };
    const context = {
      agent: this.agent,
      bridge: this.bridge,
      cwd: this.workspaceDir(),
      system: request.system,
      conversation: conversationId(options),
      log: this.log,
      onModels: (infos: Parameters<typeof toModels>[0]) => this.setModels(toModels(infos)),
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
    if (await this.context.secrets.get(API_KEY_SECRET)) {
      await this.context.secrets.delete(API_KEY_SECRET);
      this.agent.restart();
    }
    const title = 'Antigravity: finish signing in with Google in your browser';
    const done = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const cancel = token.onCancellationRequested(() => this.agent.restart());
      try {
        await this.agent.authenticate('oauth-personal');
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

  async useApiKey(): Promise<void> {
    const kind = await vscode.window.showQuickPick(API_KEY_KINDS, { title: 'Antigravity: Use an API Key' });
    const key = kind && (await vscode.window.showInputBox({ title: kind.label, prompt: kind.description, password: true, ignoreFocusOut: true }));
    if (!kind || !key) return;
    await this.context.secrets.store(API_KEY_SECRET, JSON.stringify({ [kind.env]: key }));
    this.agent.restart();
    await this.agent.authenticate(kind.method);
    await this.refresh();
  }

  async signOut(): Promise<void> {
    await this.agent.logout().catch((error: unknown) => this.log.warn(`Sign-out failed: ${String(error)}`));
    await this.context.secrets.delete(API_KEY_SECRET);
    this.restart();
    this.setModels([]);
  }

  restart(): void {
    this.sessions.closeAll();
    this.agent.restart();
  }

  describe(): string {
    const auth = authType(join(this.context.globalStorageUri.fsPath, 'home'));
    const version = this.agent.serverVersion;
    return [`Antigravity: ${auth ? (AUTH_LABELS[auth] ?? auth) : 'signed out'}`, version && `ACP server ${version}`].filter(Boolean).join(' · ');
  }

  dispose(): void {
    this.sessions.dispose();
    this.bridge.dispose();
    this.agent.dispose();
    this.changed.dispose();
  }

  private async load(): Promise<void> {
    try {
      this.setModels(toModels(await this.agent.models(this.scratchDir())));
      this.log.info(`${this.describe()}: ${this.models.length} models`);
    } catch (error) {
      if (!(error instanceof AgentError && error.signedOut)) return this.log.warn(`Model refresh failed: ${String(error)}`);
      this.setModels([]);
      void this.promptSetup();
    }
  }

  // Unchanged catalogs keep the same objects, so open picker menus stay put.
  private setModels(models: AgyModel[]): void {
    if (JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    void this.context.globalState.update(MODELS_KEY, models);
    this.changed.fire();
  }

  private async apiKeyEnv(): Promise<Record<string, string>> {
    const stored = await this.context.secrets.get(API_KEY_SECRET);
    return stored ? (JSON.parse(stored) as Record<string, string>) : {};
  }

  private explain(error: unknown): Error {
    if (!(error instanceof AgentError && error.signedOut)) return error instanceof Error ? error : new Error(String(error));
    void this.promptSetup();
    return new Error('Antigravity is not signed in. Run "Antigravity: Sign In", then try again.');
  }

  private async promptSetup(): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    const message = 'Sign in to Google Antigravity to use its models in Copilot Chat.';
    const choice = await vscode.window.showInformationMessage(message, 'Sign In with Google', 'Use an API Key');
    this.prompting = false;
    if (choice === 'Sign In with Google') await this.signIn();
    else if (choice) await this.useApiKey();
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

function allowBuiltInTools(): boolean {
  return vscode.workspace.getConfiguration('antigravityAcp').get<boolean>('allowBuiltInTools', false);
}

function configuredEffort(options: Options): string | undefined {
  return options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;
}

// Copilot passes its conversation id in modelOptions; it keeps two chats from sharing a session.
function conversationId(options: Options): string | undefined {
  const id: unknown = options.modelOptions?._conversationId;
  return typeof id === 'string' ? id : undefined;
}
