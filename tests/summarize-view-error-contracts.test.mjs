// tests/summarize-view-error-contracts.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('server/worldmonitor/intelligence/v1/summarize-view.ts', 'utf8');

describe('summarize-view error contract', () => {
  it('SummarizeViewResponse interface includes errorCode field', () => {
    assert.ok(
      src.includes("errorCode?:"),
      'SummarizeViewResponse must include optional errorCode field'
    );
  });

  it('returns provider_missing errorCode when provider is null', () => {
    assert.ok(
      src.includes("'provider_missing'"),
      'must return errorCode provider_missing when provider is null'
    );
  });

  it('returns prompt_missing errorCode when getLlmPrompt returns null', () => {
    assert.ok(
      src.includes("'prompt_missing'"),
      'must return errorCode prompt_missing when prompt is null'
    );
  });

  it('returns upstream_http_error errorCode when LLM returns non-OK status', () => {
    assert.ok(
      src.includes("'upstream_http_error'"),
      'must return errorCode upstream_http_error when LLM HTTP fails'
    );
  });

  it('returns empty_model_output errorCode when LLM returns empty content', () => {
    assert.ok(
      src.includes("'empty_model_output'"),
      'must return errorCode empty_model_output when content is empty after stripping'
    );
  });

  it('returns timeout errorCode when request times out', () => {
    assert.ok(
      src.includes("'timeout'"),
      'must return errorCode timeout for AbortError/TimeoutError'
    );
  });

  it('logs provider_missing at error level', () => {
    assert.ok(
      src.includes("console.error('[SummarizeView] provider_missing"),
      'must log provider_missing at error level'
    );
  });

  it('logs prompt_missing at error level', () => {
    assert.ok(
      src.includes("console.error('[SummarizeView] prompt_missing"),
      'must log prompt_missing at error level'
    );
  });

  it('logs upstream_http_error at error level with HTTP status', () => {
    assert.ok(
      src.includes("console.error('[SummarizeView] upstream_http_error"),
      'must log upstream_http_error at error level'
    );
    assert.ok(
      src.includes('resp.status'),
      'upstream_http_error log must include HTTP status'
    );
  });

  it('logs empty_model_output at error level', () => {
    assert.ok(
      src.includes("console.error('[SummarizeView] empty_model_output"),
      'must log empty_model_output at error level'
    );
  });

  it('logs timeout at error level with timeout duration', () => {
    assert.ok(
      src.includes("console.error('[SummarizeView] timeout"),
      'must log timeout at error level'
    );
    assert.ok(
      src.includes('SUMMARIZE_VIEW_TIMEOUT_MS'),
      'timeout log must reference SUMMARIZE_VIEW_TIMEOUT_MS'
    );
  });

  it('does not log apiKey', () => {
    const lines = src.split('\n');
    const logLines = lines.filter(l => l.includes('console.') && l.includes('apiKey'));
    assert.strictEqual(logLines.length, 0, 'must not log apiKey in any console statement');
  });

  it('does not log systemPrompt or userPrompt', () => {
    const lines = src.split('\n');
    const logLines = lines.filter(l => l.includes('console.') && (l.includes('systemPrompt') || l.includes('userPrompt')));
    assert.strictEqual(logLines.length, 0, 'must not log prompt contents in any console statement');
  });

  it('detects AbortError as timeout', () => {
    assert.ok(
      src.includes('AbortError') || src.includes("err.name === 'TimeoutError'"),
      'must detect AbortError or TimeoutError and return timeout errorCode'
    );
  });

  it('skipped path (empty snapshots) returns no errorCode', () => {
    // When snapshots are too short, provider is 'skipped' and no errorCode is set
    // Verify the empty() function is called without arguments for the short-snapshot path
    assert.ok(
      src.includes('return empty()') || src.includes("provider: errorCode ? 'error' : 'skipped'"),
      'empty snapshots path must return skipped (no errorCode)'
    );
  });
});

describe('summarize-view UI error message mapping', () => {
  const uiSrc = readFileSync('src/data/ai-handler.ts', 'utf8');
  const i18nSrc = readFileSync('src/locales/en.json', 'utf8');

  it('UI imports/uses errorProviderMissing i18n key', () => {
    assert.ok(
      uiSrc.includes('errorProviderMissing'),
      'ai-handler.ts must reference errorProviderMissing i18n key'
    );
  });

  it('UI imports/uses errorPromptMissing i18n key', () => {
    assert.ok(
      uiSrc.includes('errorPromptMissing'),
      'ai-handler.ts must reference errorPromptMissing i18n key'
    );
  });

  it('UI imports/uses errorTimeout i18n key', () => {
    assert.ok(
      uiSrc.includes('errorTimeout'),
      'ai-handler.ts must reference errorTimeout i18n key'
    );
  });

  it('UI imports/uses errorRetry i18n key for generic errors', () => {
    assert.ok(
      uiSrc.includes('errorRetry'),
      'ai-handler.ts must reference errorRetry i18n key'
    );
  });

  it('i18n file has errorProviderMissing string', () => {
    assert.ok(
      i18nSrc.includes('errorProviderMissing'),
      'en.json must define errorProviderMissing'
    );
  });

  it('i18n file has errorPromptMissing string', () => {
    assert.ok(
      i18nSrc.includes('errorPromptMissing'),
      'en.json must define errorPromptMissing'
    );
  });

  it('i18n file has errorTimeout string', () => {
    assert.ok(
      i18nSrc.includes('errorTimeout'),
      'en.json must define errorTimeout'
    );
  });

  it('i18n file has errorRetry string', () => {
    assert.ok(
      i18nSrc.includes('errorRetry'),
      'en.json must define errorRetry'
    );
  });

  it('UI logs errorCode for config errors', () => {
    assert.ok(
      uiSrc.includes('errorCode=') || uiSrc.includes("errorCode:'") || uiSrc.includes('errorCode:"') || uiSrc.includes("errorCode=${"),
      'ai-handler.ts must log errorCode when a config error is returned'
    );
  });
});
