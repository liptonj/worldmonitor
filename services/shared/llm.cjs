'use strict';

/**
 * Shared LLM provider resolution and API call logic for ai-engine generators.
 *
 * Supports:
 *  - Prompt fetching from wm_admin.llm_prompts via get_llm_prompt RPC
 *  - Per-function config (provider chains, timeouts) via get_llm_function_config RPC
 *  - Automatic provider fallback within the configured chain
 *  - JSON extraction from LLM responses that contain markdown fences or prose
 */

const { createLogger } = require('./logger.cjs');

const log = createLogger('llm');

const DEFAULT_LLM_TIMEOUT_MS = 90_000;

let _functionConfigCache = null;
let _functionConfigCacheTs = 0;
const FUNCTION_CONFIG_TTL_MS = 5 * 60_000;

const MAX_PROMPT_CHARS = 3_000;

// ---------------------------------------------------------------------------
// Complexity tier ordering
// ---------------------------------------------------------------------------

const COMPLEXITY_RANK = { light: 1, medium: 2, heavy: 3 };

function meetsComplexity(providerCap, functionComplexity) {
  return (COMPLEXITY_RANK[providerCap] ?? 3) >= (COMPLEXITY_RANK[functionComplexity] ?? 2);
}

// ---------------------------------------------------------------------------
// Token estimation (chars / 4 heuristic)
// ---------------------------------------------------------------------------

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// ---------------------------------------------------------------------------
// In-memory rate tracking — sliding-window RPM counter
// ---------------------------------------------------------------------------

const _rateLedger = {};

function isRateLimited(providerName, rpm) {
  if (!rpm || rpm <= 0) return false;
  const now = Date.now();
  const window = _rateLedger[providerName] ?? [];
  const recent = window.filter((t) => now - t < 60_000);
  _rateLedger[providerName] = recent;
  return recent.length >= rpm;
}

function recordCall(providerName) {
  if (!_rateLedger[providerName]) _rateLedger[providerName] = [];
  _rateLedger[providerName].push(Date.now());
}

// ---------------------------------------------------------------------------
// Exponential backoff on HTTP 429
// ---------------------------------------------------------------------------

const _backoffState = {};

function markProviderRateLimited(providerName) {
  const state = _backoffState[providerName] ?? { count: 0, cooldownUntil: 0 };
  state.count++;
  const delay = Math.min(300_000, 15_000 * Math.pow(2, state.count - 1));
  state.cooldownUntil = Date.now() + delay;
  _backoffState[providerName] = state;
  log.warn('Provider rate-limited with backoff', {
    provider: providerName,
    backoffMs: delay,
    consecutiveHits: state.count,
  });
}

function isInCooldown(providerName) {
  const state = _backoffState[providerName];
  if (!state) return false;
  if (Date.now() >= state.cooldownUntil) {
    state.count = Math.max(0, state.count - 1);
    return false;
  }
  return true;
}

function is429Error(err) {
  const msg = String(err?.message ?? '');
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many Requests');
}

// ---------------------------------------------------------------------------
// Context truncation — keeps prompts within model context limits
// ---------------------------------------------------------------------------

function truncateContext(obj, maxChars = MAX_PROMPT_CHARS) {
  let str = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  if (str.length <= maxChars) return str;

  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const keys = Object.keys(obj);
    const trimmed = {};
    for (const k of keys) {
      const val = obj[k];
      if (Array.isArray(val)) {
        const half = Math.max(3, Math.floor(val.length / 2));
        trimmed[k] = val.slice(0, half);
      } else {
        trimmed[k] = val;
      }
    }
    str = JSON.stringify(trimmed, null, 2);
    if (str.length <= maxChars) return str;
  }

  return str.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Prompt template helpers
// ---------------------------------------------------------------------------

function interpolate(template, vars) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const val = vars[key];
    if (val === undefined || val === null) return '';
    return String(val);
  });
}

