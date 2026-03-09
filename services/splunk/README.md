# Splunk Integration for World Monitor

This directory contains Splunk configuration for logging all Docker container output to Splunk.

## Quick Start

### 1. Configure Environment Variables

Add to your `.env` or `.env.production`:

```bash
SPLUNK_HEC_TOKEN=your-hec-token-here
SPLUNK_URL=https://your-splunk-host:8088
SPLUNK_INDEX=docker_logs
SPLUNK_INSECURE_SKIP_VERIFY=true  # Set to false with valid SSL cert
ENVIRONMENT=production
```

### 2. Start with Splunk Logging

```bash
# Start all services with Splunk logging enabled
./relay.sh up --splunk

# Or with Cloudflare tunnel too
./relay.sh up --splunk --tunnel
```

### 3. View Logs in Splunk

Login to Splunk and search:
```spl
index=docker_logs
```

## Files

```
services/splunk/
├── SPLUNK_SETUP.md                    # Complete setup guide
├── DASHBOARD_SETUP.md                 # Dashboard creation guide
├── docker_monitoring_dashboard.xml    # Pre-built dashboard
├── indexes.conf                       # Index configuration (optional)
└── README.md                          # This file
```

## Configuration Options

### Minimal Setup (Recommended)

Use the existing `docker-compose.logging.yml` overlay:

```bash
./relay.sh up --splunk
```

This automatically configures all services to send logs to Splunk.

### Advanced Setup

Edit `docker-compose.logging.yml` to customize:

- **Compression**: Add `splunk-gzip: "true"` for log compression
- **Index per service**: Set different `splunk-index` for each service
- **Format**: Change `splunk-format` (json, inline, raw)
- **Verify connection**: Set `splunk-verify-connection: "true"` to test on startup

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SPLUNK_HEC_TOKEN` | Yes | - | HTTP Event Collector token from Splunk |
| `SPLUNK_URL` | Yes | - | Splunk HEC endpoint (https://host:8088) |
| `SPLUNK_INDEX` | No | `docker_logs` | Splunk index name |
| `SPLUNK_INSECURE_SKIP_VERIFY` | No | `true` | Skip SSL verification (dev only) |
| `ENVIRONMENT` | No | `production` | Environment label for logs |

## Testing Connection

```bash
# Test Splunk HEC connectivity
cd services
./test-splunk-connection.sh
```

This verifies:
- HEC endpoint is reachable
- Token is valid
- Test event can be sent

## Dashboard

Import the pre-built dashboard:

1. Login to Splunk Web
2. **Dashboards** → **Create New Dashboard** → **Edit Source**
3. Paste contents of `docker_monitoring_dashboard.xml`
4. Save

See `DASHBOARD_SETUP.md` for detailed instructions.

## Usage

### Start with Splunk Logging

```bash
# Production deployment
./relay.sh up --splunk

# With Cloudflare tunnel
./relay.sh up --splunk --tunnel

# Restart with Splunk
./relay.sh restart --splunk
```

### View Logs

**In Docker (local logs still work):**
```bash
# View container logs normally
./relay.sh logs gateway

# View all logs
./relay.sh logs
```

**In Splunk (centralized logs):**
```spl
# All logs from last hour
index=docker_logs earliest=-1h

# Specific service
index=docker_logs source="gateway*"

# Errors only
index=docker_logs log_level=ERROR

# Real-time monitoring
index=docker_logs | head 100
```

### Stop Splunk Logging

```bash
# Stop and remove Splunk logging
./relay.sh down
./relay.sh up  # Start without --splunk flag
```

## Architecture

### How It Works

1. **Docker Logging Driver**: Each container uses the `splunk` logging driver
2. **Direct to HEC**: Logs are sent directly from Docker daemon to Splunk HTTP Event Collector
3. **JSON Format**: All logs are JSON-formatted for structured parsing
4. **Labels & Tags**: Each log includes service name, environment, and log level
5. **Non-blocking**: Logging failures don't affect container operation

### Log Flow

```
┌──────────────┐
│   Gateway    │ ──┐
└──────────────┘   │
┌──────────────┐   │
│ Orchestrator │ ──┤
└──────────────┘   │
┌──────────────┐   │    ┌────────────────┐    ┌─────────────┐
│    Worker    │ ──┼───▶│ Docker Daemon  │───▶│   Splunk    │
└──────────────┘   │    │ Splunk Driver  │    │     HEC     │
┌──────────────┐   │    └────────────────┘    └─────────────┘
│  AI Engine   │ ──┤                                  │
└──────────────┘   │                                  ▼
┌──────────────┐   │                          ┌─────────────┐
│     Redis    │ ──┘                          │   Splunk    │
└──────────────┘                              │  Indexers   │
                                              └─────────────┘
