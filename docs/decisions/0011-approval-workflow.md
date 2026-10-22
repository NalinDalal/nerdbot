# 0011 — An Approval Is a Decision That Does the Work, Not a Record of One

Date: 2026-10-22. Status: accepted and implemented.

## Context

NerdBot's gate was correct. An admin action — creating a teammate, deleting
a board, changing a permission — needed a digest-bound, one-use approval,
and the gate was fail-closed: absent the permission, denied; holding the
permission, still denied until a human answered. That part worked, and it
was tested.

What did not work was what happened *after* the human answered.

The gate created a row. The tool call returned a string to the model —
"APPROVAL REQUIRED before this action can run … then call this tool again
with the same arguments" — and the model loop carried on. The run then ended
the way any run ends, on the shell's exit code, and the task was marked
`done`. The approval sat in the table, undecided and invisible, and the
action it was about had never happened.

The evidence, from the audit of a live workspace on 2026-10-22:

- a task with six runs, all `blocked`, all saying
  `openai-compatible provider not configured`;
- seven approvals on that task, all `decision=approved`, all `consumed_at`
  set, all `task_id` null and `digest` null — manually created *run*
  approvals, not agent requests;
- one genuinely agent-requested approval, `teammate.create`, still `pending`
  — and expired on 2026-10-18, four days earlier. Expired means the
  dashboard hides it (`approval_is_pending` is false) *and* deciding it
  answers 410. It was a dead row with no surface anywhere.

And the string the owner remembered, "Awaiting approval", was not in the
shipped interface at all. The closest thing was the Home page's "N
decisions awaiting your approval", which counted pending approvals across
workspaces — and, because of the expiry rule, counted zero for a request
that had been waiting for four days.

## The gap, precisely

Three things were missing, and only one of them was a bug.

1. **A state for "waiting".** `TaskStatus` and `RunStatus` had no value
   for a run parked on a human. A run that stopped to ask for permission
   was recorded as `succeeded` — the shell exited zero, or the model
   stopped talking — and the task as `done`. **A run reported success
   while the work it was waiting for had not happened.**

2. **A place to put the action.** The gate knew the *action* and its
   digest. It did not know which tool the model had called, nor with which
   arguments — so even if the owner had said yes, there was nothing to
   carry out. The request was a yes/no with nothing attached to it.

3. **A way to carry it out.** `decide_approval` flipped a column. Nothing
   re-entered the run, nothing re-issued the call, nothing resumed. And
   there was no resume machinery to resume *with*.

## What the provider abstraction keeps — and does not

This is the question that decides the design, so it is worth being exact
about it.

`OpenAICompatibleAdapter.start_run` holds the provider conversation in a
local `messages` list. When it returns, that list is gone: the adapter is
rebuilt for every run (`adapter_for_provider`), and the transcript it
exposes (`last_transcript`) keeps only the *text* of each turn — not the
`tool_calls` of the assistant messages, and not the tool arguments of the
gated call, which never ran at all.

So: **the provider abstraction does not retain enough tool-call state to
resume a conversation safely.** Reconstructing it would mean persisting the
whole message array and re-posting it to the provider, which

- costs another provider call, and can land differently than the first;
- hands the model a fresh chance to issue *more* privileged work than the
  owner approved;
- re-runs whatever the model chooses to repeat.

## The decision

**The owner's approval covers exactly the action the owner approved, and
nothing else.** The gated action is a single, digest-bound operation with
an exact payload. It does not need the model to continue in order to be
performed. So the resume replays *that call* — not the conversation.

Concretely:

- **A gated call writes down the exact action.** The tool, the arguments,
  the bot that asked, the run and the task, on the approval row. The gate
  owns the action and the digest; the run owns the tool and the arguments;
  together the row carries the whole association.

- **The run parks.** A turn can ask for several privileged actions, and
  the model is told about each one, so the request is visible to the owner
  immediately — but the run does not finish while a request is
  unanswered. It reports `awaiting_approval`, and the task says why.

- **The decision carries the action out.** The owner's "yes" re-executes
  the exact tool call, with the exact arguments, as the same bot. The
  permission is checked *again* first: a bot that lost it between the
  request and the answer cannot act. The gate re-evaluates, finds the
  permit, consumes it, and the action runs.

- **Exactly once.** A checkpoint is marked as being carried out *before* the
  action runs, so a crash cannot repeat it. For a privileged action,
  at-most-once on crash and exactly-once on the normal path is the right
  way round: losing the action is a far better failure than repeating it.
  A second, identical decision is answered with the current state and
  performs nothing; a second, *different* decision is refused.

