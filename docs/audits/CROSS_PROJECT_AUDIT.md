# Cross-Project Audit

## Scope

Audited NerdBot plus available reference archives:

- `nerdbot` (current product)
- `nerdbot-backups` (bundles/patches/tarballs for nerdbot, ai-teammates, octop, odysseus)
- `nerdbot-refs` (`xiryn` Next.js reference app)
- `ai-teammates` (empty working copy except `.trigger`; source preserved in backup tarball/patch)
- `odysseus` (separate Python LLM app with GPU/docker harness)
- `OpenBot` (agent workspace/data, not application source)
- `nerdbot-audit` (empty)

## NerdBot current capabilities (verified)

- FastAPI backend, SQLite WAL, React/Vite dashboard served by backend.
- Chat/conversations, model providers (OpenAI-compatible/local/mock), Fernet-encrypted secrets.
- Persistent teammates/bots with face, permissions, memory scope, tool policy.
- Task orchestration, runs, artifacts, delegation tree, SSE event stream.
- Approval workflow (fail-closed, backend enforced).
- Isolated per-task Git workspaces.
- Memory (project/teammate/task scopes, provenanced).
- Scheduling, notifications, observability.
- Dashboard workflows and status filters.

## Reference project findings

### ai-teammates
- Working copy mostly empty; backup indicates design reference with uncommitted approval-queue/bot-import feature work.
- No verified superior runtime or memory implementation available in live tree.
- Treat as historical reference only; restore from backup before deeper extraction.

### octop (in backups)
- Product reference; one uncommitted infra/org change.
- Local HEAD diverges from origin; bundle captures local state.
- Candidate for integration patterns, but not verified as superior.

### odysseus
- Separate Python LLM application with GPU/docker harness, auth, DB, session manager.
- Useful deployment/GPU ideas; not a direct NerdBot subsystem replacement.

### xiryn (nerdbot-refs)
- Next.js app with Drizzle, components, proxy, docs.
- Useful UI/UX patterns only; not a backend replacement.

### OpenBot
- Agent workspace data, no application code.

## Capability comparison

| Capability | NerdBot | References | Verdict |
|---|---|---|---|
| Chat + persistence | Yes | Unknown/limited | Keep NerdBot |
| Agent identity | Yes | ai-teammates partial | Keep |
| Task orchestration | Yes | octop partial | Keep |
| Tool execution | Yes | Unknown | Keep |
| Memory | Yes | ai-teammates workspace-memory candidate | Evaluate optional filesystem layer |
| Approvals | Yes, fail-closed | Unknown | Keep |
| Workspaces | Yes, isolated Git | Unknown | Keep |
| Providers | Yes | odysseus GPU ideas | Enhance |
| Scheduling/observability | Yes | Unknown | Keep |
| Dashboard | Yes | xiryn UI patterns | Enhance selectively |

## Genuinely missing / worth evaluating

1. Optional Docker-based task runtime.
2. Explicit provider capability metadata and health checks.
3. Durable execution recovery/checkpoints (evaluate necessity).
4. Optional per-agent filesystem memory (only if advantageous).
5. MCP/OAuth/browser integrations with security gates.
6. Dashboard visibility for runtime/container/provider state.

## Security/licence notes

- Do not copy code from incompatible licences.
- Preserve provenance and third-party notices.
- Keep security enforcement backend-side.
- Avoid exposing Docker socket, host env, or privileged containers.
- Treat retrieved memory/files as untrusted context.

## Recommendation

NerdBot remains central. Implement optional, adapter-based extensions without replacing existing runtime, memory, approvals, or dashboard identity.
