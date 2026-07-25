import { resolveCodexCli, runCodexCapture } from './codex-session.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { captureProviderCommand, resolveCursorCli, resolveProviderCli } from './provider-sessions.js';
import type { AgentEffort, AgentProvider } from './types.js';

export interface ProviderModel {
  id: string;
  label: string;
  group?: string;
  description?: string;
  efforts: AgentEffort[];
  defaultEffort?: AgentEffort;
  supportsFast: boolean;
}
export type ModelCatalogSource = 'live-cli' | 'fallback' | 'official-aliases' | 'local-cache';
export interface ProviderModelCatalog {
  models: ProviderModel[];
  source: ModelCatalogSource;
}

interface RawCodexModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: Array<{ effort?: unknown }>;
  additional_speed_tiers?: unknown[];
  service_tiers?: Array<{ id?: unknown }>;
}

const allowedEfforts = new Set<AgentEffort>([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);

function parseCodexModels(raw: string): ProviderModel[] {
  const start = raw.indexOf('{');
  if (start < 0) return [];
  try {
    const catalog = JSON.parse(raw.slice(start)) as { models?: RawCodexModel[] };
    return (catalog.models ?? []).flatMap((model): ProviderModel[] => {
      if (typeof model.slug !== 'string' || model.visibility === 'hide') return [];
      const efforts = (model.supported_reasoning_levels ?? [])
        .map((level) => level.effort)
        .filter((effort): effort is AgentEffort =>
          typeof effort === 'string' && allowedEfforts.has(effort as AgentEffort),
        );
      const defaultEffort =
        typeof model.default_reasoning_level === 'string' &&
        allowedEfforts.has(model.default_reasoning_level as AgentEffort)
          ? model.default_reasoning_level as AgentEffort
          : undefined;
      const tiers = [
        ...(model.additional_speed_tiers ?? []),
        ...(model.service_tiers ?? []).map((tier) => tier.id),
      ];
      return [{
        id: model.slug,
        label: typeof model.display_name === 'string' ? model.display_name : model.slug,
        group: model.slug.includes('codex') ? 'Codex' : 'GPT',
        description: typeof model.description === 'string' ? model.description : undefined,
        efforts,
        defaultEffort,
        supportsFast: tiers.some((tier) => tier === 'fast' || tier === 'priority'),
      }];
    });
  } catch {
    return [];
  }
}

function cursorGroup(id: string): string {
  if (id.startsWith('claude-')) return 'Claude';
  if (id.startsWith('gpt-')) return 'OpenAI';
  if (id.startsWith('gemini-')) return 'Google';
  if (id.startsWith('cursor-grok') || id.startsWith('grok-')) return 'xAI';
  if (id.startsWith('composer')) return 'Cursor';
  return 'Other';
}

function parseCursorModels(raw: string): ProviderModel[] {
  const seen = new Set<string>();
  return raw.split(/\r?\n/).flatMap((line): ProviderModel[] => {
    const match = line.trim().match(/^([a-z0-9][a-z0-9._-]*)\s+-\s+(.+?)\s*$/i);
    if (!match) return [];
    const id = match[1]!;
    if (seen.has(id)) return [];
    seen.add(id);
    const label = match[2]!.replace(/\s+\((current|default)(,\s*default)?\)\s*$/i, '');
    const effort =
      /(?:^|-)(xhigh|extra-high)(?:-|$)/i.test(id) ? 'xhigh'
      : /(?:^|-)high(?:-|$)/i.test(id) ? 'high'
      : /(?:^|-)medium(?:-|$)/i.test(id) ? 'medium'
      : /(?:^|-)low(?:-|$)/i.test(id) ? 'low'
      : undefined;
    return [{
      id,
      label,
      group: cursorGroup(id),
      efforts: effort ? [effort] : [],
      defaultEffort: effort,
      supportsFast: /(?:^|-)fast(?:-|$)/i.test(id),
    }];
  });
}

function parseKimiModels(raw: string): ProviderModel[] {
  const start = raw.indexOf('{');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(raw.slice(start)) as { models?: unknown };
    if (!parsed.models || typeof parsed.models !== 'object' || Array.isArray(parsed.models)) return [];
    return Object.entries(parsed.models as Record<string, unknown>).flatMap(([alias, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const model = value as Record<string, unknown>;
      const rawEfforts = [
        model.support_efforts,
        model.supported_efforts,
        model.thinking_efforts,
        model.efforts,
      ].find(Array.isArray) as unknown[] | undefined;
      const efforts = (rawEfforts ?? [])
        .filter((effort): effort is string => typeof effort === 'string')
        .map((effort) => effort === 'off' ? 'none' : effort)
        .filter((effort): effort is AgentEffort => allowedEfforts.has(effort as AgentEffort));
      const defaultRaw = [model.default_effort, model.defaultEffort]
        .find((effort): effort is string => typeof effort === 'string');
      const defaultEffort = defaultRaw === 'off'
        ? 'none'
        : defaultRaw && allowedEfforts.has(defaultRaw as AgentEffort)
          ? defaultRaw as AgentEffort
          : efforts[0];
      const provider = typeof model.provider === 'string'
        ? model.provider
        : alias.includes('/') ? alias.split('/')[0]! : 'Kimi';
      const label = typeof model.name === 'string'
        ? model.name
        : typeof model.display_name === 'string'
          ? model.display_name
          : alias.split('/').at(-1)!.replaceAll('-', ' ');
      return [{
        id: alias,
        label: label.replace(/\b\w/g, (character) => character.toUpperCase()),
        group: provider === 'kimi-code' || provider === 'managed:kimi-code'
          ? 'Kimi Code'
          : provider,
        efforts,
        defaultEffort,
        supportsFast: /fast|turbo/i.test(alias),
      }];
    });
  } catch {
    return [];
  }
}

const claudeEfforts: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const claudeExactModels: ProviderModel[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    group: 'Claude 5',
    description: 'Resolved by the installed Claude CLI from the opus alias.',
    efforts: claudeEfforts,
    defaultEffort: 'xhigh',
    supportsFast: false,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    group: 'Claude 5',
    description: 'Resolved by the installed Claude CLI from the sonnet alias.',
    efforts: claudeEfforts,
    defaultEffort: 'high',
    supportsFast: false,
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5 · Usage credits required',
    group: 'Claude 5',
    description: 'Available in Claude CLI 2.1.220 but requires usage credits for this account.',
    efforts: claudeEfforts,
    defaultEffort: 'high',
    supportsFast: false,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5 · 2025-10-01',
    group: 'Claude 4.5',
    description: 'Exact dated model returned by the installed Claude CLI.',
    efforts: [],
    supportsFast: false,
  },
];