- **A batch is a batch.** A turn that asks for two privileged actions
  produces two requests, and the owner sees both. The run finishes when
  the last one is answered; until then it waits.

- **Expiry is a state, not a silence.** A request whose time is up is
  *expired*: not pending (it cannot be decided), not resolved (nobody
  decided it), and visible all the same, with the way to ask again. The
  sweep closes the work it was holding — the action is not performed,
  because nobody decided it — and the task is left blocked, so the owner
  can re-ask by retrying it.

- **The inbox is cross-workspace.** One place for every request, with
  filters, and one row per action.

## What this does not do

**The model's conversation is not replayed.** After the approved action
runs, the model does not continue where it left off. The run's output is
the action's result, and the task is done.

This is a deliberate limit, not an oversight. The alternative — replaying
the conversation — is the substantial architectural change the provider
abstraction cannot currently support, and it would widen what the owner's
approval covers from "this action" to "the model's next moves". A task
that needed more than the approved action should be retried; a "forever"
permit lets the same exact action through again.

**The digest binds the gate's payload, not the whole tool call.** The
`create_teammate` gate payload carries the project, the persona, the
permissions and the provider — but not the instructions. The *action* that
runs is still the checkpointed one, so the owner approves exactly what
happens; the digest is the request's identity rather than a complete
description of it. See `0012-action-binding.md` for the second digest that
closes that gap, and for why widening the gate's own digest would be a
breaking change.

## The crash windows

A process can die at any point around the action. Each boundary leaves a
state the recovery knows about, and none of them can repeat the action.

| The process dies… | What is left | What the recovery does |
| --- | --- | --- |
| before the decision is written | the request is pending, the action has not run | nothing to do; the request is still decidable |
| after the decision, before the claim | the request is approved, the action has not run | the sweep carries the action out — it is still to be done |
| after the claim, before the action | the action is claimed, the outcome is unknown | the action is **lost**, and NOT repeated; the run is closed with that reason and the task is left blocked |
| after the action, before the run is settled | the action ran, the run is still waiting | the sweep settles the run as done, and the run says what it did |
| after the run is settled | everything is consistent | nothing to do |

The recovery runs in two places: the executor's sweep, so a server left
running heals itself, and `POST /approvals/sweep`, so the interface can ask
for it. Both are the same code — `approval_flow.recover`.

**At-most-once means an action can be lost.** The third row is the price,
and it is the right way round: for a privileged action, losing it is a far
better failure than repeating it, and the loss is explicit — the run says
so, the task is left blocked, and a retry re-asks.

## Concurrency

Two decisions arriving at the same instant are settled by **conditional
updates**, not by a check followed by a write:

- the decision lands only on a row that is still pending;
- the claim lands only on a checkpoint that has not been claimed;
- the run is settled only by a run that is still waiting.

So two requests for the same approval cannot both carry the action out,
and the loser's answer is "already decided" rather than a second
performance.

**The claim is per checkpoint, not per run.** A run-level claim would
serialise a batch: two requests answered at the same moment would leave
one of the two actions unperformed, and the owner's second "yes" would
silently do nothing. The run's status is a *summary* of its checkpoints, so
a decision that arrives after the run was settled still performs its own
action.

**The task's own state is not forced.** Two workers finishing the same
batch can disagree about where the task is, and one of them can find it
already done. The settle updates the task only if the transition is
allowed; otherwise the task keeps the state it has, and the run's summary
still says what happened. A task's lifecycle belongs to whoever set it
last, and a summary update is not a reason to raise.


## Consequences

- `TaskStatus` and `RunStatus` both gained `awaiting_approval`. It is not
  terminal: a run that is waiting can still finish.
- The `approvals` table gained four columns: `teammate_id`, `tool_name`,
  `tool_arguments` and `resumed_at`. The migration is additive, like every
  other one in this codebase.
- A decided one-use approval now keeps a fresh five-minute window. The
  owner's answer is what starts the clock, not the moment the request was
  made; without this, an approval decided one second before it expired
  would leave no time in which the action could be carried out.
- The interface gained an Approvals inbox (`#/approvals`), a decision panel
  on the task page, and a demo-mode notice: a mock provider's canned reply
  is labelled as a demo, not passed off as work.
- `tests/test_approval_workflow.py` is the new end-to-end file: a scripted
  model on localhost, the real API, the real gate, the real store.
  `scripts/live_approval_check.py` is the same flow against a real server
  process, with a restart in the middle.
