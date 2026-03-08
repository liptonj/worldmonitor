# Frontend Polling Audit

> Audit of `src/app/data-loader.ts` for the frontend relay migration plan.
> **Status:** Migration already completed. No `scheduleRefresh` or `registerDeferred` calls exist.

## Search Results

```bash
grep -n "scheduleRefresh\|registerDeferred" src/app/data-loader.ts
# No matches found
```

**Finding:** The `RefreshScheduler` is deprecated (`src/app/refresh-scheduler.ts`) and is not instantiated or used. All relay channels now use WebSocket push via `initRelayPush` + `subscribeRelayPush` in `App.ts`, with `loadChannelWithFallback` for initial/on-demand load.

---

## Relay Channels (already migrated to WebSocket push)

These channels use `loadChannelWithFallback()` in data-loader.ts and receive real-time updates via WebSocket in `App.ts`:

| Channel | Load Method | Line(s) | Data Flow |
|---------|-------------|---------|-----------|
| **eonet** | `loadChannelWithFallback('eonet', ...)` | 761 | bootstrap → /panel/eonet → WebSocket push |
| **gdacs** | `loadChannelWithFallback('gdacs', ...)` | 762 | bootstrap → /panel/gdacs → WebSocket push |
| **tech-events** | `loadChannelWithFallback('tech-events', ...)` | 794 | bootstrap → /panel/tech-events → WebSocket push |
| **weather** | `loadChannelWithFallback('weather', ...)` | 821 | bootstrap → /panel/weather → WebSocket push |
| **conflict** | `loadChannelWithFallback('conflict', ...)` | 852, 1267 | bootstrap → /panel/conflict → WebSocket push |
| **oref** | `loadChannelWithFallback('oref', ...)` | 1022 | bootstrap → /panel/oref → WebSocket push |
| **cyber** | `loadChannelWithFallback('cyber', ...)` | 1125 | bootstrap → /panel/cyber → WebSocket push |
| **iran-events** | `loadChannelWithFallback('iran-events', ...)` | 1141 | bootstrap → /panel/iran-events → WebSocket push |
| **ais** | `loadChannelWithFallback('ais', ...)` | 1182 | bootstrap → /panel/ais → WebSocket push |
| **cables** | `loadChannelWithFallback('cables', ...)` | 1241 | bootstrap → /panel/cables → WebSocket push |
| **flights** | `loadChannelWithFallback('flights', ...)` | 1294 | bootstrap → /panel/flights → WebSocket push |
| **natural** | `loadChannelWithFallback('natural', ...)` | 1572 | bootstrap → /panel/natural → WebSocket push |

Additional relay channels subscribed in `App.ts` (initial data from bootstrap, updates via WebSocket):

- markets, predictions, fred, oil, bis, intelligence, pizzint, trade, supply-chain, climate, ucdp-events, telegram, spending, giving, gulf-quotes, gps-interference, strategic-posture, strategic-risk, stablecoins, etf-flows, macro-signals, service-status, config:news-sources, config:feature-flags, ai:* channels

---

## Non-Relay (keep direct API / fallback)

These sources use direct API calls or worker computations, not relay proxy. Used when `loadChannelWithFallback` returns false or for data not proxied by relay:

| Source | Method | Line(s) | Reason |
|--------|--------|---------|--------|
| **USGS Earthquakes** | `fetchEarthquakes()` | 760 | Direct USGS API; relay `natural` merges EONET+GDACS |
| **Internet Outages** | `fetchInternetOutages()` | 834, 1087 | NetBlocks API |
| **Cable Activity** | `fetchCableActivity()` | 1223 | CableOps API (activity vs health; cables channel = health) |
| **UCDP Classifications** | `fetchUcdpClassifications()` | 862 | UCDP API |
| **HAPI Summaries** | `fetchAllHapiSummaries()` | 873 | HAPI API |
| **Military Flights** | `fetchMilitaryFlights()` | 888, 1327 | OpenSky API |
| **Military Vessels** | `fetchMilitaryVessels()` | 889, 1328 | AIS/vessel API |
| **USNI Fleet Report** | `fetchUSNIFleetReport()` | 897, 1336 | USNI API |
| **UCDP Events** | `fetchUcdpEvents()` | 949, 952 | UCDP API |
| **UNHCR Population** | `fetchUnhcrPopulation()` | 975 | UNHCR API |
| **Climate Anomalies** | `fetchClimateAnomalies()` | 995 | Climate API |
| **GPS Interference** | `fetchGpsInterference()` | 1031 | GPS API (fallback when relay unavailable) |
| **Cyber Threats** | `fetchCyberThreats()` | 1127 | Fallback when relay cyber channel unavailable |
| **Theater Posture** | `fetchCachedTheaterPosture()` | 1397 | Cached computation |
| **Giving Summary** | `fetchGivingSummary()` | 1626 | Giving API |
| **GDELT Topics** | `fetchAllPositiveTopicIntelligence()` | 1706 | GDELT API |
| **Positive Geo Events** | `fetchPositiveGeoEvents()` | 1753 | Geo API |
| **Kindness Data** | `fetchKindnessData()` | 1770 | Kindness API |
| **Security Advisories** | `fetchSecurityAdvisories()` | 1781 | RSS/Advisory API |
| **Telegram Feed** | `fetchTelegramFeed()` | 1794 | Telegram API (fallback) |
| **Tech Events** | `fetchTechEvents()` | 797 | Fallback when relay tech-events unavailable |

**Other non-relay patterns:**

- **Supabase realtime:** Not used in data-loader; handled elsewhere
- **Local worker computations:** `analysisWorker`, `mlWorker`, `signalAggregator`, `updateAndCheck`, `clusterNewsHybrid`, etc.
- **News feeds:** `fetchCategoryFeeds`, `fetchNewsDigest` — category feeds and digest from config/Vercel

---

## Summary

| Metric | Count |
|--------|-------|
| **scheduleRefresh calls** | 0 |
| **registerDeferred calls** | 0 |
| **Relay channels (loadChannelWithFallback)** | 12 unique channels in data-loader |
| **Relay channels (App.ts subscribe)** | 40+ channels total |
| **Non-relay direct API calls** | 20+ sources |

## Conclusion

The frontend relay migration is **complete** for polling. There are no `scheduleRefresh` or `registerDeferred` registrations in `data-loader.ts`. All relay-backed channels use:

1. **Bootstrap** for initial hydration
2. **loadChannelWithFallback** for on-demand load when user switches map layers
3. **WebSocket push** (`subscribeRelayPush` in App.ts) for real-time updates

Non-relay sources correctly use direct API calls as fallback or for data not proxied by the relay.
