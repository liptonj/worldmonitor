#!/bin/bash
set -e

echo "🐳 Building and pushing to Docker Hub (sliptronic/*)"
echo ""

# Check if logged in
if ! docker info | grep -q "Username"; then
    echo "⚠️  Not logged in to Docker Hub. Running 'docker login'..."
    docker login
    echo ""
fi

# Navigate to services directory
cd "$(dirname "$0")"

echo "📦 Building base image..."
docker build -f Dockerfile.base -t sliptronic/worldrelay_base:latest .
echo "✅ Base image built"
echo ""

echo "🚀 Building service images..."

# Service name mapping (folder name -> repo name)
declare -A services=(
    ["gateway"]="worldrelay_gateway"
    ["orchestrator"]="worldrelay_orchestrator"
    ["worker"]="worldrelay_worker"
    ["ais-processor"]="worldrelay_ais-processor"
    ["ingest-telegram"]="worldrelay_ingest-telegram"
    ["ai-engine"]="worldrelay_ai-engine"
)

for folder in "${!services[@]}"; do
    repo=${services[$folder]}
    echo "📦 Building $repo (from $folder/)..."
    docker build -f $folder/Dockerfile -t sliptronic/$repo:latest .
    echo "✅ $repo built"
done

echo ""
echo "⬆️  Pushing images to Docker Hub..."
echo ""

echo "⬆️  Pushing base image..."
docker push sliptronic/worldrelay_base:latest
echo "✅ Base image pushed"
echo ""

for folder in "${!services[@]}"; do
    repo=${services[$folder]}
    echo "⬆️  Pushing $repo..."
    docker push sliptronic/$repo:latest
    echo "✅ $repo pushed"
done

echo ""
echo "🎉 All images pushed successfully!"
echo ""
echo "Images available at:"
echo "  - https://hub.docker.com/r/sliptronic/worldrelay_base"
echo "  - https://hub.docker.com/r/sliptronic/worldrelay_gateway"
echo "  - https://hub.docker.com/r/sliptronic/worldrelay_orchestrator"
echo "  - https://hub.docker.com/r/sliptronic/worldrelay_worker"
echo "  - https://hub.docker.com/r/sliptronic/worldrelay_ais-processor"
echo "  - https://hub.docker.com/r/sliptronic/worldrelay_ingest-telegram"
echo "  - https://hub.docker.com/r/sliptronic/worldrelay_ai-engine"
echo ""
echo "Pull with:"
echo "  docker pull sliptronic/worldrelay_gateway:latest"
echo "  docker pull sliptronic/worldrelay_orchestrator:latest"
echo "  docker pull sliptronic/worldrelay_worker:latest"
echo "  docker pull sliptronic/worldrelay_ais-processor:latest"
echo "  docker pull sliptronic/worldrelay_ingest-telegram:latest"
echo "  docker pull sliptronic/worldrelay_ai-engine:latest"
echo "  docker pull sliptronic/worldrelay_base:latest"
