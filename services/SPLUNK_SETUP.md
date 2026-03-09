# Splunk Docker Logging Configuration Guide

## Prerequisites
- Splunk Enterprise or Splunk Cloud instance running
- Access to Splunk Web UI (default: http://your-splunk-host:8000)
- Admin credentials for Splunk

## Step 1: Enable HTTP Event Collector (HEC) in Splunk

### Via Splunk Web UI:

1. **Login to Splunk Web** (http://your-splunk-host:8000)

2. **Navigate to Settings → Data Inputs**

3. **Click "HTTP Event Collector"**

4. **Click "Global Settings"** button
   - Enable: **Yes** (toggle to enabled)
   - Default Source Type: `_json`
   - Default Index: `main` (or create custom index below)
   - Enable SSL: **Yes** (recommended)
   - HTTP Port Number: `8088` (default)
   - Click **Save**

5. **Create a new HEC Token**
   - Click **"New Token"** button
   - **Name**: `docker-containers`
   - **Source type**: Select **Structured** → `_json`
   - **Index**: Select `main` or create a custom index (see Step 2)
   - **Advanced Settings** (optional):
     - Enable indexer acknowledgment: No (for better performance)
     - Enable Channel ID: No
   - Click **Review** then **Submit**
   
6. **Copy the Token Value** - you'll need this for the .env file!
   - Example: `12345678-1234-1234-1234-123456789012`

## Step 2: Create Custom Docker Logs Index (Recommended)

### Via Splunk Web UI:

1. **Settings → Indexes → New Index**

2. **Index Name**: `docker_logs`

3. **Index Data Type**: `Events`

4. **Settings**:
   - Max Size: `Auto` (or set specific size like `500GB`)
   - Retention: `30 days` (adjust as needed)
   
5. Click **Save**

6. **Repeat for service-specific indexes** (optional):
   - `gateway_logs`
   - `orchestrator_logs`
   - `worker_logs`
   - `ais_logs`

## Step 3: Configure Environment Variables

Add these to your `/Users/jolipton/Projects/worldmonitor/services/.env` file:

```bash
# Splunk Configuration
SPLUNK_HEC_TOKEN=your-token-here-from-step-1
SPLUNK_URL=https://your-splunk-host:8088
SPLUNK_INDEX=docker_logs
```

**Important**: Replace `your-splunk-host` with:
- `splunk` (if running Splunk as a Docker container in the same network)
- `localhost` or `127.0.0.1` (if Splunk is on the same host)
- Your actual Splunk server IP/hostname

## Step 4: Update Docker Compose Files

Choose **one** of these options:

### Option A: Update Existing docker-compose.yml (Minimal Changes)

Add logging configuration to each service in `docker-compose.yml`:

```yaml
services:
  gateway:
    # ... existing configuration ...
    logging:
      driver: splunk
      options:
        splunk-token: "${SPLUNK_HEC_TOKEN}"
        splunk-url: "${SPLUNK_URL}"
        splunk-insecureskipverify: "true"  # Set to "false" with valid SSL cert
        splunk-format: "json"
        splunk-index: "${SPLUNK_INDEX:-docker_logs}"
        tag: "gateway/{{.ID}}"
        labels: "service"
    labels:
      service: "gateway"
```

Repeat for: `orchestrator`, `worker`, `ais-processor`, `ingest-telegram`, `ai-engine`, `redis`, `watchtower`

### Option B: Use docker-compose.splunk.yml Override (Recommended)

I've created a separate file that you can merge with your existing setup.

## Step 5: Verify HEC Endpoint is Accessible

Test from your Docker host:

```bash
# Test HEC endpoint (should return JSON with server info)
curl -k https://your-splunk-host:8088/services/collector/health

# Expected response:
# {"text":"HEC is healthy","code":200}
```

## Step 6: Deploy with Logging

```bash
cd /Users/jolipton/Projects/worldmonitor/services

# If using Option A (modified docker-compose.yml):
docker compose down
docker compose up -d

# If using Option B (override file):
docker compose -f docker-compose.yml -f docker-compose.splunk.yml up -d
```

## Step 7: Verify Logs in Splunk

1. **Login to Splunk Web**

2. **Go to Search & Reporting App**

3. **Run searches**:

```spl
# All Docker logs
index=docker_logs

# Logs from specific service
index=docker_logs source="gateway*"

# Logs by severity
index=docker_logs log_level=ERROR

# Last 15 minutes
index=docker_logs earliest=-15m

# Count by service
index=docker_logs | stats count by source
```

## Troubleshooting

### Logs Not Appearing in Splunk

1. **Check HEC is enabled**:
   ```bash
   curl -k https://your-splunk-host:8088/services/collector/health
   ```

2. **Check Docker container logs**:
   ```bash
   docker compose logs gateway
   ```
   
   Look for Splunk logging errors.

3. **Check Splunk internal logs**:
   ```spl
   index=_internal source=*splunkd.log* "HEC"
   ```

4. **Verify token in Splunk**:
   - Settings → Data Inputs → HTTP Event Collector
   - Ensure your token is **Enabled**

5. **Check network connectivity**:
   ```bash
   docker exec gateway curl -k https://splunk:8088/services/collector/health
   ```

### "Connection Refused" Errors

- Ensure Splunk HEC port (8088) is accessible from Docker containers
- If using external Splunk, check firewall rules
- Verify `SPLUNK_URL` uses correct protocol (https/http) and port

### SSL Certificate Errors

For production, use valid SSL certificates. For testing:
- Keep `splunk-insecureskipverify: "true"` in Docker logging config
- Or disable SSL in Splunk HEC settings (not recommended for production)

### Performance Issues

If logging causes performance degradation:

1. **Reduce log verbosity**:
   ```bash
   LOG_LEVEL=warning  # Instead of info or debug
   ```

2. **Use asynchronous logging** (default with Splunk driver)

3. **Implement sampling** for high-volume services:
   ```yaml
   logging:
     driver: splunk
     options:
       # ... other options ...
       splunk-gzip: "true"
       splunk-gzip-level: "5"
   ```

## Advanced: Service-Specific Indexes

To route different services to different indexes:

```yaml
gateway:
  logging:
    driver: splunk
    options:
      splunk-token: "${SPLUNK_HEC_TOKEN}"
      splunk-url: "${SPLUNK_URL}"
      splunk-index: "gateway_logs"  # Service-specific index

orchestrator:
  logging:
    driver: splunk
    options:
      splunk-token: "${SPLUNK_HEC_TOKEN}"
      splunk-url: "${SPLUNK_URL}"
      splunk-index: "orchestrator_logs"  # Different index
```

Create these indexes in Splunk first (Step 2).

## Security Best Practices

1. **Use HTTPS** for HEC (enable SSL in Splunk)
2. **Store HEC token securely** (use Docker secrets or env files not in git)
3. **Rotate HEC tokens** periodically
4. **Restrict HEC token permissions** to specific indexes
5. **Enable indexer acknowledgment** for critical logs (may impact performance)
6. **Use TLS certificates** from trusted CA in production

## Useful Splunk Queries

```spl
# Error rate by service
index=docker_logs log_level=ERROR 
| timechart count by service span=5m

# Response times (if structured logs include duration)
index=docker_logs duration=* 
| stats avg(duration) p50(duration) p95(duration) p99(duration) by service

# Top errors
index=docker_logs log_level=ERROR 
| stats count by error_message 
| sort -count

# Service health overview
index=docker_logs 
| stats count by service log_level 
| chart count over service by log_level
```

## Monitoring Dashboard

Create a dashboard with these panels:

1. **Log Volume** - timechart of events by service
2. **Error Rate** - count of ERROR/WARN by service
3. **Service Status** - latest healthcheck results
4. **Top Errors** - table of most common errors
5. **Log Level Distribution** - pie chart of log levels

Save searches as alerts for critical conditions:
- Error rate exceeds threshold
- Service stops logging (possible crash)
- Specific error patterns detected
