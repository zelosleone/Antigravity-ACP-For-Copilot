import type * as acp from '@agentclientprotocol/sdk';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { modelOption, type Agent, type ModelChoice, type SessionHandler } from './agent.js';
import { errorResult, SERVER_NAME, toMcpTool, type Bridge, type BridgeEntry, type ToolHost } from './bridge.js';
import { firstPrompt, modeNote, nonEmpty, resultsWithPrompt, toToolResult, type Block, type ChatRequest } from './convert.js';
import { choose, decide, describe, inside, paths, type PermissionMode } from './permissions.js';

// Quiet time is measured per chat: a chat stays active while any of its sessions (its subagents and
// side requests included) is talking to Antigravity or Copilot.
// Finished sessions kept around for a follow-up, closed once their chat has been quiet for 10 minutes.
const MAX_IDLE_SESSIONS = 2;
const IDLE_MS = 10 * 60 * 1000;
// Nothing mid-turn is ever timed out: a reply can think for as long as it needs, and a tool call or
// subagent can take any time. Mid-turn sessions whose chat has gone silent for 30 minutes are most
// likely left over from a stopped turn, so only those are capped, keeping the two most recent.
const PARKED_MS = 30 * 60 * 1000;
const MAX_PARKED_SESSIONS = 2;
// Antigravity waits on a tool's permission until Copilot has run it, so nothing more can arrive after
// a call; this only lets events already on their way land in the same response.
const SETTLE_MS = 50;
// Copilot ends an autopilot turn with its task_complete tool. Gemini tends to call it without having
// written any answer, so the user sees nothing but the summary; the first such call in a turn goes back
// to the model with this instead of to Copilot.
const UNANSWERED =
  'Not done yet: the user has not seen any reply from you in this turn. Write your answer to the user as message text, then call task_complete again.';
// A closed session stays on the server's disk (a week), so its chat can resume it instead of replaying.
const SAVED_KEY = 'antigravityAcp.savedSessions';
const SAVED_MS = 7 * 24 * 60 * 60 * 1000;

type Progress = vscode.Progress<vscode.LanguageModelResponsePart>;
type State = 'busy' | 'awaiting' | 'idle' | 'closed';
type Event =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'call'; id: string; name: string; input: object }
  | { type: 'end'; stopReason: acp.StopReason }
  | { type: 'error'; error: Error };

export interface SessionSettings {
  model: string;
  tools: readonly vscode.LanguageModelChatTool[];
  mode: PermissionMode;
}

export interface SessionContext {
  agent: Agent;
  bridge: Bridge;
  /** Antigravity works in this folder, so it should match Copilot's workspace. */
  cwd: string;
  system: string;
  conversation?: string;
  log: vscode.LogOutputChannel;
  onModels(models: ModelChoice[]): void;
}

/** A Copilot tool call handed over to Copilot, waiting for its result. */
interface Pending {
  deliver(result: CallToolResult): void;
  cancel(): void;
}

/** Where a chat's session stood when it last finished a reply. */
interface Saved {
  id: string;
  responses: number;
  lastText: string;
  cwd: string;
  mode: PermissionMode;
  at: number;
}

/**
 * One ACP session per Copilot conversation, inside the shared server. Antigravity asks permission
 * before each of Copilot's tools; the reply hands that call to Copilot and the permission stays open
 * until Copilot's next request brings the result. Then the call is allowed and answered at once, so
 * Antigravity's own three-minute limit on tool calls never comes into play.
 */
export class Session implements SessionHandler, ToolHost {
  state: State = 'busy';
  responses = 0;
  lastCalls: string[] = [];
  lastText = '';
  lastActive = Date.now();
  private id = '';
  private settings: SessionSettings;
  private model = '';
  private models: string[] = [];
  private readonly key?: string;
  private readonly inbox = new Inbox<Event>();
  private readonly pending = new Map<string, Pending>();
  private readonly ready: { name: string; key: string; result: CallToolResult }[] = [];
  private readonly shown = new Set<string>();
  private usage?: { used: number; size: number };
  private entry?: BridgeEntry;
  private oneShot = false;
  /** Whether this turn has shown the user any text yet, and whether a bare task_complete was sent back. */
  private answered = false;
  private reminded = false;

