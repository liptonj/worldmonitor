# GitHub Actions Workflow Triggers

The `Build Relay Services` workflow can be triggered in three ways:

---

## 1. ✅ Automatic on Push (Production Builds)

**Triggers when:**
- Push to `main` branch
- Changes detected in:
  - `services/**` (any service code)
  - `.github/workflows/build-services.yml` (the workflow itself)

**Behavior:**
- Builds all images
- **Pushes to Docker Hub** automatically
- Tags with commit SHA and `latest`

**Example:**
```bash
# Edit a service file
echo "// update" >> services/gateway/index.cjs

# Commit and push
git add services/gateway/index.cjs
git commit -m "fix: update gateway"
git push origin main

# GitHub Actions automatically builds and pushes
```

---

## 2. ✅ Automatic on Pull Request (Test Builds)

**Triggers when:**
- PR opened/updated to `main` branch
- Changes detected in:
  - `services/**`
  - `.github/workflows/build-services.yml`

**Behavior:**
- Builds all images
- **Does NOT push** to Docker Hub
- Validates builds work correctly
- Shows CI check status on PR

**Example:**
```bash
# Create feature branch
git checkout -b feat/new-service
echo "// new feature" >> services/worker/index.cjs
git commit -am "feat: add new feature"
git push origin feat/new-service

# Open PR → GitHub Actions validates build (no push)
```

---

## 3. ✅ Manual Dispatch (On-Demand Builds)

**Triggers:** Manually via GitHub UI

**Options:**
- **Push images to Docker Hub**: Yes/No dropdown

### **How to Run:**

1. Go to: https://github.com/worldmonitor/worldmonitor/actions
2. Click **"Build Relay Services"** workflow (left sidebar)
3. Click **"Run workflow"** button (top right)
4. Select branch: `main`, `relay-decomposition`, or any branch
5. Choose **"Push images to Docker Hub"**:
   - **`true`** - Build AND push to Docker Hub
   - **`false`** - Build only (test without pushing)
6. Click **"Run workflow"** to start

### **Use Cases:**

**Scenario 1: Force rebuild without code changes**
```
Branch: main
Push images: true
→ Rebuilds everything, pushes to Docker Hub
```

**Scenario 2: Test builds on feature branch**
```
Branch: feat/my-feature
Push images: false
→ Builds to verify it works, no push
```

**Scenario 3: Push from feature branch (testing)**
```
Branch: feat/experimental
Push images: true
→ Builds and pushes tagged with branch SHA
```

**Scenario 4: Rebuild after Docker Hub issue**
```
Branch: main
Push images: true
→ Re-pushes all images with current SHA
```

---

## 📊 Trigger Comparison

| Trigger | When | Builds | Pushes | Use Case |
|---------|------|--------|--------|----------|
| **Push to main** | Auto | ✅ | ✅ | Production deployment |
| **Pull Request** | Auto | ✅ | ❌ | CI validation |
| **Dispatch (push=true)** | Manual | ✅ | ✅ | Force rebuild, test branch |
| **Dispatch (push=false)** | Manual | ✅ | ❌ | Test builds only |

---

## 🔍 Monitoring Workflow Runs

### **View Active Runs:**
https://github.com/worldmonitor/worldmonitor/actions

### **Check Logs:**
1. Click on a workflow run
2. Click on job name (`build-base` or `build-services`)
3. Expand steps to see detailed logs

### **Cancel Running Workflow:**
- Only one workflow per branch runs at a time (concurrency control)
- New runs auto-cancel old runs for same branch

---

## 🛠️ Workflow Configuration

### **Files that trigger build:**
```yaml
paths:
  - 'services/**'                          # Any service code
  - '.github/workflows/build-services.yml' # Workflow itself
```

### **Branches monitored:**
```yaml
branches: [main]
```

### **Push conditions:**
```yaml
# Pushes when:
push: ${{ 
  (github.event_name == 'push') || 
  (github.event_name == 'workflow_dispatch' && inputs.push_images == 'true') 
}}
```

---

## 🚨 Troubleshooting

### **Workflow doesn't trigger on push:**
- ✅ Check if changes are in `services/` directory
- ✅ Ensure branch is `main`
- ✅ Check if another run is in progress (cancels old runs)

### **Manual dispatch doesn't appear:**
- ✅ Ensure workflow file is on the branch you're viewing
- ✅ Refresh the Actions page
- ✅ Check you have repository permissions

### **Push fails with authentication error:**
- ✅ Verify GitHub secrets exist:
  - `DOCKERHUB_USERNAME` = `sliptronic`
  - `DOCKERHUB_TOKEN` = (valid Docker Hub access token)
- ✅ Check token hasn't expired
- ✅ Verify token has push permissions

### **Build succeeds but images not on Docker Hub:**
- ✅ Check if `push_images` was set to `false` (manual dispatch)
- ✅ Check if it was a PR build (never pushes)
- ✅ Check Docker Hub repository exists
- ✅ Verify network/Docker Hub wasn't down during push

---

## 📝 Examples

### **Example 1: Hotfix deployment**
```bash
# Make urgent fix
git checkout main
echo "// hotfix" >> services/gateway/index.cjs
git commit -am "fix: critical gateway bug"
git push origin main

# Automatically builds and deploys to Docker Hub
# No manual intervention needed
```

### **Example 2: Test experimental changes**
```bash
# Create experiment branch
git checkout -b experiment/new-architecture
# ... make changes to services/ ...
git push origin experiment/new-architecture

# Manual dispatch:
# Branch: experiment/new-architecture
# Push images: false
# → Validates build without affecting production images
```

### **Example 3: Rebuild after dependency update**
```bash
# Updated a dependency but no code change
# Use manual dispatch:
# Branch: main
# Push images: true
# → Forces full rebuild and push
```

---

## ✅ Best Practices

1. **Use automatic builds for production** - Let push to main handle deployments
2. **Test with PRs first** - Always open PR to validate builds
3. **Use manual dispatch sparingly** - Only for special cases (force rebuild, test branches)
4. **Monitor workflow runs** - Check Actions tab after push
5. **Set up status checks** - Require workflow to pass before merging PRs

---

## 🔗 Quick Links

- **Workflows**: https://github.com/worldmonitor/worldmonitor/actions
- **Workflow File**: `.github/workflows/build-services.yml`
- **Docker Hub**: https://hub.docker.com/u/sliptronic
- **GitHub Secrets**: https://github.com/worldmonitor/worldmonitor/settings/secrets/actions
