# Nerdbot 2.0 Autonomy Policy

**Status**: Stage 0 policy contract (implementation required)  
**Rule**: The LLM may propose actions; the policy engine authorizes them. Authorization is checked immediately before execution.

## 1. Policy principles

- **Least privilege**: project + teammate + tool + target scope required.
- **Explicit authorization**: no silent permission escalation.
- **Approval before execution**: plan-time approval is insufficient for high-risk actions.
- **Auditable decisions**: every allow/gate/deny/escalate decision is logged with reason, risk, actor, scope, and digest.
- **Idempotent side effects**: external actions carry idempotency keys and replay protection.
- **Human override**: pause, resume, stop, revoke, and expiry always win.

## 2. Action classes

| Class | Default | Examples | Controls |
|---|---|---|---|
| Autonomous (low risk, internal/reversible) | Allow if permitted | research/search/fetch public info, read/analyze workspace/docs, organize findings, draft reports/plans/messages, create/update internal tasks, permitted workspace edits, run tests, prepare deliverables, monitor assigned work, resume interrupted internal work | project permission, budget/rate limit, audit log, taint tracking |
| Approval-required (high risk/external/irreversible/sensitive) | Require explicit approval immediately before execution | send external message, publish/post content, spend money/initiate paid transaction, change access permissions/security settings, delete important user data, irreversible external action, access/transmit sensitive info beyond authorized scope, any policy-classified high-risk action | digest-bound approval, expiry, revocation, idempotency key, pre-exec recheck, delivery/action receipt |
| Denied | Deny | out-of-scope project/resource, missing permission, revoked/expired approval, secret exfiltration, unbounded/destructive command outside policy, bypass attempts | deny log, user-visible reason, no side effect |

## 3. Mandatory controls

- Project and teammate permissions.
- Least privilege defaults; admin/external permissions denied unless explicitly granted.
- Action budgets and rate limits (tool calls, runtime, spend, external sends, browser actions).
- Auditable decisions and tool calls (append-only event/audit records).
- Pause, resume, stop controls at agent/task/run levels.
- Human override over autonomous plans.
- Approval expiry and revocation; approvals bound to action digest.
- Idempotency for external side effects; dedupe on retry/restart/replay.
- Explicit separation between planning and authorization.

## 4. Decision outcomes

The policy evaluator returns one of:

- `allow` - execute now.
- `require_approval` - create/require approval checkpoint; no execution.
- `ask_user` - missing information/ambiguous intent; no risky execution.
- `defer` - budget/schedule/dependency/rate limit; enqueue later.
- `escalate` - blocked/risky/unknown; notify owner with evidence.
- `deny` - outside policy/permissions.

Every decision records: `decision_id`, timestamp, project, teammate, task/run, action type, target, risk, outcome, reason, policy version, approval id/digest if any.

## 5. Risk classification

| Risk | Typical actions | Default handling |
|---|---|---|
| Low | internal read/search/draft/tests/workspace read | allow if permitted |
| Medium | workspace write, internal task mutation, reversible local ops | allow if permitted; log; may require approval by autonomy level |
| High | external send/publish/delete important data/security changes/sensitive transfer/browser credentialed action | require approval immediately before execution |
| Critical | spend money, irreversible external/public destructive action, permission escalation | require explicit approval + extra confirmation; never autonomous |

## 6. Autonomy levels (to be enforced)

| Level | Meaning | Enforcement |
|---|---|---|
| `observe` | read/analyze/report only | deny mutating/external tools |
| `draft` | create drafts/internal artifacts, no external side effects | gate sends/publish/spend/delete/security |
| `act_internal` | autonomous internal/reversible actions | gate all high-risk/external/sensitive |
| `act_with_approval` | can prepare/queue high-risk actions | external/irrelevant always approval-gated |
| `act_limited_external` | narrow pre-approved external adapters only | strict allowlist, idempotency, receipts, budgets |

Existing teammate autonomy fields must map to this evaluator; decorative config is a bug.

## 7. Approval contract

- Approval bound to **action digest**: tool/action, normalized args, target, project, teammate, risk class, idempotency key.
- Re-check approval **immediately before execution**.
- If args/target/digest changed, previous approval is invalid.
- Approval has expiry, revocation, and single-use semantics for side effects unless explicitly renewed.
- Approval resume uses existing checkpoint model; no model conversation replay for privileged side effects.

## 8. Taint and sensitive data

- External/web/webhook/browser/email/content is untrusted by default.
- Taint propagates into derived drafts/plans/actions.
- Untrusted instructions cannot authorize privileged actions.
- Sensitive data (secrets, tokens, cookies, credentials, private user data) is never placed in model context/logs/artifacts; use secret refs.
- Cross-project data access is fail-closed.

## 9. Test matrix requirement

Policy tests must prove deterministic outcomes for: read/search, workspace write, test execution, external send, publish/post, spend, permission/security change, important data deletion, sensitive data transfer, approval expiry, revoked approval, digest mismatch, paused agent, budget exhaustion, idempotent replay.
