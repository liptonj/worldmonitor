#!/usr/bin/env bash
# ============================================
# Deploy Splunk Configuration to Server
# ============================================
# Copies necessary Splunk files to production server
# Usage: ./deploy-splunk-config.sh
# ============================================

set -euo pipefail

# Server configuration
SERVER_USER="ubuntu"
SERVER_HOST="10.230.255.80"
SERVER_DIR="~/worldmon/services"

echo "============================================"
echo "Deploying Splunk Configuration"
echo "============================================"
echo "Target: ${SERVER_USER}@${SERVER_HOST}:${SERVER_DIR}"
echo ""

# Check if we can reach the server
echo "Testing SSH connection..."
if ! ssh -o ConnectTimeout=5 ${SERVER_USER}@${SERVER_HOST} "echo 'Connection successful'"; then
    echo "❌ Cannot connect to server. Please check:"
    echo "   - Server is reachable: ping ${SERVER_HOST}"
    echo "   - SSH access is configured: ssh ${SERVER_USER}@${SERVER_HOST}"
    echo "   - SSH keys are set up (or use password)"
    exit 1
fi
echo "✓ SSH connection OK"
echo ""

# Create splunk directory on server if it doesn't exist
echo "Creating splunk directory on server..."
ssh ${SERVER_USER}@${SERVER_HOST} "mkdir -p ${SERVER_DIR}/splunk"
echo "✓ Directory created"
echo ""

# Copy files
echo "Copying files to server..."
echo ""

# 1. Docker Compose overlay
echo "→ Copying docker-compose.logging.yml..."
scp docker-compose.logging.yml ${SERVER_USER}@${SERVER_HOST}:${SERVER_DIR}/
echo "  ✓ docker-compose.logging.yml"

# 2. Environment file
echo "→ Copying .env.production..."
scp .env.production ${SERVER_USER}@${SERVER_HOST}:${SERVER_DIR}/.env
echo "  ✓ .env.production → .env"

# 3. Relay script (updated with --splunk flag)
echo "→ Copying relay.sh..."
scp relay.sh ${SERVER_USER}@${SERVER_HOST}:${SERVER_DIR}/
ssh ${SERVER_USER}@${SERVER_HOST} "chmod +x ${SERVER_DIR}/relay.sh"
echo "  ✓ relay.sh (made executable)"

# 4. Test script
echo "→ Copying test-splunk-connection.sh..."
scp test-splunk-connection.sh ${SERVER_USER}@${SERVER_HOST}:${SERVER_DIR}/
ssh ${SERVER_USER}@${SERVER_HOST} "chmod +x ${SERVER_DIR}/test-splunk-connection.sh"
echo "  ✓ test-splunk-connection.sh (made executable)"

# 5. Documentation
echo "→ Copying Splunk documentation..."
scp -r splunk/ ${SERVER_USER}@${SERVER_HOST}:${SERVER_DIR}/
echo "  ✓ splunk/ directory"

echo ""
echo "============================================"
echo "✓ Deployment Complete!"
echo "============================================"
echo ""
echo "Next steps on the server:"
echo ""
echo "1. SSH to server:"
echo "   ssh ${SERVER_USER}@${SERVER_HOST}"
echo ""
echo "2. Navigate to directory:"
echo "   cd ${SERVER_DIR}"
echo ""
echo "3. Test Splunk connection:"
echo "   ./test-splunk-connection.sh"
echo ""
echo "4. Deploy with Splunk logging:"
echo "   ./relay.sh down"
echo "   ./relay.sh up --splunk"
echo ""
echo "5. Check status:"
echo "   ./relay.sh ps"
echo "   ./relay.sh logs"
echo ""
echo "6. Verify logs in Splunk:"
echo "   Login to https://splunk.5ls.us:8000"
echo "   Search: index=docker_logs"
echo ""
