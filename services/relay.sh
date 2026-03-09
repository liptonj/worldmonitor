#!/usr/bin/env bash
# ============================================
# World Monitor Relay Server — Management Script
# ============================================
# Usage:
#   ./relay.sh up        Start all services (detached)
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
#
# Examples:
#   ./relay.sh up              Start without tunnel
#   ./relay.sh up --tunnel     Start with Cloudflare tunnel
#   ./relay.sh logs gateway    Follow gateway logs only
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"
PROFILE=""

# Parse --tunnel flag
for arg in "$@"; do
    if [[ "$arg" == "--tunnel" ]]; then
        PROFILE="--profile tunnel"
    fi
done

# Remove flags from positional args
COMMAND="${1:-help}"
SERVICE="${2:-}"

# Skip service arg if it's a flag
if [[ "$SERVICE" == "--tunnel" ]]; then
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
            echo "Usage: ./relay.sh shell <service>"
            echo "Services: gateway, orchestrator, worker, ai-engine, ais-processor, ingest-telegram, redis"
            exit 1
        fi
        compose exec "$SERVICE" sh
        ;;
    help|--help|-h|"")
        echo "World Monitor Relay Server"
        echo ""
        echo "Usage: ./relay.sh <command> [options]"
        echo ""
        echo "Commands:"
        echo "  up        Start all services (detached)"
        echo "  down      Stop all services"
        echo "  restart   Restart all services"
        echo "  logs      Follow logs (Ctrl+C to exit)"
        echo "  logs <svc> Follow logs for specific service"
        echo "  ps        Show running services"
        echo "  pull      Pull latest images"
        echo "  status    Health check all services"
        echo "  shell <svc> Open shell in service container"
        echo ""
        echo "Options:"
        echo "  --tunnel  Include Cloudflare tunnel service"
        echo ""
        echo "Examples:"
        echo "  ./relay.sh up              Start without tunnel"
        echo "  ./relay.sh up --tunnel     Start with Cloudflare tunnel"
        echo "  ./relay.sh logs gateway    Follow gateway logs only"
        echo "  ./relay.sh shell redis     Open shell in redis container"
        ;;
    *)
        echo "Unknown command: $COMMAND"
        echo "Run './relay.sh help' for usage"
        exit 1
        ;;
esac
