import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { PERMISSION_MODES, type PermissionMode } from './permissions.js';

export type Block = Extract<ContentBlock, { type: 'text' | 'image' }>;
type Message = vscode.LanguageModelChatRequestMessage;

// Copilot sends its system prompt with the proposed System role, which the stable typings lack.
const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;
const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const IMAGE_CHARS = 6000;
// Copilot's background compaction forks the agent prompt and appends a summary request after the tool results.
const COMPACTION_MARKERS = ['compacted', '<summary>'];
const REPLAY_NOTE =
  'This conversation started in an earlier session that has ended. Its transcript follows, with tool calls ' +
  'and results shown as text for reference only. Continue from where it stops and call tools normally.';

export interface ChatRequest {
  system: string;
  assistantCount: number;
  /** Tool call ids and text of the last assistant message: what a live session must have produced last. */
  lastCalls: string[];
  lastText: string;
  /** Results for those tool calls, when the request continues a tool round. */
  results?: Map<string, Block[]>;
  /** New user content after the last assistant message (after the results, if any). */
  prompt: Block[];
  /** Everything before the new content, replayed when no live session holds it. */
  history: readonly Message[];
  /** A side request (background compaction) that must not take over the live session it was forked from. */
  fork: boolean;
}

export function parseRequest(messages: readonly Message[]): ChatRequest {
  const chat = messages.filter((message) => message.role !== SYSTEM_ROLE);
  const last = chat.findLastIndex(isAssistant);
  const { results, extra } = splitTail(chat.slice(last + 1));
  const lastMessage = chat[last];
  return {
    system: messages.filter((message) => message.role === SYSTEM_ROLE).map(textOf).join('\n\n'),
    assistantCount: chat.filter(isAssistant).length,
    lastCalls: lastMessage ? callIds(lastMessage) : [],
    lastText: lastMessage ? textOf(lastMessage) : '',
    results: results.size > 0 ? results : undefined,
    prompt: extra,
    history: chat.slice(0, last + 1),
    fork: results.size > 0 && isCompaction(extra),
  };
}

/** The opening message of a new session: Copilot's instructions, the replayed history, then the new content. */
export function firstPrompt(request: ChatRequest, mode: PermissionMode): Block[] {
  const blocks: Block[] = [{ type: 'text', text: instructions(request.system, mode) }];
  if (request.history.length > 0) blocks.push({ type: 'text', text: transcript(request.history, request.results) });
  return [...blocks, ...nonEmpty(request.prompt)];
}

/** Tool results for a live session. Text Copilot added after them rides along with the last one. */
export function resultsWithPrompt(results: Map<string, Block[]>, prompt: Block[]): Map<string, Block[]> {
  const lastId = [...results.keys()].at(-1);
  if (lastId && prompt.length > 0) results.set(lastId, [...(results.get(lastId) ?? []), ...prompt]);
  return results;
}

export function nonEmpty(blocks: Block[]): Block[] {
  return blocks.length > 0 ? blocks : [{ type: 'text', text: 'Continue.' }];
}

export function toToolResult(blocks: Block[]): CallToolResult {
  const content = blocks.map((block) =>
    block.type === 'text' ? { type: 'text' as const, text: block.text } : { type: 'image' as const, data: block.data, mimeType: block.mimeType },
  );
  return { content: content.length > 0 ? content : [{ type: 'text', text: '(no output)' }] };
}

/** Rough size of what the model reads, for token estimates. Images count as a fixed amount. */
export function charsOf(message: Message): number {
  return message.content.reduce<number>((chars, part) => chars + partChars(part), 0);
}

/** Tells a running session that the user switched permission modes. */
export function modeNote(mode: PermissionMode): Block {
  const { label, note } = PERMISSION_MODES.find((candidate) => candidate.id === mode) ?? PERMISSION_MODES[0];
  return { type: 'text', text: `<permissions_changed>The user switched to ${label}. ${note}</permissions_changed>` };
}

// Antigravity keeps its own system prompt; Copilot's goes first in the conversation instead.
function instructions(system: string, mode: PermissionMode): string {
  const { note } = PERMISSION_MODES.find((candidate) => candidate.id === mode) ?? PERMISSION_MODES[0];
  return [
    '<copilot_instructions>',
    'You are the model behind GitHub Copilot Chat in VS Code. The instructions below come from Copilot and take ' +
      `precedence over your defaults. Copilot's tools are available to you with a vscode_ prefix (Copilot's read_file is vscode_read_file). ${note} ` +
      'Write your answer to the user as message text, since that is all they see of it: a tool such as vscode_task_complete never replaces it, ' +
      'and a plain question or greeting gets a plain reply.',
    system,
    '</copilot_instructions>',
  ].join('\n\n');
}

