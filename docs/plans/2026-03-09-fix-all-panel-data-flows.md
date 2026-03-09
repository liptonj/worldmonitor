# Fix All Panel Data Flows - Comprehensive Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix data flow issues preventing panels from receiving WebSocket push data and HTTP fallback data.

**Current State:** Only vessels/AIS channel is pushing data successfully. All other panels show errors:
- Strategic Risk Overview: "Insufficient Data"
- Intel Feed: "All Intel sources disabled"
- Live Intelligence (GDELT): "No recent articles for this topic"
- AI Insights: "Loading..."
- AI Strategic Posture: "Acquiring Data"
- World News: Loading...

**Root Causes:**
1. GDELT is not a relay channel - using direct `/gdelt` endpoint that doesn't exist
2. Some channels may not be properly scheduled in orchestrator
3. Workers may not be publishing to Redis with correct keys
4. Frontend may not be subscribing to all required channels

**Tech Stack:** TypeScript (frontend), Node.js CommonJS (gateway/orchestrator), Redis

---

## Task 1: Add GDELT as Proper Relay Channel

**Goal:** Convert GDELT from direct endpoint to proper relay channel with WebSocket support

**Files:**
- Modify: `src/config/channel-registry.ts`
- Modify: `src/services/gdelt-intel.ts`
- Generate: `services/gateway/channel-keys.json` (via script)
- Verify: `services/shared/channels/gdelt.cjs` exists

**Step 1.1: Add GDELT channel to channel-registry.ts**

Add after the `ais` channel (around line 246):

```typescript
gdelt: {
  key: 'gdelt',
  redisKey: 'relay:gdelt:v1',
  panels: ['gdelt-intel'],
  domain: 'intelligence',
  staleAfterMs: 15 * 60_000,
  timeoutMs: 30_000,
  required: false,
  applyMethod: 'applyGdelt',
},
```

**Step 1.2: Update gdelt-intel.ts to use relay panel**

In `src/services/gdelt-intel.ts`, replace the `fetchGdeltPanel()` function (lines 138-160):

```typescript
async function fetchGdeltPanel(): Promise<GdeltPanelData | null> {
  if (panelCache.data && Date.now() - panelCache.timestamp < CACHE_TTL) {
    return panelCache.data;
  }
  try {
    // Use relay panel channel instead of direct /gdelt endpoint
    const data = await fetchRelayPanel<GdeltPanelData>('gdelt');
    if (data) {
      panelCache.data = data;
      panelCache.timestamp = Date.now();
    }
    return data;
  } catch (err) {
    console.warn(`[GDELT-Intel] Panel fetch failed: ${err instanceof Error ? err.message : err}`);
    return panelCache.data;
  }
}
```

**Step 1.3: Add GDELT handler to intelligence-handler.ts**

Create `applyGdelt` handler in `src/data/intelligence-handler.ts`:

```typescript
applyGdelt(payload: unknown): void {
  // GDELT payload structure: { timestamp, source, data: { topic1: {...}, topic2: {...} } }
  const data = payload as { data?: Record<string, { articles: GdeltArticle[]; query: string; fetchedAt: string }> };
  if (!data?.data) {
    console.warn('[intelligence-handler] applyGdelt: no data');
    return;
  }
  
  // Cache is already handled by gdelt-intel.ts fetchGdeltPanel
  // This handler enables WebSocket push updates
  console.log('[intelligence-handler] applyGdelt: received update', {
    topicCount: Object.keys(data.data).length,
  });
}
```

**Step 1.4: Register applyGdelt in DATA_LOADER_CHANNEL_MAP**

The channel-registry already has `applyMethod: 'applyGdelt'`, so this will auto-register when we add the channel.

**Step 1.5: Regenerate channel keys**

```bash
npm run generate:channel-keys
```

**Step 1.6: Verify orchestrator schedules GDELT worker**

Check `services/orchestrator/config.cjs` to ensure GDELT worker is scheduled.

---

## Task 2: Verify Strategic Risk Channel Configuration

**Goal:** Ensure `strategic-risk` channel is properly configured and worker is publishing

**Files:**
- Verify: `src/config/channel-registry.ts` (line 329-337)
- Check: `services/shared/channels/` for strategic-risk worker
- Test: Redis key `risk:scores:sebuf:v1` has data

