/** Cross-workspace awareness for the Command Center.
 *
 *  The chat is project-scoped, but the owner needs to see what the fleet as a
 *  whole is doing: runs in flight, decisions pending, and how each team is
 *  executing. This module aggregates those signals across every project and
 *  team on the server (one personal workspace server — a handful of projects,
 *  so a bounded fan-out is fine). */
import { api } from "./api";
import type { Approval, Run, Task, Team, Teammate } from "./types";
import type { ReactNode } from "react";
import { useAsync, statusTone, taskTally, approvalIsPending, Button, EmptyState } from "./components";

export interface ProjectBundle {
  project: { id: string; owner: string; repository: string };
  tasks: Task[];
  runs: Run[];
  approvals: Approval[];
  teammates: Teammate[];
}

export interface TeamBundle {
  team: Team;
  projects: string[];
  teammates: Teammate[];
}

export interface EnrichedRun {
  run: Run;
  projectId: string;
  projectName: string;
  task: Task | null;
}

export interface EnrichedApproval {
  approval: Approval;
  projectName: string;
}

export interface WorkspaceSummary {
  bundles: ProjectBundle[];
  teams: TeamBundle[];
  bots: Teammate[];
  activeRuns: EnrichedRun[];
  failedRuns: EnrichedRun[];
  pendingApprovals: EnrichedApproval[];
  queuedTasks: number;
  runningTasks: number;
  blockedTasks: number;
  /** Tasks waiting on a human decision. */
  awaitingTasks: number;
}

/** What the async loader resolves to: the summary plus load honesty. */
export interface WorkspaceLoadResult {
  summary: WorkspaceSummary;
  loadFailed: boolean;
}



export function summarize(
  data: Pick<WorkspaceSummary, "bundles" | "teams" | "bots" >,
  now?: number,
): WorkspaceSummary {
  const taskById = new Map<string, Task>();
  for (const bundle of data.bundles) {
    for (const task of bundle.tasks) taskById.set(task.id, task);
  }
  const runningRunIds = new Set<string>();
  const activeRuns: EnrichedRun[] = [];
  const failedRuns: EnrichedRun[] = [];
  const pendingApprovals: EnrichedApproval[] = [];
  let queuedTasks = 0;
  let runningTasks = 0;
  let blockedTasks = 0;
  let awaitingTasks = 0;
  for (const bundle of data.bundles) {
    const name = bundle.project.repository || "workspace";
    const tally = taskTally(bundle.tasks);
    queuedTasks += tally.queued;
    runningTasks += tally.running;
    blockedTasks += tally.blocked;
    awaitingTasks += tally.awaiting;
    for (const run of bundle.runs) {
      if (run.status === "running") {
        // One task can have one live run; mark and dedupe.
        if (run.task_id && runningRunIds.has(run.task_id)) continue;
        if (run.task_id) runningRunIds.add(run.task_id);
        activeRuns.push({ run, projectId: bundle.project.id, projectName: name, task: taskById.get(run.task_id) ?? null });
      } else if (run.status === "failed") {
        const task = taskById.get(run.task_id) ?? null;
        /* A failed attempt is history once the task succeeded, was cancelled,
           or has a newer run in flight. Keeping those in the banner would
           leave the owner looking at a solved problem forever. */
        if (
          task &&
          (task.status === "done" || task.status === "cancelled" || task.status === "running")
        ) {
          continue;
        }
        failedRuns.push({ run, projectId: bundle.project.id, projectName: name, task });
      }
    }
    for (const approval of bundle.approvals) {
      // An expired, undecided approval can no longer be decided (the API
      // answers 410), so it is not actionable and must not be surfaced as a
      // pending decision.
      if (approvalIsPending(approval, now)) {
        pendingApprovals.push({ approval, projectName: name });
      }
    }
  }
  // Most relevant first: failed, then queued (oldest), then running (newest first is fine).
  failedRuns.sort((a, b) => (b.run.finished_at || "").localeCompare(a.run.finished_at || ""));
  return {
    bundles: data.bundles,
    teams: data.teams,
    bots: data.bots,
    activeRuns,
    failedRuns,
    pendingApprovals,
    queuedTasks,
    runningTasks,
    blockedTasks,
    awaitingTasks,
  };
}

