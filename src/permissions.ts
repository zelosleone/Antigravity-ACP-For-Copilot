import type * as acp from '@agentclientprotocol/sdk';
import { relative } from 'node:path';
import * as vscode from 'vscode';

/** How Antigravity's own tools are handled; Copilot's tools always go through Copilot. */
export type PermissionMode = 'copilot' | 'default' | 'auto_edit' | 'yolo';

export const PERMISSION_MODES: readonly { id: PermissionMode; label: string; description: string; note: string }[] = [
  {
    id: 'copilot',
    label: 'Copilot Tools',
    description: "Edits and commands go through Copilot's tools; Antigravity's own are turned off",
    note: 'Use them for edits and terminal commands: your built-in edit and command tools are turned off here.',
  },
  {
    id: 'default',
    label: 'Ask',
    description: 'Antigravity asks before each of its own edits and commands',
    note: 'Your built-in tools work too; the user approves each of their edits and commands.',
  },
  {
    id: 'auto_edit',
    label: 'Auto Edit',
    description: "Antigravity's own file edits run without asking; its commands ask",
    note: 'Your built-in tools work too; their file edits run without asking, and the user approves their commands.',
  },
  {
    id: 'yolo',
    label: 'YOLO',
    description: "Antigravity's own edits and commands run without asking",
    note: 'Your built-in tools work too and run without asking.',
  },
];

// Built-in tools that Copilot's own replace (edits, commands, questions, subagents), by the names the
// server's tool filter takes.
const REPLACED_BY_COPILOT = ['run_command', 'create_file', 'edit_file', 'ask_question', 'start_subagent'];
const FILE_KINDS: readonly string[] = ['edit', 'delete', 'move'];
const VERBS: Record<string, string> = { read: 'Read', edit: 'Edited', delete: 'Deleted', move: 'Moved' };
const DETAIL_CHARS = 1200;

/**
 * The server's own filter for its built-in tools, sent when a session is created or loaded. Turned off,
 * they also stay out of the prompt, so the model reads less and doesn't reach for them. An empty list
 * clears what a loaded session had.
 */
export function toolFilter(mode: PermissionMode): { agy: { disabledTools: string[] } } {
  return { agy: { disabledTools: mode === 'copilot' ? REPLACED_BY_COPILOT : [] } };
}

/** The answer to Antigravity's request to run one of its own tools. */
export function decide(request: acp.RequestPermissionRequest, mode: PermissionMode, home: string): acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse> {
  if (allowed(request.toolCall, mode, home)) return choose(request, 'allow_once');
  return mode === 'copilot' ? choose(request, 'reject_once') : ask(request);
}

export function choose(request: acp.RequestPermissionRequest, kind: acp.PermissionOptionKind): acp.RequestPermissionResponse {
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** A one-line account of a tool Antigravity runs itself, for the chat. */
export function describe(call: acp.ToolCallUpdate, cwd: string): string {
  const where = paths(call).map((path) => `\`${inside(cwd, path) ? relative(cwd, path) : path}\``);
  const title = oneLine(call.title ?? 'a tool');
  if (call.kind === 'execute') return `Ran \`${title}\``;
  const verb = where.length > 0 ? VERBS[call.kind ?? ''] : undefined;
  return verb ? `${verb} ${where.join(', ')}` : title;
}

export function paths(call: acp.ToolCallUpdate): string[] {
  const fromContent = (call.content ?? []).flatMap((item) => (item.type === 'diff' ? [item.path] : []));
  return [...new Set([...(call.locations ?? []).map((location) => location.path), ...fromContent])];
}

export function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel);
}

// Its plans, task lists and notes live in its own home, never among the user's files.
function allowed(call: acp.ToolCallUpdate, mode: PermissionMode, home: string): boolean {
  if (mode === 'yolo' || (mode === 'auto_edit' && FILE_KINDS.includes(call.kind ?? ''))) return true;
  const where = paths(call);
  return where.length > 0 && where.every((path) => inside(home, path));
}

// The server's own options (Allow Always, Allow, Deny), in a modal like VS Code's other approvals.
async function ask(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
  const call = request.toolCall;
  const message = `Antigravity wants to run: ${oneLine(call.title ?? 'a tool')}`;
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail: detail(call) }, ...request.options.map((option) => option.name));
  const option = request.options.find((candidate) => candidate.name === choice);
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : choose(request, 'reject_once');
}

function detail(call: acp.ToolCallUpdate): string {
  const diffs = (call.content ?? []).flatMap((item) => (item.type === 'diff' ? [`${item.path}\n${item.newText}`] : []));
  const parts = [call.kind ? `Kind: ${call.kind}` : '', ...diffs, diffs.length > 0 ? '' : JSON.stringify(call.rawInput ?? {}, null, 2)];
  const text = parts.filter(Boolean).join('\n\n');
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
