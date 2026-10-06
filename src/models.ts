import type * as vscode from 'vscode';
import type { ModelChoice } from './agent.js';
import { PERMISSION_MODES, type PermissionMode } from './permissions.js';

// The server names each thinking effort of a model as its own entry: "Gemini 3.8 Flash (High)".
const VARIANT = /^(.+?)\s*\(([^()]+)\)$/;
// Copilot's prompt budget before the server has reported any context window (usage updates do, from
// the first reply on); then each model uses its own.
const UNREPORTED_WINDOW = 1_048_576;

type Option = { enum: string[]; default: string } & Record<string, unknown>;

interface ConfigSchema {
  properties: { reasoningEffort?: Option; permissionMode: Option };
}

export type AgyModel = vscode.LanguageModelChatInformation & {
  readonly isBYOK: true;
  readonly configurationSchema: ConfigSchema;
  /** Antigravity's model id per effort ('' when the model has a single entry). */
  readonly variants: Record<string, string>;
};

/**
 * Copilot gets one model per name, with the server's effort entries as its thinking effort option,
 * in the server's order (the first is the default). Nothing about the models is fixed here: names,
 * ids, efforts and context windows all come from the server.
 */
export function toModels(choices: readonly ModelChoice[], windows: Readonly<Record<string, number>>): AgyModel[] {
  const groups = new Map<string, ModelChoice[]>();
  for (const choice of choices) {
    const base = VARIANT.exec(choice.name)?.[1] ?? choice.name;
    groups.set(base, [...(groups.get(base) ?? []), choice]);
  }
  return [...groups].map(([base, group]) => {
    const variants = group.length > 1 ? group.map((choice): [string, string] => [VARIANT.exec(choice.name)![2], choice.id]) : undefined;
    return toModel(variants ? base : group[0].name, variants ?? [['', group[0].id]], windowOf(group, windows));
  });
}

/** Antigravity's model id for the picked effort, or the model's default effort. */
export function pickVariant(model: AgyModel, configured: string | undefined): string {
  return model.variants[configured ?? ''] ?? model.variants[model.configurationSchema.properties.reasoningEffort?.default ?? ''];
}

export function pickMode(configured: string | undefined): PermissionMode {
  return PERMISSION_MODES.find((mode) => mode.id === configured)?.id ?? 'copilot';
}

// The window the server last reported for the model, else for any model.
function windowOf(group: ModelChoice[], windows: Readonly<Record<string, number>>): number {
  const own = Math.max(0, ...group.map((choice) => windows[choice.id] ?? 0));
  return own || Math.max(0, ...Object.values(windows)) || UNREPORTED_WINDOW;
}

// The server reports one context window and no separate output limit. Copilot budgets prompts with
// maxInputTokens and VS Code shows input plus output as the context size, so the window is all input.
function toModel(name: string, variants: [string, string][], window: number): AgyModel {
  const id = name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
  const efforts = variants.map(([label]) => label);
  return {
    id,
    name,
    // A gemini-* family gets Copilot's Gemini-tuned prompts.
    family: id,
    version: id,
    detail: 'Antigravity',
    tooltip: `${name} through Google Antigravity`,
    maxInputTokens: window,
    maxOutputTokens: 0,
    capabilities: { toolCalling: true, imageInput: true },
    isBYOK: true,
    configurationSchema: { properties: { ...(efforts.length > 1 ? { reasoningEffort: effortOption(efforts) } : {}), permissionMode: modeOption() } },
    variants: Object.fromEntries(variants.map(([label, model]) => [label.toLowerCase(), model])),
  };
}

// Copilot's picker shows one option per group next to the model: effort in 'navigation', and
// permissions in 'tokens', the only other group it shows (normally a context-size choice).
function effortOption(labels: string[]): Option {
  return {
    type: 'string',
    title: 'Thinking Effort',
    enum: labels.map((label) => label.toLowerCase()),
    enumItemLabels: labels,
    default: labels[0].toLowerCase(),
    group: 'navigation',
  };
}

function modeOption(): Option {
  return {
    type: 'string',
    title: 'Permissions',
    enum: PERMISSION_MODES.map((mode) => mode.id),
    enumItemLabels: PERMISSION_MODES.map((mode) => mode.label),
    enumDescriptions: PERMISSION_MODES.map((mode) => mode.description),
    default: 'copilot',
    group: 'tokens',
  };
}
