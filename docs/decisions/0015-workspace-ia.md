# 0015 — The Workspace Is the Product, Not the Admin Table

Date: 2026-10-23. Status: accepted and implemented.

## Context

The backend had the pieces of an AI workspace: persistent bots, tasks, runs,
approvals, workspaces, boards, teams, knowledge, schedules, memory, and files.
The dashboard exposed them as a set of top-level containers. Every object got a
nav item, every object got a page of raw fields, and the owner had to know where
a piece of work lived before they could look at it.

The screenshots made the cost obvious:

- Home showed two lists of conversations and two warnings above the composer.
- The task page led with approvals, owner, and eleven actions. The output, the
  reason the task exists, was below the fold.
- Fleet was a table that collapsed its own columns ("3 ta…"), and a bot page
  opened with a raw teammate id and a provider id.
- Settings described the server in prose but did not let the owner connect a
  model without going to a workspace's Providers tab.
- Boards, Teams, and Workspaces were top-level destinations even though they
  are containers the owner visits occasionally, not the work itself.

This is the CRUD-admin failure mode: the database schema became the
information architecture.

## The decision

**Five surfaces, one command surface.** The sidebar is Home, Work, Fleet,
Approvals, Settings.

- **Home** is the command surface: one composer, one conversation list, a work
  pulse, and an attention banner only when something is actionable.
- **Work** is the cross-workspace inbox: every task, bucketed into needs you,
  running, queued, and done. It is where new work starts and where a task is
  opened.
- **Fleet** is the bots: who they are, what model they think with, what they
  are doing, and a single "Give work" action.
- **Approvals** is the trust boundary: pending, expired, and decided.
- **Settings** owns models and workspaces, and links to the container pages
  (boards, teams, all workspaces, capabilities) under Advanced.

**The output comes before the machinery.** A task page leads with the latest
run's answer or output. Pending approvals are shown only while pending; decided
ones stay in Approvals. Run, Stop, and Run again live in the header. Everything
else is one "More" disclosure. Raw task, run, project, and provider ids are not
primary content.

**A bot is an operating card, not a settings form.** The bot page opens with
its face, live state, open work, run count, and model name, plus "Give work".
Instructions and access are folded away. The face earns its place; the ids do
not.

**Model output is read as Markdown.** Bot answers are rendered as headings,
paragraphs, lists, quotes, tables, and fenced code, using React nodes rather
than HTML. Shell runs stay monospace logs. The renderer is local and
dependency-free; it does not accept `javascript:` links.

**Attention means attention.** A failed run is not surfaced in the Home banner
once its task is done, cancelled, or has a newer run in flight. Three failed
attempts at one task are one row with an attempt count, not three rows.

## Consequences

- Workspaces, Boards, and Teams remain fully reachable, but they are no longer
  first-class nav. The project page is still the 15-tab console for a workspace
  and is reachable from Settings.
- Work fans out one task request per workspace. There is one owner and a
  handful of workspaces, so a bounded fan-out is the honest trade; a failed
  workspace read is reported without hiding the rest of the list.
- The task page can still show every evidence surface (runs, handoffs,
  delegation tree, artifacts, reviews, PR packages, roll-ups, checkout), but
  only after the answer.
- The Home banner's "solved failures" filter is a display rule, not a data
  deletion: the failed runs remain in history and in the run table.
- "Bits" in the product framing means the small autonomous units the owner
  commands: a bot, a task, a schedule. The workspace is the orchestration
  surface over those units, not another unit to manage.
- The Markdown renderer is a subset, not CommonMark. Unsupported syntax falls
  back to readable text instead of raw HTML, which is the correct failure mode
  for untrusted run output.

## Alternatives rejected

- **Keep every container in the nav and only restyle it.** This preserves the
  schema-shaped IA and the "where did I put that task" problem.
- **Make Home a dashboard of cards.** Cards for every object reproduce the
  admin table with more chrome. The composer and the inbox are the two things
  the owner actually uses.
- **Render bot output as raw text with a "view source" toggle.** It is honest
  but unreadable. The source is still available in the run artifacts.
- **Add a Markdown dependency.** A full renderer and sanitizer is a large
  surface for a subset that bots already emit in practice. The local parser
  never emits HTML.
