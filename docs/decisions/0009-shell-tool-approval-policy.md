# 0009 — The Shell Tool Is Not Approval-Gated (and Why That Is the Decision)

Date: 2026-10-21. Status: accepted and implemented.

## Context

The approval system (`gates.py`) governs **authority**: the admin
permissions — `teammate.create`, `teammate.update`, `teammate.delete`,
`team.create`, `team.membership`, `board.delete`, `permission.change` — are
default-deny, and holding one is not enough. The action also needs a
digest-bound, one-use human approval, so approving "create a bot" never
approves "create a different bot".

The shell is a different kind of thing: it is **execution**. And it is not
one surface but two:

1. the task command, executed by the local runtime adapter as
   `sh -c <task.command>` inside the task's workspace;
2. the `run_command` tool in the bounded agent tool loop.

Neither surface is approval-gated today, and neither is permission-gated
today: the workspace tool schemas are offered to every agent run
(`providers.py::_tools_for` — "workspace tools always"), and only the app
tools are filtered by the teammate's granted permissions.

The 2026-10-21 architecture audit named this as the second hole in the
approval model — "the agents' most powerful tool, `run_command` (shell), is
outside the approval system entirely" — and asked for a decision rather
than silence. This ADR is that decision.

## Options considered

**(a) Gate every shell command with a digest-bound approval.** Rejected.

- The gate is one-shot by construction: one approval authorizes one exact
  action, consumed on use. An agent run calls the shell many times. The
  model would stall on the first tool call and wait for a human, every
  time, for the whole run. That is not a gate, it is a manual driver.
- The cost is high and the safety gain is not proportional. What makes a
  command dangerous is the workspace it runs in and the privileges it
  inherits, not the string `pytest -q` versus `npm test`. A digest over
  the command string cannot express "these commands, in this workspace, for
  this task".
- The owner is a poor judge of a shell string they did not write. The
  digest-bound gate works because the payload is human-readable and
  consequential ("give this bot these permissions"). A wall of shell
  commands is neither.

**(b) Permission-gate the shell** (a new `shell.exec` permission, tool
schemas filtered by it). Rejected as the answer, recorded as a later tier.

- It would gate the visible half of the hole. The task command still
  reaches `sh -c` through the local adapter, so the same capability stays
  reachable by a path no permission list covers.
- A permission is not a sandbox. Removing a tool from the schema the model
  sees does not remove the capability: the same command can be written into
  a file and run, or issued as the task command. A gate that can be walked
  around by a determined model is theatre.
- Every existing teammate would silently lose the shell until the owner
  granted the new permission — a capability regression in the one area the
  product's value actually rests on (agents that do work, not agents that
  talk).

**(c) Leave the shell outside the approval gate, and state — precisely —
what bounds it instead.** Accepted.

## Decisions

1. **The shell is deliberately outside the digest-bound approval gate.**
   The rule the product now follows: *if the action changes who may do
   what, it is approval-gated; if the action only works inside an
   already-authorized run, it is not.* The gate is an authority gate, not a
   supervision gate.

2. **What actually bounds the shell.** In place of the gate, six controls
   stand between a model's intent and the machine:

   - **Run boundary.** A run only exists for a task the caller owns
     (`POST /tasks/{id}/runs` requires project ownership) or for a task a
     teammate owns (the executor sweep). A bot cannot start a run for a
     task it does not own, so it cannot aim the shell at someone else's
     work.
   - **Workspace boundary.** Every command runs with its working directory
     set to that task's isolated Git workspace on a purposeful branch
     (`nb/<task_id>`). Paths are derived from the task id, never accepted
     from the model, and the file tools resolve strictly inside the
     workspace (ADR 0008).
   - **Deny-list.** `runtime.BLOCKED_PATTERNS` refuses the classic
     destructive idioms (`rm -rf /`, fork bombs, `curl|sh`, the cloud
     metadata address). The check runs before *every* shell execution, on
     both shell surfaces. The provider adapter never executes the task
     command as a script — it sends it to the model as an instruction, and
     the only shell that runs is the one behind the check.
   - **Secret hygiene.** The child environment never carries the server's
     secret key or API token (`runtime.child_env`), and both stdout and
     stderr are scrubbed of secrets and ciphertext blobs before they are
     stored or shown (`runtime.scrub_secrets`).
   - **Bounded execution.** A wall-clock budget (60 s per tool call,
     `NERDBOT_RUN_TIMEOUT_S` per run), a bounded output size, and output
     framed as untrusted data before it ever reaches the model.
   - **Stoppability.** A run in flight can be stopped: the command runs in
     its own process group, and `POST /runs/{id}/cancel` kills the whole
     group (`runtime._terminate_process_group`). A boundary the owner
     cannot withdraw is not a boundary.

3. **Board membership is authority, so it is gated.** Changing who
   coordinates on a board changes who may act — the same class of change
   as creating a bot. `add_board_member_service` and
   `remove_board_member_service` now run
   `gates.require(conn, acting, "teammate.create", payload=...)`, with the
   digest bound to the exact `(board, teammate, role, operation)` tuple, so
   an approval for one roster change never covers another — approving an
   *add* never authorizes the matching *remove*. The human owner path
   (`acting is None`) is never gated.

4. **What is *not* claimed.** The shell is **not sandboxed**. A command
   runs with the server process's own privileges; the deny-list is a
   deny-list, not an allow-list; outbound network access is not blocked
   beyond the metadata address; a command can read anything the server
   user can read. A project is a workspace, not a security boundary. This
   is a single-owner deployment posture and the product does not pretend
   otherwise. Known limit, already recorded in the acceptance report: the
   local adapter runs the task command as a shell script, so a
   natural-language instruction that reaches it is executed by `sh` and
   fails loudly rather than meaningfully.

5. **The trigger that voids this decision for the shell.** The moment the
   product has bot authors the owner does not control — a teammate that can
   widen its own permissions, a shared or multi-tenant deployment, bots
   imported from elsewhere — option (c) stops being available and the
   shell must become either sandboxed (container or namespace) or
   per-command approval-gated. Until then the honest statement is the one
   this ADR makes: *the shell is un-gated by decision, and here is what
   stands in for the gate.*

6. **The tier that would carry it, if one is added.** A trust tier on the
   teammate, not a per-command prompt: an "untrusted" teammate gets the
   shell denied or per-command gated; an owner-created, owner-granted
   teammate keeps it. The mechanism belongs in `tool_policy`, so it lands
   in the same catalogue the permission editor already exposes and needs
   no new approval machinery.

## Consequences

- The approval story is coherent and stated out loud: **gates govern
  authority, the shell governs execution, and the boundary for execution is
  the run + workspace + deny-list + stop switch.** No surface is silently
  ungated.
- `run_command` and the task command are still not permission-gated. If
  that changes, it must cover both shell surfaces and be enforced below the
  tool-schema layer, or it is decoration.
- Tests that pin the decisions: `tests/test_agent_tools.py` (deny-list,
  environment, scrubbing, untrusted framing), `tests/test_run_cancellation.py`
  (the stop switch, process-group kill), `tests/test_board_member_gates.py`
  (the roster gate, including digest binding and one-use consumption).
- The residual risk is named rather than hidden: on a single-owner
  deployment the shell is a trusted capability, and the product says so.