**Step 2.1: Verify channel registry entry exists**

Confirm `strategic-risk` channel exists in `channel-registry.ts`:

```typescript
'strategic-risk': {
  key: 'strategic-risk',
  redisKey: 'risk:scores:sebuf:v1',
  panels: ['strategic-risk', 'cii'],
  domain: 'intelligence',
  staleAfterMs: 15 * 60_000,
  timeoutMs: 30_000,
  required: true,
},
```

**Step 2.2: Check if worker exists**

```bash
ls -la services/shared/channels/ | grep -i risk
```

**Step 2.3: Check Redis for data**

```bash
cd services && docker-compose exec -T redis redis-cli GET "risk:scores:sebuf:v1"
```

**Step 2.4: Check orchestrator scheduling**

```bash
cd services && grep -r "strategic-risk\|risk:scores" orchestrator/
```

**Step 2.5: If worker missing, create placeholder**

If no worker exists, the panel will need to use fallback data or we need to implement the worker.

---

## Task 3: Verify Strategic Posture Channel Configuration

**Goal:** Ensure `strategic-posture` channel is properly configured and worker is publishing

**Files:**
- Verify: `src/config/channel-registry.ts` (line 320-328)
- Check: `services/shared/channels/` for theater-posture worker
- Test: Redis key `theater-posture:sebuf:v1` has data

**Step 3.1: Verify channel registry entry exists**

Confirm `strategic-posture` channel exists in `channel-registry.ts`:

```typescript
'strategic-posture': {
  key: 'strategic-posture',
  redisKey: 'theater-posture:sebuf:v1',
  panels: ['strategic-posture'],
  domain: 'intelligence',
  staleAfterMs: 15 * 60_000,
  timeoutMs: 30_000,
  required: true,
},
```

**Step 3.2: Check if worker exists**

```bash
ls -la services/shared/channels/ | grep -i posture
```

**Step 3.3: Check Redis for data**

```bash
cd services && docker-compose exec -T redis redis-cli GET "theater-posture:sebuf:v1"
```

**Step 3.4: Check orchestrator scheduling**

```bash
cd services && grep -r "strategic-posture\|theater-posture" orchestrator/
```

---

## Task 4: Verify AI Insights Channel Configuration

**Goal:** Ensure `ai:panel-summary` channel is properly configured and AI engine is publishing

**Files:**
- Verify: `src/config/channel-registry.ts` (line 413-420)
- Check: AI engine publishing to `ai:panel-summary:v1`
- Test: Redis key has data

**Step 4.1: Verify channel registry entry exists**

Confirm `ai:panel-summary` channel exists in `channel-registry.ts`:

```typescript
'ai:panel-summary': {
  key: 'ai:panel-summary',
  redisKey: 'ai:panel-summary:v1',
  panels: ['insights'],
  domain: 'ai',
  staleAfterMs: 15 * 60_000,
  timeoutMs: 30_000,
  required: false,
},
```

**Step 4.2: Check Redis for data**

```bash
cd services && docker-compose exec -T redis redis-cli GET "ai:panel-summary:v1"
```

**Step 4.3: Check AI engine logs**

```bash
cd services && docker-compose logs ai-engine 2>&1 | grep -i "panel-summary" | tail -20
```

**Step 4.4: Verify AI engine is running and configured**

```bash
cd services && docker-compose ps ai-engine
cd services && docker-compose exec ai-engine env | grep -E "(OPENAI|ANTHROPIC|AI_)"
```

---

## Task 5: Verify Intelligence/Intel Feed Channel

**Goal:** Fix "All Intel sources disabled" error in Intel Feed panel

**Files:**
- Check: `src/config/channel-registry.ts` (line 248-257)
- Verify: `intelligence` channel is subscribed
- Check: Panel is receiving `intelligence` channel data

**Step 5.1: Verify channel registry entry**

Confirm `intelligence` channel exists:

```typescript
intelligence: {
  key: 'intelligence',
  redisKey: 'ai:digest:global:v1',
  panels: ['intel', 'gdelt-intel', 'global-digest'],
  domain: 'intelligence',
  staleAfterMs: 15 * 60_000,
  timeoutMs: 30_000,
  required: true,
  applyMethod: 'applyIntelligence',
},
```

**Step 5.2: Check Redis for data**