  constructor(
    private readonly context: SessionContext,
    settings: SessionSettings,
    private readonly saved: SavedSessions,
    private readonly spares: Spares,
  ) {
    this.settings = settings;
    // A chat's subagents share its id but not its system prompt.
    if (context.conversation) this.key = `${context.conversation}|${createHash('sha256').update(context.system).digest('hex').slice(0, 16)}`;
  }

  get conversation(): string | undefined {
    return this.context.conversation;
  }

  /** Whether this session already holds everything in the request except its new tail. */
  continues(request: ChatRequest, conversation: string | undefined): boolean {
    if (request.fork || !this.sameChat(request, conversation)) return false;
    return request.results ? this.awaits(request) : this.idleAfter(request);
  }

  /** Resumes the session this chat finished its last reply in, if the server kept it; else opens one that replays the history. */
  async begin(request: ChatRequest): Promise<void> {
    const saved = request.fork ? undefined : this.savedFor(request);
    if (!request.fork) this.saved.put(this.key, undefined);
    const prompt = (saved && (await this.reopen(saved, request))) || (await this.open(request));
    await this.useModel(this.settings.model);
    // A replayed or resumed history already holds this many replies, so the next request counts on from here.
    this.responses = request.assistantCount;
    // Nothing ever follows up on a side request, so its session goes as soon as it has answered.
    this.oneShot = request.fork;
    this.send(prompt);
  }

  async resume(request: ChatRequest, settings: SessionSettings): Promise<void> {
    this.state = 'busy';
    this.lastActive = Date.now();
    this.saved.put(this.key, undefined);
    this.context.log.info(`${settings.model}: continuing with ${request.results ? 'tool results' : 'a new turn'}`);
    const previous = this.settings;
    const prompt = [...(settings.mode === previous.mode ? [] : [modeNote(settings.mode)]), ...request.prompt];
    this.settings = { ...settings, model: previous.model };
    if (request.results) return this.deliver(resultsWithPrompt(request.results, prompt));
    this.settings = settings;
    await this.switchModel(settings.model, toolNames(previous.tools) !== toolNames(settings.tools));
    this.send(nonEmpty(prompt));
  }

