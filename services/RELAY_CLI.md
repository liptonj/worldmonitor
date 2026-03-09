# Relay CLI

Global command-line interface for managing World Monitor relay services.

## Installation

Install the `relay` command globally:

```bash
cd services
sudo ./install-relay.sh
```

This creates a symlink in `/usr/local/bin/relay` so you can use the command from anywhere.

## Usage

```bash
relay <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `relay up` | Start all services (with Splunk logging) |
| `relay down` | Stop all services |
| `relay restart` | Restart all services |
| `relay logs` | Follow all logs |
| `relay logs <service>` | Follow specific service logs |
| `relay ps` | Show running services |
| `relay status` | Health check all services |
| `relay pull` | Pull latest Docker images |
| `relay shell <service>` | Open shell in service container |
| `relay splunk` | Check Splunk logging status |
| `relay help` | Show help message |

### Options

| Option | Description |
|--------|-------------|
| `--tunnel` | Include Cloudflare tunnel service |
| `--no-splunk` | Disable Splunk logging (enabled by default) |

### Examples

```bash
# Start all services with Splunk logging (default)
relay up

# Start with Cloudflare tunnel
relay up --tunnel

# Start without Splunk logging
relay up --no-splunk

# View logs for specific service
relay logs gateway
relay logs ai-engine

# Check Splunk status
relay splunk

# Open shell in Redis container
relay shell redis

# Stop all services
relay down
```

## Splunk Logging

Splunk logging is **enabled by default** when you run `relay up`.

### Check Splunk Status

```bash
relay splunk
```

This shows:
- ✓ Configuration status (URL, token, index)
- ✓ Container status (running/stopped)
- ✓ Web UI URL and credentials
- ✓ Active container count
- ✓ Quick access to dashboards

### Access Splunk Dashboard

1. Run `relay splunk` to get the Web UI URL
2. Open browser to `http://localhost:<port>`
3. Login with `admin/changeme` (change on first login)
4. Navigate to: **Search & Reporting** → **Dashboards** → **Docker Monitoring**

### Configuration

Splunk requires these environment variables in `.env.production`:

```bash
SPLUNK_HEC_TOKEN=your-token-here
SPLUNK_URL=https://your-splunk-host:8088
SPLUNK_INDEX=docker_logs
```

## Services

Available services for `relay logs <service>` and `relay shell <service>`:

- `gateway` - API gateway service
- `orchestrator` - Service orchestration
- `worker` - Background workers (3 replicas)
- `ai-engine` - AI/LLM engine
- `ais-processor` - AIS vessel tracking
- `ingest-telegram` - Telegram OSINT ingestion
- `redis` - Redis cache
- `splunk` - Splunk logging (when enabled)

## Troubleshooting

### Command not found

If you get "command not found" after installation:

1. Make sure `/usr/local/bin` is in your `$PATH`
2. Try re-running the installer: `sudo ./install-relay.sh`
3. Check the symlink exists: `ls -la /usr/local/bin/relay`

### Splunk not running

```bash
# Check status
relay splunk

# Restart with Splunk
relay restart

# View Splunk logs
relay logs splunk
```

### Permission denied

If you see permission errors:

```bash
# Make script executable
chmod +x services/relay.sh

# Reinstall globally
cd services
sudo ./install-relay.sh
```

## Uninstallation

To remove the global command:

```bash
sudo rm /usr/local/bin/relay
```

The script will still work locally as `./services/relay.sh`
