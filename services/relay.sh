#!/usr/bin/env bash
# ============================================
# World Monitor Relay Server — Management Script
# ============================================
# Usage:
#   ./relay.sh up        Start all services (detached, includes Splunk logging)
#   ./relay.sh down      Stop all services
#   ./relay.sh restart   Restart all services
#   ./relay.sh logs      Follow logs (Ctrl+C to exit)
#   ./relay.sh logs <svc> Follow logs for specific service
#   ./relay.sh ps        Show running services
#   ./relay.sh pull      Pull latest images
#   ./relay.sh status    Health check all services
#
# Options:
#   --tunnel    Include Cloudflare tunnel service
#   --no-splunk Disable Splunk logging (enabled by default)
#
# Examples:
#   ./relay.sh up              Start with Splunk logging (default)
#   ./relay.sh up --tunnel     Start with Cloudflare tunnel and Splunk
#   ./relay.sh up --no-splunk  Start without Splunk logging
#   ./relay.sh up --tunnel --no-splunk  Start with tunnel only
#   ./relay.sh logs gateway    Follow gateway logs only
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"
PROFILE=""
ENABLE_SPLUNK=true

# Parse flags
for arg in "$@"; do
    if [[ "$arg" == "--tunnel" ]]; then
        PROFILE="$PROFILE --profile tunnel"
    elif [[ "$arg" == "--no-splunk" ]]; then
        ENABLE_SPLUNK=false
    fi
done

# Add Splunk logging by default unless --no-splunk is specified
if [[ "$ENABLE_SPLUNK" == true ]]; then
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.logging.yml"
fi

# Remove flags from positional args
COMMAND="${1:-help}"
SERVICE="${2:-}"

# Skip service arg if it's a flag
if [[ "$SERVICE" == "--tunnel" ]] || [[ "$SERVICE" == "--no-splunk" ]]; then
    SERVICE=""
fi

compose() {
    docker compose $COMPOSE_FILES $PROFILE "$@"
}

case "$COMMAND" in
    up)
        echo "Starting relay services..."
        compose up -d
        echo ""
        compose ps
        ;;
    down)
        echo "Stopping relay services..."
        compose down
        ;;
    restart)
        echo "Restarting relay services..."
        compose down
        compose up -d
        echo ""
        compose ps
        ;;
    logs)
        if [[ -n "$SERVICE" ]]; then
            compose logs -f "$SERVICE"
        else
            compose logs -f
        fi
        ;;
    ps)
        compose ps
        ;;
    pull)
        echo "Pulling latest images..."
        compose pull
        ;;
    status)
        echo "Service health status:"
        echo ""
        compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
        ;;
    shell)
        if [[ -z "$SERVICE" ]]; then
            echo "Usage: relay shell <service>"
            echo "Services: gateway, orchestrator, worker, ai-engine, ais-processor, ingest-telegram, redis"
            exit 1
        fi
        compose exec "$SERVICE" sh
        ;;
    splunk)
        echo "Splunk Logging Status"
        echo "====================="
        echo ""
        
        # Check if Splunk is configured
        if [[ -f ".env.production" ]]; then
            SPLUNK_URL=$(grep "^SPLUNK_URL=" .env.production | cut -d'=' -f2)
            SPLUNK_TOKEN=$(grep "^SPLUNK_HEC_TOKEN=" .env.production | cut -d'=' -f2)
            SPLUNK_INDEX=$(grep "^SPLUNK_INDEX=" .env.production | cut -d'=' -f2)
            
            if [[ -n "$SPLUNK_URL" ]] && [[ -n "$SPLUNK_TOKEN" ]]; then
                echo "✓ Configuration: OK"
                echo "  URL:   $SPLUNK_URL"
                echo "  Index: ${SPLUNK_INDEX:-docker_logs}"
                echo ""
            else
                echo "✗ Configuration: Missing SPLUNK_URL or SPLUNK_HEC_TOKEN in .env.production"
                echo ""
            fi
        else
            echo "✗ Configuration: .env.production not found"
            echo ""
        fi
        
        # Check if Splunk service is running
        if docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.logging.yml ps splunk 2>/dev/null | grep -q "Up"; then
            echo "✓ Splunk Container: Running"
            SPLUNK_CONTAINER=$(docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.logging.yml ps -q splunk 2>/dev/null)
            if [[ -n "$SPLUNK_CONTAINER" ]]; then
                SPLUNK_PORT=$(docker port "$SPLUNK_CONTAINER" 8000 2>/dev/null | cut -d':' -f2)
                if [[ -n "$SPLUNK_PORT" ]]; then
                    echo "  Web UI: http://localhost:$SPLUNK_PORT"
                    echo "  Credentials: admin/changeme (change on first login)"
                fi
            fi
            echo ""
        else
            echo "✗ Splunk Container: Not running"
            echo ""
        fi
        
        # Check recent log entries
        echo "Recent Log Statistics:"
        echo "  Checking last 5 minutes of logs..."
        
        # Try to get container stats
        CONTAINERS=$(compose ps -q 2>/dev/null)
        if [[ -n "$CONTAINERS" ]]; then
            RUNNING_COUNT=$(echo "$CONTAINERS" | wc -l | tr -d ' ')
            echo "  Active containers: $RUNNING_COUNT"
            echo ""
            echo "Run 'relay logs splunk' to view Splunk logs"
            echo "Run 'relay logs <service>' to view service logs"
        else
            echo "  No containers running"
        fi
        echo ""
        echo "Dashboard: Navigate to Splunk Web UI → Search & Reporting"
        echo "           → Dashboards → Docker Monitoring"
        ;;
    help|--help|-h|"")
        echo "World Monitor Relay Server"
        echo ""
        echo "Usage: relay <command> [options]"
        echo ""
        echo "Commands:"
        echo "  up        Start all services (detached, includes Splunk logging)"
        echo "  down      Stop all services"
        echo "  restart   Restart all services"
        echo "  logs      Follow logs (Ctrl+C to exit)"
        echo "  logs <svc> Follow logs for specific service"
        echo "  ps        Show running services"
        echo "  pull      Pull latest images"
        echo "  status    Health check all services"
        echo "  shell <svc> Open shell in service container"
        echo "  splunk    Check Splunk logging status and configuration"
        echo ""
        echo "Options:"
        echo "  --tunnel     Include Cloudflare tunnel service"
        echo "  --no-splunk  Disable Splunk logging (enabled by default)"
        echo ""
        echo "Examples:"
        echo "  relay up                    Start with Splunk logging (default)"
        echo "  relay up --tunnel           Start with tunnel and Splunk"
        echo "  relay up --no-splunk        Start without Splunk logging"
        echo "  relay up --tunnel --no-splunk  Start with tunnel only"
        echo "  relay logs gateway          Follow gateway logs only"
        echo "  relay shell redis           Open shell in redis container"
        echo "  relay splunk                Check Splunk status"
        echo ""
        echo "Note: Splunk logging is enabled by default and requires"
        echo "      SPLUNK_HEC_TOKEN and SPLUNK_URL in .env.production"
        ;;
    *)
        echo "Unknown command: $COMMAND"
        echo "Run 'relay help' for usage"
        exit 1
        ;;
esac