```bash
cd services && docker-compose exec -T redis redis-cli GET "ai:digest:global:v1"
```

**Step 5.3: Check frontend panel configuration**

Verify the Intel Feed panel is configured to receive the `intelligence` channel in `src/app/panel-layout.ts`.

**Step 5.4: Investigate "All Intel sources disabled" message**

Check `src/components/IntelPanel.ts` or equivalent to understand what this error means and what data it's expecting.

---

## Task 6: Fix World News Panel Data Flow

**Goal:** Ensure World News panel receives RSS feed data or appropriate channel data

**Files:**
- Check: `src/config/panels.ts` - verify `politics` panel configuration
- Check: Panel implementation for data source
- Verify: RSS feeds or news channels are configured

**Step 6.1: Check panel configuration**

Verify `politics` panel in `panels.ts`:

```typescript
politics: { name: 'World News', enabled: true, priority: 1 },
```

**Step 6.2: Identify data source**

Check if `politics` panel uses:
- RSS feeds (check `src/services/rss-feeds.ts` or similar)
- A relay channel (check if `panels: ['politics']` in any channel)
- News aggregator service

**Step 6.3: Verify data source is working**

Based on Step 6.2 findings, verify the appropriate data source is functioning.

---

## Task 7: Verify All Channels Are Subscribed

**Goal:** Ensure frontend is subscribing to all required channels via WebSocket

**Files:**
- Check: `src/app/App.ts` or main app initialization
- Verify: All panel channels are included in WebSocket subscription list
- Test: WebSocket connection includes all channels

**Step 7.1: Check WebSocket subscription initialization**

Find where `initRelayPush(channels)` is called and verify it includes all required channels:

```typescript
// Should include: markets, predictions, fred, oil, bis, flights, weather,
// natural, eonet, gdacs, gps-interference, cables, cyber, climate, conflict,
// ucdp-events, telegram, oref, ais, intelligence, trade, supply-chain, gdelt,
// strategic-posture, strategic-risk, ai:panel-summary, etc.
```

**Step 7.2: Verify channel subscription logic**

Check that the app derives channels from enabled panels:

```typescript
// Get all channels from enabled panels
const channels = Object.values(DEFAULT_PANELS)
  .filter(p => p.enabled && p.channels)
  .flatMap(p => p.channels || []);
```

**Step 7.3: Add missing channels**

If channels are hardcoded, ensure all required channels are included.

**Step 7.4: Test WebSocket subscription message**

Open browser dev tools and verify the WebSocket connection sends a subscription message like:

```json
{"type":"wm-subscribe","channels":["markets","predictions","gdelt",...]}
```

---

## Task 8: Verify Orchestrator Scheduling

**Goal:** Ensure orchestrator is scheduling all required workers

**Files:**
- Check: `services/orchestrator/config.cjs`
- Verify: All channels have corresponding worker schedules
- Check: Workers are executing and publishing to Redis

**Step 8.1: List all scheduled jobs**

```bash
cd services && grep -E "^\s*\(" orchestrator/config.cjs | grep -v "^//"
```

**Step 8.2: Verify required channels are scheduled**

Ensure these channels have scheduled workers:
- `gdelt` → `relay:gdelt:v1`
- `strategic-risk` → `risk:scores:sebuf:v1`
- `strategic-posture` → `theater-posture:sebuf:v1`
- `ai:panel-summary` → `ai:panel-summary:v1`
- `intelligence` → `ai:digest:global:v1`

**Step 8.3: Check orchestrator logs for errors**

```bash
cd services && docker-compose logs orchestrator 2>&1 | grep -iE "(error|failed|exception)" | tail -30
```

**Step 8.4: Add missing worker schedules**

If any workers are missing from the orchestrator config, add them with appropriate cron schedules.

---

## Task 9: Test End-to-End Data Flow

**Goal:** Verify data flows from worker → Redis → Gateway → WebSocket → Frontend

**Files:**
- Test: Each channel independently
- Verify: Data appears in panels

**Step 9.1: Monitor Redis keys**

```bash
cd services && docker-compose exec -T redis redis-cli KEYS "relay:*" "ai:*" "risk:*" "theater-posture:*"
```

**Step 9.2: Monitor WebSocket messages**

Open browser dev tools and watch WebSocket frames for `wm-push` messages.

