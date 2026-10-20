// Configuration: profiles in anycode.config.json + env vars + CLI flags.
// Resolution order: CLI flags > env > profile > built-in defaults.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAiProvider } from './providers/openai.js';
import type { ChatProvider } from './types.js';

export type ProviderKind = 'anthropic' | 'openai';

export interface ProfileConfig {
  provider?: ProviderKind;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
}

export interface ResolvedConfig {
  provider: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}

export interface CliFlags {
  profile?: string;
  provider?: ProviderKind;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

function configPaths(): string[] {
  const local = join(process.cwd(), 'anycode.config.json');
  const home = join(homedir(), '.anycode', 'config.json');
  return [local, home];
}

export function loadProfiles(): Record<string, ProfileConfig> {
  for (const p of configPaths()) {
    try {
      const raw = readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as {
        profiles?: Record<string, ProfileConfig>;
      };
      if (parsed.profiles) return parsed.profiles;
    } catch {
      continue; // missing or invalid config file is not an error
    }
  }
  return {};
}

function errMissingKey(): string {
  return 'No API key. Set provider config in anycode.config.json (apiKey or apiKeyEnv), or pass --api-key-env / env var.';
}

export function resolveConfig(flags: CliFlags): ResolvedConfig {
  const profiles = loadProfiles();
  const profileName = flags.profile ?? 'default';
  const profile = profiles[profileName] ?? {};

  const provider = flags.provider ?? profile.provider ?? detectProvider();
  const model =
    flags.model ??
    profile.model ??
    (provider === 'anthropic'
      ? DEFAULT_ANTHROPIC_MODEL
      : DEFAULT_OPENAI_MODEL);

  // API key: explicit flag env var > profile apiKeyEnv > profile apiKey > env fallbacks.
  let apiKey = '';
  const envName =
    flags.apiKeyEnv ??
    profile.apiKeyEnv ??
    (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  if (envName) apiKey = process.env[envName] ?? '';
  if (!apiKey && profile.apiKey) apiKey = profile.apiKey;

  const baseUrl =
    flags.baseUrl ??
    profile.baseUrl ??
    (provider === 'anthropic'
      ? process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com'
      : process.env['OPENAI_BASE_URL'] ?? process.env['ANYCODE_BASE_URL'] ?? '');

  if (provider === 'openai' && !baseUrl) {
    throw new Error(
      'OpenAI-compatible provider needs a base URL. Pass --base-url (e.g. http://localhost:11434/v1 for Ollama).',
    );
  }
  if (provider === 'anthropic' && !apiKey) throw new Error(errMissingKey());

  const maxTokens =
    flags.maxTokens ?? profile.maxTokens ?? 16384;

  return { provider, apiKey, baseUrl, model, maxTokens };
}

function detectProvider(): ProviderKind {
  if (process.env['ANTHROPIC_API_KEY']) return 'anthropic';
  return 'openai';
}

export function makeProvider(cfg: ResolvedConfig): ChatProvider {
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider(cfg.apiKey, cfg.baseUrl);
  }
  return new OpenAiProvider(cfg.apiKey, cfg.baseUrl);
}