  /** Streams one Copilot response: until Antigravity waits on one of Copilot's tools or its turn ends. */
  async respond(progress: Progress, token: vscode.CancellationToken): Promise<void> {
    const reply = new Reply(progress);
    const cancel = token.onCancellationRequested(() => this.close());
    if (token.isCancellationRequested) this.close();
    try {
      while (!reply.done) reply.handle(await this.inbox.next(reply.calls.length > 0 ? SETTLE_MS : undefined));
    } catch (error) {
      this.close();
      throw error;
    } finally {
      cancel.dispose();
    }
    if (this.state === 'closed') throw new Error('The Antigravity session ended before finishing the reply.');
    this.settle(reply, progress);
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const pending of this.pending.values()) pending.cancel();
    this.pending.clear();
    this.inbox.end();
    this.entry?.remove();
    if (this.id) this.context.agent.closeSession(this.id);
  }

  // ACP side: what Antigravity says and asks.

  update(update: acp.SessionUpdate): void {
    this.lastActive = Date.now();
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') this.reply(update.content.text);
    else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') this.push({ type: 'thought', text: update.content.text });
    else if (update.sessionUpdate === 'usage_update') this.usage = { used: update.used, size: update.size };
    else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') this.showTool(update);
  }

  permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    this.lastActive = Date.now();
    const tool = copilotTool(request.toolCall);
    if (tool && this.unanswered(tool)) return Promise.resolve(this.remind(request, tool));
    if (tool) return this.handOver(request, tool);
    this.context.log.info(`Antigravity's own tool (${this.settings.mode}): ${request.toolCall.title ?? 'unknown'}`);
    return Promise.resolve(decide(request, this.settings.mode, this.context.agent.home));
  }

  exited(error: Error): void {
    this.push({ type: 'error', error });
    this.close();
  }

  // MCP side: Copilot's tools as Antigravity sees them.

  tools(): Tool[] {
    return this.settings.tools.map(toMcpTool);
  }

  // Normally the result is already here, delivered before the permission was granted.
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const index = this.ready.findIndex((entry) => entry.name === name && entry.key === keyOf(args));
    if (index >= 0) return Promise.resolve(this.ready.splice(index, 1)[0].result);
    // A call that skipped the permission round goes to Copilot from here instead.
    const id = randomUUID();
    this.push({ type: 'call', id, name, input: args });
    return new Promise((resolve) => this.pending.set(id, { deliver: resolve, cancel: () => resolve(errorResult('The session ended before this tool ran.')) }));
  }

  // The session prepared in the background if there is one, else a new one.
  private async open(request: ChatRequest): Promise<Block[]> {
    const kind = request.fork ? 'one-off session for background compaction' : 'session';
    const spare = this.spares.take(this.context.cwd);
    this.context.log.info(`${this.settings.model}: new ${kind}${spare ? ' (prepared)' : ''}, replaying ${request.history.length} earlier messages`);
    if (spare) {
      this.attach(spare.entry);
      this.context.agent.adopt(spare.id, this);
      this.use(spare.id, spare.choices, spare.model);
    } else {
      this.attach(await this.context.bridge.add());
      const created = await this.context.agent.newSession(this.context.cwd, [this.entry!.server], this);
      this.use(created.sessionId, ...pick(created.configOptions));
    }
    return firstPrompt(request, this.settings.mode);
  }

  // Undefined when the server no longer has the session; a new one replays the history instead.
  private async reopen(saved: Saved, request: ChatRequest): Promise<Block[] | undefined> {
    const entry = await this.context.bridge.add();
    try {
      const resumed = await this.context.agent.resumeSession(saved.id, this.context.cwd, [entry.server], this);
      this.attach(entry);
      this.use(saved.id, ...pick(resumed.configOptions));
    } catch (error) {
      entry.remove();
      this.context.log.warn(`Saved session ${saved.id} could not be resumed: ${String(error)}`);
      return undefined;
    }
    this.context.log.info(`${this.settings.model}: resumed the saved session after ${request.history.length} messages`);
    return nonEmpty([...(saved.mode === this.settings.mode ? [] : [modeNote(this.settings.mode)]), ...request.prompt]);
  }

  private attach(entry: BridgeEntry): void {
    this.entry = entry;
    entry.attach(this);
  }

  private use(id: string, choices: ModelChoice[], current: string): void {
    this.id = id;
    this.model = current;
    this.models = choices.map((choice) => choice.id);
    this.context.onModels(choices);
  }

  private savedFor(request: ChatRequest): Saved | undefined {
    const saved = this.key ? this.saved.get(this.key) : undefined;
    if (!saved || request.results || saved.cwd !== this.context.cwd) return undefined;
    return saved.responses === request.assistantCount && saved.lastText.trim() === request.lastText.trim() ? saved : undefined;
  }

  // Antigravity's own tools show in the chat once they run; Copilot's show as Copilot tool calls instead.
  private showTool(call: acp.ToolCallUpdate): void {
    if (call.status !== 'in_progress' || copilotTool(call) || this.shown.has(call.toolCallId)) return;
    this.shown.add(call.toolCallId);
    // Its plans, task lists and notes in its own home are internal.
    if (paths(call).some((path) => inside(this.context.agent.home, path))) return;
    this.push({ type: 'text', text: `\n\n> ${describe(call, this.context.cwd)}\n\n` });
  }

  private reply(text: string): void {
    if (text.trim()) this.answered = true;
    this.push({ type: 'text', text });
  }

  private unanswered(tool: { name: string }): boolean {
    return tool.name === 'task_complete' && !this.answered && !this.reminded;
  }

  // Allowed, but answered here: the call's result is the reminder, so Copilot never runs it.
  private remind(request: acp.RequestPermissionRequest, tool: { name: string; input: Record<string, unknown> }): acp.RequestPermissionResponse {
    this.reminded = true;
    this.context.log.info('task_complete came before any answer; asking for the answer first');
    this.ready.push({ name: tool.name, key: keyOf(tool.input), result: errorResult(UNANSWERED) });
    return choose(request, 'allow_once');
  }

  private handOver(request: acp.RequestPermissionRequest, tool: { name: string; input: Record<string, unknown> }): Promise<acp.RequestPermissionResponse> {
    const id = request.toolCall.toolCallId;
    this.push({ type: 'call', id, name: tool.name, input: tool.input });
    return new Promise((resolve) => {
      const deliver = (result: CallToolResult) => {
        this.ready.push({ name: tool.name, key: keyOf(tool.input), result });
        resolve(choose(request, 'allow_once'));
      };
      this.pending.set(id, { deliver, cancel: () => resolve({ outcome: { outcome: 'cancelled' } }) });
    });
  }

  private deliver(results: Map<string, Block[]>): void {
    for (const [id, blocks] of results) {
      this.pending.get(id)?.deliver(toToolResult(blocks));
      this.pending.delete(id);
    }
  }

  // Switching models restarts the harness, so it only happens between turns. The harness reads
  // Copilot's tool list when it starts, so a changed list (tools turned on or off) restarts it too,
  // by way of another model when the model itself stays the same.
  private async switchModel(model: string, toolsChanged: boolean): Promise<void> {
    if (toolsChanged && model === this.model) await this.useModel(this.models.find((id) => id !== model) ?? model);
    await this.useModel(model);
  }

  private async useModel(model: string): Promise<void> {
    if (model === this.model) return;
    await this.context.agent.setModel(this.id, model);
    this.model = model;
  }

  // A new turn: the user has seen nothing of it yet.
  private send(prompt: Block[]): void {
    this.answered = false;
    this.reminded = false;
    this.context.agent.prompt(this.id, prompt).then(
      (response) => this.push({ type: 'end', stopReason: response.stopReason }),
      (error: unknown) => this.push({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
    );
  }

  private push(event: Event): void {
    this.lastActive = Date.now();
    this.inbox.push(event);
  }

  private sameChat(request: ChatRequest, conversation: string | undefined): boolean {
    const sameConversation = !conversation || !this.conversation || conversation === this.conversation;
    return sameConversation && this.context.system === request.system && this.responses === request.assistantCount;
  }

  private awaits(request: ChatRequest): boolean {
    const answered = this.lastCalls.every((id) => request.results?.has(id));
    return this.state === 'awaiting' && answered && sameIds(this.lastCalls, request.lastCalls);
  }

  private idleAfter(request: ChatRequest): boolean {
    const sameReply = request.lastCalls.length === 0 && request.lastText.trim() === this.lastText.trim();
    return this.state === 'idle' && sameReply;
  }

  private settle(reply: Reply, progress: Progress): void {
    this.responses++;
    this.lastCalls = reply.calls;
    this.lastText = reply.text;
    this.lastActive = Date.now();
    this.state = reply.calls.length > 0 ? 'awaiting' : 'idle';
    // Copilot reads this data part to drive its context window indicator.
    const used = this.usage?.used ?? 0;
    if (used > 0) progress.report(vscode.LanguageModelDataPart.json({ prompt_tokens: used, completion_tokens: 0, total_tokens: used }, 'usage'));
    if (this.oneShot && this.state === 'idle') return this.close();
    if (this.state === 'idle') this.saved.put(this.key, { id: this.id, responses: this.responses, lastText: this.lastText, cwd: this.context.cwd, mode: this.settings.mode, at: Date.now() });
  }
}

/** One Copilot response, built from Antigravity's events. */
class Reply {
  text = '';
  readonly calls: string[] = [];
  done = false;

  constructor(private readonly progress: Progress) {}

  /** No event means the session went quiet after a tool call, or closed. */
  handle(event: Event | undefined): void {
    if (!event || event.type === 'end') {
      this.done = true;
    } else if (event.type === 'text') {
      this.text += event.text;
      this.progress.report(new vscode.LanguageModelTextPart(event.text));
    } else if (event.type === 'thought') {
      const part = thinkingPart(event.text);
      if (part) this.progress.report(part);
    } else if (event.type === 'call') {
      this.calls.push(event.id);
      this.progress.report(new vscode.LanguageModelToolCallPart(event.id, event.name, event.input));
    } else {
      throw event.error;
    }
  }
}

/** Where each chat's sessions stood when they last finished a reply, kept across windows and restarts. */
class SavedSessions {
  constructor(private readonly memento: vscode.Memento) {}

  get(key: string): Saved | undefined {
    return this.all()[key];
  }

  put(key: string | undefined, saved: Saved | undefined): void {
    if (!key || (!saved && !this.get(key))) return;
    const now = Date.now();
    const kept = Object.entries(this.all()).filter(([other, entry]) => other !== key && now - entry.at < SAVED_MS);
    void this.memento.update(SAVED_KEY, Object.fromEntries(saved ? [...kept, [key, saved]] : kept));
  }

  private all(): Record<string, Saved> {
    return this.memento.get<Record<string, Saved>>(SAVED_KEY, {});
  }
}

/** A session made ahead of time, waiting for the next new chat or subagent to take it over. */
interface Spare {
  id: string;
  cwd: string;
  model: string;
  choices: ModelChoice[];
  entry: BridgeEntry;
}

/** Keeps one session ready, so a new chat skips creating one (seconds) and usually switching its model. */
class Spares {
  private spare?: Spare;
  private preparing = false;

  constructor(private readonly agent: Agent) {}

  prepare(bridge: Bridge, cwd: string, model: string | undefined, log: vscode.LogOutputChannel): void {
    if (this.preparing || this.spare?.cwd === cwd) return;
    this.close();
    this.preparing = true;
    void this.make(bridge, cwd, model)
      .catch((error: unknown) => log.warn(`Preparing a session failed: ${String(error)}`))
      .finally(() => (this.preparing = false));
  }

  take(cwd: string): Spare | undefined {
    const spare = this.spare?.cwd === cwd ? this.spare : undefined;
    this.spare = spare ? undefined : this.spare;
    return spare;
  }

  close(): void {
    if (this.spare) this.agent.closeSession(this.spare.id);
    this.spare?.entry.remove();
    this.spare = undefined;
  }

  private async make(bridge: Bridge, cwd: string, model: string | undefined): Promise<void> {
    const entry = await bridge.add();
    let id = '';
    // Until a chat takes it over it only waits; it is dropped if the server goes away.
    const waiting: SessionHandler = {
      update: () => undefined,
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      exited: () => {
        if (this.spare?.id === id) this.spare = undefined;
      },
    };
    try {
      const created = await this.agent.newSession(cwd, [entry.server], waiting);
      id = created.sessionId;
      const [choices, current] = pick(created.configOptions);
      if (model && model !== current) await this.agent.setModel(id, model);
      this.spare = { id, cwd, model: model ?? current, choices, entry };
    } catch (error) {
      entry.remove();
      throw error;
    }
  }
}

/** Live conversations, most recent first. Each runs its own harness (~90 MB), so keep few. */
export class Sessions implements vscode.Disposable {
  private sessions: Session[] = [];
  private readonly saved: SavedSessions;
  private readonly spares: Spares;
  private readonly timer = setInterval(() => this.sweep(), 60_000);

  constructor(memento: vscode.Memento, agent: Agent) {
    this.saved = new SavedSessions(memento);
    this.spares = new Spares(agent);
    this.timer.unref();
  }

  /** Continues the live session that holds this conversation, or opens one (resumed, prepared or new). */
  async open(request: ChatRequest, settings: SessionSettings, context: SessionContext): Promise<Session> {
    const live = this.sessions.find((session) => session.continues(request, context.conversation));
    const session = live ?? new Session(context, settings, this.saved, this.spares);
    // Both mark the session busy before their first await, so the sweep below spares it.
    const ready = live ? live.resume(request, settings) : session.begin(request);
    this.sessions = [session, ...this.sessions.filter((other) => other !== session)];
    this.sweep();
    try {
      await ready;
    } catch (error) {
      session.close();
      throw error;
    }
    this.prepare(context.bridge, context.cwd, settings.model, context.log);
    return session;
  }

  /** Makes a session ahead of time for the next new chat. */
  prepare(bridge: Bridge, cwd: string, model: string | undefined, log: vscode.LogOutputChannel): void {
    this.spares.prepare(bridge, cwd, model, log);
  }

  closeAll(): void {
    for (const session of this.sessions) session.close();
    this.sessions = [];
    this.spares.close();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.closeAll();
  }

  private sweep(): void {
    const now = Date.now();
    const chats = chatActivity(this.sessions);
    let idle = 0;
    let parked = 0;
    for (const session of this.sessions) {
      const quietMs = now - (chats.get(session.conversation) ?? session.lastActive);
      if (session.state === 'idle') idle++;
      if (session.state === 'awaiting' && quietMs > PARKED_MS) parked++;
      if (expired(session.state, quietMs, idle, parked)) session.close();
    }
    this.sessions = this.sessions.filter((session) => session.state !== 'closed');
  }
}

/** A prompt-side queue that a reply drains; next() gives up after `timeoutMs`, or once ended. */
class Inbox<T> {
  private readonly items: T[] = [];
  private wake?: () => void;
  private ended = false;

  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async next(timeoutMs?: number): Promise<T | undefined> {
    if (this.items.length === 0 && !this.ended) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        if (timeoutMs !== undefined) setTimeout(resolve, timeoutMs);
      });
      this.wake = undefined;
    }
    return this.items.shift();
  }
}

