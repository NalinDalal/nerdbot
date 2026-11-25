/** NerdBot Command Center - AI Operating Environment.

  The homepage is the user's entry point into the autonomous AI operating
  environment. It answers three questions immediately:

  1. What can I accomplish here?
  2. What should I do next?
  3. What is already happening?

  It transitions the user from "managing agents" to "managing outcomes" while
  retaining all the execution infrastructure underneath.
*/

import { useEffect } from "react";
import { useAsync, Button, EmptyState } from "./components";
import { api } from "./api";
import { navigate } from "./router";
import { usePermissionCatalogue } from "./components/ui";
import type { Run, Task, Teammate } from "./types";

export interface ProjectBundle {
  project: { id: string; owner: string; repository: string };
  tasks: Task[];
  runs: Run[];
  approvals: any[];
  teammates: Teammate[];
}

export interface WorkspaceSummary {
  bundles: ProjectBundle[];
  teams: { id: string; name: string; status: "active" | "archived" }[];
  bots: Teammate[];
  activeRuns: Run[];
  failedRuns: Run[];
  pendingApprovals: any[];
  queuedTasks: number;
  runningTasks: number;
  blockedTasks: number;
  awaitingTasks: number;
}

export interface TeamBundle {
  team: { id: string; name: string; status: "active" | "archived" };
  projects: string[];
  teammates: Teammate[];
}

/* ---------------------------------------------------------------
   Helper: concise labeling (preserves existing contract)
   --------------------------------------------------------------- */

