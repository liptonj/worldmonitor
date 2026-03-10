#!/bin/bash
# Check what data is currently in Redis using raw Redis protocol
# Works without redis-cli by using netcat (nc)
set -e
#
# Usage:
#   ./check-redis-data-nc.sh 10.230.255.80      # Remote redis (IP:6379)
#   ./check-redis-data-nc.sh 10.230.255.80:6380 # Remote redis (custom port)

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES_DIR="$BASE_DIR/services"
REMOTE_SERVICES_DIR="${REMOTE_SERVICES_DIR:-$SERVICES_DIR}"

if [ -z "$1" ]; then
    echo "Usage: $0 <host[:port]>"
    echo "Example: $0 10.230.255.80"
    exit 1
fi

REDIS_HOST="$1"

# Parse host:port
if [[ "$REDIS_HOST" == *:* ]]; then
    HOST="${REDIS_HOST%%:*}"
    PORT="${REDIS_HOST##*:}"
else
    HOST="$REDIS_HOST"
    PORT="6379"
fi

echo "=== Checking Redis Data Status ==="
echo "Target: Redis at $HOST:$PORT"
echo ""

# Check if nc is available
if ! command -v nc &> /dev/null; then
    echo "ERROR: netcat (nc) not found. Install it with:"
    echo "  macOS:   (should be pre-installed)"
    echo "  Ubuntu:  sudo apt-get install netcat"
    exit 1
fi

# Function to send Redis command and get response
redis_cmd() {
    local cmd="$1"
    # Send Redis protocol command
    echo -e "$cmd\r\n" | nc -w 1 "$HOST" "$PORT" 2>/dev/null | tail -n 1
}

# Test connection
echo "Testing connection..."
ping_response=$(echo -e "PING\r\n" | nc -w 1 "$HOST" "$PORT" 2>/dev/null | head -n 1)

if [[ "$ping_response" != "+PONG"* ]]; then
    echo "✗ Cannot connect to Redis at $HOST:$PORT"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check if port $PORT is open: nc -zv $HOST $PORT"
    echo "  2. Verify Redis is running: ssh ubuntu@$HOST 'docker ps | grep redis'"
    echo "  3. Check if Redis is bound to 0.0.0.0 (not just 127.0.0.1)"
    echo "  4. Check firewall rules"
    exit 1
fi

echo "✓ Redis is accessible"
echo ""

# Function to check if a key exists
check_key() {
    local key=$1
    local label=$2
    
    # EXISTS command
    exists=$(echo -e "EXISTS $key\r\n" | nc -w 1 "$HOST" "$PORT" 2>/dev/null | grep -o ':[0-9]' | cut -d: -f2)
    
    if [ "$exists" = "1" ]; then
        # Get TTL
        ttl=$(echo -e "TTL $key\r\n" | nc -w 1 "$HOST" "$PORT" 2>/dev/null | grep -o ':[0-9-]*' | cut -d: -f2)
        
        # Get size
        size=$(echo -e "STRLEN $key\r\n" | nc -w 1 "$HOST" "$PORT" 2>/dev/null | grep -o ':[0-9]*' | cut -d: -f2)
        
        if [ "$ttl" = "-1" ]; then
            echo "✓ $label: EXISTS (no TTL, ${size} bytes)"
        elif [ "$ttl" = "-2" ]; then
            echo "✗ $label: EXPIRED"
        else
            echo "✓ $label: EXISTS (TTL: ${ttl}s, ${size} bytes)"
        fi
    else
        echo "✗ $label: MISSING"
    fi
}

echo "--- Core Channels ---"
check_key "news:digest:v1:full:en" "News Digest (Full)"
check_key "relay:telegram:v1" "Telegram Intel"
check_key "ai:panel-summary:v1" "AI Panel Summary"
check_key "ai:digest:global:v1" "AI Intel Digest"
check_key "theater-posture:sebuf:v1" "Strategic Posture"
check_key "risk:scores:sebuf:v1" "Strategic Risk"
check_key "relay:gdelt:v1" "GDELT Intelligence"

echo ""
echo "--- Data Channels ---"
check_key "relay:flights:v1" "Military Flights"
check_key "relay:conflict:v1" "ACLED Conflicts"
check_key "conflict:ucdp-events:v1" "UCDP Events"
check_key "relay:oref:v1" "Oref Sirens"

echo ""
echo "--- Config ---"
check_key "relay:config:news-sources" "News Sources Config"
check_key "relay:config:feature-flags" "Feature Flags"

echo ""
echo "--- Total Keys in Redis ---"
dbsize=$(echo -e "DBSIZE\r\n" | nc -w 1 "$HOST" "$PORT" 2>/dev/null | grep -o ':[0-9]*' | cut -d: -f2)
dbsize="${dbsize:-0}"
if ! [[ "$dbsize" =~ ^[0-9]+$ ]]; then
    dbsize=0
fi
echo "Total keys: $dbsize"

echo ""
echo "=== Summary ==="
if [ "$dbsize" -lt "5" ]; then
    echo "⚠️  WARNING: Very few keys in Redis. Workers may not have run yet."
    echo ""
    echo "Next steps:"
    echo "  1. SSH to server: ssh ubuntu@$HOST"
    echo "  2. Check orchestrator: cd $REMOTE_SERVICES_DIR && docker-compose logs orchestrator | tail -20"
    echo "  3. Restart orchestrator: docker-compose restart orchestrator"
else
    echo "✓ Redis contains data. Bootstrap should work."
    echo ""
    echo "If panels still not loading, check:"
    echo "  1. Frontend bootstrap request: Browser DevTools → Network → /bootstrap"
    echo "  2. Gateway logs: ssh ubuntu@$HOST 'cd $REMOTE_SERVICES_DIR && docker-compose logs gateway | tail -20'"
fi
