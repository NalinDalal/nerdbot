# Nerdbot 2.0 Browser / WebMCP / Computer

## Status

Implementation staged; no fake browser autonomy claimed. Existing capabilities: SSRF-guarded search/fetch, workspace gateway. `browser.automation` remains stub until isolated adapter is verified.

## Target architecture

- **Browser adapter interface**: `BrowserSessionManager` with isolated profile/container, explicit ownership, timeouts, audit events, artifact capture (screenshot/dom/a11y tree).
- **WebMCP**: expose read-only dashboard inspection tools first (`inspect_current_view`, `list_navigation`, `inspect_agent_status`, `inspect_capabilities`, `inspect_task_state`, `inspect_errors`, `inspect_responsive_state`); mutating tools require authorization.
- **Computer use**: only behind explicit feature flag and strong sandbox; default disabled.

## Security controls

- Isolated profile/container per session; no shared cookies.
- Credential refs only; never inject secrets/cookies/passwords into model context.
- Egress allow/deny + SSRF protections; block private/link-local metadata by default.
- Prompt-injection defenses: external page content treated as untrusted data, taint propagated.
- Tool-level permissions and approval before high-risk actions (form submit, publish, download to sensitive path, authenticated session use).
- Full action audit trail with evidence artifacts.

## WebMCP self-inspection

Use WebMCP for structured app interaction; browser automation for visual/layout/responsive/a11y verification. Read-only by default.
