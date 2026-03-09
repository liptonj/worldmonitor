# Ollama Authentication Migration: CF Access → Bearer Token

## Summary

Migrated Ollama LiteLLM proxy authentication from Cloudflare Access Service Tokens to standard Bearer token authentication.

## Changes Made

### 1. Environment Configuration

#### Updated Files:
- `services/.env.production`
- `.env`
- `services/.env.example`

#### Changes:
- **Removed**: `OLLAMA_CF_ACCESS_CLIENT_ID` and `OLLAMA_CF_ACCESS_CLIENT_SECRET`
- **Added**: `OLLAMA_BEARER_TOKEN=sk-lm-YjxQWaQb:KPwD5m6UN7uCJnmJ30Ed`
- **Updated**: `OLLAMA_MODEL=qwen/qwen3.5-9b` (was `qwen3:8b`)
- **Server URL**: Unchanged at `https://ollama.5ls.us/v1/`

### 2. Database Migration

#### New Migration:
`supabase/migrations/20260309200000_update_ollama_bearer_auth.sql`

#### Changes:
- Updated `public.get_ollama_credentials()` function
- **Removed columns**: `cf_access_client_id`, `cf_access_client_secret`
- **Added column**: `bearer_token`
- Function now fetches `OLLAMA_BEARER_TOKEN` from vault instead of CF Access credentials
- Updated default model to `qwen/qwen3.5-9b`

### 3. Server-Side Code Updates

#### File: `server/_shared/llm.ts`

**Changes**:
- Updated `OllamaCredentials` interface to use `bearer_token` instead of CF Access fields
- Removed `extraHeaders` logic for CF Access headers
- `resolveOllamaProvider()` now sets `apiKey` to the bearer token directly
- Updated comment: "Ollama authenticates via Bearer token" (was "CF Access headers")

#### File: `server/worldmonitor/news/v1/_shared.ts`

**Changes in `getProviderCredentials()`**:
- Replaced `cfId` and `cfSecret` variables with `bearerToken`
- Updated RPC call return type to expect `bearer_token` instead of CF Access fields
- Removed CF Access header logic
- Now sets `Authorization: Bearer ${bearerToken}` header
- Maintains backward compatibility with `OLLAMA_API_KEY` as fallback
- Updated default model to `qwen/qwen3.5-9b`
- Updated qwen3 detection to use `.includes('qwen3')` instead of `.startsWith('qwen3')`

### 4. AI Engine Generator Files

All 8 generator files updated with identical pattern:

- `services/ai-engine/generators/article-summaries.cjs`
- `services/ai-engine/generators/classifications.cjs`
- `services/ai-engine/generators/country-briefs.cjs`
- `services/ai-engine/generators/instability-analysis.cjs`
- `services/ai-engine/generators/posture-analysis.cjs`
- `services/ai-engine/generators/risk-overview.cjs`
- `services/ai-engine/generators/panel-summary.cjs`
- `services/ai-engine/generators/intel-digest.cjs`

#### Changes in `fetchLLMProvider()`:
- Removed `cfAccessClientId` and `cfAccessClientSecret` variables
- Replaced with `bearerToken` variable
- Changed from parallel RPC calls for CF Access creds to single call for bearer token
- Updated return object to include `bearer_token` instead of CF Access fields
- Updated comment: "Ollama behind LiteLLM proxy" (was "Cloudflare Access")

#### Changes in `callLLM()`:
- Removed `cf_access_client_id` and `cf_access_client_secret` from destructuring
- Added `bearer_token` to destructuring
- Removed CF Access header logic
- Now prioritizes `bearer_token` over `api_key` for Authorization header
- Simplified to single Bearer token authentication method

## Authentication Flow

### Before (CF Access):
```
Client → CF Access Headers → Cloudflare Tunnel → Ollama
  (CF-Access-Client-Id + CF-Access-Client-Secret)
```

### After (Bearer Token):
```
Client → Bearer Token → LiteLLM Proxy → Ollama
  (Authorization: Bearer sk-lm-YjxQWaQb:KPwD5m6UN7uCJnmJ30Ed)
```

## Deployment Steps

1. **Run Migration**: Apply the new Supabase migration
   ```bash
   supabase db push
   ```

2. **Update Vault Secrets**: In Supabase vault, add:
   - `OLLAMA_BEARER_TOKEN` = `sk-lm-YjxQWaQb:KPwD5m6UN7uCJnmJ30Ed`
   - `OLLAMA_API_URL` = `https://ollama.5ls.us/v1/`
   - `OLLAMA_MODEL` = `qwen/qwen3.5-9b`

3. **Update Environment Files**: Deploy updated `.env` files to production servers

4. **Restart Services**: Restart all services that use Ollama:
   - Gateway service
   - AI Engine service
   - Vercel edge functions

## Testing

Verify authentication works by testing:
1. Article summarization endpoint
2. AI engine generators
3. Panel hydration with AI summaries

## Security Notes

- Bearer token is stored in Supabase vault (encrypted at rest)
- Token is fetched via `get_ollama_credentials()` RPC (SECURITY DEFINER)
- Token is never exposed to client-side code
- Environment variable fallback maintained for local development

## Backward Compatibility

- Fallback to `OLLAMA_API_KEY` secret if `OLLAMA_BEARER_TOKEN` not found
- Environment variable fallback for local dev
- Old CF Access credentials can be removed from vault after successful migration

## Model Update

Changed default Ollama model from `qwen3:8b` to `qwen/qwen3.5-9b` to match LiteLLM proxy model naming conventions.
