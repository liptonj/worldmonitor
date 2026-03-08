# Quick Start: Push to Docker Hub

## Your Docker Hub Repositories

Each service has its own repository:

- `sliptronic/worldrelay_base`
- `sliptronic/worldrelay_gateway`
- `sliptronic/worldrelay_orchestrator`
- `sliptronic/worldrelay_worker`
- `sliptronic/worldrelay_ais-processor`
- `sliptronic/worldrelay_ingest-telegram`
- `sliptronic/worldrelay_ai-engine`

---

## 🚀 Method 1: Automated Script (Easiest)

```bash
cd /Users/jolipton/Projects/worldmonitor/.worktrees/relay-decomposition/services

# Run the push script
./push-to-dockerhub.sh
```

This will:
1. Check if you're logged in (prompts if not)
2. Build all 7 images
3. Push to their respective Docker Hub repositories
4. Show you the Docker Hub URLs

**Time:** ~5-10 minutes depending on your machine

---

## 🔨 Method 2: Manual Commands

### Login to Docker Hub
```bash
docker login
# Username: sliptronic
# Password: (your Docker Hub password or access token)
```

### Build All Images
```bash
cd /Users/jolipton/Projects/worldmonitor/.worktrees/relay-decomposition/services

# Base image
docker build -f Dockerfile.base -t sliptronic/worldrelay_base:latest .

# Services
docker build -f gateway/Dockerfile -t sliptronic/worldrelay_gateway:latest .
docker build -f orchestrator/Dockerfile -t sliptronic/worldrelay_orchestrator:latest .
docker build -f worker/Dockerfile -t sliptronic/worldrelay_worker:latest .
docker build -f ais-processor/Dockerfile -t sliptronic/worldrelay_ais-processor:latest .
docker build -f ingest-telegram/Dockerfile -t sliptronic/worldrelay_ingest-telegram:latest .
docker build -f ai-engine/Dockerfile -t sliptronic/worldrelay_ai-engine:latest .
```

### Push All Images
```bash
docker push sliptronic/worldrelay_base:latest
docker push sliptronic/worldrelay_gateway:latest
docker push sliptronic/worldrelay_orchestrator:latest
docker push sliptronic/worldrelay_worker:latest
docker push sliptronic/worldrelay_ais-processor:latest
docker push sliptronic/worldrelay_ingest-telegram:latest
docker push sliptronic/worldrelay_ai-engine:latest
```

---

## 📦 Your Images on Docker Hub

After pushing, view at:
- https://hub.docker.com/r/sliptronic/worldrelay_base
- https://hub.docker.com/r/sliptronic/worldrelay_gateway
- https://hub.docker.com/r/sliptronic/worldrelay_orchestrator
- https://hub.docker.com/r/sliptronic/worldrelay_worker
- https://hub.docker.com/r/sliptronic/worldrelay_ais-processor
- https://hub.docker.com/r/sliptronic/worldrelay_ingest-telegram
- https://hub.docker.com/r/sliptronic/worldrelay_ai-engine

---

## 🚀 Deploy from Docker Hub

On any server with Docker:

```bash
# Clone repo or just copy docker-compose files
git clone https://github.com/worldmonitor/worldmonitor.git
cd worldmonitor/services

# Create .env
cp .env.example .env
nano .env  # Add your Supabase credentials

# Pull and run
docker-compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f gateway
```

---

## 🔄 Update Images

### Push new version:
```bash
cd /Users/jolipton/Projects/worldmonitor/.worktrees/relay-decomposition/services
./push-to-dockerhub.sh
```

### Pull on server:
```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## 🤖 GitHub Actions (Automated)

To enable automatic builds on every push:

1. **Add GitHub Secrets:**
   - Go to: https://github.com/worldmonitor/worldmonitor/settings/secrets/actions
   - Add `DOCKERHUB_USERNAME` = `sliptronic`
   - Add `DOCKERHUB_TOKEN` = (create at https://hub.docker.com/settings/security)

2. **Push code:**
   ```bash
   git add .
   git commit -m "feat: configure Docker Hub"
   git push origin relay-decomposition
   ```

3. **Watch it build:**
   - https://github.com/worldmonitor/worldmonitor/actions
   - Images auto-pushed to Docker Hub on every push to main

---

## ✅ Verification

After pushing, verify:

```bash
# Pull an image
docker pull sliptronic/worldrelay_gateway:latest

# Run it
docker run --rm sliptronic/worldrelay_gateway:latest node --version
```

Expected: Node.js version prints (proves image works)

---

## 🎯 Quick Commands

```bash
# Build and push everything
./push-to-dockerhub.sh

# Deploy on server
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Update server
docker-compose pull && docker-compose up -d

# View images locally
docker images | grep worldrelay

# Clean up old images
docker image prune -a
```

---

## 📋 Image List

| Service | Docker Hub Repository | Pull Command |
|---------|----------------------|--------------|
| Base | `sliptronic/worldrelay_base` | `docker pull sliptronic/worldrelay_base:latest` |
| Gateway | `sliptronic/worldrelay_gateway` | `docker pull sliptronic/worldrelay_gateway:latest` |
| Orchestrator | `sliptronic/worldrelay_orchestrator` | `docker pull sliptronic/worldrelay_orchestrator:latest` |
| Worker | `sliptronic/worldrelay_worker` | `docker pull sliptronic/worldrelay_worker:latest` |
| AIS Processor | `sliptronic/worldrelay_ais-processor` | `docker pull sliptronic/worldrelay_ais-processor:latest` |
| Telegram Ingest | `sliptronic/worldrelay_ingest-telegram` | `docker pull sliptronic/worldrelay_ingest-telegram:latest` |
| AI Engine | `sliptronic/worldrelay_ai-engine` | `docker pull sliptronic/worldrelay_ai-engine:latest` |