/** Aggregate everything the Command Center banner and rollup need.
 *
 *  Per-parcel failures stay soft (one broken project must not blank the
 *  rest), but they are never hidden: the result reports whether any fetch
 *  failed so the caller can show an honest, retryable error. */
export function useWorkspaceSummary(): ReturnType<typeof useAsync<WorkspaceLoadResult>> & {
  summary: WorkspaceSummary;
  loadFailed: boolean;
} {
  const state = useAsync(async (): Promise<WorkspaceLoadResult> => {
    let loadFailed = false;
    const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch(() => {
        loadFailed = true;
        return fallback;
      });
    const [projectsRes, teamsRes, botsRes] = await Promise.all([
      soft(api.listProjects(), { projects: [], counts: {} } as Awaited<ReturnType<typeof api.listProjects>>),
      soft(api.listTeams(), { teams: [], counts: {} } as Awaited<ReturnType<typeof api.listTeams>>),
      soft(api.listAllTeammates(), { teammates: [] } as Awaited<ReturnType<typeof api.listAllTeammates>>),
    ]);
    const projectList = projectsRes.projects ?? [];
    const bundles: ProjectBundle[] = await Promise.all(
      projectList.map(async (project) => {
        const [tasks, runs, approvals, teammates] = await Promise.all([
          soft(api.projectTasks(project.id).then((r) => r.tasks), [] as Task[]),
          soft(api.projectRuns(project.id).then((r) => r.runs), [] as Run[]),
          soft(api.projectApprovals(project.id).then((r) => r.approvals), [] as Approval[]),
          soft(api.listTeammates(project.id).then((r) => r.teammates), [] as Teammate[]),
        ]);
        return { project, tasks, runs, approvals, teammates };
      }),
    );
    const teams: TeamBundle[] = await Promise.all(
      (teamsRes.teams ?? []).map(async (team) => {
        const detail = await soft(api.getTeam(team.id), null);
        if (!detail) return { team, projects: [], teammates: [] };
        return {
          team,
          projects: detail.projects.map((p) => p.id),
          teammates: detail.teammates,
        };
      }),
    );
    return {
      summary: summarize({ bundles, teams, bots: botsRes.teammates ?? [] }),
      loadFailed,
    };
  }, []);
  return {
    ...state,
    summary: state.data?.summary ?? emptySummary(),
    loadFailed: state.data?.loadFailed ?? false,
  };
}

function emptySummary(): WorkspaceSummary {
  return {
    bundles: [],
    teams: [],
    bots: [],
    activeRuns: [],
    failedRuns: [],
    pendingApprovals: [],
    queuedTasks: 0,
    runningTasks: 0,
    blockedTasks: 0,
    awaitingTasks: 0,
  };
}

/* --- Operational attention banner --- */

function StatusLabel({
  tone,
  children,
}: {
  tone: "info" | "warn" | "danger" | "neutral";
  children: ReactNode;
}) {
  const styles = {
    info: "text-[var(--info)] bg-[var(--info-dim)]",
    warn: "text-[var(--warn)] bg-[var(--warn-dim)]",
    danger: "text-[var(--danger)] bg-[var(--danger-dim)]",
    neutral: "text-[var(--muted)] bg-[var(--surface-2)]",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

function SectionHeading({
  eyebrow,
  title,
  count: total,
}: {
  eyebrow?: string;
  title: string;
  count?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
            {eyebrow}
          </div>
        )}
        <h3 className="text-sm font-semibold tracking-tight text-[var(--text)]">
          {title}
        </h3>
      </div>
      {total !== undefined && total > 0 && (
        <span className="flex h-6 min-w-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 text-xs font-medium text-[var(--muted)]">
          {total}
        </span>
      )}
    </div>
  );
}

