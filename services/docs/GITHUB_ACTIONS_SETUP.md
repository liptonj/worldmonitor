# GitHub Actions Workflow - Complete Setup

## ✅ **What Was Added**

### **1. Workflow Dispatch (Manual Trigger)**
You can now manually trigger builds from GitHub UI with option to push or not.

### **2. Workflow File Trigger**
Changes to `.github/workflows/build-services.yml` now trigger rebuilds.

---

## 🚀 **Three Ways to Trigger Builds**

### **1. Automatic - Push to Main** ✅
```bash
# Edit any file in services/
vim services/gateway/index.cjs

# Commit and push
git commit -am "fix: update gateway"
git push origin main

# → Automatically builds and pushes to Docker Hub
```

**Triggers when:**
- Push to `main` branch
- Changes in `services/**` OR `.github/workflows/build-services.yml`

**Result:**
- ✅ Builds all images
- ✅ Pushes to Docker Hub
- ✅ Tags with SHA and `latest`

---

### **2. Automatic - Pull Request** ✅
```bash
# Create feature branch
git checkout -b feat/new-feature
vim services/worker/index.cjs
git push origin feat/new-feature

# Open PR → builds automatically
```

**Triggers when:**
- PR opened/updated to `main`
- Changes in `services/**` OR `.github/workflows/build-services.yml`

**Result:**
- ✅ Builds all images (validates)
- ❌ Does NOT push to Docker Hub
- ✅ Shows CI check on PR

---

### **3. Manual - Workflow Dispatch** ✅ **NEW!**

**How to use:**
1. Go to: https://github.com/worldmonitor/worldmonitor/actions
2. Click "Build Relay Services" (left sidebar)
3. Click "Run workflow" button (top right)
4. Select:
   - **Branch**: `main`, `relay-decomposition`, or any branch
   - **Push images to Docker Hub**: `true` or `false`
5. Click "Run workflow"

**Options:**

| Push Images | What Happens |
|-------------|--------------|
| `true` | Builds AND pushes to Docker Hub |
| `false` | Builds only (test without pushing) |

**Use cases:**
- ✅ Force rebuild without code changes
- ✅ Test builds on feature branch
- ✅ Rebuild after Docker Hub issue
- ✅ Test workflow changes before merging

---

## 🎯 **Trigger Summary**

| Scenario | Method | Builds | Pushes |
|----------|--------|--------|--------|
| Push code to `main` | Automatic | ✅ | ✅ |
| Open PR to `main` | Automatic | ✅ | ❌ |
| Manual (push=true) | Manual | ✅ | ✅ |
| Manual (push=false) | Manual | ✅ | ❌ |

---

## 📂 **Files That Trigger Builds**

**These changes trigger automatic builds:**

```
services/                                    ✅ Triggers
├── Dockerfile.base                          ✅ Triggers
├── docker-compose.yml                       ✅ Triggers
├── docker-compose.prod.yml                  ✅ Triggers
├── shared/                                  ✅ Triggers
├── proto/                                   ✅ Triggers
├── gateway/                                 ✅ Triggers
├── orchestrator/                            ✅ Triggers
├── worker/                                  ✅ Triggers
├── ais-processor/                           ✅ Triggers
├── ingest-telegram/                         ✅ Triggers
└── ai-engine/                               ✅ Triggers

.github/workflows/build-services.yml         ✅ Triggers (NEW!)

docs/                                        ❌ No trigger
src/                                         ❌ No trigger
api/                                         ❌ No trigger
```

---

## 🔧 **Setup Required**

Before workflows can push to Docker Hub, add GitHub secrets:

1. Go to: https://github.com/worldmonitor/worldmonitor/settings/secrets/actions
2. Click "New repository secret"
3. Add:
   - **Name**: `DOCKERHUB_USERNAME`
   - **Value**: `sliptronic`
4. Click "Add secret"
5. Add second secret:
   - **Name**: `DOCKERHUB_TOKEN`
   - **Value**: (get from https://hub.docker.com/settings/security)
6. Click "Add secret"

---

## 📊 **Example Workflows**

### **Example 1: Normal Development**
```bash
# Create feature branch
git checkout -b feat/add-caching
vim services/gateway/index.cjs

# Push and open PR
git push origin feat/add-caching
# → PR build validates (no push)

# Merge PR
# → Main build pushes to Docker Hub
```

### **Example 2: Hotfix**
```bash
git checkout main
vim services/orchestrator/index.cjs
git commit -am "fix: critical bug"
git push origin main
# → Automatic build and push
```

### **Example 3: Test Experimental Branch**
```bash
git checkout -b experiment/refactor
# ... make changes ...
git push origin experiment/refactor

# Manual dispatch:
# Branch: experiment/refactor
# Push: false
# → Validates build, no push
```

### **Example 4: Force Rebuild**
```bash
# No code changes, but want to rebuild
# (e.g., base image updated, dependency fix)

# Manual dispatch:
# Branch: main
# Push: true
# → Rebuilds and pushes everything
```

---

## ✅ **Verification**

After setup, verify:

```bash
# 1. Make a test change
cd services
echo "// test" >> gateway/index.cjs
git commit -am "test: trigger workflow"
git push origin main

# 2. Watch workflow run
# Go to: https://github.com/worldmonitor/worldmonitor/actions

# 3. Verify on Docker Hub
# Check: https://hub.docker.com/r/sliptronic/worldrelay_gateway/tags
```

---

## 📖 **Documentation Files**

- **This file**: Complete setup guide
- **`github-actions-triggers.md`**: Detailed trigger documentation
- **`DOCKER_HUB_QUICKSTART.md`**: Docker Hub deployment guide
- **`docker-hub-deployment.md`**: Full deployment documentation

---

## 🎉 **Complete Features**

✅ Automatic builds on push to main  
✅ Automatic validation on PRs  
✅ Manual trigger with push option  
✅ Triggers on workflow file changes  
✅ Smart path filtering (`services/**`)  
✅ Concurrency control (cancels old runs)  
✅ GitHub Actions caching  
✅ Docker Hub integration  
✅ Multi-service matrix builds  
✅ SHA and latest tagging  

**Everything is production-ready!** 🚀
