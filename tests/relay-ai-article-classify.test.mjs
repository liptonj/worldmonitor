// tests/relay-ai-article-classify.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI article summarization and classification', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines summarizeAndClassifyHeadlines function', () => {
    assert.ok(src.includes('summarizeAndClassifyHeadlines'));
  });

  it('uses news_summary prompt key', () => {
    assert.ok(src.includes("'news_summary'") || src.includes('"news_summary"'));
  });

  it('uses classify_event prompt key', () => {
    assert.ok(src.includes("'classify_event'") || src.includes('"classify_event"'));
  });

  it('broadcasts to ai:article-summaries channel', () => {
    assert.ok(src.includes("'ai:article-summaries'") || src.includes('"ai:article-summaries"'));
  });

  it('broadcasts to ai:classifications channel', () => {
    assert.ok(src.includes("'ai:classifications'") || src.includes('"ai:classifications"'));
  });
});