const count = (n: number, singular: string, plural?: string) =>
  `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;

/* ---------------------------------------------------------------
   Summary aggregation (preserves existing contract)
   --------------------------------------------------------------- */

export function summarize(
  data: Pick<WorkspaceSummary, "bundles" | "teams" | "bots">,
  now?: number,
): WorkspaceSummary {
  const bundles: ProjectBundle[] = data.bundles ?? [];
  const teams: TeamBundle[] = data.teams ?? [];
  const bots: Teammate[] = data.bots ?? [];

  const runningRuns: Run[] = [];
  const failedRuns: Run[] = [];
  const pendingApprovals: any[] = [];
  let queuedTasks = 0;
  let runningTasks = 0;
  let blockedTasks = 0;
  let awaitingTasks = 0;

  for (const bundle of bundles) {
    for (const task of bundle.tasks) {
      if (task.status === "running") runningRuns.push(task.runs?.[0] ?? task);
      if (task.status === "failed") failedRuns.push(task);
    }

    const tally = tasks => {
      let queued = 0, running = 0, blocked = 0, awaiting = 0;
      for (const t of tasks) {
        if (t.status === "queued") queued++;
        if (t.status === "running") running++;
        if (t.status === "blocked") blocked++;
        if (t.status === "awaiting_approval") awaiting++;
      }
      return { queued, running, blocked, awaiting };
    };
    const bundleTally = tally(bundle.tasks);

    queuedTasks += bundleTally.queued;
    runningTasks += bundleTally.running;
    blockedTasks += bundleTally.blocked;
    awaitingTasks += bundleTally.awaiting;

    for (const approval of bundle.approvals) {
      if (approvalIsPending(approval, now)) pendingApprovals.push(approval);
    }
  }

  return {
    bundles,
    teams: teams.length > 0 ? teams : undefined,
    bots: bots.length > 0 ? bots : undefined,
    activeRuns: runningRuns,
    failedRuns,
    pendingApprovals,
    queuedTasks,
    runningTasks,
    blockedTasks,
    awaitingTasks,
  };
}

/* ---------------------------------------------------------------
   useWorkspaceSummary hook (preserves existing contract)
   --------------------------------------------------------------- */

export function useWorkspaceSummary(): ReturnType<typeof useAsync<WorkspaceSummary>> & {
  summary: WorkspaceSummary;
  loadFailed: boolean;
} {
  const state = useAsync(async (): Promise<WorkspaceSummary> => {
    const [projectsRes, teamsRes, botsRes] = await Promise.all([
      api.listProjects(),
      api.listTeams(),
      api.listAllTeammates(),
    ]);

    const projectList = projectsRes.projects ?? [];
    const bundles: ProjectBundle[] = await Promise.all(
      projectList.map(async (project) => {
        const tasks = api.projectTasks(project.id).then(r => r.tasks) ?? [];
        const runs = api.projectRuns(project.id).then(r => r.runs) ?? [];
        const approvals = api.projectApprovals(project.id).then(r => r.approvals) ?? [];
        const teammates = api.listTeammates(project.id).then(r => r.teammates) ?? [];
        return Promise.all([tasks, runs, approvals, teammates]).then(
          ([tasks, runs, approvals, teammates]) => ({
            project,
            tasks: tasks ?? [],
            runs: runs ?? [],
            approvals: approvals ?? [],
            teammates: teammates ?? [],
          }),
        );
      }),
    );

    const teamBundles: TeamBundle[] = (teamsRes.teams ?? []).map(team => {
      const detail = api.getTeam(team.id);
      if (!detail) return { team, projects: [], teammates: [] };
      return {
        team: { ...detail, name: detail.name || "Unnamed team", status: detail.status || "active" },
        projects: detail.projects?.map((p: any) => p.id) ?? [],
        teammates: detail.teammates ?? [],
      };
    });

    return {
      summary: {
        bundles: bundles.length > 0 ? bundles : undefined,
        teams: teamBundles.length > 0 ? teamBundles : undefined,
        bots: botsRes.teammates ?? [],
        activeRuns: [],
        failedRuns: [],
        pendingApprovals: [],
        queuedTasks: 0,
        runningTasks: 0,
        blockedTasks: 0,
        awaitingTasks: 0,
      },
      loadFailed: false,
    };
  }, []);

  return {
    ...state,
    summary: state.data?.summary ?? {
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
    },
    loadFailed: state.data?.loadFailed ?? false,
  };
}

/* ---------------------------------------------------------------
   emptySummary helper (preserves existing contract)
   --------------------------------------------------------------- */

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

/* ======================================================================
   HOMEPAGE: AI Operating Environment Command Center
   ====================================================================== */

export function HomeView({
  onStartObjective,
  onOpenTask,
  onOpenTeam,
}: {
  onStartObjective: (objective: string) => void;
  onOpenTask: (projectId: string, taskId: string) => void;
  onOpenTeam: (teamId: string) => void;
}) {
  const teamButtonExtraClass = " border-t border-[var(--border-dim)]";
  const { data, loadFailed } = useWorkspaceSummary();
  const summary = data?.summary ?? emptySummary();

  /* ==============================================================
     Active work at a glance — running objectives
     ============================================================== */

  const activeWork = summary.bundles
    .filter(b => b.tasks.some(t => t.status === "running"))
    .map(b => ({
      project: b.project.repository || "Unnamed project",
      running: b.tasks.filter(t => t.status === "running").length,
      blocked: b.tasks.filter(t => t.status === "blocked").length,
      awaiting: b.tasks.filter(t => t.status === "awaiting_approval").length,
    }));

  /* ==============================================================
     Needs attention — one clear actionable item
     ============================================================== */

  const needsAttention = summary.bundles
    .filter(b => b.tasks.some(t => t.status === "blocked" || t.status === "awaiting_approval"))
    .slice(0, 3)
    .map(b => ({
      project: b.project.repository || "Unnamed project",
      issues: b.tasks
        .filter(t => t.status === "blocked" || t.status === "awaiting_approval")
        .map(t => {
          const reason = t.blocked_reason || t.status === "awaiting_approval" ? "approval needed" : t.blocked_reason;
          return { id: t.id, reason };
        }),
    }));

  /* ==============================================================
     Pending approvals — what requires user attention
     ============================================================== */

  const pendingApprovals = summary.pendingApprovals.slice(0, 5).map((a: any) => ({
    id: a.id,
    project: a.project_id ? (summary.bundles?.find((b: any) => b.project.id === a.project_id)?.project?.repository || "Unnamed project") : "Unnamed project",
    task: a.task_id ? `task ${a.task_id}` : "unknown task",
    description: a.description || "Approval required",
    status: a.status,
  }));

  /* ==============================================================
     GUIDED START — natural language objective input
     ============================================================== */

  const [objectiveText, setObjectiveText] = (React as any).useState("");
  const [isSubmitting, setIsSubmitting] = (React as any).useState(false);

  const handleStartObjective = async (e: React.MouseEvent) => {
    e.preventDefault();
    const trimmed = objectiveText.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    try {
      await onStartObjective(trimmed);
      setObjectiveText("");
      setIsSubmitting(false);
      // Navigate to the workbench to follow execution
      navigate("/workbench");
    } catch (err) {
      setIsSubmitting(false);
      console.error("Failed to start objective:", err);
    }
  };

  /* ==============================================================
     QUICK ACTION TEMPLATES — reduce decision fatigue
     ============================================================== */

  const templates = [
    { label: "Research a market", hint: "Find opportunities and competitors", category: "research" },
    { label: "Build a GTM plan", hint: "Research, strategy and execution", category: "strategy" },
    { label: "Analyze customer feedback", hint: "Turn data into decisions", category: "analysis" },
    { label: "Delegate engineering work", hint: "Engineering delegation and implementation", category: "engineering" },
    { label: "Start a new project", hint: "Create project and add teammates", category: "project" },
  ];

  /* ==============================================================
     RENDER
     ============================================================== */

  return (
    <section className="max-w-7xl mx-auto p-6 sm:p-8">
      <header className="mb-8">
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-[var(--text)]">
          AI Operating Environment
        </h1>
        <p className="text-base sm:text-lg text-[var(--muted)] mb-4">
          Your autonomous AI workforce is ready. Describe what you want to get done
          and Nerdbot will figure out which agents to use, how to break it down,
          and what requires your approval.
        </p>
      </header>

      {/* ============================================================
         WHAT DO YOU WANT TO GET DONE? - Natural language objective
         ============================================================ */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-7 mb-6">
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text)] mb-3">
          Start an objective
        </h2>

        <p className="text-step--1 text-[var(--muted)] mb-4">
          Describe what you want to accomplish. Your AI workforce will figure out
          which agents to use, how to break it down, and what requires your approval.
        </p>

        <form
          className="space-y-3"
          onSubmit={handleStartObjective}
        >
          <div>
            <textarea
              value={objectiveText}
              onChange={(e: React.ChangeEvent) => setObjectiveText(e.target.value)}
              placeholder="e.g. Research 50 SaaS companies experiencing API dependency risks, identify their CTOs, prepare personalized outreach drafts, and organize everything in my workspace"
              rows={3}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 text-[var(--text)] placeholder-text-[var(--muted)] focus-ring:outline-none focus-ring:ring-2 focus-ring ring-[var(--accent)] focus-ring:ring-offset-2 resize-none"
              style={{ minHeight: 100 }}
              disabled={isSubmitting}
              aria-disabled={isSubmitting}
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full sm:w-auto rounded-xl px-6 py-3 text-step--1 font-medium text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Working..." : "Launch Autonomous Execution"}
          </button>
        </form>

        {pendingApprovals.length > 0 && (
          <p className="mt-3 text-step--1 text-[var(--muted)]">
            {pendingApprovals.length} pending approval{s > 1 ? 's' : ''}{' '}
            {pendingApprovals.some(a => a.status === 'awaiting_approval') ? 'requires your approval to continue' : ''}
          </p>
        )}
      </section>

      {/* ============================================================
         ACTIVE WORK - Running objectives at a glance
         ============================================================ */}
      {summary.runningTasks > 0 && (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-7 mb-5">
          <h3 className="text-xl font-medium text-[var(--text)] mb-3">
            <span className="text-[var(--accent)]">Running</span> objectives
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeWork.map((work, i) => (
              <article
                key={i}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 transition-colors hover:bg-[var(--surface)]"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <strong className="text-step--1 text-[var(--text)]">
                    {work.project}
                  </strong>
                  <span className="text-xs text-[var(--muted)]">
                    {work.running} running
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-step--1">
                  <div>
                    <span className="text-[var(--muted)]">blocked</span>
                    <span className="font-medium text-[var(--warn)]">{work.blocked}</span>
                  </div>
                  <div>
                    <span className="text-[var(--muted)]">awaiting</span>
                    <span className="font-medium text-[var(--muted)]">{work.awaiting}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* ============================================================
         NEEDS ATTENTION - What requires user action
         ============================================================ */}
      {needsAttention.length > 0 && (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-7 mb-5">
          <h3 className="text-xl font-medium text-[var(--text)] mb-3">
            <span className="text-[var(--warn)]">Needs attention</span>
          </h3>
          <p className="text-step--1 text-[var(--muted)] mb-4">
            The following tasks require your intervention:
          </p>
          <ul className="space-y-3 max-h-80 overflow-y-auto">
            {needsAttention.map((item, i) => (
              <li
                key={i}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 transition-colors hover:bg-[var(--surface)]"
              >
                <div className="flex items-center justify-between mb-1">
                  <strong className="text-step--1 text-[var(--text)]">
                    {item.project}
                  </strong>
                  <span className="text-xs text-[var(--muted)]">
                    {item.issues.length} issue{s > 1 ? 's' : ''}
                  </span>
                </div>
                <p className="text-step--1 text-[var(--muted)] small">
                  {item.issues.map((issue: any, j: number) => (
                    <span key={j}>
                      {j > 0 && ", "}{issue.reason}
                    </span>
                  ))}</p
                >
                <Button
                  variant="ghost"
                  className="mt-2 w-full sm:w-auto rounded-md px-3 py-1.5 text-step--1 text-[var(--muted)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                  onClick={() => onOpenTask(item.project, item.issues[0]?.id ?? "")}
                >
                  Resolve
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ============================================================
         QUICK ACTION TEMPLATES - One clear action, not a grid
         ============================================================ */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-7 mb-5">
        <h3 className="text-xl font-medium text-[var(--text)] mb-3">
          Quick actions
        </h3>
        <p className="text-step--1 text-[var(--muted)] mb-4">
          Describe what you want to accomplish — or choose a template:
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          {templates.map((template, i) => (
            <Button
              key={i}
              variant="ghost"
              className="rounded-xl px-4 py-2.5 text-step--1 text-[var(--muted)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors flex items-center gap-2"
              onClick={() => setObjectiveText(template.label)}
            >
              <span className="text-step--1">{template.label}</span>
              <span className="text-[var(--faint)] text-xs">{template.hint}</span>
            </Button>
          ))}
        </div>
      </section>

      {/* ============================================================
         YOUR WORKFORCE - AI team concept communication
         ============================================================ */}
      {summary.teams.length > 0 ? (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 mb-5">
          <h3 className="text-lg font-medium text-[var(--text)] mb-3">
            My Workforce
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            {summary.teams.map((bundle, index) => (
              <article
                key={bundle.team.id}
                className="rounded-xl border border-[var(--surface-2)] bg-[var(--surface)] p-3 sm:p-4 transition-colors hover:bg-[var(--surface-2)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--text)]">
                    {bundle.team.name || "Unnamed team"}
                  </span>
                  <Badge variant={bundle.team.status === "archived" ? "neutral" : "ok"}>
                    {bundle.team.status === "archived" ? "Archived" : "Active"}
                  </Badge>
                </div>

                <div className="text-step--1">
                  {bundle.teammates.length > 0 ? (
                    <span className="ml-2 text-[var(--muted)]">· {bundle.teammates.length} on deck</span>
                  ) : (
                    <span className="text-[var(--muted)]">no bots</span>
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2 text-step--1 text-[var(--muted)]">
            <span className="font-medium text-[var(--text)]">
              {summary.runningTasks} task{s > 1 ? 's' : ''} running
            </span>
            {summary.runningTasks > 0 && summary.runningTasks < 4 ? (
              <span className="ml-1 text-[var(--accent)] font-medium">in progress</span>
            ) : null}
            <span className="ml-2">·</span>
            <span>{summary.queuedTasks} queued</span>
          </div>
        </section>
      ) : (
        <EmptyState
          title="No teams yet"
          hint="Group bots into teams to see each crew's execution state."
        />
      )}

      {/* ============================================================
         EXECUTION ROLLUP - Teams overview with live state
         ============================================================ */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 mb-5">
        <h3 className="text-lg font-medium text-[var(--text)] mb-3">
          Execution Rollup
        </h3>
        {summary.teams.length === 0 ? (
          <EmptyState
            title="No teams yet"
            hint="Group bots into teams to get a live rollup of what each crew is running, queued, or waiting on."
          />
        ) : (
          summary.teams.map((bundle, index) => {
            const tasks = summary.bundles?.flatMap((b: any) => b.tasks) ?? [];
            const running = tasks.filter((t: any) => t.status === "running").length;
            const queued = tasks.filter((t: any) => t.status === "queued").length;
            const blocked = tasks.filter((t: any) => t.status === "blocked").length;

            const busyBots = bundle.teammates.filter(
              (bot: any) =>
                b.tasks.some((t: any) => t.owner_teammate_id === bot.id && t.status === "running")
            ).length;

            return (
              <button
                key={bundle.team.id}
                onClick={() => onOpenTeam(bundle.team.id)}
                className="flex w-full flex-wrap items-center gap-3 py-3 px-4 rounded-xl transition-colors hover:bg-[var(--surface-2)]" + (index > 0 ? teamButtonExtraClass : "")
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text)]">
                      {bundle.team.name || "Unnamed team"}
                    </span>
                    <span className="text-xs text-[var(--faint)]">team</span>
                  </div>
                  <div className="mt-1">
                    {bundle.teammates.length > 0 ? (
                      <span className="text-step--1 text-[var(--muted)]">
                        {running > 0 ? `${running} running·` : ""}
                        {busyBots} on deck
                      </span>
                    ) : (
                      <span className="text-step--1 text-[var(--muted)]">no bots</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {running > 0 && <span className="text-step--1 text-[var(--accent)]">running</span>}
                  {blocked > 0 && <span className="text-step--1 text-[var(--warn)]">blocked</span>}
                  {queued > 0 && <span className="text-step--1 text-[var(--muted)]">queued</span>}
                  <span className="text-[var(--faint)]" aria-hidden>→</span>
                </div>
              </button>
            );
          })}
        )}
      </section>

      {/* ============================================================
         PROJECT SNAPSHOTS - Quick project state glance
         ============================================================ */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 mb-5">
        <h3 className="text-lg font-medium text-[var(--text)] mb-3">
          Projects
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {summary.bundles.map((bundle, i) => {
            const tally = tasks => {
              let q = 0, r = 0, b = 0, a = 0;
              for (const t of tasks) {
                if (t.status === "queued") q++;
                if (t.status === "running") r++;
                if (t.status === "blocked") b++;
                if (t.status === "awaiting_approval") a++;
              }
              return { q, r, b, a };
            }(bundle.tasks);

            return (
              <article
                key={bundle.project.id}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4 transition-colors hover:bg-[var(--surface-2)]"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <h4 className="font-medium text-[var(--text)] truncate">
                    {bundle.project.repository || "Unnamed project"}
                  </h4>
                  <span className="text-xs text-[var(--faint)]">
                    {count(bundle.tasks.length, "task", "tasks")}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1 text-xs text-step--1">
                  <div>
                    <span className="text-[var(--muted)]">running</span>
                    <span className="font-medium text-[var(--accent)]">{tally.running}</span>
                  </div>
                  <div>
                    <span className="text-[var(--muted)]">queued</span>
                    <span className="font-medium text-[var(--muted)]">{tally.queued}</span>
                  </div>
                  <div>
                    <span className="text-[var(--muted)]">blocked</span>
                    <span className="font-medium text-[var(--warn)]">{tally.blocked}</span>
                  </div>
                </div>

                <div className="mt-2">
                  <Button
                    variant="secondary"
                    onClick={() => onOpenTask(bundle.project.id, bundle.tasks[0]?.id ?? "")}
                    className="w-full sm:w-auto rounded-md px-3 py-1.5 text-step--1 text-[var(--accent)] hover:bg-[var(--surface-2)]"
                  >
                    View tasks
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {loadFailed && (
        <section
          className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-5 sm:p-6 mb-6"
        >
          <p className="text-step--1 text-[var(--muted)]">
            Unable to load fleet signals. <a href="#" className="underline underline-offset-2 hover:text-[var(--accent)]">Retry</a>.</p>
        </section>
      )}
    </section>
  );
}