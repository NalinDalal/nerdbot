/** Cross-workspace awareness for the Command Center.
 *
 *  The chat is project-scoped, but the owner needs to see what the fleet as a
 *  whole is doing: runs in flight, decisions pending, and how each team is
 *  executing. This module aggregates those signals across every project and
 *  team on the server (one personal workspace server — a handful of projects,
 *  so a bounded fan-out is fine). */
import { api } from "./api";
import type { Approval, Run, Task, Team, Teammate } from "./types";
import { useAsync, statusTone, Button, EmptyState } from "./components";

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
}

const count = (n: number, singular: string, plural?: string) =>
  `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;

export function summarize(
  data: Pick<WorkspaceSummary, "bundles" | "teams" | "bots" >,
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
  for (const bundle of data.bundles) {
    const name = bundle.project.repository || "workspace";
    for (const task of bundle.tasks) {
      if (task.status === "running") runningTasks += 1;
      else if (task.status === "blocked") blockedTasks += 1;
      else if (task.status === "pending" || task.status === "ready") queuedTasks += 1;
    }
    for (const run of bundle.runs) {
      if (run.status === "running") {
        // One task can have one live run; mark and dedupe.
        if (run.task_id && runningRunIds.has(run.task_id)) continue;
        if (run.task_id) runningRunIds.add(run.task_id);
        activeRuns.push({ run, projectId: bundle.project.id, projectName: name, task: taskById.get(run.task_id) ?? null });
      } else if (run.status === "failed") {
        failedRuns.push({ run, projectId: bundle.project.id, projectName: name, task: taskById.get(run.task_id) ?? null });
      }
    }
    for (const approval of bundle.approvals) {
      if (approval.decision === "pending" || !approval.decision) {
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
  };
}

/** Aggregate everything the Command Center banner and rollup need. */
export function useWorkspaceSummary(): ReturnType<typeof useAsync<WorkspaceSummary>> & {
  summary: WorkspaceSummary;
} {
  const state = useAsync(async () => {
    const [projectsRes, teamsRes, botsRes] = await Promise.all([
      api.listProjects().catch(() => ({ projects: [] })),
      api.listTeams().catch(() => ({ teams: [] })),
      api.listAllTeammates().catch(() => ({ teammates: [] })),
    ]);
    const projectList = projectsRes.projects ?? [];
    const bundles: ProjectBundle[] = await Promise.all(
      projectList.map(async (project) => {
        const [tasks, runs, approvals, teammates] = await Promise.all([
          api.projectTasks(project.id).then((r) => r.tasks).catch(() => [] as Task[]),
          api.projectRuns(project.id).then((r) => r.runs).catch(() => [] as Run[]),
          api.projectApprovals(project.id).then((r) => r.approvals).catch(() => [] as Approval[]),
          api.listTeammates(project.id).then((r) => r.teammates).catch(() => [] as Teammate[]),
        ]);
        return { project, tasks, runs, approvals, teammates };
      }),
    );
    const teams: TeamBundle[] = await Promise.all(
      (teamsRes.teams ?? []).map(async (team) => {
        try {
          const detail = await api.getTeam(team.id);
          return {
            team,
            projects: detail.projects.map((p) => p.id),
            teammates: detail.teammates,
          };
        } catch {
          return { team, projects: [], teammates: [] };
        }
      }),
    );
    return summarize({ bundles, teams, bots: botsRes.teammates ?? [] });
  }, []);
  return { ...state, summary: state.data ?? emptySummary() };
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
  };
}

/* --- Attention banner --- */

export function AttentionBanner({
  summary,
  busy,
  onDecide,
  onOpenTask,
}: {
  summary: WorkspaceSummary | null;
  busy: boolean;
  onDecide: (approvalId: string, decision: "approved" | "approved_forever" | "denied") => void;
  onOpenTask: (projectId: string, taskId: string) => void;
}) {
  if (!summary) return null;
  const { activeRuns, pendingApprovals, failedRuns } = summary;
  if (activeRuns.length === 0 && pendingApprovals.length === 0 && failedRuns.length === 0) {
    return null;
  }
  const urgent = pendingApprovals.length > 0 || failedRuns.length > 0;
  return (
    <section
      aria-label="Attention"
      className={`order-3 rounded-xl border px-4 py-3 ${
        urgent
          ? "border-[var(--warn)] bg-[var(--warn-dim)]"
          : "border-[var(--border)] bg-[var(--surface)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span
          className={`inline-flex items-center gap-2 text-[var(--step-minus-1)] font-medium uppercase tracking-[0.14em] ${
            urgent ? "text-[var(--warn)]" : "text-[var(--info)]"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${urgent ? "bg-[var(--warn)]" : "bg-[var(--info)]"} animate-pulse`}
          />
          {urgent ? "Needs your attention" : "The fleet is working"}
        </span>
        {activeRuns.length > 0 && (
          <span className="text-[var(--step-minus-1)] text-[var(--text-soft)]">
            <strong className="text-[var(--text)]">{count(activeRuns.length, "run")}</strong> in flight ·{" "}
            {summary.queuedTasks > 0 && count(summary.queuedTasks, "task queued")}
          </span>
        )}
        {pendingApprovals.length > 0 && (
          <span className="text-[var(--step-minus-1)] text-[var(--text-soft)]">
            <strong className="text-[var(--warn)]">{count(pendingApprovals.length, "decision", "decisions")}</strong>{" "}
            awaiting your approval
          </span>
        )}
        {failedRuns.length > 0 && (
          <span className="text-[var(--step-minus-1)] text-[var(--text-soft)]">
            <strong className="text-[var(--danger)]">{count(failedRuns.length, "failed run", "failed runs")}</strong>
          </span>
        )}
      </div>

      {pendingApprovals.length > 0 && (
        <div className="mt-3 border-t border-[var(--warn-dim)] pt-3 flex flex-col gap-2">
          {pendingApprovals.map(({ approval, projectName }) => (
            <div
              key={approval.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)]"
            >
              <div className="min-w-0">
                <span className="text-[var(--text)]">{approval.action}</span>
                <span className="mono ml-2 text-[var(--faint)]">{projectName}</span>
                {approval.task_id && approval.project_id ? (
                  <button
                    className="ml-2 text-[var(--accent)] hover:underline"
                    onClick={() => onOpenTask(approval.project_id as string, approval.task_id as string)}
                  >
                    open task →
                  </button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="primary" disabled={busy} onClick={() => onDecide(approval.id, "approved")}>
                  Approve once
                </Button>
                <Button disabled={busy} onClick={() => onDecide(approval.id, "approved_forever")}>
                  Forever
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => onDecide(approval.id, "denied")}>
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* --- Team-level execution rollup --- */

function perTeamCounts(
  team: TeamBundle,
  bundles: ProjectBundle[],
): { running: number; queued: number; blocked: number } {
  const inTeam = new Set(team.projects);
  let running = 0;
  let queued = 0;
  let blocked = 0;
  for (const bundle of bundles) {
    if (!inTeam.has(bundle.project.id)) continue;
    for (const task of bundle.tasks) {
      if (task.status === "running") running += 1;
      else if (task.status === "blocked") blocked += 1;
      else if (task.status === "pending" || task.status === "ready") queued += 1;
    }
  }
  return { running, queued, blocked };
}

function botStatusFor(bot: Teammate, bundles: ProjectBundle[]): string {
  for (const bundle of bundles) {
    if (bundle.project.id !== bot.project_id) continue;
    const mine = bundle.tasks.filter((t) => t.owner_teammate_id === bot.id);
    if (mine.some((t) => t.status === "running")) return "running";
    if (mine.some((t) => t.status === "ready")) return "ready";
    if (mine.some((t) => t.status === "blocked")) return "blocked";
  }
  return bot.status;
}

function CountChip({ tone, n, children }: { tone: "info" | "warn" | "bad"; n: number; children: string }) {
  if (n === 0) return null;
  const color =
    tone === "warn"
      ? "border-[var(--warn)] text-[var(--warn)] bg-[var(--warn-dim)]"
      : tone === "bad"
        ? "border-[var(--danger)] text-[var(--danger)] bg-[var(--danger-dim)]"
        : "border-[var(--info)] text-[var(--info)] bg-[var(--info-dim)]";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[var(--step-minus-1)] font-medium ${color}`}>
      <strong>{n}</strong> {children}
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
  if (!summary) return <EmptyState title="Loading execution state…" />;
  if (summary.teams.length === 0) {
    return (
      <EmptyState
        title="No teams yet"
        hint="Group bots into teams to get a live rollup of what each crew is running, queued, or waiting on."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      {summary.teams.map((bundle, index) => {
        const counts = perTeamCounts(
          bundle,
          summary.bundles,
        );
        const busyBots = bundle.teammates.filter(
          (bot) => statusTone(botStatusFor(bot, summary.bundles)) === "info",
        ).length;
        return (
          <button
            key={bundle.team.id}
            onClick={() => onOpenTeam(bundle.team.id)}
            className={`group flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] ${
              index > 0 ? "border-t border-[var(--border-dim)]" : ""
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-[var(--text)]">{bundle.team.name || "Unnamed team"}</span>
                <span className="text-[var(--step-minus-1)] text-[var(--faint)]">team</span>
              </div>
              <div className="mt-0.5">
                {bundle.teammates.length > 0 ? (
                  <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
                    {counts.running > 0 ? `${counts.running} running · ` : ""}
                    {count(busyBots, "bot")} on deck
                  </span>
                ) : (
                  <span className="text-[var(--step-minus-1)] text-[var(--muted)]">no bots assigned</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <CountChip tone="info" n={counts.running}>running</CountChip>
              <CountChip tone="bad" n={counts.blocked}>awaiting approval</CountChip>
              <CountChip tone="warn" n={counts.queued}>queued</CountChip>
              <span className="text-[var(--faint)] transition-transform group-hover:translate-x-0.5" aria-hidden>→</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function teamRollupLine(summary: WorkspaceSummary): string {
  const bits: string[] = [];
  if (summary.runningTasks) bits.push(`${summary.runningTasks} running`);
  if (summary.queuedTasks) bits.push(`${summary.queuedTasks} queued`);
  if (summary.blockedTasks) bits.push(`${summary.blockedTasks} awaiting approval`);
  return bits.join(" · ");
}
