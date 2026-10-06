import type * as vscode from 'vscode';
import type { ModelChoice } from './agent.js';
import { PERMISSION_MODES, type PermissionMode } from './permissions.js';

const EFFORTS = ['high', 'medium', 'low'];
const EFFORT_SUFFIX = /^(.*?)\s*\((low|medium|high)\)$/i;
// Antigravity's usage updates report a 1M-token window; the harness manages its own context within it.
const CONTEXT_WINDOW = 1_048_576;
const MAX_OUTPUT_TOKENS = 65_536;

type Option = { enum: string[]; default: string } & Record<string, unknown>;

interface ConfigSchema {
  properties: { reasoningEffort?: Option; permissionMode: Option };
}

export type AgyModel = vscode.LanguageModelChatInformation & {
  readonly isBYOK: true;
  readonly configurationSchema: ConfigSchema;
  /** Antigravity's model id per effort level ('' when the model has no levels). */
  readonly variants: Record<string, string>;
};

/** Antigravity lists each effort as its own model, e.g. "Gemini 3.8 Flash (High)"; Copilot gets one model with an effort option. */
export function toModels(choices: readonly ModelChoice[]): AgyModel[] {
  const groups = new Map<string, Record<string, string>>();
  for (const choice of choices) {
    const [, name = choice.name, effort = ''] = EFFORT_SUFFIX.exec(choice.name) ?? [];
    groups.set(name, { ...groups.get(name), [effort.toLowerCase()]: choice.id });
  }
  return [...groups].map(([name, variants]) => toModel(name, variants));
}

/** Antigravity's model id for the picked effort, or the model's default effort. */
export function pickVariant(model: AgyModel, configured: string | undefined): string {
  const effort = configured !== undefined && model.variants[configured] ? configured : model.configurationSchema.properties.reasoningEffort?.default;
  return model.variants[effort ?? ''] ?? Object.values(model.variants)[0];
}

export function pickMode(configured: string | undefined): PermissionMode {
  return PERMISSION_MODES.find((mode) => mode.id === configured)?.id ?? 'copilot';
}

function toModel(name: string, variants: Record<string, string>): AgyModel {
  const id = name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
  const levels = EFFORTS.filter((level) => variants[level]);
  return {
    id,
    name,
    // A gemini-* family gets Copilot's Gemini-tuned prompts.
    family: id,
    version: id,
    detail: 'Antigravity',
    tooltip: `${name} through Google Antigravity`,
    maxInputTokens: CONTEXT_WINDOW - MAX_OUTPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: { toolCalling: true, imageInput: true },
    isBYOK: true,
    configurationSchema: { properties: { ...(levels.length > 1 ? { reasoningEffort: effortOption(levels) } : {}), permissionMode: modeOption() } },
    variants,
  };
}

// Copilot's picker shows one option per group next to the model: effort in 'navigation', and
// permissions in 'tokens', the only other group it shows (normally a context-size choice).
function effortOption(levels: string[]): Option {
  return {
    type: 'string',
    title: 'Thinking Effort',
    enum: levels,
    enumItemLabels: levels.map((level) => level.charAt(0).toUpperCase() + level.slice(1)),
    default: levels[0],
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