```

## Comparison: With vs Without Splunk

### Without Splunk (Default)

```bash
./relay.sh up
./relay.sh logs gateway  # Local logs only
```

**Pros:**
- Simple setup
- No external dependencies
- Fast local access

**Cons:**
- Logs lost on container removal
- No centralized view
- Hard to correlate across services
- No long-term retention

### With Splunk

```bash
./relay.sh up --splunk
./relay.sh logs gateway  # Still works locally
# Plus: Centralized logs in Splunk
```

**Pros:**
- Centralized log management
- Long-term retention (30+ days)
- Advanced search and analytics
- Real-time dashboards
- Alerting on patterns
- Correlation across all services

**Cons:**
- Requires Splunk infrastructure
- Additional network traffic
- Slight performance overhead (~1-2%)

## Troubleshooting

### Logs Not Appearing in Splunk

1. **Check HEC token**:
   ```bash
   curl -k "${SPLUNK_URL}/services/collector/health"
   ```

2. **Verify environment variables**:
   ```bash
   grep SPLUNK services/.env
   ```

3. **Check Docker logs for errors**:
   ```bash
   docker logs gateway 2>&1 | grep -i splunk
   ```

4. **Test connection**:
   ```bash
   ./test-splunk-connection.sh
   ```

### SSL Certificate Errors

For production, use valid certificates. For development:

```bash
# In .env.production
SPLUNK_INSECURE_SKIP_VERIFY=true
```

### Performance Impact

If Splunk logging causes slowdowns:

1. **Enable compression**:
   ```yaml
   splunk-gzip: "true"
   splunk-gzip-level: "5"
   ```

2. **Reduce log verbosity**:
   ```bash
   LOG_LEVEL=warning  # Instead of info
   ```

3. **Use async mode** (already default)

### Connection Refused

Check network connectivity:
```bash
# From Docker host
curl -k "${SPLUNK_URL}/services/collector/health"

# From inside container
docker exec gateway curl -k "${SPLUNK_URL}/services/collector/health"
```

Ensure port 8088 is accessible from Docker containers.

## Best Practices

### Production Deployment

1. **Use valid SSL certificates** on Splunk
2. **Set SPLUNK_INSECURE_SKIP_VERIFY=false**
3. **Create dedicated index** (`docker_logs`)
4. **Set appropriate retention** (30+ days)
5. **Configure alerts** for errors and service failures
6. **Use dashboards** for real-time monitoring

### Security

1. **Protect HEC token**: Never commit to git
2. **Use HTTPS**: Always use TLS for HEC endpoint
3. **Restrict access**: Limit who can read logs in Splunk
4. **Rotate tokens**: Change HEC tokens periodically
5. **Review permissions**: Ensure proper RBAC in Splunk

### Performance

1. **Monitor overhead**: Watch CPU/network usage
2. **Use compression**: Enable gzip for high-volume logs
3. **Batch events**: Let Docker driver batch automatically
4. **Tune verbosity**: Use appropriate LOG_LEVEL

## Migration Guide

### From Local Logs to Splunk

1. **Set up Splunk** (see SPLUNK_SETUP.md)
2. **Configure .env** with Splunk variables
3. **Test connection**: `./test-splunk-connection.sh`
4. **Restart services**: `./relay.sh restart --splunk`
5. **Verify in Splunk**: `index=docker_logs`
6. **Import dashboard**: Use `docker_monitoring_dashboard.xml`

### Rollback (Stop Using Splunk)

```bash
# Stop services
./relay.sh down

# Start without --splunk flag
./relay.sh up
```

Logs will go back to Docker's default JSON file driver.

## Support

For issues or questions:

1. Check `SPLUNK_SETUP.md` for detailed setup
2. Run `./test-splunk-connection.sh` to diagnose
3. Review Docker logs: `./relay.sh logs <service>`
4. Check Splunk internal logs: `index=_internal source=*splunkd.log*`

## References

- [Docker Splunk Logging Driver](https://docs.docker.com/config/containers/logging/splunk/)
- [Splunk HTTP Event Collector](https://docs.splunk.com/Documentation/Splunk/latest/Data/UsetheHTTPEventCollector)
- [Docker Compose Logging](https://docs.docker.com/compose/compose-file/compose-file-v3/#logging)