**Step 9.3: Check gateway broadcast logs**

```bash
cd services && docker-compose logs gateway 2>&1 | grep -i "broadcast" | tail -20
```

**Step 9.4: Verify data freshness**

Check `dataFreshness.recordUpdate()` calls are happening for each channel.

**Step 9.5: Test manual Redis publish**

Manually publish to a channel to test the entire pipeline:

```bash
cd services && docker-compose exec -T redis redis-cli SET "relay:gdelt:v1" '{"timestamp":"2026-03-09T12:00:00Z","source":"test","data":{"military":{"articles":[],"query":"test","fetchedAt":"2026-03-09T12:00:00Z"}}}'
```

Then verify the gateway broadcasts it and the frontend receives it.

---

## Task 10: Fix Missing Workers (If Needed)

**Goal:** Implement or stub missing workers for channels without data

**Files:**
- Create: Missing worker files in `services/shared/channels/`
- Update: `services/orchestrator/config.cjs`

**Step 10.1: Identify missing workers**

Based on Task 2, 3, 4, 5 findings, list workers that don't exist but are needed.

**Step 10.2: Create stub workers**

For each missing worker, create a minimal implementation that returns placeholder data:

```javascript
// services/shared/channels/strategic-risk.cjs
module.exports = async function fetchStrategicRisk({ redis, log }) {
  log.debug('fetchStrategicRisk executing (stub)');
  return {
    timestamp: new Date().toISOString(),
    source: 'strategic-risk',
    data: {
      // Stub data structure
      globalRisk: 'moderate',
      regions: [],
    },
    status: 'success',
  };
};
```

**Step 10.3: Add to orchestrator schedule**

Add the worker to `services/orchestrator/config.cjs`:

```javascript
('strategic-risk', '*/15 * * * *', 'risk:scores:sebuf:v1', 900, 'Strategic risk scores'),
```

**Step 10.4: Restart orchestrator**

```bash
cd services && docker-compose restart orchestrator
```

---

## Task 11: Validate All Fixes

**Goal:** Comprehensive end-to-end validation

**Files:**
- Test: All panels receive data
- Verify: No 404 errors in browser console
- Confirm: WebSocket messages are flowing

**Step 11.1: Clear browser cache and reload**

Full page reload to ensure all changes take effect.

**Step 11.2: Check browser console for errors**

Verify no 404 errors for `/panel/*` or `/gdelt` endpoints.

**Step 11.3: Verify all panels show data or "No data" (not "Loading...")**

Panels should either:
- Show data successfully
- Show "No data" if worker returned empty results
- NOT show "Loading..." indefinitely

**Step 11.4: Monitor WebSocket message rate**

Verify multiple `wm-push` messages are received per minute (not just vessels).

**Step 11.5: Check data freshness indicators**

Verify panels show recent timestamps (last updated times).

---

## Success Criteria

✅ No 404 errors in browser console  
✅ GDELT panel shows articles or "No recent articles" (not loading forever)  
✅ Strategic Risk panel shows data or "No data available" (not "Insufficient Data")  
✅ AI Insights panel shows summary or "Generating..." (not stuck loading)  
✅ Strategic Posture panel shows posture data or "No posture data" (not "Acquiring Data")  
✅ Intel Feed panel shows items or "No intel available" (not "All Intel sources disabled")  
✅ World News panel shows articles  
✅ WebSocket receives `wm-push` messages for multiple channels  
✅ All enabled panels transition out of loading state within 30 seconds  

---

## Rollback Plan

If issues occur:

1. **Revert GDELT changes**: 
   ```bash
   git restore src/config/channel-registry.ts src/services/gdelt-intel.ts
   npm run generate:channel-keys
   ```

2. **Restart services**:
   ```bash
   cd services && docker-compose restart gateway orchestrator
   ```

3. **Clear Redis** (if data corruption):
   ```bash
   cd services && docker-compose exec -T redis redis-cli FLUSHALL
   ```

---

## Notes

- All channels must be in `channel-registry.ts` to be accessible via WebSocket and HTTP
- Gateway auto-loads channels from `channel-keys.json` which is generated from `channel-registry.ts`
- Workers publish to Redis with keys defined in channel registry
- Frontend subscribes to channels based on enabled panels
- Panels can have multiple channels (e.g., `commodities` uses 5 channels)