async function fetchPrompt(supabase, promptKey, { variant, mode } = {}) {
  const args = { p_key: promptKey };
  if (variant !== undefined) args.p_variant = variant;
  if (mode !== undefined) args.p_mode = mode;

  const { data, error } = await supabase.rpc('get_llm_prompt', args);

  if (error) {
    log.warn('fetchPrompt RPC error', { promptKey, error: error.message });
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.system_prompt) return null;
  return { systemPrompt: row.system_prompt, userPrompt: row.user_prompt ?? '' };
}

// ---------------------------------------------------------------------------
// Per-function config (provider chain, timeout, retries)
// ---------------------------------------------------------------------------

async function fetchFunctionConfig(supabase) {
  const now = Date.now();
  if (_functionConfigCache && (now - _functionConfigCacheTs) < FUNCTION_CONFIG_TTL_MS) {
    return _functionConfigCache;
  }

  const { data, error } = await supabase.rpc('get_llm_function_config');
  if (error || !data) {
    log.warn('fetchFunctionConfig RPC error', { error: error?.message });
    return _functionConfigCache ?? {};
  }

  const map = {};
  for (const row of data) {
    map[row.function_key] = {
      providerChain: row.provider_chain ?? [],
      maxRetries: row.max_retries ?? 1,
      timeoutMs: row.timeout_ms ?? DEFAULT_LLM_TIMEOUT_MS,
    };
  }

  _functionConfigCache = map;
  _functionConfigCacheTs = now;
  return map;
}

// ---------------------------------------------------------------------------
// JSON extraction from LLM responses
// ---------------------------------------------------------------------------

