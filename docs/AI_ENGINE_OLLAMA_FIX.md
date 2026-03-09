# AI Engine Ollama Cloudflare Access Fix

## Problem

The AI engine was failing with the error:
```
{"level":"error","timestamp":"2026-03-09T16:20:01.384Z","service":"ai-engine","message":"generateIntelDigest error","error":"Could not resolve API key for provider ollama"}
```

## Root Cause

1. The Ollama endpoint (`https://ollama.5ls.us/v1`) is protected by **Cloudflare Access**, not a traditional API key
2. The AI engine generators were configured to require an API key (`OLLAMA_API_KEY`) but:
   - This secret didn't exist in the Vault
   - Ollama doesn't need a traditional API key - it needs Cloudflare Access service token headers instead

## Solution

### 1. Database Migration (`20260309000001_fix_ollama_api_key.sql`)

- Set `api_key_secret_name` to `NULL` for the Ollama provider (since it doesn't use API keys)
- Created `OLLAMA_API_KEY` vault secret with a placeholder value (`'not-required'`) for backward compatibility

### 2. AI Engine Code Updates

Updated all 8 AI generator files to:

**A. Fetch Cloudflare Access credentials from Vault:**
- `OLLAMA_CF_ACCESS_CLIENT_ID`
- `OLLAMA_CF_ACCESS_CLIENT_SECRET`

**B. Pass Cloudflare Access headers when calling the Ollama endpoint:**
```javascript
headers['CF-Access-Client-Id'] = cf_access_client_id;
headers['CF-Access-Client-Secret'] = cf_access_client_secret;
```

**C. Make API keys optional:**
- Only add `Authorization: Bearer ${api_key}` header if an API key is present
- Ollama works without this header (relies on CF Access headers instead)

### Files Modified

#### AI Engine Generators (all updated with CF Access support):
1. `services/ai-engine/generators/intel-digest.cjs`
2. `services/ai-engine/generators/panel-summary.cjs`
3. `services/ai-engine/generators/article-summaries.cjs`
4. `services/ai-engine/generators/classifications.cjs`
5. `services/ai-engine/generators/country-briefs.cjs`
6. `services/ai-engine/generators/instability-analysis.cjs`
7. `services/ai-engine/generators/posture-analysis.cjs`
8. `services/ai-engine/generators/risk-overview.cjs`

#### Database Migration:
- `supabase/migrations/20260309000001_fix_ollama_api_key.sql`

## How It Works Now

1. **LLM Provider Selection:**
   - AI engine calls `get_active_llm_provider()` RPC
   - Returns Ollama configuration from `wm_admin.llm_providers`

2. **Credential Fetching:**
   - If provider is `'ollama'`, fetch CF Access credentials from Vault:
     - `OLLAMA_CF_ACCESS_CLIENT_ID`
     - `OLLAMA_CF_ACCESS_CLIENT_SECRET`
   - If provider requires an API key (e.g., Groq, OpenRouter), fetch that secret

3. **LLM API Call:**
   - Build headers dynamically:
     - Always include `Content-Type: application/json`
     - If CF Access credentials exist, add `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers
     - If API key exists, add `Authorization: Bearer ${api_key}` header
   - Call the LLM endpoint with the appropriate headers

## Deployment Steps

1. **Apply the migration:**
   ```bash
   # On production server
   cd ~/worldmon
   git pull origin main
   supabase db push
   ```

2. **Rebuild and restart the AI engine:**
   ```bash
   cd services
   docker-compose build ai-engine
   docker-compose restart ai-engine
   ```

3. **Verify the fix:**
   - Check AI engine logs for successful LLM calls
   - Verify no more "Could not resolve API key" errors
   - Confirm AI-generated content appears in panels (AI Insights, Intel Feed, etc.)

## Future Considerations

- If switching to a different LLM provider (Groq, OpenRouter), ensure the API key is properly configured in Vault
- If adding new AI generators, use the pattern from the existing generators (fetch provider, handle CF Access + API keys)
- The CF Access credentials are currently stored in Vault - if they need to be rotated, update them via the admin portal Secrets page

## Related Issues

- AI panels were showing "Loading..." indefinitely because the AI engine was failing to generate content
- This fix resolves all AI-related data flow issues identified in the comprehensive panel data flow audit
