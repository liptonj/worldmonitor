# Gateway CORS Verification — Admin Cache Routes

**Task 8: CORS and access headers cleanup**

This document records the verification that the gateway CORS configuration correctly allows the admin portal to access admin cache routes (`/admin/cache/*`).

---

## Step 1: Code Review — CORS Configuration

**File:** `services/gateway/index.cjs`

### OPTIONS Preflight Handler (lines 299–306)

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| `Access-Control-Allow-Origin: *` | ✓ | `CORS_HEADER` / `CORS_VALUE` |
| `Access-Control-Allow-Methods: GET, DELETE, OPTIONS` | ✓ | Line 304 |
| `Access-Control-Allow-Headers: Authorization, Content-Type` | ✓ | Line 305 (`Content-Type, Authorization` — order is irrelevant for CORS) |

The OPTIONS handler runs for **all paths** before route-specific logic, so preflight requests to `/admin/cache/keys`, `/admin/cache/key/:key`, etc. receive the correct CORS headers.

### CORS Headers on Admin Routes

All admin cache responses use `jsonH` (line 331):

```javascript
const jsonH = { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
```

| Route | Method | CORS Headers |
|-------|--------|--------------|
| `/admin/cache/keys` | GET | ✓ `jsonH` |
| `/admin/cache/key/:key` | GET | ✓ `jsonH` |
| `/admin/cache/key/:key` | DELETE | ✓ `jsonH` |
| 401 Unauthorized | — | ✓ `CORS_HEADER` |
| 503 Admin not configured | — | ✓ `CORS_HEADER` |
| 404 Not found | — | ✓ `jsonH` |
| 500 Internal error | — | ✓ `jsonH` |

### Other Routes

- **405 Method not allowed** (line 311): includes `CORS_HEADER`
- **routeHttpRequest** (panel, bootstrap, map): uses `jsonHeaders` with `CORS_HEADER` (line 121)
- **GDELT proxy**: includes `CORS_HEADER` on all responses

---

## Step 2 & 3: Browser Testing (Manual)

To verify CORS in the browser:

1. Start the gateway: `cd services && npm run dev` (or equivalent)
2. Open the admin portal in a browser
3. Navigate to **Service Scheduling → Cache Viewer**
4. Open DevTools → Network tab
5. Inspect:
   - **OPTIONS** preflight to `/admin/cache/keys` — should return 204 with:
     - `Access-Control-Allow-Origin: *`
     - `Access-Control-Allow-Methods: GET, DELETE, OPTIONS`
     - `Access-Control-Allow-Headers: authorization, content-type` (or equivalent)
   - **GET** to `/admin/cache/keys` — should return 200 with:
     - `Access-Control-Allow-Origin: *`
     - `Content-Type: application/json`
   - **DELETE** (when invalidating a key) — should return 200 with CORS headers
6. Confirm no CORS errors in the console

---

## Step 4: Findings

**Result:** CORS is correctly configured. No code changes required.

### Self-Review Checklist

- [x] CORS headers present on OPTIONS preflight
- [x] CORS headers present on GET responses
- [x] CORS headers present on DELETE responses
- [x] Authorization header allowed in preflight
- [ ] No CORS errors in browser console (manual verification)
- [x] Any issues fixed and committed — N/A (no issues found)

### Commit

No commit required — verification only.
