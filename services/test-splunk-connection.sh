#!/bin/bash
# Quick script to test Splunk HEC connectivity

set -e

# Load environment variables
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

SPLUNK_URL="${SPLUNK_URL:-https://localhost:8088}"
SPLUNK_HEC_TOKEN="${SPLUNK_HEC_TOKEN}"

echo "Testing Splunk HEC connection..."
echo "URL: $SPLUNK_URL"
echo

# Test health endpoint
echo "1. Testing HEC health endpoint..."
if curl -k -s "${SPLUNK_URL}/services/collector/health" | grep -q "HEC is healthy"; then
  echo "✓ HEC endpoint is healthy"
else
  echo "✗ HEC endpoint is not responding correctly"
  exit 1
fi

echo

# Test authentication with token
if [ -z "$SPLUNK_HEC_TOKEN" ]; then
  echo "⚠ SPLUNK_HEC_TOKEN not set in .env"
  echo "Please configure your HEC token before sending test events"
  exit 0
fi

echo "2. Testing HEC authentication with token..."
RESPONSE=$(curl -k -s -o /dev/null -w "%{http_code}" \
  "${SPLUNK_URL}/services/collector/event" \
  -H "Authorization: Splunk ${SPLUNK_HEC_TOKEN}" \
  -d '{"event":"test", "sourcetype":"manual"}')

if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "201" ]; then
  echo "✓ Authentication successful (HTTP $RESPONSE)"
else
  echo "✗ Authentication failed (HTTP $RESPONSE)"
  echo "Check your SPLUNK_HEC_TOKEN value"
  exit 1
fi

echo

# Send a test event
echo "3. Sending test event..."
RESPONSE=$(curl -k -s \
  "${SPLUNK_URL}/services/collector/event" \
  -H "Authorization: Splunk ${SPLUNK_HEC_TOKEN}" \
  -d '{
    "event": {
      "message": "Test event from Docker Splunk setup",
      "service": "test-script",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    },
    "sourcetype": "_json",
    "index": "'"${SPLUNK_INDEX:-docker_logs}"'"
  }')

if echo "$RESPONSE" | grep -q '"code":0'; then
  echo "✓ Test event sent successfully"
  echo
  echo "Check Splunk with this query:"
  echo "  index=${SPLUNK_INDEX:-docker_logs} service=test-script"
else
  echo "✗ Failed to send test event"
  echo "Response: $RESPONSE"
  exit 1
fi

echo
echo "✓ All tests passed!"
echo
echo "Next steps:"
echo "1. Apply logging configuration: docker compose -f docker-compose.yml -f docker-compose.logging.yml up -d"
echo "2. Check logs in Splunk: index=${SPLUNK_INDEX:-docker_logs}"
