import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'src', 'services', 'breaking-news-alerts.ts'), 'utf8');

describe('breaking-news-alerts oref_siren integration', () => {
  it('includes oref_siren in origin union type', () => {
    assert.ok(SRC.includes("'oref_siren'"), 'origin type should include oref_siren');
  });

  it('exports dispatchOrefBreakingAlert function', () => {
    assert.ok(SRC.includes('export function dispatchOrefBreakingAlert('), 'should export dispatchOrefBreakingAlert');
  });

  it('imports OrefAlert type', () => {
    assert.ok(SRC.includes("import type { OrefAlert }") || SRC.includes("import { OrefAlert }"), 'should import OrefAlert');
  });

  it('builds headline with location overflow count', () => {
    assert.ok(SRC.includes('+${overflow} areas'), 'should show overflow count');
  });

  it('limits shown locations to 3', () => {
    assert.ok(SRC.includes('slice(0, 3)'), 'should limit to 3 locations');
  });

  it('uses stable dedupe key from alert identifiers', () => {
    assert.ok(SRC.includes("'oref:'"), 'dedupe key should start with oref:');
    assert.ok(SRC.includes('.sort()'), 'key parts should be sorted for stability');
  });

  it('sets threatLevel to critical', () => {
    assert.ok(SRC.includes("threatLevel: 'critical'"), 'oref alerts should be critical');
  });

  it('bypasses global cooldown (no isGlobalCooldown check)', () => {
    const fnBody = SRC.slice(SRC.indexOf('function dispatchOrefBreakingAlert'), SRC.indexOf('export function initBreakingNewsAlerts'));
    assert.ok(!fnBody.includes('isGlobalCooldown'), 'should not check global cooldown');
  });

  it('checks isDuplicate for per-event dedupe', () => {
    const fnBody = SRC.slice(SRC.indexOf('function dispatchOrefBreakingAlert'), SRC.indexOf('export function initBreakingNewsAlerts'));
    assert.ok(fnBody.includes('isDuplicate'), 'should check isDuplicate');
  });

  it('returns early when settings disabled or no alerts', () => {
    const fnBody = SRC.slice(SRC.indexOf('function dispatchOrefBreakingAlert'), SRC.indexOf('export function initBreakingNewsAlerts'));
    assert.ok(fnBody.includes('!settings.enabled') && fnBody.includes('!alerts.length'), 'should guard settings and empty alerts');
  });
});

describe('oref breaking news wiring (intelligence-handler + intelligence-loader)', () => {
  const IH = readFileSync(join(__dirname, '..', 'src', 'data', 'intelligence-handler.ts'), 'utf8');
  const IL = readFileSync(join(__dirname, '..', 'src', 'data', 'intelligence-loader.ts'), 'utf8');

  it('intelligence-handler imports dispatchOrefBreakingAlert', () => {
    assert.ok(IH.includes('dispatchOrefBreakingAlert'), 'intelligence-handler should import dispatchOrefBreakingAlert');
  });

  it('renderOrefAlerts calls dispatchOrefBreakingAlert when alerts present', () => {
    assert.ok(IH.includes('renderOrefAlerts'), 'intelligence-handler should define renderOrefAlerts');
    const renderOrefStart = IH.indexOf('function renderOrefAlerts');
    const renderOrefEnd = IH.indexOf('function renderIranEvents', renderOrefStart) || IH.length;
    const renderOrefBody = IH.slice(renderOrefStart, renderOrefEnd);
    assert.ok(renderOrefBody.includes('dispatchOrefBreakingAlert'), 'renderOrefAlerts should call dispatchOrefBreakingAlert');
  });

  it('oref handler calls renderOrefAlerts for WebSocket updates', () => {
    const orefKeyIdx = IH.indexOf('oref:');
    assert.ok(orefKeyIdx >= 0, 'intelligence-handler should have oref handler');
    const upToIran = IH.indexOf("'iran-events':", orefKeyIdx);
    const orefHandlerBody = IH.slice(orefKeyIdx, upToIran >= 0 ? upToIran : orefKeyIdx + 600);
    assert.ok(orefHandlerBody.includes('renderOrefAlerts'), 'oref handler should call renderOrefAlerts');
  });

  it('intelligence-loader loads oref via getHandler on initial load', () => {
    assert.ok(IL.includes('loadChannelWithFallback') && (IL.includes("'oref'") || IL.includes('"oref"')), 'intelligence-loader should load oref channel');
    assert.ok(IL.includes("getHandler('oref')"), 'intelligence-loader should pass data to getHandler(oref)');
  });
});
