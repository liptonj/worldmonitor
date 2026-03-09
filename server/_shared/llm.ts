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
  extraHeaders?: Record<string, string>;
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
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('[LLM] Missing env: SUPABASE_URL=%s SUPABASE_ANON_KEY=%s',
      process.env.SUPABASE_URL ? 'set' : 'MISSING',
      process.env.SUPABASE_ANON_KEY ? 'set' : 'MISSING');
    return null;
  }

  try {
    const supabase = createAnonClient();
    const { data, error } = await supabase.rpc('get_active_llm_provider');
    const row = Array.isArray(data) && data.length > 0 ? data[0] as Record<string, string> : null;

    if (error) {
      console.error('[LLM] RPC get_active_llm_provider error:', error.message);
    }

    if (!error && row) {
      const providerName = row.name ?? '';

      // Ollama: resolve entirely via get_ollama_credentials (anon-accessible, SECURITY DEFINER).
      // Ollama authenticates via Bearer token.
      if (providerName === 'ollama') {
        const ollamaProvider = await resolveOllamaProvider(supabase);
        if (ollamaProvider) {
          if (redis) {
            try { await redis.setex('wm:llm:active-provider:v1', PROVIDER_CACHE_TTL, JSON.stringify(ollamaProvider)); } catch { /* non-fatal */ }
          }
          return ollamaProvider;
        }
        console.error('[LLM] Ollama is active provider but get_ollama_credentials failed');
        return null;
      }

      // Non-Ollama providers: resolve API key via getSecret (needs service role for vault)
      const secretName = row.api_key_secret_name;
      if (!secretName) {
        console.error('[LLM] Provider %s has no api_key_secret_name', providerName);
        return null;
      }
      const apiKey = await getSecret(secretName);
      if (!apiKey) {
        console.error('[LLM] Could not resolve secret %s for provider %s', secretName, providerName);
        return null;
      }
      const provider: LlmProvider = {
        name: providerName,
        apiUrl: row.api_url ?? '',
        model: row.default_model ?? '',
        apiKey,
      };
      if (redis) {
        try { await redis.setex('wm:llm:active-provider:v1', PROVIDER_CACHE_TTL, JSON.stringify(provider)); } catch { /* non-fatal */ }
      }
      return provider;
    } else if (!row) {
      console.error('[LLM] RPC get_active_llm_provider returned no rows');
    }
  } catch (err) {
    console.error('[LLM] getActiveLlmProvider exception:', err);
  }

  // 3. No provider available
  return null;
}

interface OllamaCredentials {
  api_url?: string | null;
  model?: string | null;
  bearer_token?: string | null;
}

async function resolveOllamaProvider(
  supabase: ReturnType<typeof createAnonClient>,
): Promise<LlmProvider | null> {
  try {
    const { data, error } = await supabase.rpc('get_ollama_credentials');
    if (error) {
      console.error('[LLM] RPC get_ollama_credentials error:', error.message);
      return null;
    }
    const creds = (Array.isArray(data) && data.length > 0 ? data[0] : null) as OllamaCredentials | null;
    if (!creds?.api_url) {
      console.error('[LLM] get_ollama_credentials returned no api_url');
      return null;
    }

    const chatUrl = creds.api_url.replace(/\/+$/, '') + '/chat/completions';

    return {
      name: 'ollama',
      apiUrl: chatUrl,
      model: creds.model ?? '',
      apiKey: creds.bearer_token ?? 'ollama',
    };
  } catch (err) {
    console.error('[LLM] resolveOllamaProvider exception:', err);
    return null;
  }
}

/**
 * Fetches a prompt by key/variant/mode from wm_admin.llm_prompts.
 * Tries exact match (variant+mode), then variant-only, then mode-only, then wildcard.
 * Falls back to null if Supabase unavailable.
 */
export async function getLlmPrompt(
  promptKey: string,
  variant: string | null,
  mode: string | null,
  model?: string | null,
): Promise<LlmPromptResult | null> {
  const cacheKey = `wm:llm:prompt:v1:${promptKey}:${variant ?? 'null'}:${mode ?? 'null'}:${model ?? 'null'}`;
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
      p_model: model ?? null,
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
      // Also clear all cached prompts (variadic del for single round-trip)
      const keys = await redis.keys('wm:llm:prompt:v1:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch { /* non-fatal */ }
  }
}
