#!/bin/bash
# Diagnostic script to check World Monitor worker and data status
set -e

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES_DIR="$BASE_DIR/services"

echo "=== World Monitor Diagnostics ==="
echo ""

echo "1. Checking Docker service status..."
cd "$SERVICES_DIR"
docker-compose ps

echo ""
echo "2. Checking orchestrator logs (last 50 lines)..."
docker-compose logs --tail=50 orchestrator

echo ""
echo "3. Checking AI engine logs (last 30 lines)..."
docker-compose logs --tail=30 ai-engine

echo ""
echo "4. Checking Redis for AI-generated data..."
echo "Run this command to check if AI data exists in Redis:"
echo "docker-compose exec redis redis-cli KEYS 'ai:*'"

echo ""
echo "5. Checking gateway logs (last 30 lines)..."
docker-compose logs --tail=30 gateway

echo ""
echo "6. Manual worker triggers:"
echo "   NOTE: The orchestrator uses the Supabase trigger_requests table instead of HTTP endpoints."
echo "   Insert a row into wm_admin.trigger_requests (channel_key, status='pending') to trigger a worker."

echo ""
echo "=== End of Diagnostics ==="
