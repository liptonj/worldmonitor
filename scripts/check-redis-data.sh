#!/bin/bash
# Check what data is currently in Redis
#
# Usage:
#   ./check-redis-data.sh                    # Local docker-compose redis
#   ./check-redis-data.sh 10.230.255.80      # Remote redis (IP:6379)
#   ./check-redis-data.sh 10.230.255.80:6380 # Remote redis (custom port)

REDIS_HOST="${1:-local}"

echo "=== Checking Redis Data Status ==="
echo ""

# Determine how to connect to Redis
if [ "$REDIS_HOST" = "local" ]; then
    REDIS_CMD="docker-compose -f services/docker-compose.yml exec -T redis redis-cli"
    echo "Target: Local Docker Compose Redis"
else
    # Parse host:port
    if [[ "$REDIS_HOST" == *:* ]]; then
        HOST="${REDIS_HOST%%:*}"
        PORT="${REDIS_HOST##*:}"
    else
        HOST="$REDIS_HOST"
        PORT="6379"
    fi
    REDIS_CMD="redis-cli -h $HOST -p $PORT"
    echo "Target: Remote Redis at $HOST:$PORT"
    
    # Check if redis-cli is installed
    if ! command -v redis-cli &> /dev/null; then
        echo ""
        echo "ERROR: redis-cli not found. Install it with:"
        echo "  macOS:   brew install redis"
        echo "  Ubuntu:  sudo apt-get install redis-tools"
        echo "  Alpine:  apk add redis"
        exit 1
    fi
fi

echo ""

# Check if Redis is accessible
if ! $REDIS_CMD ping > /dev/null 2>&1; then
    echo "ERROR: Cannot connect to Redis"
    echo ""
    if [ "$REDIS_HOST" != "local" ]; then
        echo "Troubleshooting:"
        echo "  1. Check if port 6379 is open: nc -zv $HOST $PORT"
        echo "  2. Verify Redis is running: ssh ubuntu@$HOST 'docker ps | grep redis'"
        echo "  3. Check firewall rules"
    fi
    exit 1
fi

echo "✓ Redis is accessible"
echo ""

# Function to check if a key exists and show its age
check_key() {
    local key=$1
    local label=$2
    
    exists=$($REDIS_CMD EXISTS "$key" 2>/dev/null | tr -d '\r')
    
    if [ "$exists" = "1" ]; then
        # Get TTL
        ttl=$($REDIS_CMD TTL "$key" 2>/dev/null | tr -d '\r')
        
        # Get size
        size=$($REDIS_CMD STRLEN "$key" 2>/dev/null | tr -d '\r')
        
        if [ "$ttl" = "-1" ]; then
            echo "✓ $label: EXISTS (no TTL, ${size} bytes)"
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
total=$($REDIS_CMD DBSIZE 2>/dev/null | grep -o '[0-9]*')
echo "Total keys: $total"

echo ""
echo "=== Summary ==="
if [ "$total" -lt "5" ]; then
    echo "⚠️  WARNING: Very few keys in Redis. Workers may not have run yet."
    echo "    Run: cd services && docker-compose logs orchestrator | tail -20"
else
    echo "✓ Redis contains data. Bootstrap should work."
fi
