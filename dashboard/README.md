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
screen. The token lives in memory only and is cleared on disconnect.

## Deployment note

The API currently sends no CORS headers, so browsers block cross-origin
calls. Serve this dashboard same-origin with the API (reverse proxy) or
add `CORSMiddleware` server-side (requires a backend change, not done here).
Direct API use via curl is unaffected.

## Security rules enforced in this UI

- Token: memory-only React state + module scope. Never `localStorage`,
  never in URLs, never logged.
- Provider secrets: create form uses password inputs; list views render a
  client-side mask over secret-shaped keys even though the server already
  redacts them; secret values are never put in URLs or logs.
- Backup import is always dry-run first in the UI flow; apply is explicit.
- All server errors surface via toast with the server `detail` string.
