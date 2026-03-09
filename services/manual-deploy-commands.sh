#!/usr/bin/env bash
# ============================================
# Quick Manual Deploy Instructions
# ============================================
# If the automated script doesn't work, use these manual SCP commands
# ============================================

SERVER="ubuntu@10.230.255.80"
REMOTE_DIR="~/worldmon/services"

echo "Manual SCP deployment commands:"
echo ""
echo "# 1. Create remote directory"
echo "ssh ${SERVER} 'mkdir -p ${REMOTE_DIR}/splunk'"
echo ""
echo "# 2. Copy Docker Compose overlay"
echo "scp docker-compose.logging.yml ${SERVER}:${REMOTE_DIR}/"
echo ""
echo "# 3. Copy environment file"
echo "scp .env.production ${SERVER}:${REMOTE_DIR}/.env"
echo ""
echo "# 4. Copy relay script"
echo "scp relay.sh ${SERVER}:${REMOTE_DIR}/"
echo "ssh ${SERVER} 'chmod +x ${REMOTE_DIR}/relay.sh'"
echo ""
echo "# 5. Copy test script"
echo "scp test-splunk-connection.sh ${SERVER}:${REMOTE_DIR}/"
echo "ssh ${SERVER} 'chmod +x ${REMOTE_DIR}/test-splunk-connection.sh'"
echo ""
echo "# 6. Copy splunk documentation"
echo "scp -r splunk/ ${SERVER}:${REMOTE_DIR}/"
echo ""
