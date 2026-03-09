#!/bin/bash
# Check what data is currently in Redis

echo "=== Checking Redis Data Status ==="
echo ""

# Check if Redis is accessible
if ! docker-compose -f services/docker-compose.yml exec -T redis redis-cli ping > /dev/null 2>&1; then
    echo "ERROR: Cannot connect to Redis"
    exit 1
fi

echo "✓ Redis is accessible"
echo ""

# Function to check if a key exists and show its age
check_key() {
    local key=$1
    local label=$2
    
    exists=$(docker-compose -f services/docker-compose.yml exec -T redis redis-cli EXISTS "$key" 2>/dev/null | tr -d '\r')
    
    if [ "$exists" = "1" ]; then
        # Get TTL
        ttl=$(docker-compose -f services/docker-compose.yml exec -T redis redis-cli TTL "$key" 2>/dev/null | tr -d '\r')
        
        # Get size
        size=$(docker-compose -f services/docker-compose.yml exec -T redis redis-cli STRLEN "$key" 2>/dev/null | tr -d '\r')
        
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
total=$(docker-compose -f services/docker-compose.yml exec -T redis redis-cli DBSIZE 2>/dev/null | grep -o '[0-9]*')
echo "Total keys: $total"

echo ""
echo "=== Summary ==="
if [ "$total" -lt "5" ]; then
    echo "⚠️  WARNING: Very few keys in Redis. Workers may not have run yet."
    echo "    Run: cd services && docker-compose logs orchestrator | tail -20"
else
    echo "✓ Redis contains data. Bootstrap should work."
fi
