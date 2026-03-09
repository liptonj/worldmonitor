# Deploying Cloudflare Access Credentials

## Problem
The AI engine is getting HTTP 403 errors when trying to call the Ollama endpoint at `https://ollama.5ls.us/v1` because it's missing Cloudflare Access authentication credentials.

## Solution
The Cloudflare Access credentials are stored in **Supabase Vault** and need to be retrieved by the AI engine at runtime.

## Credentials Location

### Supabase Vault (Primary Source)
The credentials are stored in Supabase Vault:
- `OLLAMA_CF_ACCESS_CLIENT_ID`: `5526ac644e153997663dc54ac71b33c6.access`
- `OLLAMA_CF_ACCESS_CLIENT_SECRET`: `ec8f5ed17b3a10abc11d3c929ae3329cb6eea1c1be2597153f4b4c617c459e75`

### Verification
To verify the credentials are in the Vault:
```sql
SELECT name, description, created_at, updated_at 
FROM vault.secrets 
WHERE name IN ('OLLAMA_CF_ACCESS_CLIENT_ID', 'OLLAMA_CF_ACCESS_CLIENT_SECRET');
```

## Deployment Steps

### On Production Server

1. **Update the `.env.production` file** (if needed for fallback):
   ```bash
   cd ~/worldmon/services
   
   # Add these lines to .env.production if not already present:
   cat >> .env.production << 'EOF'
   # Cloudflare Access credentials for Ollama endpoint
   OLLAMA_CF_ACCESS_CLIENT_ID=5526ac644e153997663dc54ac71b33c6.access
   OLLAMA_CF_ACCESS_CLIENT_SECRET=ec8f5ed17b3a10abc11d3c929ae3329cb6eea1c1be2597153f4b4c617c459e75
   EOF
   ```

2. **Rebuild and restart the AI engine**:
   ```bash
   cd ~/worldmon/services
   docker-compose build ai-engine
   docker-compose restart ai-engine
   ```

3. **Verify the fix**:
   ```bash
   # Check AI engine logs - should no longer see 403 errors
   docker-compose logs -f ai-engine
   
   # You should see successful LLM API calls instead of:
   # "HTTP 403: <!DOCTYPE html>...Error ・ Cloudflare Access"
   ```

4. **Manually trigger AI workers** (optional, to test immediately):
   ```bash
   docker-compose exec orchestrator curl -X POST http://orchestrator:3000/trigger/ai:panel-summary
   docker-compose exec orchestrator curl -X POST http://orchestrator:3000/trigger/ai:intel-digest
   ```

## How It Works

1. **AI Engine Startup**: The AI engine reads `OLLAMA_CF_ACCESS_CLIENT_ID` and `OLLAMA_CF_ACCESS_CLIENT_SECRET` from:
   - Supabase Vault (via `get_vault_secret_value` RPC) - Primary method
   - Environment variables (fallback)

2. **LLM API Calls**: When calling the Ollama endpoint, the AI engine includes these headers:
   ```javascript
   headers['CF-Access-Client-Id'] = '5526ac644e153997663dc54ac71b33c6.access';
   headers['CF-Access-Client-Secret'] = 'ec8f5ed17b3a10abc11d3c929ae3329cb6eea1c1be2597153f4b4c617c459e75';
   ```

3. **Cloudflare Access**: The Cloudflare Access service at `ollama.5ls.us` validates these credentials and allows the request through.

## Troubleshooting

### Still getting 403 errors after deployment?

1. **Check credentials in Vault**:
   ```sql
   SELECT decrypted_secret 
   FROM vault.decrypted_secrets 
   WHERE name IN ('OLLAMA_CF_ACCESS_CLIENT_ID', 'OLLAMA_CF_ACCESS_CLIENT_SECRET');
   ```

2. **Verify AI engine can access Vault**:
   - Check that `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set in `.env.production`
   - Check AI engine logs for Vault access errors

3. **Verify Cloudflare Access token is still valid**:
   - Test the endpoint manually:
     ```bash
     curl -X POST https://ollama.5ls.us/v1/chat/completions \
       -H "Content-Type: application/json" \
       -H "CF-Access-Client-Id: 5526ac644e153997663dc54ac71b33c6.access" \
       -H "CF-Access-Client-Secret: ec8f5ed17b3a10abc11d3c929ae3329cb6eea1c1be2597153f4b4c617c459e75" \
       -d '{"model":"qwen3-wm","messages":[{"role":"user","content":"test"}]}'
     ```
   - If this returns 403, the service token may have been revoked or expired

4. **Regenerate service token** (if expired):
   - Go to Cloudflare Dashboard → Access → Service Auth → Service Tokens
   - Regenerate the token for `ollama.5ls.us`
   - Update the credentials in Supabase Vault
   - Restart the AI engine

## Related Files
- **AI Engine Code**: `services/ai-engine/generators/*.cjs` (all 8 generators)
- **Migration**: `supabase/migrations/20260303000004_seed_ollama_config.sql`
- **Documentation**: `docs/AI_ENGINE_OLLAMA_FIX.md`
