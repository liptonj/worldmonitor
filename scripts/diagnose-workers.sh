#!/bin/bash
# Diagnostic script to check World Monitor worker and data status

echo "=== World Monitor Diagnostics ==="
echo ""

echo "1. Checking Docker service status..."
cd ~/worldmon/services
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
echo "6. To manually trigger AI workers, run these commands:"
echo "docker-compose exec orchestrator curl -X POST http://orchestrator:3000/trigger/ai:panel-summary"
echo "docker-compose exec orchestrator curl -X POST http://orchestrator:3000/trigger/ai:intel-digest"
echo "docker-compose exec orchestrator curl -X POST http://orchestrator:3000/trigger/ai:classifications"

echo ""
echo "=== End of Diagnostics ==="