function stripThinking(text) {
  if (typeof text !== 'string') return text;
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  cleaned = cleaned.replace(/^Thinking Process:[\s\S]*?\n\n(?=\{|\[|[A-Z#])/i, '');
  return cleaned.trim();
}

function extractJson(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('LLM returned empty content');
  }

  const trimmed = stripThinking(text).trim();

  try {
    return JSON.parse(trimmed);
  } catch (_) { /* fall through to extraction */ }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (_) { /* fall through */ }
  }

  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  let start = -1;
  let closeChar = '';

  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace <= firstBracket)) {
    start = firstBrace;
    closeChar = '}';
  } else if (firstBracket >= 0) {
    start = firstBracket;
    closeChar = ']';
  }

  if (start >= 0) {
    const lastClose = trimmed.lastIndexOf(closeChar);
    if (lastClose > start) {
      try {
        return JSON.parse(trimmed.slice(start, lastClose + 1));
      } catch (_) { /* fall through */ }
    }
  }

  throw new Error('LLM response does not contain valid JSON');
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

async function resolveProviderSecret(supabase, secretName) {
  if (!secretName) return '';
  const { data, error } = await supabase.rpc('get_vault_secret_value', { secret_name: secretName });
  if (!error && data != null) return String(data);
  return process.env[secretName] ?? '';
}

async function buildProviderConfig(supabase, row) {
  const providerName = row.name ?? 'unknown';
  const apiKey = await resolveProviderSecret(supabase, row.api_key_secret_name ?? '');

  let bearerToken = '';
  if (providerName.toLowerCase() === 'ollama') {
    bearerToken = await resolveProviderSecret(supabase, 'OLLAMA_BEARER_TOKEN');
    if (!bearerToken) bearerToken = process.env.OLLAMA_BEARER_TOKEN ?? '';
  }

  return {
    api_key: apiKey,
    base_url: row.api_url ?? '',
    model_name: row.default_model ?? '',
    provider_type: 'openai',
    provider_name: providerName,
    bearer_token: bearerToken,
    max_tokens: row.max_tokens ?? 3000,
    requests_per_minute: row.requests_per_minute ?? 60,
    tokens_per_minute: row.tokens_per_minute ?? 0,
    context_window: row.context_window ?? 8192,
    complexity_cap: row.complexity_cap ?? 'heavy',
  };
}

async function fetchLLMProvider(supabase) {
  const { data: providerRows, error: providerError } = await supabase.rpc('get_active_llm_provider');
  if (providerError || !providerRows || providerRows.length === 0) {
    throw new Error('No active LLM provider found');
  }
  return buildProviderConfig(supabase, providerRows[0]);
}

async function fetchAllLLMProviders(supabase) {
  const { data: rows, error } = await supabase.rpc('get_all_enabled_providers');
  if (error || !rows || rows.length === 0) {
    throw new Error('No enabled LLM providers found');
  }
  const providers = [];
  for (const row of rows) {
    providers.push(await buildProviderConfig(supabase, row));
  }
  return providers;
}

/**
 * Filter and order providers according to a function's configured provider_chain.
 * Falls back to all enabled providers if the chain is empty or no matches found.
 */
function filterProvidersByChain(allProviders, chain) {
  if (!chain || chain.length === 0) return allProviders;

  const ordered = [];
  for (const name of chain) {
    const match = allProviders.find((p) => p.provider_name.toLowerCase() === name.toLowerCase());
    if (match) ordered.push(match);
  }
  return ordered.length > 0 ? ordered : allProviders;
}

// ---------------------------------------------------------------------------
// Core LLM call
// ---------------------------------------------------------------------------

async function callLLM(provider, systemPrompt, userPrompt, http, options = {}) {
  const { api_key, base_url, model_name, bearer_token } = provider;
  const url = base_url.includes('/chat/completions') ? base_url : base_url.replace(/\/+$/, '') + '/chat/completions';
  const maxTokens = options.maxTokens ?? 2000;
  const temperature = options.temperature ?? 0.7;
  const timeout = options.timeout ?? DEFAULT_LLM_TIMEOUT_MS;
  const jsonMode = options.jsonMode !== false;

  const headers = { 'Content-Type': 'application/json' };
  if (bearer_token) {
    headers.Authorization = `Bearer ${bearer_token}`;
  } else if (api_key) {
    headers.Authorization = `Bearer ${api_key}`;
  }

  const body = {
    model: model_name,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  if (provider.provider_name === 'ollama') {
    body.chat_template_kwargs = { enable_thinking: false };
    body.reasoning_effort = 'none';
    body.messages[0].content += '\nDo NOT output any thinking, reasoning, or analysis process. Output ONLY the final answer directly.';
    body.num_ctx = options.numCtx ?? 8192;
  }

  if (jsonMode && provider.provider_name !== 'ollama') {
    body.response_format = { type: 'json_object' };
    const combined = (systemPrompt + ' ' + userPrompt).toLowerCase();
    if (!combined.includes('json')) {
      body.messages[0].content += '\nRespond with valid JSON only.';
    }
  }

  const response = await http.fetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout,
  });

  if (response.error) {
    throw new Error(response.error.message || 'LLM API error');
  }

  const rawContent = response.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error('LLM returned empty or invalid response');
  }

  return stripThinking(rawContent);
}

// ---------------------------------------------------------------------------
// Fallback orchestration (uses all enabled providers)
// ---------------------------------------------------------------------------

async function callLLMWithFallback(supabase, systemPrompt, userPrompt, http, options = {}) {
  const allProviders = await fetchAllLLMProviders(supabase);
  const providers = filterProvidersByChain(allProviders, options.providerChain);
  const errors = [];

  for (const provider of providers) {
    try {
      const rawContent = await callLLM(provider, systemPrompt, userPrompt, http, options);

      if (options.jsonMode === false) {
        return {
          content: rawContent,
          provider_name: provider.provider_name,
          model_name: provider.model_name,
        };
      }

      const parsed = extractJson(rawContent);
      return {
        content: JSON.stringify(parsed),
        parsed,
        provider_name: provider.provider_name,
        model_name: provider.model_name,
      };
    } catch (err) {
      log.warn('LLM provider failed', {
        provider: provider.provider_name,
        model: provider.model_name,
        error: err.message,
      });
      errors.push({ provider: provider.provider_name, model: provider.model_name, error: err.message });
    }
  }

  const summary = errors.map((e) => `${e.provider}/${e.model}: ${e.error}`).join('; ');
  throw new Error(`All LLM providers failed: ${summary}`);
}

