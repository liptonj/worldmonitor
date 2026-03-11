# Agent Memory

## Learned User Preferences

- Use MCP server to apply all Supabase migrations and configuration changes
- Use MCP server to read from Supabase Vault for credentials
- Use Supabase as primary data source, with .env as fallback only
- Fetch prompts and configuration from Supabase database, not hardcoded
- All data should flow through WebSocket relay system, no fallback browser loading
- No fallback mechanisms—everything must work via the relay
- Always verify builds pass TypeScript checks, linting, and tests before committing
- Commit and push to GitHub after completing changes
- Connect to Redis server at 10.230.255.80 to verify data population
- Fix all issues found during testing—baseline test failures are acceptable for triage but all must pass at completion
- Panel channel naming must match backend channel keys exactly
- Rotate credentials immediately if found in git (even if in .gitignore)
- Strategic Posture and OpenSky channels use direct OAuth2 to OpenSky API (no relay proxy; credentials from Supabase Vault via secrets.cjs)
- Fix broken code instead of removing it; do not delete panels on suspicion that data is missing
- Write separate frontend and backend plans; be specific on naming, grouping, and filters so they match
- Avoid stubs, todos, and helper-of-helper patterns in plans and code
- Run code-reviewer and deslop before claiming completion
- Use workers for server-side prefiltering; avoid relying on the client
- Telegram AI: process each channel sequentially, then cross-channel synthesis pass
- On the production server, the env file is `.env` (not `.env.production`)

## Learned Workspace Facts

- Tech stack: TypeScript frontend, Docker containers (worldmon-* naming), Redis relay cache, Supabase backend, WebSocket data relay
- Redis uses relay:channel:v1 key pattern for cached data
- Frontend panels subscribe to channels via channelKeys property
- Panels receive data via applyRelayData() or applyPush() methods
- CHANNEL_REGISTRY maps channel names to target panels and apply methods
- Channel state management uses setChannelState() to transition between loading/ready/error states
- Panel base class has 30-second loading timeout that must be cleared via clearLoadingTimeout() when data arrives
- Panel content elements use ID pattern: ${panelId}Content
- AI engine uses LLM prompts stored in Supabase
- Telegram polling service populates Redis with data
- All 35+ backend channels should be available via WebSocket relay
- Docker logs available for debugging: docker logs worldmon-gateway-1, worldmon-worker-1, etc.
- Server accessible via SSH at 10.230.255.80 (username: ubuntu)
- Strategic Posture panel depends on OpenSky Network API for military aircraft tracking
- Check Redis data without redis-cli using scripts/check-redis-data-nc.sh (uses netcat)
- Redis key for Strategic Posture: theater-posture:sebuf:v1
- Supabase project ID: fmultmlsevqgtnqzaylg; schema: wm_admin
- Server layout: /home/ubuntu/worldmon — flat structure (docker-compose, .env, relay.sh in root)
- Gateway IS the relay server; workers fetch from external APIs directly, store in Redis, gRPC broadcast to gateway, gateway pushes to WebSocket clients
- Data flow: Worker → Redis (relay:channel:v1) → Gateway → WebSocket → Frontend panels
- Most channels fetch from external APIs; config-news-sources, config-feature-flags, and markets query Supabase directly
- scripts/ais-relay.cjs is DEPRECATED — do NOT modify or reference it; all logic has been ported to services/
- .env.production is in .gitignore; credentials are not committed
