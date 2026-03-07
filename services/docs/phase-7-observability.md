# Phase 7: Observability & Alerting

## Alert Webhook (Discord / Slack)

When a service exceeds `max_consecutive_failures`, the orchestrator sends an alert to a webhook URL.

### Configuration

Set the `ALERT_WEBHOOK_URL` environment variable:

```bash
# Discord webhook
ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN

# Slack incoming webhook
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/YOUR_WORKSPACE_ID/YOUR_CHANNEL_ID/YOUR_TOKEN
```

- **Discord**: Create a webhook in Server Settings → Integrations → Webhooks.
- **Slack**: Create an Incoming Webhook in your app's configuration.

If `ALERT_WEBHOOK_URL` is not set, alerting is disabled (no-op).

## Splunk Logging

Logs are shipped to Splunk via the Docker Splunk logging driver, configured in `docker-compose.prod.yml`.

### Configuration

Set these environment variables for production:

```bash
SPLUNK_HEC_URL=https://your-splunk-server:8088
SPLUNK_HEC_TOKEN=your-splunk-hec-token
```

### Key Log Fields to Search

| Field | Description |
|-------|--------------|
| `service_key` | Channel/service identifier (e.g. `markets`, `ai:intel-digest`) |
| `trigger_id` | Unique ID for a trigger/run |
| `status` | `ok` or `error` |
| `consecutive_failures` | Number of consecutive failures |
| `error` | Error message when status is `error` |

### Example Splunk Queries

```
# All errors for a service
service_key="markets" status="error"

# Services exceeding failure threshold
consecutive_failures>=5

# Trigger completion
trigger_id=*
```
