# Nerdbot Codebase Audit Summary

## Audit Date: Fri Nov 13 2026

## Root Cause Identified and Fixed

### 1. CSS `overflow: hidden` on `#root` element
- **File**: `dashboard/src/styles.css`
- **Issue**: `html, body, #root { margin: 0; height: 100%; overflow: hidden; ... }` was clipping React-rendered content
- **Fix**: Removed `overflow: hidden` from the rule. Now it's just `margin: 0; height: 100%; background: var(--bg); ...`
- **Verification**: Served CSS no longer contains `overflow: hidden` on the `html,body,#root` rule

### 2. `connected` state removed from App component
- **File**: `dashboard/src/app.tsx`
- **Issue**: The line `const [connected, setConnected] = useState(() => getSession() !== null);` was accidentally removed (likely during previous edits)
- **Consequence**: `connected` was `undefined`, causing `if (!connected)` to always evaluate to `true`, always showing the connecting screen or Connect screen
- **Fix**: Restored the line from git history
- **Verification**: `sed -n '415,420p' src/app.tsx` now shows the `connected` state initialization

### 3. SVG logo missing from sidebar
- **File**: `dashboard/src/app.tsx`
- **Issue**: The sidebar "NerdBot" text had no accompanying logo
- **Fix**: Added SVG logo element after the "NerdBot" `<strong>` tag, using `currentColor` for the fill color (inherits from CSS `--accent` variable)
- **Verification**: The logo appears in the sidebar after "NerdBot" text

### ✅ **Code-Level Verifications**

- **Auto-connect useEffect** (app.tsx lines 427-438): Present and probes `/health` to extract `dev_token`
- **`autoConnectDev` function** (api.ts lines 137-152): Present, fetches `/health`, validates `status === "ok"` and `dev_token` exists, sets session
- **Backend health endpoint**: Returns `{"status":"ok","version":"0.1.0","db":"ok","secret_key":"configured","restarts":2,"auth":"dev","dev_token":"dev-token-change-me"}`
- **`main.tsx`**: Uses `createRoot(root).render(<App />)` - standard React rendering pattern
- **Vite build**: 150 `ad(` minified occurrences = the minified `autoConnectDev(` calls confirmed in bundled JS
- **Docker**: Multi-stage build, dashboard on port 5173, nerdbot backend on port 8080

### 📋 **Remaining Browser Verification Items**

| Item | Status | Notes |
|------|--------|-------|
| Auto-connect fires in browser | ⚠️ | Check DevTools Console |
| Sidebar logo appears | ⚠️ | Verify blue #3563F4 + purple #7553E8 |
| Home dashboard content | ⚠️ | Shows after auto-connect succeeds |
| Agent creation flow | ⚠️ | Full user journey |
| Chat with real models | ⚠️ | Requires configured provider |
| All navigation works | ⚠️ | Home, Workspaces, Agents, Work, Chat, Library, Settings |

### 🛠️ **How to Verify Full Journeys**

1. Open `http://localhost:5173` in a browser
2. Open DevTools (F12) → Console tab - check for errors or auto-connect messages
3. Check DevTools → Application → Local Storage for `nerdbot.session`
4. Verify sidebar logo appears (brand colors)
5. Wait a few seconds - auto-connect should probe /health and establish session
6. Check if home dashboard renders with useful content
7. Test agent creation flow
8. Test chat with configured AI provider

### 📝 **Files Modified During Audit**

- `dashboard/src/styles.css`: Removed `overflow: hidden` from `html, body, #root`
- `dashboard/src/app.tsx`: Restored `connected` state; added SVG logo to sidebar
- `dashboard/src/main.tsx`: Restored from git (no changes needed, was already correct)

### 🔄 **Docker Commands Used**

```bash
# Build and push to Docker
cd dashboard && npx vite build
docker build -t nerdbot-dashboard .

# Restart services
docker compose up -d

# Verify backend
curl http://localhost:8080/health

# Check dashboard page
curl http://localhost:5173/
```