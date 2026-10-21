# AI Workspace: what the evidence shows

Date: 2026-10-21. Status: investigated, resolved, verdict recorded.

## The question

An "AI Workspace", reportedly implemented by Odysseus, could not be found in
NerdBot. This file records what was actually checked, what was found, and
what changed.

## What was checked

**Every ref, not just branches.** `git branch -a` shows one branch. The
repository also carries a hidden namespace that the branch listing does not
show:

```
refs/t3/orchestration-v2/checkpoints/<id>/ordinal/<n>
```

Four checkpoint chains, 71 refs in total, the newest from 2026-10-20. These
are snapshots of an earlier orchestration run of this same codebase, not
another product. Every chain was searched for the feature.

**Every commit.** `git log --all -S "AI Workspace"` returns matches in six
checkpoint commits and in `main`. Reading them shows the string only ever
appears as a product tagline:

- `README.md`: "NerdBot is a self-hosted, single-owner personal AI
  workspace."
- `docs/DESIGN.md`, `docs/PHASE1-PRODUCT-BRIEF.md`: the same description of
  NerdBot itself.

**The whole current tree.** Frontend routes, navigation, components, backend
endpoints, API clients, models, migrations, permissions, feature flags,
tests and docs. There is no `ai_workspace` entity, table, route, component
or setting anywhere.

**`~/odysseus`, which does exist.** A separate application on this machine.
Its own README calls it "a self-hosted AI workspace for chat, agents,
research, documents, email, notes, calendar, and local model workflows".
That is the product tagline, and it is the same phrase.

Odysseus does have a *workspace* concept, and it is a different thing
entirely. `routes/workspace_routes.py` is headed "Workspace API - browse
server directories to pick a tool workspace folder". Its endpoints are a
directory browser (`GET /api/workspace/browse`, admin-only because it
enumerates the host filesystem), a path validator, and a getter for the
configured workspace root. In Odysseus, a workspace is a directory on the
server that the agent's file and shell tools are confined to.

Odysseus is AGPL-3.0. NerdBot is MIT, and `docs/phase0-startup-commands.md`
records the rule for that relationship: "DO NOT COPY IMPLEMENTATION CODE.
Patterns may be re-implemented clean-room in TypeScript." Nothing was
copied. The behaviour was read and the capability implemented against
NerdBot's own architecture.

## The verdict

**Case E: the feature does not exist in NerdBot, and never did.**

There was no hidden implementation to restore, no disconnected route to
reconnect and no stub to complete. The two "AI workspace" mentions on this
machine are the same marketing phrase applied to two different products,
and that collision is what made a missing feature look like a broken one.

The capability the phrase points at does exist in NerdBot, under a
different name. A workspace is a **project**: it owns bots, tasks, boards,
memory, knowledge, approvals and conversations. It is implemented, it works,
and it is reachable from the nav as **Workspaces**.

## What changed anyway

The confusion came from one word meaning two things. In NerdBot, "workspace"
had meant both the project *and* the per-task checkout on disk, so "is the
AI Workspace available?" had no answer.

- **One word, one thing.** The project is the workspace. The per-task
  isolated checkout is now called the **task checkout**, everywhere it
  appears. `docs/decisions/0008-workspace-isolation.md` keeps its name: it
  describes the isolation of the checkout.
- **A workspace shows its files.** New `GET /projects/{id}/workspace/files`
  lists the files across every task checkout in a workspace, and a new
  **Files** tab on the workspace page shows them grouped by task and
  branch. Before, a workspace's actual working files were only reachable
  one task at a time. This is the closest coherent equivalent of what
  Odysseus's workspace surface lets you do: see the real files of your
  work in one place.
- **The Workspaces page describes each workspace** instead of showing a
  grid of ids. `GET /projects` now returns per-workspace counts beside the
  list, without changing the project shape.
- **Recovery links land where they must.** A workspace route carries the tab
  to open (`#/p/<id>?tab=Providers`), so a blocked task can send the owner
  straight to the model connections that will unblock it.

## What was not built, and why

A folder picker that binds a task to an arbitrary directory on the host was
considered and not built. It would contradict ADR 0008, which isolates each
task into its own checkout, and it would widen the reach of the shell tool
(the workspace is not a security boundary today, and pointing it at a
folder of the owner's choosing is a larger change than a UI repair). If
that is the capability wanted, it is a decision about isolation, not about
a missing page, and it should be made on purpose.

## Verifying it

```
cd dashboard && npm run build
.venv/bin/nerdbot run --host 127.0.0.1 --port 8080
```

Open `http://localhost:8080`, sign in with the bearer token, then
**Workspaces**, open one, and use its **Files** tab.
