import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import type { Run, RunEvent } from "./types";
import {
  ApprovalRow,
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  ShortId,
  StatusBadge,
  TABLE_SHELL,
  TABLE_TD as TD,
  TABLE_TH as TH,
  FORM_INPUT_SM as FORM_INPUT,
  LOG_BLOCK,
  Button,
  BotChip,
  SectionLabel,
  approvalIsPending,
  Page,
  PageHeader,
  relativeTime,
  useAsync,
  runStatusLabel,
} from "./components";
import { taskTitle } from "./taskTitle";
import { explainRunError, type RunErrorExplanation } from "./explainRunError";
import { EntityForm } from "./forms";
import { Markdown } from "./markdown";

/* Plain render columns over the static runs data — the core-row-model only
 * treatment TanStack was giving this table, without the dependency. */
interface RunColumn {
  header: string;
  cell: (run: Run) => ReactNode;
}

/** The runtime wraps provider output in prompt-injection markers before it
 *  goes back to a model. The owner is not a model; show the answer. */
function unwrapRunOutput(text: string): string {
  return text
    .replace(/^<<<UNTRUSTED_RUN_OUTPUT>>>\s*/, "")
    .replace(/\s*<<<END_UNTRUSTED_RUN_OUTPUT>>>$/, "");
}

const runColumns: RunColumn[] = [
  {
    header: "Started",
    cell: (run) => <span className="text-[var(--muted)]">{relativeTime(run.started_at)}</span>,
  },
  {
    header: "Status",
    cell: (run) => <StatusBadge status={run.status} label={runStatusLabel(run.status)} />,
  },
  {
    header: "Exit",
    cell: (run) => <span className="mono text-[var(--text-soft)]">{run.exit_code ?? "—"}</span>,
  },
  {
    header: "Runtime",
    cell: (run) => <span className="text-[var(--muted)]">{run.runtime}</span>,
  },
  {
    header: "Secs",
    cell: (run) => (
      <span className="mono text-[var(--text-soft)]">{Number(run.duration_s ?? 0).toFixed(1)}</span>
    ),
  },
];

function RunsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return <EmptyState title="No runs yet" hint="Run the task to produce execution evidence." />;
  }
  return (
    <div className={TABLE_SHELL}>
      <table className="w-full">
        <thead>
          <tr>
            {runColumns.map((column) => (
              <th key={column.header} className={TH}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="transition-colors hover:bg-[var(--surface-2)]">
              {runColumns.map((column) => (
                <td key={column.header} className={TD}>
                  {column.cell(run)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "stopped",
  "cancelled",
  "blocked",
]);

/** The run's event stream, appended as it happens.
 *
 *  A run is not a spinner: the server records ordered events (model turns,
 *  tool calls, approvals). The page opens the replayable SSE stream from the
 *  end of its history — live events arrive as they are recorded, and the
 *  stream closes itself when the run is terminal. If the stream transport is
 *  unavailable (an older server, a proxy that buffers SSE), the component
 *  falls back to the same endpoint polled every 2s, so the timeline is live
 *  either way, including after a refresh. */
function RunTimeline({ run, live }: { run: Run; live: boolean }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  /** true: SSE connected · false: polling fallback · null: not connected yet */
  const [transport, setTransport] = useState<"stream" | "poll" | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let next = 0;

    /* Events are ordered by seq; a stream reconnect (or a stream/poll pump
       racing in the same tick) may hand back a seq already appended. */
    const append = (items: RunEvent[]) => {
      setEvents((prev) => {
        const fresh = items.filter((event) => event.seq > next);
        if (fresh.length === 0) return prev;
        next = Math.max(next, fresh[fresh.length - 1].seq);
        return [...prev, ...fresh];
      });
    };

    const poll = () => {
      setTransport("poll");
      timer = setTimeout(async () => {
        try {
          const page = await api.runEvents(run.id, next);
          if (cancelled) return;
          append(page.events);
          const finished =
            TERMINAL_RUN_STATUSES.has(page.run.status) || !!page.run.finished_at;
          if (finished) return;
          poll();
        } catch (err) {
          if (!cancelled) setError(err);
        }
      }, 2000);
    };

    void (async () => {
      try {
        const page = await api.runEvents(run.id, 0);
        if (cancelled) return;
        append(page.events);
        next = Math.max(next, page.next);
        const finished =
          TERMINAL_RUN_STATUSES.has(page.run.status) || !!page.run.finished_at;
        if (!live || finished) return;
        try {
          setTransport("stream");
          let attempt = 0;
          // Reconnect with bounded exponential backoff + jitter before
          // falling back to polling. Track `next` so replays don't duplicate.
          while (!cancelled) {
            try {
              await api.streamRunEvents(run.id, next, {
                onEvent: (event) => {
                  if (!cancelled) {
                    append([event]);
                    if (typeof event.seq === "number") {
                      next = Math.max(next, event.seq + 1);
                    }
                  }
                },
                onEnd: () => {
                  if (!cancelled) setTransport(null);
                },
              });
              break;
            } catch (err) {
              if (cancelled) return;
              attempt += 1;
              if (attempt > 3) throw err;
              const delay = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 500;
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
          /* The stream resolved; its end frame already reset the transport. */
        } catch {
          if (cancelled) return;
          setTransport("poll");
          poll();
        }
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [run.id, live]);

  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel>Execution timeline</SectionLabel>
        <span className="text-step--2 text-[var(--faint)]">
          {live
            ? transport === "stream"
              ? "live · stream"
              : transport === "poll"
                ? "live · refreshes every 2s"
                : `${events.length} event${events.length === 1 ? "" : "s"}`
            : `${events.length} event${events.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {error ? (
          <div className="px-4 py-3">
            <ErrorState error={error} onRetry={() => setError(null)} />
          </div>
        ) : events.length === 0 ? (
          <p className="px-4 py-4 text-step--1 text-[var(--muted)]">
            {live ? "Waiting for the first event…" : "This run recorded no events."}
          </p>
        ) : (
          <ol className="max-h-[22rem] overflow-y-auto">
            {events.map((event, index) => (
              <li
                key={`${event.seq}-${index}`}
                className={`flex gap-3 px-4 py-2.5 ${
                  index > 0 ? "border-t border-[var(--border-dim)]" : ""
                }`}
              >
                <span className="mono w-8 shrink-0 pt-0.5 text-step--2 text-[var(--faint)]">
                  {event.seq}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="mb-0.5 block text-step--2 font-medium uppercase tracking-[0.12em] text-[var(--faint)]">
                    {event.kind}
                  </span>
                  <span className="block whitespace-pre-wrap break-words text-step--1 text-[var(--text-soft)]">
                    {event.content}
                  </span>
                </span>
                <span className="mono shrink-0 pt-0.5 text-step--2 text-[var(--faint)]">
                  {relativeTime(event.timestamp)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/** How much description counts as "long": above it the instructions block
 *  starts collapsed, so a 40k-char persona YAML does not bury the page. */
const LONG_INSTRUCTIONS = 400;

/**
 * The explanation banner to show for a task's newest failed run — the
 * translated "nothing ran" guidance — or null when there is nothing to
 * add: unknown failures need no banner, because the raw output rendered
 * below already carries their text.
 */
function bestFailureExplanation(
  task: { id: string; command: string; project_id: string },
  runs: Run[],
): RunErrorExplanation | null {
  const failedRuns = runs.filter((run) => run.task_id === task.id && run.status === "failed");
  if (failedRuns.length === 0) return null;
  const latest = failedRuns.reduce((a, b) => (b.started_at > a.started_at ? b : a));
  const failure = explainRunError(task, latest);
  return failure.actions.length > 0 ? failure : null;
}

/**
 * The task's full instructions, plus the two facts to read next to them:
 * the command that executes them, and where the task was delegated from.
 *
 * A long description starts collapsed — the persona YAML a bot hands over
 * can run tens of thousands of characters — with an expand/collapse toggle,
 * a Copy button, and a character count. The block is capped at ~320px with
 * internal scroll, so a wall of text never pushes the rest of the page away.
 */
function InstructionsSection({
  description,
  command,
  parent,
  projectId,
  ownerSlot,
  expanded,
  onToggle,
}: {
  description: string;
  command: string;
  parent: { id: string; description: string } | null;
  projectId: string;
  /** The owner chip and Assign control, folded in from the old Owner
   *  section: one details area holds everything about how the task runs
   *  and who runs it. */
  ownerSlot?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  const long = description.length > LONG_INSTRUCTIONS;
  const collapsed = long && !expanded;
  const parentTitle = parent?.description.trim() || "Untitled";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(description);
      toast.success("Instructions copied.");
    } catch {
      toast.error("Copy failed. Select the text manually.");
    }
  };
  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel>Instructions</SectionLabel>
        <span className="text-step--2 text-[var(--faint)]">
          {description.length.toLocaleString()} chars
        </span>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div
          className={`relative ${
            collapsed
              ? "max-h-40 overflow-hidden"
              : "max-h-[320px] overflow-y-auto overflow-x-hidden"
          }`}
        >
          {description ? (
            <pre className="mono whitespace-pre-wrap break-words text-step--1 leading-relaxed text-[var(--text-soft)]">
              {description}
            </pre>
          ) : (
            <p className="text-step--1 text-[var(--muted)]">No written instructions.</p>
          )}
          {collapsed ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--surface)] to-transparent"
            />
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {long ? (
            <Button onClick={onToggle}>{expanded ? "Collapse" : "Expand"}</Button>
          ) : null}
          <Button onClick={() => void copy()}>Copy</Button>
        </div>
        <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--border-dim)] pt-3 text-step--1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="w-32 shrink-0 text-[var(--muted)]">Command</span>
            {command ? (
              <code className="mono min-w-0 break-all text-[var(--text)]">{command}</code>
            ) : (
              <span className="min-w-0 flex-1 text-[var(--muted)]">
                none (when a model runs this task, the description is the instruction)
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="w-32 shrink-0 text-[var(--muted)]">Delegated from</span>
            {parent ? (
              <a
                className="min-w-0 max-w-full truncate text-[var(--accent)] hover:underline"
                href={`/p/${projectId}/t/${parent.id}`}
                title={parentTitle}
              >
                {parentTitle}
              </a>
            ) : (
              <span className="min-w-0 flex-1 text-[var(--muted)]">
                none. This is a root task
              </span>
            )}
          </div>
          {ownerSlot ? (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
              <span className="w-32 shrink-0 text-[var(--muted)]">Owner</span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {ownerSlot}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function TaskDetailView({
  projectId,
  taskId,
  onBack,
}: {
  projectId: string;
  taskId: string;
  onBack: () => void;
}) {
  const view = useAsync(() => api.taskView(taskId), [taskId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showPackage, setShowPackage] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [rollup, setRollup] = useState<Record<string, unknown> | null>(null);
  const [assignDraft, setAssignDraft] = useState<string | null>(null);
  const [delegateTo, setDelegateTo] = useState("");
  const [delegateReason, setDelegateReason] = useState("");
  const [delegateDepth, setDelegateDepth] = useState("1");
  const [reviewVerdict, setReviewVerdict] = useState("accepted");
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewRisks, setReviewRisks] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [watch, setWatch] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const watchTicks = useRef(0);
  const teammates = useAsync(() => api.listTeammates(projectId), [projectId]);
  const delegations = useAsync(() => api.listTaskDelegations(taskId), [taskId]);
  const projects = useAsync(() => api.listProjects(), [projectId]);

  /* A task in flight is followed by polling, not by holding the request open.
     The server records the run; this page just reads it back. A run started
     here is watched even before the task flips to `running`, so a fast
     transition cannot leave the page frozen on `pending`. The tick counter
     drives the loop; every stop condition is derived, never written back
     into state from inside the effect. */
  const viewData = view.data;
  const reloadView = view.reload;
  useEffect(() => {
    if (!viewData) return;
    const taskRunning = viewData.task.status === "running";
    const runRunning = viewData.runs.some(
      (run) => run.status === "running" || run.status === "queued",
    );
    const terminal = ["done", "failed", "cancelled", "blocked"].includes(
      viewData.task.status,
    );
    if (terminal) return;
    if (!watch && !taskRunning && !runRunning) return;
    if (watch && watchTicks.current >= 80) return;
    const timer = setTimeout(() => {
      if (watch) watchTicks.current += 1;
      reloadView();
      setPollTick((count) => count + 1);
    }, 1500);
    return () => clearTimeout(timer);
  }, [viewData, reloadView, watch, pollTick]);

  const act = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    try {
      const result = await fn();
      view.reload();
      return result;
    } catch (err) {
      notifyError(err);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const delegate = async () => {
    if (!delegateTo) {
      notifyError("Pick a teammate to delegate to");
      return;
    }
    try {
      await api.delegateTask(taskId, {
        from_teammate_id: view.data?.task.owner_teammate_id ?? "",
        to_teammate_id: delegateTo,
        reason: delegateReason.trim(),
        depth: Number(delegateDepth || 1),
      });
      setDelegateTo("");
      setDelegateReason("");
      setDelegateDepth("1");
      delegations.reload();
      view.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const decide = async (delegationId: string, decision: "accepted" | "declined") => {
    try {
      await api.decideDelegation(delegationId, decision);
      delegations.reload();
      view.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const cancelDelegation = async (delegationId: string) => {
    try {
      await api.cancelDelegation(delegationId, "cancelled from the task view");
      delegations.reload();
      view.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  if (view.loading || teammates.loading || delegations.loading) {
    return (
      <Page width="data">
        <LoadingState lines={6} />
      </Page>
    );
  }
  if (view.error || !view.data || teammates.error || delegations.error) {
    return (
      <Page>
        <ErrorState error={view.error ?? teammates.error ?? delegations.error ?? "Task not found"} onRetry={view.reload} />
      </Page>
    );
  }

  const data = view.data;
  const { task, runs, artifacts, issue, reviews, pr_packages, approvals, children, parent } = data;
  // The approvals this task is holding. The owner decides them here, instead
  // of having to find them in the approvals view.
  const approvalRows = approvals ?? [];
  // Merge view-level delegations with the dedicated endpoint (deduped).
  const delegationRows = [
    ...data.delegations,
    ...(delegations.data?.delegations ?? []).filter(
      (d) => !data.delegations.some((v) => v.id === d.id),
    ),
  ];
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
  // The run that can still be stopped: the newest one that has not ended.
  const liveRun = [...runs].reverse().find((run) => run.status === "running") ?? null;
  const latestPackage = pr_packages.length > 0 ? pr_packages[pr_packages.length - 1] : null;
  const owner = task.owner_teammate_id
    ? teammates.data?.teammates.find((m) => m.id === task.owner_teammate_id)
    : undefined;
  const headingSource = task.title || taskTitle(task.description);
  const cut = headingSource.slice(0, 110);
  const heading =
    headingSource.length > 110
      ? `${cut.replace(/\s+\S*$/, "") || cut}…`
      : headingSource;
  const description = (task.description || "").trim();
  const pendingApprovals = approvalRows.filter((approval) => approvalIsPending(approval));
  const latestOutput = unwrapRunOutput(
    latestRun?.output_excerpt?.trim() ||
      latestRun?.stdout?.trim() ||
      latestRun?.stderr?.trim() ||
      "",
  );
  const projectName =
    projects.data?.projects.find((project) => project.id === task.project_id)
      ?.repository || "Project";
  const terminal = ["done", "failed", "cancelled"].includes(task.status);
  /* A run started from this page keeps the page live until the task ends.
     `watch` is the request; whether the button still reads "Running…" is
     derived, so a finished task cannot leave a spinner behind. */
  const watching = watch && !terminal;
  /* The select follows the server unless the owner has changed it in this
     session; no effect is needed to mirror the loaded task back into state. */
  const assignTo = assignDraft ?? task.owner_teammate_id ?? "";
  const runPrimary = () => {
    if (terminal) {
      void act("retry", async () => {
        await api.retryTask(taskId);
        toast.message("Retry started.");
        return null;
      });
      return;
    }
    setWatch(true);
    watchTicks.current = 0;
    setPollTick((count) => count + 1);
    void act("run", async () => {
      await api.runTaskAsync(taskId);
      toast.message("Run started. Watching progress…");
      return null;
    });
  };

  return (
    <Page>
      <PageHeader
        eyebrow={`${projectName} · Task`}
        title={heading}
        description="What was asked, who is doing it, what is happening now, and what came out."
        back={{ label: projectName, onClick: onBack }}
        actions={
          <>
            <StatusBadge status={task.status} />
            {owner ? (
              <BotChip
                persona={owner.persona || "bot"}
                id={owner.id}
                status={owner.status}
                face={owner.face}
              />
            ) : (
              <Badge variant="warn">Unassigned</Badge>
            )}
            {liveRun ? (
              <Button
                variant="danger"
                disabled={!!busy}
                onClick={() => void act("stop", () => api.cancelRun(liveRun.id))}
              >
                {busy === "stop" ? "Stopping…" : "Stop run"}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!!busy || watching || task.status === "running"}
                onClick={runPrimary}
              >
                {busy === "run" || watching || task.status === "running"
                  ? "Running…"
                  : terminal
                    ? "Run again"
                    : "Run"}
              </Button>
            )}
            <Button onClick={() => setShowMore((value) => !value)}>
              {showMore ? "Close" : "More"}
            </Button>
          </>
        }
      />

      {showMore ? (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <Button disabled={!!busy} onClick={() => void act("retry", () => api.retryTask(taskId))}>
            {busy === "retry" ? "Retrying…" : "Retry (new run)"}
          </Button>
          <Button
            variant="danger"
            disabled={!!busy}
            onClick={() => void act("cancel", () => api.cancelTask(taskId, "cancelled from the task view"))}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel task"}
          </Button>
          <Button disabled={!!busy} onClick={() => void act("workspace", () => api.ensureWorkspace(taskId))}>
            Ensure workspace
          </Button>
          <Button disabled={!!busy} onClick={() => setShowKnowledge(true)}>
            Attach knowledge
          </Button>
          <Button disabled={!!busy} onClick={() => setShowReview(true)}>
            Submit review
          </Button>
          <Button disabled={!!busy} onClick={() => setShowPackage(true)}>
            Generate PR package
          </Button>
          <Button
            disabled={!!busy || !latestPackage}
            onClick={() => void act("approval", () => api.requestPackageApproval(taskId))}
          >
            Request package approval
          </Button>
          {latestRun ? (
            <>
              <Button
                disabled={!!busy}
                onClick={() =>
                  void act("patch", () => api.capturePatch(taskId, latestRun.id).then(() => null))
                }
              >
                Capture patch
              </Button>
              <Button
                disabled={!!busy}
                onClick={() =>
                  void act("approval", () =>
                    api.requestApproval(latestRun.id, "deploy").then(() => null),
                  )
                }
              >
                Request run approval
              </Button>
            </>
          ) : null}
          <Button
            disabled={!!busy}
            onClick={() =>
              void act("rollup", async () => {
                setRollup((await api.buildRollup(taskId)) as Record<string, unknown>);
              })
            }
          >
            Build roll-up
          </Button>
          <Button disabled={!!busy} onClick={() => view.reload()}>
            Refresh
          </Button>
        </div>
      ) : null}

      {/* Status at a glance: what this task is and where it stands. */}
      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-step--1">
          <span className="font-medium text-[var(--text)]">{task.status}</span>
          <span className="text-[var(--muted)]">
            {owner ? owner.persona || owner.id : "Unassigned"}
          </span>
          {latestRun ? (
            <span className="text-[var(--muted)]">
              latest run: {runStatusLabel(latestRun.status)} · {Number(latestRun.duration_s ?? 0).toFixed(1)}s
            </span>
          ) : (
            <span className="text-[var(--faint)]">no runs yet</span>
          )}
          {latestRun?.exit_code !== null && latestRun?.exit_code !== undefined ? (
            <span className="mono text-[var(--faint)]">exit {latestRun.exit_code}</span>
          ) : null}
        </div>
        {task.blocked_reason ? (
          <div className="mt-2 text-step--1 text-[var(--warn)]">{task.blocked_reason}</div>
        ) : null}
      </section>

      {/* Deliverables: what this task actually produced. */}
      {artifacts && artifacts.length > 0 ? (
        <section className="mb-6">
          <SectionLabel>Deliverables</SectionLabel>
          <div className="mt-2 flex flex-col gap-2">
            {artifacts.map((artifact) => (
              <a
                key={artifact.id}
                href={`/artifacts/${artifact.id}`}
                className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 hover:bg-[var(--surface-2)]"
              >
                <span className="font-medium text-[var(--text)]">{artifact.type}</span>
                <span className="text-[var(--muted)]">{artifact.summary || artifact.location}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {/* The answer comes before the machinery. A run that produced a result
          is the point of the task; the runs, approvals and evidence are how
          it got there. */}
      <section className="mb-8">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
          <SectionLabel>Output</SectionLabel>
          {latestRun ? (
            <span className="text-step--2 text-[var(--faint)]">
              {runStatusLabel(latestRun.status)} · {Number(latestRun.duration_s ?? 0).toFixed(1)}s ·{" "}
              {relativeTime(latestRun.started_at)}
            </span>
          ) : null}
        </div>
        {latestRun ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            {latestRun.status === "failed" && latestRun.exit_code !== null ? (
              <div className="mb-3 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]">
                Run failed with exit code <span className="mono">{latestRun.exit_code}</span>.
              </div>
            ) : null}
            {(() => {
              const failure = bestFailureExplanation(task, runs);
              if (!failure) return null;
              return (
                <div
                  className="mb-3 rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-step--1 text-[var(--text)]"
                  role="status"
                >
                  <div>{failure.message}</div>
                  {failure.actions.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-3">
                      {failure.actions.map((action) => (
                        <a
                          key={action.href}
                          className="text-step--1 text-[var(--accent)] hover:underline"
                          href={action.href}
                        >
                          {action.label}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })()}
            {latestOutput ? (
              <>
                <div className="max-h-[28rem] overflow-y-auto pr-1">
                  {latestRun?.runtime === "shell" ? (
                    <pre className={`${LOG_BLOCK} mt-0 !whitespace-pre-wrap break-words`}>
                      {latestOutput.slice(0, 4000)}
                    </pre>
                  ) : (
                    <Markdown text={latestOutput.slice(0, 4000)} />
                  )}
                </div>
                {latestOutput.length > 4000 ? (
                  <p className="mt-2 text-step--2 text-[var(--faint)]">
                    Showing the first 4000 characters. The full output is in the run artifacts.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-step--1 text-[var(--muted)]">
                The run finished without output.
              </p>
            )}
          </div>
        ) : (
          <EmptyState
            title="No output yet"
            hint="Run the task to see what the bot produces."
            action={
              <Button variant="primary" disabled={!!busy} onClick={runPrimary}>
                {busy === "run" ? "Running…" : "Run task"}
              </Button>
            }
          />
        )}
      </section>

      {latestRun ? (
        <RunTimeline
          key={latestRun.id}
          run={latestRun}
          live={latestRun.status === "running" || latestRun.status === "queued" || watching}
        />
      ) : null}

      {pendingApprovals.length > 0 ? (
        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <SectionLabel>Waiting on you</SectionLabel>
            <span className="mono text-step--2 text-[var(--faint)]">
              {pendingApprovals.length} request{pendingApprovals.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {pendingApprovals.map((approval) => (
              <ApprovalRow
                key={approval.id}
                approval={approval}
                busy={busy !== null}
                onDecide={async (decision) => {
                  const result = await act("approval", () =>
                    api.decideApproval(approval.id, decision),
                  );
                  const resume =
                    result && typeof result === "object" && "resume" in result
                      ? result.resume
                      : null;
                  if (resume && resume.outcome === "carried_out") {
                    toast.success("Approved. The action was carried out.");
                  } else if (resume && resume.outcome === "refused") {
                    toast.error(`Approved, but the action did not run: ${resume.output}`);
                  } else if (resume && resume.outcome === "waiting") {
                    toast.message("Approved. One more decision is still needed.");
                  } else if (decision === "denied") {
                    toast.message("Rejected. Nothing was performed.");
                  }
                }}
                onReask={
                  approval.tool_name
                    ? async () => {
                        await act("approval", () => api.reaskApproval(approval.id));
                        toast.message("Asked again. A new request is waiting for you.");
                      }
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {task.blocked_reason ? (
        <div
          className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3"
          role="status"
        >
          {task.status === "awaiting_approval" ? (
            /* The reason already says it: "waiting for your approval of X". */
            <strong className="text-step--1 text-[var(--warn)]">
              {task.blocked_reason.charAt(0).toUpperCase() + task.blocked_reason.slice(1)}
            </strong>
          ) : (
            <>
              <strong className="text-step--1 text-[var(--warn)]">
                This task is blocked
              </strong>
              <span className="text-step--1 text-[var(--text)]">
                {task.blocked_reason}
              </span>
              {task.blocked_reason.includes("provider") ? (
                <span className="text-step--1 text-[var(--muted)]">
                  Connect a working model key in{" "}
                  <a
                    className="text-[var(--accent)] hover:underline"
                    href={`/p/${task.project_id}?tab=Providers`}
                  >
                    this workspace&rsquo;s Providers tab
                  </a>
                  , then run it again.
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {issue ? (
        <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <strong className="text-[var(--text)]">{issue.title}</strong>
          <span className="mono text-step--2 text-[var(--faint)]">
            {issue.source}
            {issue.external_id ? ` · ${issue.external_id}` : ""}
          </span>
        </div>
      ) : null}

      <InstructionsSection
        description={description}
        command={task.command}
        parent={parent}
        projectId={projectId}
        ownerSlot={
          <>
            {owner ? (
              <BotChip persona={owner.persona || "bot"} id={owner.id} status={owner.status} face={owner.face} />
            ) : (
              <span className="text-step--1 text-[var(--muted)]">
                Unassigned. Pick a bot to own this task.
              </span>
            )}
            <select
              aria-label="Assign owner teammate"
              value={assignTo}
              onChange={(e) => setAssignDraft(e.target.value)}
              className={`${FORM_INPUT} max-w-[14rem]`}
            >
              <option value="">Unassigned</option>
              {teammates.data?.teammates.map((mate) => (
                <option key={mate.id} value={mate.id}>
                  {mate.persona || "Unnamed teammate"}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              disabled={!!busy || assignTo === (task.owner_teammate_id ?? "")}
              onClick={() =>
                void act("assign", async () => {
                  await api.assignTask(taskId, assignTo || null);
                  toast.success(assignTo ? "Owner updated." : "Task unassigned.");
                  return null;
                })
              }
            >
              {busy === "assign" ? "Saving…" : "Assign"}
            </Button>
          </>
        }
        expanded={showInstructions}
        onToggle={() => setShowInstructions((value) => !value)}
      />

      {showReview ? (
        <Modal title="Submit review" onClose={() => setShowReview(false)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reviewerId) {
                notifyError("Pick the teammate who reviewed this work.");
                return;
              }
              void act("review", async () => {
                await api.submitReview(taskId, {
                  reviewer_teammate_id: reviewerId,
                  verdict: reviewVerdict,
                  notes: reviewNotes,
                  risks: reviewRisks
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                  run_id: latestRun?.id ?? "",
                });
                setShowReview(false);
                return null;
              });
            }}
          >
            <label className="flex flex-col gap-1 text-step--1 text-[var(--muted)]">
              Reviewer
              <select
                value={reviewerId}
                onChange={(e) => setReviewerId(e.target.value)}
                required
                className={FORM_INPUT}
              >
                <option value="">(select a teammate)</option>
                {teammates.data?.teammates.map((mate) => (
                  <option key={mate.id} value={mate.id}>
                    {mate.persona || "Unnamed teammate"}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-step--1 text-[var(--muted)]">
              Verdict
              <select
                value={reviewVerdict}
                onChange={(e) => setReviewVerdict(e.target.value)}
                className={FORM_INPUT}
              >
                <option value="accepted">Accepted</option>
                <option value="needs_work">Needs work</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-step--1 text-[var(--muted)]">
              Notes
              <textarea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                rows={3}
                className={FORM_INPUT}
              />
            </label>
            <label className="flex flex-col gap-1 text-step--1 text-[var(--muted)]">
              Risks (comma separated)
              <input
                value={reviewRisks}
                onChange={(e) => setReviewRisks(e.target.value)}
                className={FORM_INPUT}
              />
            </label>
            <div className="mt-1 flex justify-end gap-2">
              <Button type="button" onClick={() => setShowReview(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={!reviewerId || busy === "review"}>
                {busy === "review" ? "Submitting…" : "Submit review"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {showPackage ? (
        <Modal title="Generate PR package" onClose={() => setShowPackage(false)}>
          <EntityForm
            submitLabel="Generate"
            fields={[
              { name: "title", label: "Title", required: true, placeholder: task.description },
              { name: "body", label: "Body", type: "textarea" },
            ]}
            onSubmit={async (values) => {
              await api.generatePackage(taskId, values);
              setShowPackage(false);
            }}
          />
        </Modal>
      ) : null}
      {showKnowledge ? (
        <Modal title="Attach knowledge evidence" onClose={() => setShowKnowledge(false)}>
          <EntityForm
            submitLabel="Search and attach"
            fields={[{ name: "query", label: "Query", required: true }]}
            onSubmit={async (values) => {
              await api.attachKnowledge(taskId, values.query, latestRun?.id ?? "");
              setShowKnowledge(false);
            }}
          />
        </Modal>
      ) : null}

      {/* Runs */}
      <section className="mb-6">
        <div className="mb-2 flex items-baseline justify-between">
          <SectionLabel>Runs</SectionLabel>
          {latestRun ? (
            <span className="mono text-step--2 text-[var(--faint)]">
              {runs.length} total · latest {relativeTime(latestRun.started_at)}
            </span>
          ) : null}
        </div>
        <RunsTable runs={runs} />
      </section>

      {/* Handoffs (delegation) */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Handoffs (delegation)</SectionLabel>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="text-[var(--text)]">Delegate to another bot</strong>
            <span className="text-step--2 text-[var(--faint)]">
              Bounded depth (max 5), cycle-checked.
            </span>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void delegate(); }} className="flex flex-wrap items-end gap-2">
            <select
              aria-label="Delegate to teammate"
              value={delegateTo}
              onChange={(e) => setDelegateTo(e.target.value)}
              className={`${FORM_INPUT} max-w-[14rem]`}
            >
              <option value="">Select a teammate</option>
              {teammates.data?.teammates
                .filter((mate) => mate.id !== task.owner_teammate_id)
                .map((mate) => (
                  <option key={mate.id} value={mate.id}>
                    {mate.persona || "Unnamed teammate"}
                  </option>
                ))}
            </select>
            <input
              aria-label="Reason"
              value={delegateReason}
              onChange={(e) => setDelegateReason(e.target.value)}
              placeholder="Why hand off?"
              className={`${FORM_INPUT} min-w-56 flex-1`}
            />
            <input
              type="number"
              min="1"
              max="5"
              value={delegateDepth}
              onChange={(e) => setDelegateDepth(e.target.value)}
              aria-label="Depth"
              className={`${FORM_INPUT} w-20`}
            />
            <Button variant="primary" type="submit" disabled={!delegateTo}>
              Delegate
            </Button>
          </form>
          {delegationRows.length > 0 ? (
            <>
              <div className={`mt-3 ${TABLE_SHELL}`}>
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={TH}>From</th>
                      <th className={TH}>To</th>
                      <th className={TH}>Depth</th>
                      <th className={TH}>Status</th>
                      <th className={TH}>Reason</th>
                      <th className={TH}>Child task</th>
                      <th className={TH}>Result</th>
                      <th className={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {delegationRows.map((d) => {
                      const pending = d.status === "pending";
                      const open = d.status === "pending" || d.status === "accepted";
                      const fromName = teammates.data?.teammates.find((m) => m.id === d.from_teammate_id)?.persona || <ShortId id={d.from_teammate_id} />;
                      const toName = teammates.data?.teammates.find((m) => m.id === d.to_teammate_id)?.persona || <ShortId id={d.to_teammate_id} />;
                      return (
                        <tr key={d.id} className="transition-colors hover:bg-[var(--surface-2)]">
                          <td className={`${TD} mono text-[var(--text-soft)]`}>{fromName}</td>
                          <td className={`${TD} mono text-[var(--text-soft)]`}>{toName}</td>
                          <td className={`${TD} mono`}>{d.depth}</td>
                          <td className={TD}>
                            <StatusBadge status={d.status} />
                          </td>
                          <td className={`${TD} text-[var(--muted)]`}>{d.reason || "—"}</td>
                          <td className={TD}>
                            {d.child_task_id ? (
                              <a
                                className="text-[var(--accent)] hover:underline"
                                href={`/p/${projectId}/t/${d.child_task_id}`}
                              >
                                <ShortId id={d.child_task_id} />
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className={`${TD} max-w-[260px] text-[var(--muted)]`}>
                            {d.result ? d.result.slice(0, 200) : "—"}
                            {d.finished_at ? (
                              <div className="mt-0.5 text-step--2 text-[var(--faint)]">
                                finished {relativeTime(d.finished_at)}
                              </div>
                            ) : null}
                          </td>
                          <td className={TD}>
                            {pending ? (
                              <div className="flex items-center gap-1.5">
                                <Button variant="primary" onClick={() => void decide(d.id, "accepted")}>
                                  Accept
                                </Button>
                                <Button variant="danger" onClick={() => void decide(d.id, "declined")}>
                                  Decline
                                </Button>
                                <Button onClick={() => void cancelDelegation(d.id)}>Cancel</Button>
                              </div>
                            ) : open ? (
                              <Button onClick={() => void cancelDelegation(d.id)}>Cancel</Button>
                            ) : (
                              <span className="text-[var(--muted)]">{d.decided_at ?? ""}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-step--1 text-[var(--muted)]">
                Accepting a delegation makes the target bot the task owner. Child results flow back
                through the response channel (see the project&apos;s Messages tab).
              </p>
            </>
          ) : (
            <EmptyState title="No delegations yet" hint="Hand a task from one bot to another here." />
          )}
        </div>
      </section>

      {/* Delegation tree */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Delegation tree</SectionLabel>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center gap-2 text-step--1">
            <span className="text-[var(--muted)]">Parent:</span>
            {parent ? (
              <a
                className="text-[var(--accent)] hover:underline"
                href={`/p/${projectId}/t/${parent.id}`}
              >
                {parent.description || "Untitled"}
              </a>
            ) : (
              <span className="text-[var(--muted)]">none. This is a root task</span>
            )}
          </div>
          <div className="mt-3">
            <span className="text-step--1 text-[var(--muted)]">
              Children ({children.length}):
            </span>
            {children.length === 0 ? (
              <div className="mt-1 text-step--1 text-[var(--faint)]">
                No child tasks yet. Bots create them when they delegate with a command.
              </div>
            ) : (
              <div className="mt-1.5 flex flex-col gap-1">
                {children.map((child) => {
                  const link = delegationRows.find((d) => d.child_task_id === child.id);
                  return (
                    <div
                      key={child.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-step--1 transition-colors hover:bg-[var(--surface-2)]"
                    >
                      <span className="min-w-0">
                        <a
                          className="text-[var(--accent)] hover:underline"
                          href={`/p/${projectId}/t/${child.id}`}
                        >
                          {child.description || "Untitled"}
                        </a>{" "}
                        <span className="mono text-step--2 text-[var(--faint)]">
                          via {link
                            ? `${teammates.data?.teammates.find((m) => m.id === link.to_teammate_id)?.persona || <ShortId id={link.to_teammate_id} />} · ${link.status}`
                            : "delegation"}
                        </span>
                      </span>
                      <StatusBadge status={child.status} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      <WorkspacePanel taskId={taskId} />

      {/* Artifacts */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Artifacts</SectionLabel>
        {artifacts.length > 0 ? (
          <div className={TABLE_SHELL}>
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>ID</th>
                  <th className={TH}>Type</th>
                  <th className={TH}>Verification</th>
                  <th className={TH}>Summary</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((artifact) => (
                  <tr key={artifact.id} className="transition-colors hover:bg-[var(--surface-2)]">
                    <td className={TD}>
                      <ShortId id={artifact.id} />
                    </td>
                    <td className={`${TD} mono`}>{artifact.type}</td>
                    <td className={TD}>
                      <StatusBadge status={artifact.verification_status} />
                    </td>
                    <td className={`${TD} text-[var(--muted)]`}>{artifact.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No artifacts" hint="Runs produce test-log and transcript artifacts." />
        )}
      </section>

      {/* Reviews */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Reviews</SectionLabel>
        {reviews.length > 0 ? (
          <div className="flex flex-col gap-2">
            {reviews.map((review) => (
              <div key={review.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <ShortId id={review.id} />
                    <StatusBadge status={review.verdict} />
                </div>
                <div className="mt-1.5 text-step--1 text-[var(--text-soft)]">
                  {review.notes || "No notes"}
                </div>
                {review.risks.length > 0 ? (
                  <div className="mt-1 text-step--2 text-[var(--faint)]">
                    Risks: {review.risks.join(", ")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No reviews" hint="A distinct reviewer records verdict and risks here." />
        )}
      </section>

      {/* PR packages */}
      <section className="mb-6">
        <SectionLabel className="mb-2">PR packages</SectionLabel>
        {pr_packages.length > 0 ? (
          <div className="flex flex-col gap-2">
            {pr_packages.map((pkg) => (
              <div key={pkg.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <strong className="text-[var(--text)]">{pkg.title}</strong>
                <div className="mono mt-1 text-step--2 text-[var(--faint)]">
                  {pkg.base_branch} ← {pkg.head_branch} · digest {pkg.digest.slice(0, 12)}…
                </div>
                <div className="mt-1 text-step--2 text-[var(--muted)]">{pkg.patch_summary}</div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No PR packages" hint="Generate a reviewable candidate package." />
        )}
      </section>

      {rollup ? (
        <section className="mb-6">
          <SectionLabel className="mb-2">Roll-up</SectionLabel>
          <pre className={LOG_BLOCK}>{JSON.stringify(rollup, null, 2)}</pre>
        </section>
      ) : null}
      <div className="mt-6 text-step--1">
        <a
          href={`/p/${projectId}`}
          className="text-[var(--muted)] hover:text-[var(--text)] hover:underline"
        >
          Open project →
        </a>
      </div>
    </Page>
  );
}

/** Isolated workspace browser: file list → content, plus the uncommitted diff. */
function WorkspacePanel({ taskId }: { taskId: string }) {
  const files = useAsync(() => api.workspaceFiles(taskId), [taskId]);
  const diff = useAsync(() => api.workspaceDiff(taskId), [taskId]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const openFile = async (path: string) => {
    setOpenPath(path);
    setContent(null);
    setContentError(null);
    try {
      const res = await api.workspaceFile(taskId, path);
      setContent(res.content);
    } catch (err) {
      setContentError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <SectionLabel>Task checkout</SectionLabel>
          <span className="text-step--2 text-[var(--faint)]">
            this task&apos;s isolated working copy
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              setShowDiff((v) => !v);
              diff.reload();
            }}
          >
            {showDiff ? "Hide diff" : "Show diff"}
          </Button>
          <Button
            onClick={() => {
              files.reload();
              diff.reload();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>
      {showDiff ? (
        <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <strong className="text-[var(--text)]">Uncommitted changes</strong>
          {diff.loading ? (
            <LoadingState lines={3} />
          ) : diff.error ? (
            <ErrorState error={diff.error} onRetry={diff.reload} />
          ) : diff.data?.exists && diff.data.diff ? (
            <pre className={LOG_BLOCK}>{diff.data.diff.slice(0, 8000)}</pre>
          ) : (
            <div className="mt-2 text-step--1 text-[var(--muted)]">
              No uncommitted changes (or the workspace does not exist yet; use Ensure workspace).
            </div>
          )}
        </div>
      ) : null}
      {files.loading && !files.data ? (
        <LoadingState lines={4} />
      ) : files.error ? (
        <ErrorState error={files.error} onRetry={files.reload} />
      ) : files.data && files.data.files.length > 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mono mb-3 text-step--2 text-[var(--faint)]">{files.data.root}</div>
          <div className="flex flex-wrap gap-1.5">
            {files.data.files.map((f) => (
              <Button
                key={f.path}
                variant={openPath === f.path ? "primary" : "default"}
                onClick={() => void openFile(f.path)}
                title={`${f.size} bytes`}
              >
                {f.path}
              </Button>
            ))}
          </div>
          {openPath ? (
            <div className="mt-3">
              <strong className="mono text-step--1 text-[var(--text)]">{openPath}</strong>
              {contentError ? (
                <div className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]" role="alert">
                  {contentError}
                </div>
              ) : content === null ? (
                <LoadingState lines={3} />
              ) : (
                <pre className={LOG_BLOCK}>{content.slice(0, 8000)}</pre>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState
          title="No workspace files"
          hint="Run the task or press “Ensure workspace” to materialize its isolated checkout."
        />
      )}
    </section>
  );
}