// ---------------------------------------------------------------------------
// High-level: call LLM using DB prompt + function config
// ---------------------------------------------------------------------------

/**
 * Calls the LLM using a prompt fetched from wm_admin.llm_prompts and
 * per-function config from wm_admin.llm_function_config.
 *
 * @param {object}  supabase
 * @param {string}  functionKey  - key in llm_function_config (e.g. 'intel_digest')
 * @param {string}  promptKey    - key in llm_prompts (e.g. 'intel_digest')
 * @param {object}  placeholders - values to interpolate into prompt templates
 * @param {object}  http         - http module with fetchJson
 * @param {object}  [options]    - temperature, maxTokens, jsonMode, variant, mode
 * @returns {{ content: string, parsed?: object, provider_name: string, model_name: string }}
 */
async function callLLMForFunction(supabase, functionKey, promptKey, placeholders, http, options = {}) {
  const [funcConfig, allProviders] = await Promise.all([
    fetchFunctionConfig(supabase),
    fetchAllLLMProviders(supabase),
  ]);

  const config = funcConfig[functionKey] ?? {};
  const providerChain = config.providerChain ?? [];
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const providers = filterProvidersByChain(allProviders, providerChain);

  if (providers.length === 0) {
    throw new Error(`No providers available for function ${functionKey}`);
  }

  const errors = [];
  for (const provider of providers) {
    const promptOpts = {
      variant: options.variant ?? null,
      mode: options.mode ?? null,
    };

    const dbPrompt = await fetchPrompt(supabase, promptKey, promptOpts);

    let systemPrompt;
    let userPrompt;
    if (dbPrompt) {
      systemPrompt = interpolate(dbPrompt.systemPrompt, placeholders);
      userPrompt = interpolate(dbPrompt.userPrompt, placeholders);
      log.debug('Using DB prompt', { promptKey, model: provider.model_name });
    } else if (options.fallbackSystemPrompt) {
      systemPrompt = options.fallbackSystemPrompt;
      userPrompt = options.fallbackUserPrompt ?? '';
      log.debug('Using fallback prompt', { promptKey, model: provider.model_name });
    } else {
      errors.push({ provider: provider.provider_name, model: provider.model_name, error: 'No prompt found' });
      continue;
    }

    const callOpts = {
      ...options,
      timeout: timeoutMs,
      providerChain,
    };

    try {
      const rawContent = await callLLM(provider, systemPrompt, userPrompt, http, callOpts);

      if (options.jsonMode === false) {
        return {
          content: rawContent,
          provider_name: provider.provider_name,
          model_name: provider.model_name,
        };
      }

      const parsed = extractJson(rawContent);
      return {
        content: JSON.stringify(parsed),
        parsed,
        provider_name: provider.provider_name,
        model_name: provider.model_name,
      };
    } catch (err) {
      log.warn('LLM provider failed', {
        function: functionKey,
        provider: provider.provider_name,
        model: provider.model_name,
        error: err.message,
      });
      errors.push({ provider: provider.provider_name, model: provider.model_name, error: err.message });
    }
  }

  const summary = errors.map((e) => `${e.provider}/${e.model}: ${e.error}`).join('; ');
  throw new Error(`All LLM providers failed for ${functionKey}: ${summary}`);
}

module.exports = {
  fetchLLMProvider,
  fetchAllLLMProviders,
  callLLM,
  callLLMWithFallback,
  callLLMForFunction,
  fetchPrompt,
  fetchFunctionConfig,
  extractJson,
  interpolate,
  truncateContext,
  stripThinking,
};
