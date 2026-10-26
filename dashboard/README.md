# NerdBot Ops Dashboard

Read-mostly operations UI for the NerdBot API. No backend changes were made
for this slice; the dashboard is a pure API consumer.

## Run

```bash
cd dashboard
npm install
npm run dev      # local dev server
npm run build    # typecheck + production build
npm run lint     # eslint, zero warnings allowed
npm test         # mocked API contract tests (no network, no backend needed)
```

Configure the API base URL and paste the bearer token on the connect
screen. The session (base URL + token) is persisted to this browser's
`localStorage` under `nerdbot.session`, so a reload stays connected;
Disconnect removes it.

## Deployment note

The API currently sends no CORS headers, so browsers block cross-origin
calls. Serve this dashboard same-origin with the API (reverse proxy) or
add `CORSMiddleware` server-side (requires a backend change, not done here).
Direct API use via curl is unaffected.

## Security rules enforced in this UI

- Token: React state + module scope, persisted to this browser's
  `localStorage` (`nerdbot.session`) so a reload stays connected.
  Disconnect removes the key. Never in URLs, never logged. This is a
  single-owner local UI — do not use a shared browser profile.
- Provider secrets: create form uses password inputs; list views render a
  client-side mask over secret-shaped keys even though the server already
  redacts them; secret values are never put in URLs or logs.
- Backup import is always dry-run first in the UI flow; apply is explicit.
- All server errors surface via toast with the server `detail` string.