export function AttentionBanner({
  summary,
  busy,
  onDecide,
  onOpenTask,
}: {
  summary: WorkspaceSummary | null;
  busy: boolean;
  onDecide: (
    approvalId: string,
    decision: "approved" | "approved_forever" | "denied",
  ) => void;
  onOpenTask: (projectId: string, taskId: string) => void;
}) {
  if (!summary) return null;

  const { activeRuns, pendingApprovals, failedRuns } = summary;

  if (
    activeRuns.length === 0 &&
    pendingApprovals.length === 0 &&
    failedRuns.length === 0
  ) {
    return null;
  }

  const urgent = pendingApprovals.length > 0 || failedRuns.length > 0;

  // Group failed attempts by task. The newest attempt is shown first.
  const failuresByTask = new Map<
    string,
    {
      run: (typeof failedRuns)[number]["run"];
      task: (typeof failedRuns)[number]["task"];
      projectName: string;
      projectId: string;
      attempts: number;
    }
  >();

  for (const failure of failedRuns) {
    const key = failure.task?.id ?? failure.run.id;
    const existing = failuresByTask.get(key);

    if (existing) {
      existing.attempts += 1;
    } else {
      failuresByTask.set(key, { ...failure, attempts: 1 });
    }
  }

  const shownFailures = [...failuresByTask.values()].slice(0, 3);

  return (
    <section
      aria-label="Live operations"
      className={`overflow-hidden rounded-2xl border ${
        urgent
          ? "border-[var(--warn)]/30 bg-[var(--surface)]"
          : "border-[var(--border)] bg-[var(--surface)]"
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-xl ${
              urgent
                ? "bg-[var(--warn-dim)] text-[var(--warn)]"
                : "bg-[var(--info-dim)] text-[var(--info)]"
            }`}
          >
            <span className="text-base" aria-hidden="true">
              {urgent ? "!" : "↗"}
            </span>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--text)]">
              {urgent ? "Needs attention" : "Live operations"}
            </h2>
            <p className="text-xs text-[var(--muted)]">
              {urgent
                ? "Some work needs your decision"
                : "Your agents are actively working"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeRuns.length > 0 && (
            <StatusLabel tone="info">
              {activeRuns.length} running
            </StatusLabel>
          )}
          {pendingApprovals.length > 0 && (
            <StatusLabel tone="warn">
              {pendingApprovals.length} approvals
            </StatusLabel>
          )}
          {failedRuns.length > 0 && (
            <StatusLabel tone="danger">
              {failedRuns.length} failed
            </StatusLabel>
          )}
        </div>
      </div>

      <div className="divide-y divide-[var(--border)]">
        {/* Failed work */}
        {shownFailures.length > 0 && (
          <div className="p-4 sm:p-5">
            <SectionHeading
              eyebrow="Action required"
              title="Failed executions"
              count={failuresByTask.size}
            />

            <div className="mt-3 space-y-2">
              {shownFailures.map(
                ({ run, task, projectName, projectId, attempts }) => (
                  <div
                    key={run.id}
                    className="group flex items-center gap-3 rounded-xl border border-[var(--danger)]/20 bg-[var(--danger-dim)]/30 p-3 transition-colors hover:bg-[var(--danger-dim)]/50"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--danger-dim)] text-[var(--danger)]">
                      <span className="text-sm font-semibold">×</span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--text)]">
                        {task?.description?.trim() || "Execution failed"}
                      </p>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {projectName}
                        {attempts > 1 && ` · ${attempts} attempts`}
                      </p>
                    </div>

                    {task && (
                      <button
                        onClick={() => onOpenTask(projectId, task.id)}
                        className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-2)]"
                      >
                        Inspect
                        <span className="ml-1 opacity-60">↗</span>
                      </button>
                    )}
                  </div>
                ),
              )}
            </div>

            {failuresByTask.size > 3 && (
              <p className="mt-2 text-xs text-[var(--muted)]">
                + {failuresByTask.size - 3} more failed tasks
              </p>
            )}
          </div>
        )}

        {/* Approval queue */}
        {pendingApprovals.length > 0 && (
          <div className="p-4 sm:p-5">
            <SectionHeading
              eyebrow="Human in the loop"
              title="Approval queue"
              count={pendingApprovals.length}
            />

            <div className="mt-3 space-y-3">
              {pendingApprovals.map(({ approval, projectName }) => (
                <article
                  key={approval.id}
                  className="rounded-xl border border-[var(--warn)]/25 bg-[var(--warn-dim)]/20 p-3 sm:p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="break-words text-sm font-medium text-[var(--text)]">
                        {approval.action}
                      </h4>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {projectName}
                      </p>
                    </div>

                    <StatusLabel tone="warn">Awaiting decision</StatusLabel>
                  </div>

                  {approval.task_id && approval.project_id ? (
                    <Button variant="link" size="sm" onClick={() => onOpenTask(approval.project_id, approval.task_id)}>
                      View associated task →
                    </Button>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => onDecide(approval.id, "approved")}
                    >
                      Approve once
                    </Button>

                    <Button
                      disabled={busy}
                      onClick={() => onDecide(approval.id, "approved_forever")}
                    >
                      Always allow
                    </Button>

                    <Button variant="danger" disabled={busy} onClick={() => onDecide(approval.id, "denied")}>
                      Reject
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}

        {/* Active execution */}
        {activeRuns.length > 0 && (
          <div className="p-4 sm:p-5">
            <SectionHeading
              eyebrow="In progress"
              title="Agents at work"
              count={activeRuns.length}
            />

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {activeRuns.slice(0, 4).map((item) => (
                <div
                  key={item.run.id}
                  className="flex min-w-0 items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--info-dim)] text-[var(--info)]">
                    <span className="text-xs">↗</span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-medium text-[var(--text)]">
                      {item.task?.description?.trim() || "Working on objective"}
                    </p>
                    <p className="mt-1 truncate text-xs text-[var(--muted)]">
                      {item.projectName}
                    </p>
                    {item.run.task_id && (
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => onOpenTask(item.projectId, item.run.task_id)}
                      >
                        View execution →
                      </Button>
                    )}
                  </div>

                  <span className="relative mt-1 flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--info)] opacity-30" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--info)]" />
                  </span>
                </div>
              ))}
            </div>

            {activeRuns.length > 4 && (
              <p className="mt-2 text-xs text-[var(--muted)]">
                + {activeRuns.length - 4} more executions running
              </p>
            )}

            {summary.queuedTasks > 0 && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--muted)]">
                <span className="text-[var(--info)]">⏳</span>
                {summary.queuedTasks} task{summary.queuedTasks === 1 ? "" : "s"} waiting in queue
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
/* --- Team-level execution rollup --- */



function perTeamCounts(
  team: TeamBundle,
  bundles: ProjectBundle[],
): { running: number; queued: number; blocked: number } {
  const inTeam = new Set(team.projects);
  const tasks = bundles.flatMap((bundle) =>
    inTeam.has(bundle.project.id) ? bundle.tasks : [],
  );
  const { running, queued, blocked } = taskTally(tasks);
  return { running, queued, blocked };
}

function botStatusFor(bot: Teammate, bundles: ProjectBundle[]): string {
  for (const bundle of bundles) {
    if (bundle.project.id !== bot.project_id) continue;

    const mine = bundle.tasks.filter(
      (task) => task.owner_teammate_id === bot.id,
    );

    if (mine.some((task) => task.status === "running")) return "running";
    if (mine.some((task) => task.status === "ready")) return "ready";
    if (mine.some((task) => task.status === "awaiting_approval")) return "blocked";
    if (mine.some((task) => task.status === "blocked")) return "blocked";
  }

  return bot.status;
}

function CountChip({
  tone,
  n,
  children,
}: {
  tone: "info" | "warn" | "bad";
  n: number;
  children: ReactNode;
}) {
  if (n === 0) return null;

  const styles = {
    info: "border-[var(--info)]/20 bg-[var(--info-dim)] text-[var(--info)]",
    warn: "border-[var(--warn)]/20 bg-[var(--warn-dim)] text-[var(--warn)]",
    bad: "border-[var(--danger)]/20 bg-[var(--danger-dim)] text-[var(--danger)]",
  };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${styles[tone]}`}
    >
      <strong className="font-semibold tabular-nums">{n}</strong>
      <span>{children}</span>
    </span>
  );
}

export function ExecutionRollup({
  summary,
  onOpenTeam,
}: {
  summary: WorkspaceSummary | null;
  onOpenTeam: (teamId: string) => void;
}) {
  if (!summary) {
    return <EmptyState title="Loading execution state…" />;
  }

  if (summary.teams.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8">
        <EmptyState
          title="Your workforce starts here"
          hint="Create a team and group your agents together to see their execution activity here."
        />
      </div>
    );
  }

  const totalRunning = summary.teams.reduce(
    (total, team) =>
      total + perTeamCounts(team, summary.bundles).running,
    0,
  );

  const totalBots = summary.teams.reduce(
    (total, team) => total + team.teammates.length,
    0,
  );

  return (
    <section className="space-y-4">
      {/* Rollup header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
            Workforce
          </div>
          <h2 className="text-base font-semibold tracking-tight text-[var(--text)]">
            Team activity
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Execution across your teams
          </p>
        </div>

        <div className="flex gap-2">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <div className="text-lg font-semibold tabular-nums text-[var(--text)]">
              {summary.teams.length}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Teams
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <div className="text-lg font-semibold tabular-nums text-[var(--text)]">
              {totalBots}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Agents
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <div className="text-lg font-semibold tabular-nums text-[var(--info)]">
              {totalRunning}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Running
            </div>
          </div>
        </div>
      </div>

      {/* Team cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {summary.teams.map((bundle) => {
          const counts = perTeamCounts(bundle, summary.bundles);

          const statuses = bundle.teammates.map((bot) =>
            botStatusFor(bot, summary.bundles),
          );

          const busyBots = statuses.filter(
            (status) => statusTone(status) === "info",
          ).length;

          const blockedBots = statuses.filter(
            (status) => status === "blocked",
          ).length;

          const idleBots = bundle.teammates.length - busyBots - blockedBots;

          const isActive = counts.running > 0;
          const hasIssues = counts.blocked > 0;

          return (
            <button
              key={bundle.team.id}
              onClick={() => onOpenTeam(bundle.team.id)}
              className="group relative flex min-h-[168px] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--accent)]/40 hover:bg-[var(--surface-2)] hover:shadow-lg"
            >
              {/* Status accent */}
              <div
                className={`absolute inset-x-0 top-0 h-[2px] ${
                  hasIssues
                    ? "bg-[var(--warn)]"
                    : isActive
                      ? "bg-[var(--info)]"
                      : "bg-[var(--border)]"
                }`}
              />

              {/* Card heading */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] text-sm font-semibold ${
                      isActive
                        ? "bg-[var(--info-dim)] text-[var(--info)]"
                        : "bg-[var(--surface-2)] text-[var(--muted)]"
                    }`}
                  >
                    {(bundle.team.name || "T").trim().charAt(0).toUpperCase()}
                  </div>

                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-[var(--text)]">
                      {bundle.team.name || "Unnamed team"}
                    </h3>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {bundle.teammates.length}{" "}
                      {bundle.teammates.length === 1 ? "agent" : "agents"}
                      {" · "}
                      {bundle.projects.length}{" "}
                      {bundle.projects.length === 1 ? "project" : "projects"}
                    </p>
                  </div>
                </div>

                <span
                  className={`mt-1 flex h-2 w-2 shrink-0 rounded-full ${
                    hasIssues
                      ? "bg-[var(--warn)]"
                      : isActive
                        ? "bg-[var(--info)]"
                        : "bg-[var(--border)]"
                  }`}
                  aria-label={
                    hasIssues
                      ? "Blocked work"
                      : isActive
                        ? "Active"
                        : "Idle"
                  }
                />
              </div>

              {/* Agent status */}
              <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {busyBots > 0 && (
                  <span className="text-[var(--info)]">
                    {busyBots} working
                  </span>
                )}
                {blockedBots > 0 && (
                  <span className="text-[var(--warn)]">
                    {blockedBots} blocked
                  </span>
                )}
                {idleBots > 0 && (
                  <span className="text-[var(--muted)]">
                    {idleBots} idle
                  </span>
                )}
                {bundle.teammates.length === 0 && (
                  <span className="text-[var(--muted)]">
                    No agents assigned
                  </span>
                )}
              </div>

              {/* Task counters */}
              <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
                <CountChip tone="info" n={counts.running}>
                  running
                </CountChip>
                <CountChip tone="warn" n={counts.queued}>
                  queued
                </CountChip>
                <CountChip tone="bad" n={counts.blocked}>
                  blocked
                </CountChip>

                {counts.running === 0 &&
                  counts.queued === 0 &&
                  counts.blocked === 0 && (
                    <span className="rounded-md bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--muted)]">
                      No active tasks
                    </span>
                  )}

                <span className="ml-auto text-sm text-[var(--muted)] transition-transform group-hover:translate-x-1 group-hover:text-[var(--text)]">
                  →
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
