# Splunk Quick Reference

## Start Services with Splunk

```bash
# Basic (with Splunk logging)
./relay.sh up --splunk

# With Cloudflare tunnel
./relay.sh up --splunk --tunnel

# Restart with Splunk
./relay.sh restart --splunk
```

## Essential Splunk Queries

```spl
# All Docker logs (last hour)
index=docker_logs earliest=-1h

# Specific service
index=docker_logs source="gateway*"
index=docker_logs source="orchestrator*"
index=docker_logs source="worker*"

# By log level
index=docker_logs log_level=ERROR
index=docker_logs log_level=WARN
index=docker_logs log_level=INFO

# Real-time (last 5 minutes, auto-refresh)
index=docker_logs earliest=-5m

# Count by service
index=docker_logs 
| stats count by source

# Error rate over time
index=docker_logs log_level=ERROR 
| timechart count span=5m

# Service health check
index=docker_logs earliest=-5m 
| stats count by source 
| eval status=if(count>0, "Active", "Inactive")

# Pattern detection
index=docker_logs 
| rex field=_raw mode=sed "s/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/TIMESTAMP/g"
| stats count by _raw
| sort -count
| head 20

# Find specific error
index=docker_logs "connection refused"
index=docker_logs "timeout"
index=docker_logs "failed"

# Last 100 logs with details
index=docker_logs 
| table _time, source, _raw 
| head 100
```

## Dashboard

Import: `docker_monitoring_dashboard.xml`

## Test Connection

```bash
./test-splunk-connection.sh
```

## Environment Variables

Required in `.env` or `.env.production`:

```bash
SPLUNK_HEC_TOKEN=your-token
SPLUNK_URL=https://splunk-host:8088
SPLUNK_INDEX=docker_logs
```

## Troubleshooting

```bash
# Check if logs are sending
curl -k "${SPLUNK_URL}/services/collector/health"

# View container logs locally
./relay.sh logs gateway

# Check for Splunk driver errors
docker inspect gateway | grep -A 20 "LogConfig"
```

## Common Issues

**No logs in Splunk?**
- Verify HEC token is correct
- Check SPLUNK_URL includes :8088
- Run `./test-splunk-connection.sh`

**SSL errors?**
- Set `SPLUNK_INSECURE_SKIP_VERIFY=true` (dev only)
- Use valid cert in production

**Performance issues?**
- Reduce LOG_LEVEL to warning
- Enable compression in docker-compose.logging.yml

## Alerts

Create alerts for:
- Error count > 10 in 5 minutes
- Service stops logging (no events for 5 minutes)
- Specific error patterns (e.g., "database connection failed")

## Dashboard Panels

- Total Events
- Error Count (with thresholds)
- Active Services
- Warning Count
- Log Volume by Service (area chart)
- Error Rate Trend (line chart)
- Service Health Status (table with 🟢🟡🔴)
- Recent Errors (table)
- Raw Log Viewer (searchable table)
