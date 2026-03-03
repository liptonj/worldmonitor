/**
 * LLM provider resolution.
 * Fetches active provider config from wm_admin.llm_providers (Redis-cached).
 * Falls back to hard-coded constants if Supabase is unavailable.
 */

import { getRedisClient } from './redis';
import { createAnonClient } from './supabase';
import { getSecret } from './secrets';

const PROVIDER_CACHE_TTL = 900; // 15 minutes
const PROMPT_CACHE_TTL = 900;

export interface LlmProvider {
  name: string;
  apiUrl: string;
  model: string;
  apiKey: string;
}

export interface LlmPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Returns the highest-priority enabled LLM provider with its API key resolved.
 * Falls back to Groq env var if Supabase is unavailable.
 */
export async function getActiveLlmProvider(): Promise<LlmProvider | null> {
  const redis = getRedisClient();

  // 1. Redis cache
  if (redis) {
    try {
      const cached = await redis.get<string>('wm:llm:active-provider:v1');
      if (cached) {
        const parsed = JSON.parse(cached) as LlmProvider;
        return parsed;
      }
    } catch { /* non-fatal */ }
  }

  // 2. Supabase via public RPC (anon key)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;

  try {
    const supabase = createAnonClient();
    const { data, error } = await supabase.rpc('get_active_llm_provider');
    const row = Array.isArray(data) && data.length > 0 ? data[0] as Record<string, string> : null;

    if (!error && row) {
      const secretName = row.api_key_secret_name;
      if (!secretName) return null;
      const apiKey = await getSecret(secretName);
      if (apiKey) {
        const provider: LlmProvider = {
          name: row.name ?? '',
          apiUrl: row.api_url ?? '',
          model: row.default_model ?? '',
          apiKey,
        };
        if (redis) {
          try { await redis.setex('wm:llm:active-provider:v1', PROVIDER_CACHE_TTL, JSON.stringify(provider)); } catch { /* non-fatal */ }
        }
        return provider;
      }
    }
  } catch { /* fall through */ }

  // 3. No provider available
  return null;
}

/**
 * Fetches a prompt by key/variant/mode from wm_admin.llm_prompts.
 * Tries exact match (variant+mode), then variant-only, then mode-only, then wildcard.
 * Falls back to null if Supabase unavailable.
 */
export async function getLlmPrompt(
  promptKey: string,
  variant: string,
  mode: string,
): Promise<LlmPromptResult | null> {
  const cacheKey = `wm:llm:prompt:v1:${promptKey}:${variant}:${mode}`;
  const redis = getRedisClient();

  // 1. Redis cache
  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as LlmPromptResult;
        return parsed;
      }
    } catch { /* non-fatal */ }
  }

  // 2. Supabase via public RPC (anon key)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return null;
  }

  try {
    const supabase = createAnonClient();
    const { data, error } = await supabase.rpc('get_llm_prompt', {
      p_key: promptKey,
      p_variant: variant ?? null,
      p_mode: mode ?? null,
    });

    const row = Array.isArray(data) && data.length > 0 ? data[0] as Record<string, string> : null;
    if (!error && row) {
      const result: LlmPromptResult = {
        systemPrompt: row.system_prompt ?? '',
        userPrompt: row.user_prompt ?? '',
      };
      if (redis) {
        try { await redis.setex(cacheKey, PROMPT_CACHE_TTL, JSON.stringify(result)); } catch { /* non-fatal */ }
      }
      return result;
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * Replace {placeholder} tokens in a prompt template.
 * Unknown placeholders are left untouched.
 */
export function buildPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

/** Invalidate LLM caches after admin changes */
export async function invalidateLlmCache(): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del('wm:llm:active-provider:v1');
      // Prompt caches will expire naturally after 15 min
    } catch { /* non-fatal */ }
  }
}