const fallbacks: Record<AgentProvider, ProviderModel[]> = {
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', group: 'GPT', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', supportsFast: true },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', group: 'GPT', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', supportsFast: true },
  ],
  claude: claudeExactModels,
  cursor: [
    { id: 'auto', label: 'Auto', group: 'Cursor', efforts: [], supportsFast: false },
    { id: 'composer-2.5', label: 'Composer 2.5', group: 'Cursor', efforts: [], supportsFast: true },
  ],
  hermes: [
    { id: 'openai-codex::gpt-5.6-sol', label: 'GPT-5.6-Sol', group: 'OpenAI Codex', efforts: [], supportsFast: false },
  ],
  copilot: [
    { id: 'auto', label: 'Auto', group: 'GitHub Copilot', efforts: [], supportsFast: false },
    {
      id: 'claude-sonnet-4.6',
      label: 'Claude Sonnet 4.6',
      group: 'Anthropic',
      description: 'General-purpose coding; the documented Copilot CLI default.',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      supportsFast: false,
    },
    {
      id: 'claude-haiku-4.5',
      label: 'Claude Haiku 4.5',
      group: 'Anthropic',
      description: 'Fast, lightweight operations.',
      efforts: [],
      supportsFast: false,
    },
    {
      id: 'gpt-5.4',
      label: 'GPT-5.4',
      group: 'OpenAI',
      description: 'Complex reasoning tasks.',
      efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      supportsFast: false,
    },
    {
      id: 'gpt-5.3-codex',
      label: 'GPT-5.3-Codex',
      group: 'OpenAI',
      description: 'Code-focused tasks.',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      supportsFast: false,
    },
    {
      id: 'gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro · Preview',
      group: 'Google',
      description: 'Google Gemini reasoning model.',
      efforts: [],
      supportsFast: false,
    },
    {
      id: 'gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      group: 'Google',
      description: 'Fast Google Gemini responses.',
      efforts: [],
      supportsFast: true,
    },
    {
      id: 'mai-code-1-flash',
      label: 'MAI-Code-1-Flash',
      group: 'Microsoft',
      description: 'Fast, adaptive coding tasks.',
      efforts: [],
      supportsFast: true,
    },
  ],
  kimi: [
    {
      id: 'kimi-code/k3',
      label: 'Kimi K3',
      group: 'Kimi Code',
      description: 'Current Kimi Code subscription model; the installed CLI replaces this fallback with its live catalog.',
      efforts: [],
      supportsFast: false,
    },
  ],
};