function pick(options: acp.SessionConfigOption[] | null | undefined): [ModelChoice[], string] {
  const { choices, current } = modelOption(options);
  return [choices, current ?? ''];
}

// Gemini's thinking, where VS Code offers a part for it (not yet in the stable typings).
function thinkingPart(text: string): vscode.LanguageModelResponsePart | undefined {
  const Part = (vscode as { LanguageModelThinkingPart?: new (value: string) => vscode.LanguageModelResponsePart }).LanguageModelThinkingPart;
  return Part ? new Part(text) : undefined;
}

// Each chat's latest activity across its sessions; sessions without a chat id stand alone.
function chatActivity(sessions: Session[]): Map<string | undefined, number> {
  const chats = new Map<string | undefined, number>();
  for (const { conversation, lastActive } of sessions) {
    if (conversation) chats.set(conversation, Math.max(chats.get(conversation) ?? 0, lastActive));
  }
  return chats;
}

// Ranks count finished and parked sessions, most recent first. Busy sessions are never closed here.
function expired(state: State, quietMs: number, idleRank: number, parkedRank: number): boolean {
  if (state === 'idle') return idleRank > MAX_IDLE_SESSIONS || quietMs > IDLE_MS;
  return state === 'awaiting' && quietMs > PARKED_MS && parkedRank > MAX_PARKED_SESSIONS;
}

/** The Copilot tool behind a tool call on our MCP server, if it is one. */
function copilotTool(call: acp.ToolCallUpdate): { name: string; input: Record<string, unknown> } | undefined {
  const mcp = (call._meta as { mcp?: { server?: unknown; tool?: unknown } } | undefined)?.mcp;
  if (mcp?.server !== SERVER_NAME || typeof mcp.tool !== 'string') return undefined;
  const input = (call.rawInput as { arguments?: unknown } | undefined)?.arguments;
  return { name: mcp.tool, input: isRecord(input) ? input : {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The same arguments with keys in any order.
function keyOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(keyOf).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${keyOf(value[key])}`);
  return `{${entries.join(',')}}`;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function toolNames(tools: readonly vscode.LanguageModelChatTool[]): string {
  return tools
    .map((tool) => tool.name)
    .sort()
    .join(',');
}
