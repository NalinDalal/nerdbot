# 0006 — Phase 2 Milestone: Credentials, Token Hygiene, Manifest Import

Date: 2026-10-16. Status: accepted and implemented.

## Baseline mapping (this product has no users table or chat sessions)

The milestone brief assumed a users/sessions baseline. NerdBot's actual
auth model is a single bearer token plus approval capability-tokens, so:

- "`users.llmApiKey` encrypted" → provider `config` secrets encrypted
  (`secrets.py`, Fernet, `enc:<version>:` envelope).
- "Chat session token expiry/ownership" → approval capability-tokens:
  owner-scoped request/decide endpoints, `approval_project` binding each
  approval to exactly one project, `purge_expired_approvals` removing only
  expired-undecided rows.
- "Backup manifest import" → `backup.import_manifest` as specified.

## Decisions

Keyless mode (deliberate): the product runs without `NERDBOT_SECRET_KEY`
for local development with non-secret providers only. Any write carrying
a secret-shaped value is rejected without a key; any stored secret is
unusable without its decryption key (fail-closed). There is no silent
plaintext mode for secrets. `capabilities.py` reports this posture.

1. **Keyring from env, versions "1" (current) + "0" (previous, decrypt-only).**
   Missing key at secret-write time raises (no silent plaintext);
   undecryptable stored values raise at resolve time (blocked run, never
   passthrough). Legacy plaintext rows are encrypted in place by migration
   when a key exists.
2. **Secrets never restored.** Imported providers get empty config;
   each dropped secret is counted (`secrets_stripped`). Backup manifests
   keep `[redacted]` placeholders, enforced by validation.
3. **History never replayed.** Runs, artifacts, reviews, packages,
   approvals, events import as `skipped/history not replayed`. Tasks,
   teammates, issues, knowledge, schedules, notifications, and memories
   import with domain-model + foreign-key validation; failures rejected
   with reasons. Re-import is idempotent (existing ids skipped).
4. **Approval hygiene is owner-scoped.** Request/decide/purge all verify
   project ownership; purge deletes only expired-undecided rows and emits
   `approval.purged`. Decided approvals are never purged.

## Consequences

- `cryptography` added as a runtime dependency (Fernet).
- Tests that create secret-bearing providers set `NERDBOT_SECRET_KEY`.
- Single-user token model unchanged; no sessions, lockouts, or tenants added.