function partChars(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) return part.value.length;
  if (part instanceof vscode.LanguageModelToolCallPart) return part.name.length + JSON.stringify(part.input).length;
  if (part instanceof vscode.LanguageModelToolResultPart) return part.content.reduce<number>((n, item) => n + partChars(item), 0);
  return isImage(part) ? IMAGE_CHARS : 0;
}

function isAssistant(message: Message): boolean {
  return message.role === vscode.LanguageModelChatMessageRole.Assistant;
}

function textOf(message: Message): string {
  return message.content
    .filter((part) => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('');
}

function callIds(message: Message): string[] {
  return message.content.filter((part) => part instanceof vscode.LanguageModelToolCallPart).map((part) => part.callId);
}

// Copilot sends one user message per tool result, sometimes followed by extra user text.
function splitTail(tail: readonly Message[]): { results: Map<string, Block[]>; extra: Block[] } {
  const results = new Map<string, Block[]>();
  const extra: Block[] = [];
  for (const part of tail.flatMap((message) => message.content)) {
    if (part instanceof vscode.LanguageModelToolResultPart) results.set(part.callId, resultBlocks(part.content));
    else pushBlock(extra, part);
  }
  return { results, extra };
}

function isCompaction(extra: Block[]): boolean {
  const text = extra.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return COMPACTION_MARKERS.every((marker) => text.includes(marker));
}

function resultBlocks(content: readonly unknown[]): Block[] {
  const blocks: Block[] = [];
  for (const item of content) pushBlock(blocks, item instanceof vscode.LanguageModelPromptTsxPart ? toText(item.value) : item);
  return blocks;
}

function toText(value: unknown): vscode.LanguageModelTextPart {
  return new vscode.LanguageModelTextPart(typeof value === 'string' ? value : JSON.stringify(value));
}

function pushBlock(blocks: Block[], part: unknown): void {
  const previous = blocks.at(-1);
  if (part instanceof vscode.LanguageModelTextPart && previous?.type === 'text') previous.text += part.value;
  else if (part instanceof vscode.LanguageModelTextPart) blocks.push({ type: 'text', text: part.value });
  else if (isImage(part)) blocks.push({ type: 'image', data: Buffer.from(part.data).toString('base64'), mimeType: part.mimeType });
}

function isImage(part: unknown): part is vscode.LanguageModelDataPart {
  return part instanceof vscode.LanguageModelDataPart && IMAGE_TYPES.includes(part.mimeType);
}

function transcript(history: readonly Message[], results?: Map<string, Block[]>): string {
  const names = new Map<string, string>();
  const turns = history.map((message) => renderTurn(message, names));
  if (results) turns.push(`<user>\n${[...results].map(([id, blocks]) => renderResult(names.get(id), blocks)).join('\n')}\n</user>`);
  return `<conversation_history>\n${REPLAY_NOTE}\n\n${turns.filter(Boolean).join('\n\n')}\n</conversation_history>`;
}

function renderTurn(message: Message, names: Map<string, string>): string {
  const lines = message.content.map((part) => renderPart(part, names)).filter(Boolean);
  const role = isAssistant(message) ? 'assistant' : 'user';
  return lines.length > 0 ? `<${role}>\n${lines.join('\n')}\n</${role}>` : '';
}

function renderPart(part: unknown, names: Map<string, string>): string {
  if (part instanceof vscode.LanguageModelTextPart) return part.value;
  if (part instanceof vscode.LanguageModelToolCallPart) {
    names.set(part.callId, part.name);
    return `<tool_call name="${part.name}">${JSON.stringify(part.input)}</tool_call>`;
  }
  if (part instanceof vscode.LanguageModelToolResultPart) return renderResult(names.get(part.callId), resultBlocks(part.content));
  return isImage(part) ? '[image]' : '';
}

function renderResult(name: string | undefined, blocks: Block[]): string {
  const text = blocks.map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n');
  return `<tool_result name="${name ?? 'unknown'}">\n${text}\n</tool_result>`;
}