async function readHermesModelCache(): Promise<ProviderModel[]> {
  const hermesHome = process.env.HERMES_HOME?.trim() ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'hermes')
      : path.join(homedir(), '.hermes'));
  try {
    const raw = JSON.parse(
      await readFile(path.join(hermesHome, 'provider_models_cache.json'), 'utf8'),
    ) as Record<string, { models?: unknown }>;
    const providerLabels: Record<string, string> = {
      'openai-codex': 'OpenAI Codex',
      anthropic: 'Anthropic',
      openrouter: 'OpenRouter',
      nous: 'Nous Portal',
      google: 'Google Gemini',
      deepseek: 'DeepSeek',
      xai: 'xAI',
    };
    return Object.entries(raw).flatMap(([provider, entry]) =>
      Array.isArray(entry.models)
        ? entry.models.flatMap((model): ProviderModel[] =>
            typeof model === 'string' && model.trim()
              ? [{
                  id: `${provider}::${model.trim()}`,
                  label: model.trim(),
                  group: providerLabels[provider] ?? provider,
                  efforts: [],
                  supportsFast: /(?:^|[-_.])fast(?:[-_.]|$)/i.test(model),
                }]
              : [],
          )
        : [],
    );
  } catch {
    return [];
  }
}

export async function getProviderModelCatalog(
  provider: AgentProvider,
): Promise<ProviderModelCatalog> {
  if (provider === 'claude') {
    const launch = await resolveProviderCli('claude');
    if (!launch) return { models: fallbacks.claude, source: 'fallback' };
    return { models: claudeExactModels, source: 'official-aliases' };
  }
  if (provider === 'codex') {
    const launch = await resolveCodexCli();
    if (!launch) return { models: fallbacks.codex, source: 'fallback' };
    const result = await runCodexCapture(launch, ['debug', 'models'], { timeoutMs: 30_000 });
    const parsed = parseCodexModels(`${result.stdout}\n${result.stderr}`);
    return parsed.length
      ? { models: parsed, source: 'live-cli' }
      : { models: fallbacks.codex, source: 'fallback' };
  }
  if (provider === 'hermes') {
    const launch = await resolveProviderCli('hermes');
    if (!launch) return { models: fallbacks.hermes, source: 'fallback' };
    const cached = await readHermesModelCache();
    if (cached.length) return { models: cached, source: 'local-cache' };
    const status = await captureProviderCommand(launch, ['status']);
    const model = status.match(/^\s*Model:\s+([^\r\n]+)/mi)?.[1]?.trim();
    return model ? { models: [{
      id: `openai-codex::${model}`,
      label: model,
      group: 'Hermes configured model',
      efforts: [],
      supportsFast: false,
    }], source: 'live-cli' } : { models: fallbacks.hermes, source: 'fallback' };
  }
  if (provider === 'copilot') {
    return { models: fallbacks.copilot, source: 'official-aliases' };
  }
  if (provider === 'kimi') {
    const launch = await resolveProviderCli('kimi');
    if (!launch) return { models: fallbacks.kimi, source: 'fallback' };
    const parsed = parseKimiModels(
      await captureProviderCommand(launch, ['provider', 'list', '--json']),
    );
    return parsed.length
      ? { models: parsed.map((model) => ({ ...model, efforts: [], defaultEffort: undefined })), source: 'live-cli' }
      : { models: fallbacks.kimi, source: 'fallback' };
  }
  const launch = await resolveCursorCli();
  if (!launch) return { models: fallbacks.cursor, source: 'fallback' };
  const parsed = parseCursorModels(await captureProviderCommand(launch, ['models']));
  return parsed.length
    ? { models: parsed, source: 'live-cli' }
    : { models: fallbacks.cursor, source: 'fallback' };
}

export async function listProviderModels(provider: AgentProvider): Promise<ProviderModel[]> {
  return (await getProviderModelCatalog(provider)).models;
}
