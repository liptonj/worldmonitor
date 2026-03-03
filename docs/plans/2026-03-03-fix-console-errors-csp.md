# Fix Console Errors + Hide Token-Gated Panels

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** (1) Fix the CSP console error caused by a JSON-LD script hash not being injected into the `script-src` directive, and (2) hide panels entirely on desktop when their required API token is not configured — instead of showing an error/empty placeholder.

**Architecture:**
- **CSP fix:** `htmlVariantPlugin` in `vite.config.ts` modifies the JSON-LD `featureList` at build time, producing a hash that isn't in the hardcoded CSP meta tag. A new `cspHashPlugin` runs post-transform, extracts all inline script hashes, and injects them into the CSP via a sentinel token.
- **Panel hiding:** Add a `requiredFeature?: RuntimeFeatureId` field to `PanelConfig`. In `applyPanelSettings()` (panel-layout.ts), if the panel's `requiredFeature` is not available on desktop, call `panel.hide()` directly. In `data-loader.ts` remove the `showConfigError` calls for token-missing cases (they become redundant). Panels currently showing "not configured" messages get hidden instead.

**Tech Stack:** TypeScript, Vite 5, Node.js `crypto` (built-in), `src/types/index.ts`, `src/config/panels.ts`, `src/app/panel-layout.ts`, `src/app/data-loader.ts`, `src/components/EconomicPanel.ts`, `src/components/TradePolicyPanel.ts`, `src/components/SupplyChainPanel.ts`, `vite.config.ts`, `index.html`.

---

## What the Console Errors Actually Are

| Error | Fixable? | Fix |
|---|---|---|
| `CSP: inline script blocked (sha256-Op9U4c...)` | **YES** | `cspHashPlugin` injects JSON-LD hash at build time |
| Panels showing "not configured" placeholder when token missing | **YES** | Hide panel entirely via `requiredFeature` in `PanelConfig` |
| EONET `503 Service Unavailable` | No — upstream | Already handled by `Promise.allSettled` |
| RSS-proxy `504` (AU Smartraveller/DNT/Reconsider) | No — upstream | Already handled by `Promise.allSettled` |
| GDELT-Intel `RPC error: internal error` | No — upstream | Already handled, logs `console.warn` not `console.error` |
| `apple-touch-icon.png 404` from `info.5ls.us` | No — external | External favicon proxy, not our code |

---

## Affected Panels for Token-Gating

| Panel Key | Required Feature | Required Secret(s) | Current Behavior | New Behavior |
|---|---|---|---|---|
| `markets` + `heatmap` | `finnhubMarkets` | `FINNHUB_API_KEY` | `showConfigError(...)` | hidden |
| `satellite-fires` | `nasaFirms` | `NASA_FIRMS_API_KEY` | `showConfigError(...)` | hidden |
| `economic` | `economicFred` | `FRED_API_KEY` | `setErrorState(true, ...)` | hidden |
| `trade-policy` | `wtoTrade` | `WTO_API_KEY` | `setContent(<empty>)` | hidden |
| `supply-chain` | `supplyChain` | `FRED_API_KEY` | `return <empty>` | hidden |

**Scope:** Desktop runtime only (`isDesktopRuntime()`). On web, all secrets are server-side and panels always display.

---

## Task 1: Add `requiredFeature` to `PanelConfig` type

**Files:**
- Modify: `src/types/index.ts` around line 496

**Step 1: Verify current PanelConfig definition**

```bash
grep -n "PanelConfig" src/types/index.ts
```

Expected: `export interface PanelConfig` with `name`, `enabled`, `priority?`.

**Step 2: Add `requiredFeature` field**

Change:
```typescript
export interface PanelConfig {
  name: string;
  enabled: boolean;
  priority?: number;
}
```

To:
```typescript
export interface PanelConfig {
  name: string;
  enabled: boolean;
  priority?: number;
  requiredFeature?: RuntimeFeatureId;
}
```

You'll need to import `RuntimeFeatureId`. Add at the top of the relevant section or import from the config module. Check what's already imported in `src/types/index.ts`:

```bash
grep -n "import" src/types/index.ts | head -10
```

If `RuntimeFeatureId` isn't already imported, add:
```typescript
import type { RuntimeFeatureId } from '@/services/runtime-config';
```

**Step 3: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: zero new errors.

**Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add requiredFeature field to PanelConfig type"
```

---

## Task 2: Set `requiredFeature` on token-gated panels in `panels.ts`

**Files:**
- Modify: `src/config/panels.ts`

**Step 1: Read the current panel config for the affected panels**

```bash
grep -n "satellite-fires\|economic\|trade-policy\|supply-chain\|markets\|heatmap" src/config/panels.ts
```

Note the exact keys and current config objects.

**Step 2: Update the affected panel configs**

Find each panel in `FULL_PANELS` (and equivalent in other variant configs if present) and add `requiredFeature`:

```typescript
// Before
'satellite-fires': { name: 'Fires', enabled: true, priority: 2 },
'economic': { name: 'Economic Indicators', enabled: true, priority: 1 },
'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1 },
'supply-chain': { name: 'Supply Chain', enabled: true, priority: 1 },
'markets': { name: 'Markets', enabled: true, priority: 1 },
'heatmap': { name: 'Sector Heatmap', enabled: true, priority: 2 },

// After
'satellite-fires': { name: 'Fires', enabled: true, priority: 2, requiredFeature: 'nasaFirms' },
'economic': { name: 'Economic Indicators', enabled: true, priority: 1, requiredFeature: 'economicFred' },
'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1, requiredFeature: 'wtoTrade' },
'supply-chain': { name: 'Supply Chain', enabled: true, priority: 1, requiredFeature: 'supplyChain' },
'markets': { name: 'Markets', enabled: true, priority: 1, requiredFeature: 'finnhubMarkets' },
'heatmap': { name: 'Sector Heatmap', enabled: true, priority: 2, requiredFeature: 'finnhubMarkets' },
```

Check if these panels also appear in other variant configs (tech, finance, happy) and add `requiredFeature` there too if applicable.

**Step 3: Add the RuntimeFeatureId import to panels.ts**

```bash
head -5 src/config/panels.ts
```

Add if not present:
```typescript
import type { RuntimeFeatureId } from '@/services/runtime-config';
```

Wait — `panels.ts` currently imports from `@/types` and `@/config/variant`. Check if the import would cause a circular dependency:

```bash
grep -n "import" src/config/panels.ts
```

If circular dependency risk (types → runtime-config → panels), instead inline the type in PanelConfig as `string` with a JSDoc note, or ensure the import is `import type` only (no runtime cost). Using `import type` avoids circular dependency at runtime.

**Step 4: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: zero new errors.

**Step 5: Commit**

```bash
git add src/config/panels.ts
git commit -m "feat: add requiredFeature to token-gated panel configs"
```

---

## Task 3: Enforce `requiredFeature` in `applyPanelSettings`

**Files:**
- Modify: `src/app/panel-layout.ts` around line 318

**Step 1: Read the current `applyPanelSettings` method**

```bash
sed -n '315,335p' src/app/panel-layout.ts
```

Current code:
```typescript
applyPanelSettings(): void {
  Object.entries(this.ctx.panelSettings).forEach(([key, config]) => {
    if (key === 'map') {
      const mapSection = document.getElementById('mapSection');
      if (mapSection) {
        mapSection.classList.toggle('hidden', !config.enabled);
      }
      return;
    }
    const panel = this.ctx.panels[key];
    panel?.toggle(config.enabled);
  });
}
```

**Step 2: Update `applyPanelSettings` to hide token-gated panels on desktop**

```typescript
applyPanelSettings(): void {
  Object.entries(this.ctx.panelSettings).forEach(([key, config]) => {
    if (key === 'map') {
      const mapSection = document.getElementById('mapSection');
      if (mapSection) {
        mapSection.classList.toggle('hidden', !config.enabled);
      }
      return;
    }
    const panel = this.ctx.panels[key];
    if (!panel) return;

    // On desktop, hide panels whose required feature is not available (missing token).
    // On web, all features are available server-side — always respect user's enabled setting.
    if (isDesktopRuntime() && config.requiredFeature && !isFeatureAvailable(config.requiredFeature)) {
      panel.hide();
      return;
    }

    panel.toggle(config.enabled);
  });
}
```

**Step 3: Add required imports to panel-layout.ts**

```bash
grep -n "import" src/app/panel-layout.ts | head -10
```

Add if not present:
```typescript
import { isDesktopRuntime } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';
```

**Step 4: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: zero new errors.

**Step 5: Commit**

```bash
git add src/app/panel-layout.ts
git commit -m "feat: hide token-gated panels on desktop when feature unavailable"
```

---

## Task 4: Remove Redundant "Not Configured" Error Messages in data-loader.ts

Now that panels hide themselves when the token is missing, the `showConfigError` / `setErrorState` calls for missing token cases in `data-loader.ts` are redundant (the panel is hidden, so nobody sees those messages anyway). Clean them up.

**Files:**
- Modify: `src/app/data-loader.ts`

**Step 1: Find all instances to remove**

```bash
grep -n "showConfigError\|not configured\|isFeatureAvailable" src/app/data-loader.ts
```

**Step 2: Remove the Finnhub "not configured" message from `loadMarkets`**

Find around line 946-950:
```typescript
} else if (stocksResult.skipped) {
  this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
  if (stocksResult.data.length === 0) {
    this.ctx.panels['markets']?.showConfigError(finnhubConfigMsg);
  }
}
```

Remove the `showConfigError` call (keep the status panel update — that's in the StatusPanel overlay, not the grid panel):
```typescript
} else if (stocksResult.skipped) {
  this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
}
```

Also remove the `finnhubConfigMsg` variable declaration on line ~939 if it's no longer used after this change.

**Step 3: Remove the NASA FIRMS "not configured" message from `loadFirmsData`**

Find around line 2016-2018:
```typescript
if (fireResult.skipped) {
  this.ctx.panels['satellite-fires']?.showConfigError('NASA_FIRMS_API_KEY not configured — add in Settings');
  this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
  return;
}
```

Change to (keep status update, remove panel message):
```typescript
if (fireResult.skipped) {
  this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
  return;
}
```

**Step 4: Remove the FRED "not configured" error state from the economic panel load path**

Find around line 1801-1802:
```typescript
if (!isFeatureAvailable('economicFred')) {
  economicPanel?.setErrorState(true, 'FRED_API_KEY not configured — add in Settings');
```

Change to (panel is hidden when FRED unavailable, so just return):
```typescript
if (!isFeatureAvailable('economicFred')) {
  return;
```

Also check line ~1826 where `isFeatureAvailable('economicFred')` is used again — that guard is for conditionally loading FRED data, which is still correct and should remain.

**Step 5: Clean up the heatmap showConfigError if present**

```bash
grep -n "heatmap.*showConfigError\|showConfigError.*heatmap" src/app/data-loader.ts
```

Remove any such line found.

**Step 6: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: zero new errors.

**Step 7: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "refactor: remove redundant 'not configured' error messages for hidden panels"
```

---

## Task 5: Remove Redundant Token Guards Inside Panel Render Methods

Now that panels hide at the layout level, the token guards inside `EconomicPanel`, `TradePolicyPanel`, and `SupplyChainPanel` are dead code (panel is hidden before render is called). Remove them.

**Files:**
- Modify: `src/components/EconomicPanel.ts` around line 133
- Modify: `src/components/TradePolicyPanel.ts` around line 57
- Modify: `src/components/SupplyChainPanel.ts` around line 114

**Step 1: Remove the guard in EconomicPanel**

Find:
```typescript
if (isDesktopRuntime() && !isFeatureAvailable('economicFred')) {
  return `<div class="economic-empty">${t('components.economic.fredKeyMissing')}</div>`;
}
```

Delete those 3 lines entirely. If `isFeatureAvailable` is no longer used in `EconomicPanel.ts` after removal, also remove that import.

**Step 2: Remove the guard in TradePolicyPanel**

Find:
```typescript
if (isDesktopRuntime() && !isFeatureAvailable('wtoTrade')) {
  this.setContent(`<div class="economic-empty">${t('components.tradePolicy.apiKeyMissing')}</div>`);
  return;
}
```

Delete those 4 lines. Remove the `isFeatureAvailable` import if no longer used.

**Step 3: Remove the guard in SupplyChainPanel**

Find:
```typescript
if (isDesktopRuntime() && !isFeatureAvailable('supplyChain')) {
  return `<div class="economic-empty">${t('components.supplyChain.fredKeyMissing')}</div>`;
}
```

Delete those 3 lines. Remove the `isFeatureAvailable` import if no longer used.

**Step 4: Type-check and lint check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

```bash
# Check for unused imports (tsc should catch these)
grep -n "isFeatureAvailable\|isDesktopRuntime" src/components/EconomicPanel.ts src/components/TradePolicyPanel.ts src/components/SupplyChainPanel.ts
```

Each file should either have 0 references (import should be removed) or still have other uses of the function.

**Step 5: Commit**

```bash
git add src/components/EconomicPanel.ts src/components/TradePolicyPanel.ts src/components/SupplyChainPanel.ts
git commit -m "refactor: remove dead token guards from panel render methods"
```

---

## Task 6: Fix CSP — Add JSON-LD Hash Injection via Vite Plugin

**Files:**
- Modify: `index.html` line 6 (CSP meta tag)
- Modify: `vite.config.ts` (add `cspHashPlugin`, add `import { createHash } from 'crypto'`)

### Part A: Add sentinel token to index.html

**Step 1: Verify the CSP script-src in index.html**

```bash
python3 -c "
with open('index.html') as f:
    for i, line in enumerate(f, 1):
        if 'Content-Security-Policy' in line:
            print(f'Line {i}:', line[:120])
"
```

**Step 2: Insert `__JSON_LD_CSP_HASHES__` into script-src**

In the `script-src` directive, insert the sentinel **before** the first existing `'sha256-` hash, separated by a space:

Change:
```
script-src 'self' 'sha256-LnMFPWZx...
```

To:
```
script-src 'self' __JSON_LD_CSP_HASHES__ 'sha256-LnMFPWZx...
```

The sentinel has no quotes — it will be replaced by the plugin with `'sha256-HASH='` tokens.

**Step 3: Verify**

```bash
grep "__JSON_LD_CSP_HASHES__" index.html && echo "PASS" || echo "FAIL"
```

### Part B: Add cspHashPlugin to vite.config.ts

**Step 1: Add crypto import at the top of vite.config.ts**

```bash
head -10 vite.config.ts
```

Add after the existing imports:
```typescript
import { createHash } from 'crypto';
```

**Step 2: Add the plugin function before `devCspStripPlugin` (around line 570)**

```typescript
function cspHashPlugin(): Plugin {
  return {
    name: 'csp-hash-inject',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html: string): string {
        const hashes: string[] = [];
        const re = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
          const content = m[1];
          if (content.trim()) {
            const hash = createHash('sha256').update(content, 'utf8').digest('base64');
            hashes.push(`'sha256-${hash}'`);
          }
        }
        return html.replace('__JSON_LD_CSP_HASHES__', hashes.join(' '));
      },
    },
  };
}
```

**Step 3: Register `cspHashPlugin()` in the plugins array**

In the `plugins: [` array, add `cspHashPlugin()` directly after `htmlVariantPlugin()`:

```typescript
plugins: [
  devCspStripPlugin(),
  htmlVariantPlugin(),
  cspHashPlugin(),   // ← add here
  polymarketPlugin(),
  // ... rest unchanged
```

**Step 4: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add index.html vite.config.ts
git commit -m "feat: auto-inject JSON-LD CSP hashes at build time via cspHashPlugin"
```

---

## Task 7: Verify Everything with a Local Build

**Files:** None (verification only)

**Step 1: Build**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds without errors.

**Step 2: Verify CSP sentinel is replaced in dist**

```bash
python3 << 'EOF'
import re, hashlib, base64

with open('dist/index.html') as f:
    html = f.read()

# Sentinel should be gone
assert '__JSON_LD_CSP_HASHES__' not in html, 'FAIL: sentinel still in dist'
print('PASS: sentinel replaced')

# All inline scripts should have their hash in the CSP
csp_m = re.search(r'Content-Security-Policy[^"]*"([^"]+)"', html)
assert csp_m, 'FAIL: no CSP meta found'
csp = csp_m.group(1)

scripts = [s for s in re.findall(r'<script[^>]*>([^]*?)</script>', html) if s.strip()]
print(f'Found {len(scripts)} inline scripts')

for i, s in enumerate(scripts):
    h = "sha256-" + base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()
    ok = f"'{h}'" in csp
    print(f"{'PASS' if ok else 'FAIL'}: script {i+1} hash in CSP")
EOF
```

Expected:
```
PASS: sentinel replaced
Found 2 inline scripts
PASS: script 1 hash in CSP
PASS: script 2 hash in CSP
```

**Step 3: Verify no panels remain with token-missing error states in desktop build**

This is logic-level — confirm by code inspection:
```bash
grep -n "not configured\|apiKeyMissing\|fredKeyMissing\|showConfigError.*KEY" src/components/*.ts src/app/data-loader.ts
```

Expected: zero results (all removed in Tasks 4 and 5).

**Step 4: Final type-check**

```bash
npx tsc --noEmit 2>&1
```

Expected: zero errors.

---

## Deslop Checklist (Run Before Each Commit)

```bash
# 1. No hardcoded secrets
grep -rn "sk_live\|AKIA\|ghp_\|eyJ" src/ --include="*.ts"

# 2. No debug console.log left in
grep -n "console.log\b" src/app/panel-layout.ts src/types/index.ts vite.config.ts 2>/dev/null

# 3. No unused imports introduced
npx tsc --noEmit 2>&1 | grep "is declared but"

# 4. No commented-out code blocks
grep -rn "// TODO\|// FIXME\|// HACK\|// XXX\|/\*\*\* " src/app/panel-layout.ts src/types/index.ts src/config/panels.ts 2>/dev/null
```

---

## Notes

- **Web runtime is unaffected.** All `requiredFeature` / token gating uses `isDesktopRuntime()` guard — on web, features are always available server-side.
- **The `cspHashPlugin` hashes ALL inline scripts**, so the four existing hardcoded theme-script hashes in the CSP become redundant (they are already covered). They can be removed in a follow-up cleanup — leave them for now to avoid scope creep.
- **GDELT/EONET/RSS 504 errors** are upstream failures, not bugs. They don't need fixes.
