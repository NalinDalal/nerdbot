# 0012 — Two Digests: The Request's Identity, and the Action's Binding

Date: 2026-10-22. Status: accepted and implemented.

## Context

An approval in NerdBot is bound to a payload by a digest, so approving one
action never approves a different one. That has been true since the gate was
written, and it is the security property the whole mechanism rests on.

The digest is computed over the **gate payload** — what the permission
covers. For `create_teammate` that is:

```python
{"project_id": ..., "persona": ..., "permissions": [...], "provider_id": ...}
```

The tool call itself is wider: the same call also carries `instructions`,
and other tools carry more again. So the digest is **narrower than the
action**: it identifies the request, not the whole invocation.

That was fine when an approval was only a record. It stopped being fine
when the approval became the thing that *performs* the action: the resume
replays a tool call, and what it must replay is exactly the call that was
asked for.

## The decision

**Two digests, with two jobs, and neither changes the other.**

**1. The gate digest — unchanged.** It stays exactly as it is: the identity
of the request, over the gate payload. It is what `find_approved_action`
looks up, and widening it would change the gate's contract — every stored
approval, every pending approval, and the meaning of every existing row
would move. That is a breaking change to a security control, and it is not
needed for correctness.

**2. The action binding — new.** A digest over the *invocation*:

```
sha256(canonical({
  "tool":        the tool name,
  "arguments":  the arguments, canonicalised (sorted keys),
  "teammate_id": the bot that asked,
  "run_id":      the run it belongs to,
  "task_id":     the task it belongs to,
}))
```

It is written on the approval row when the checkpoint is recorded, and it is
**checked before the action runs**. A checkpoint whose invocation no longer
matches its binding is not performed.

Three things fall out of it:

- **The arguments are canonicalised.** `{"a": 1, "b": 2}` and
  `{"b": 2, "a": 1}` are the same action, so the binding does not depend on
  the order the model happened to write them in.
- **The bot is part of it.** One bot's approval cannot carry another bot's
  call, even for the same tool and the same arguments.
- **The work is part of it.** A checkpoint that was moved to another run or
  task is not performed.

## What is still not covered

The binding covers the invocation, not the *world* it runs in: the provider
that will answer, the workspace the run has, the board the message goes to.
A checkpoint whose tool arguments are unchanged but whose surrounding state
has moved — a board deleted between the request and the answer — is still
performed, and the tool's own checks are what refuse it. Binding the
environment would mean hashing state that changes on its own, which is a
different problem and a different decision.

**The gate payload remains narrow**, and that is deliberate: the payload is
what the *permission* is about. `teammate.create` is about creating a
teammate with a persona and a set of permissions; the instructions are
content, not authority. The action binding is what closes the gap, and it
sits beside the gate digest rather than inside it.

## Consequences

- The `approvals` table gained a `tool_digest` column, written with the
  checkpoint and checked at the resume.
- A tampered checkpoint is refused: the action is not performed, and the
  refusal says why.
- The gate's own digest, and every existing row, are untouched. Nothing
  already stored changes meaning.
