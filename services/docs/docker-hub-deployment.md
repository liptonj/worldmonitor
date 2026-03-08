# Docker Hub Deployment Guide

Complete guide for pushing relay microservices to Docker Hub.

---

## 🐳 Option 1: GitHub Actions (Automated)

### **Step 1: Create Docker Hub Account**

1. Go to https://hub.docker.com
2. Sign up or log in
3. Note your username (e.g., `worldmonitor`)

### **Step 2: Create Access Token**

1. Go to https://hub.docker.com/settings/security
2. Click **New Access Token**
3. Name: `GitHub Actions`
4. Permissions: **Read, Write, Delete**
5. Generate and **copy the token** (you won't see it again)

### **Step 3: Add Secrets to GitHub**

1. Go to your GitHub repo: https://github.com/worldmonitor/worldmonitor
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add two secrets:

   **Secret 1:**
   - Name: `DOCKERHUB_USERNAME`
   - Value: `worldmonitor` (your Docker Hub username)

   **Secret 2:**
   - Name: `DOCKERHUB_TOKEN`
   - Value: (paste the access token from Step 2)

### **Step 4: Push Code to GitHub**

The workflow will automatically:
1. Build the base image
2. Build all 6 service images
3. Push to Docker Hub

```bash
# In your worktree
cd /Users/jolipton/Projects/worldmonitor/.worktrees/relay-decomposition

# Commit the Docker Hub changes
git add .github/workflows/build-services.yml
git add services/docker-compose.prod.yml
git add services/.env.example
git commit -m "feat: configure Docker Hub for container registry"

# Push to GitHub
git push origin relay-decomposition
```

### **Step 5: Monitor Build**

1. Go to https://github.com/worldmonitor/worldmonitor/actions
2. Watch the **Build Relay Services** workflow
3. All 7 images should build and push to Docker Hub

### **Step 6: Verify on Docker Hub**

Check that images are available:
- https://hub.docker.com/r/worldmonitor/relay-base
- https://hub.docker.com/r/worldmonitor/relay-gateway
- https://hub.docker.com/r/worldmonitor/relay-orchestrator
- https://hub.docker.com/r/worldmonitor/relay-worker
- https://hub.docker.com/r/worldmonitor/relay-ais-processor
- https://hub.docker.com/r/worldmonitor/relay-ingest-telegram
- https://hub.docker.com/r/worldmonitor/relay-ai-engine

---

## 🔨 Option 2: Manual Build and Push

If you want to build and push manually from your local machine:

### **Step 1: Login to Docker Hub**

```bash
docker login
# Enter your Docker Hub username and password/token
```

### **Step 2: Build All Images**

```bash
cd /Users/jolipton/Projects/worldmonitor/.worktrees/relay-decomposition/services

# Build base image
docker build -f Dockerfile.base -t worldmonitor/relay-base:latest .

# Build service images
docker build -f gateway/Dockerfile -t worldmonitor/relay-gateway:latest .
docker build -f orchestrator/Dockerfile -t worldmonitor/relay-orchestrator:latest .
docker build -f worker/Dockerfile -t worldmonitor/relay-worker:latest .
docker build -f ais-processor/Dockerfile -t worldmonitor/relay-ais-processor:latest .
docker build -f ingest-telegram/Dockerfile -t worldmonitor/relay-ingest-telegram:latest .
docker build -f ai-engine/Dockerfile -t worldmonitor/relay-ai-engine:latest .
```

### **Step 3: Push All Images**

```bash
# Push base image
docker push worldmonitor/relay-base:latest

# Push service images
docker push worldmonitor/relay-gateway:latest
docker push worldmonitor/relay-orchestrator:latest
docker push worldmonitor/relay-worker:latest
docker push worldmonitor/relay-ais-processor:latest
docker push worldmonitor/relay-ingest-telegram:latest
docker push worldmonitor/relay-ai-engine:latest
```

### **Step 4: Verify**

Check Docker Hub (https://hub.docker.com/u/worldmonitor) to see all 7 images.

---

## 🚀 Deploying from Docker Hub

### **On Any Server with Docker:**

```bash
# Clone repo (or just copy docker-compose files)
git clone https://github.com/worldmonitor/worldmonitor.git
cd worldmonitor/services

# Create .env file
cp .env.example .env
nano .env  # Edit with your values

# Set your Docker Hub username (if different from 'worldmonitor')
echo "DOCKERHUB_USERNAME=worldmonitor" >> .env

# Pull and start
docker-compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

---

## 📦 Image Names on Docker Hub

After successful push, images are available as:

```
worldmonitor/relay-base:latest
worldmonitor/relay-gateway:latest
worldmonitor/relay-orchestrator:latest
worldmonitor/relay-worker:latest
worldmonitor/relay-ais-processor:latest
worldmonitor/relay-ingest-telegram:latest
worldmonitor/relay-ai-engine:latest
```

And also tagged with commit SHA:
```
worldmonitor/relay-gateway:<commit-sha>
...
```

---

## 🔄 Updating Images

### **Automatic (GitHub Actions):**

Every push to `main` that changes `services/**` will:
1. Build new images
2. Tag with commit SHA and `latest`
3. Push to Docker Hub

### **Manual Update on Server:**

```bash
# Pull latest images
docker-compose -f docker-compose.yml -f docker-compose.prod.yml pull

# Restart with new images
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Clean up old images
docker image prune -f
```

---

## 🎯 Image Size Optimization (Optional)

Current base image uses `node:22-alpine` which is already optimized.

If you want smaller images, consider:
1. Multi-stage builds (already implemented)
2. `.dockerignore` (already configured)
3. Remove dev dependencies (`--omit=dev` already used)

---

## 🔐 Security Best Practices

1. **Never push images with secrets**
   - All secrets via environment variables
   - No hardcoded credentials in images

2. **Scan images for vulnerabilities**
   ```bash
   docker scan worldmonitor/relay-gateway:latest
   ```

3. **Keep base image updated**
   - Rebuild periodically for security patches
   - GitHub Actions rebuilds on every push

4. **Use access tokens, not passwords**
   - Already configured in GitHub Actions
   - Rotate tokens every 90 days

---

## 🧪 Testing Images Locally

Before pushing to production:

```bash
# Pull your images
docker pull worldmonitor/relay-gateway:latest

# Run locally
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Test gateway
curl http://localhost:3004/health

# Check logs
docker-compose logs
```

---

## 📊 Monitoring Docker Hub

### **Image Stats:**
- View pull count: https://hub.docker.com/r/worldmonitor/relay-gateway
- Check image size
- See last updated time

### **Webhook Notifications (Optional):**

Set up webhooks to notify when images are pushed:
1. Go to https://hub.docker.com/r/worldmonitor/relay-gateway/settings/webhooks
2. Add webhook URL (e.g., Discord, Slack)
3. Get notified on every push

---

## 🆘 Troubleshooting

### **Login Fails:**
```bash
# If login fails, create access token at hub.docker.com
docker login --username worldmonitor
# Use token as password
```

### **Build Fails:**
```bash
# Check Dockerfile syntax
docker build -f Dockerfile.base -t test .

# Check build logs
docker-compose build --no-cache
```

### **Push Fails (Permission Denied):**
```bash
# Ensure you're logged in
docker login

# Ensure username in image tag matches Docker Hub username
docker tag relay-gateway:latest YOUR_USERNAME/relay-gateway:latest
docker push YOUR_USERNAME/relay-gateway:latest
```

### **GitHub Actions Fails:**
1. Verify secrets are set: Settings → Secrets → Actions
2. Check workflow logs for specific error
3. Ensure `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are correct

---

## 📝 Quick Commands Reference

```bash
# Build all images
docker-compose build

# Push all to Docker Hub (manual)
for service in gateway orchestrator worker ais-processor ingest-telegram ai-engine; do
  docker push worldmonitor/relay-$service:latest
done

# Pull from Docker Hub
docker-compose -f docker-compose.yml -f docker-compose.prod.yml pull

# Run production
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# View running containers
docker ps

# Stop all
docker-compose down

# Clean up
docker system prune -a
```

---

## ✅ Deployment Checklist

- [ ] Docker Hub account created
- [ ] Access token generated
- [ ] GitHub secrets configured (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`)
- [ ] Code pushed to GitHub (workflow runs automatically)
- [ ] Images visible on Docker Hub
- [ ] `.env` file configured on server
- [ ] Images pulled and containers started
- [ ] Health check passes (`/health` endpoint)
- [ ] Logs show no errors
- [ ] Services processing data correctly
