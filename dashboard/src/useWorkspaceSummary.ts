import { useAsync } from "./components";
import { api } from "./api";
import { approvalIsPending } from "./components";
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
  teams: TeamBundle[];
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

interface WorkspaceSummarySnapshot {
  summary: WorkspaceSummary;
  loadFailed: boolean;
}

function summarize(
  data: Pick<WorkspaceSummary, "bundles" | "teams" | "bots">,
  now?: number,
): WorkspaceSummary {
  const bundles = data.bundles ?? [];
  const teams = data.teams ?? [];
  const bots = data.bots ?? [];

  const runningRuns: Run[] = [];
  const failedRuns: Run[] = [];
  const pendingApprovals: any[] = [];
  let queuedTasks = 0;
  let runningTasks = 0;
  let blockedTasks = 0;
  let awaitingTasks = 0;

  for (const bundle of bundles) {
    for (const run of bundle.runs) {
      if (run.status === "running") runningRuns.push(run);
      if (run.status === "failed") failedRuns.push(run);
    }

    for (const t of bundle.tasks) {
      if (t.status === "queued") queuedTasks++;
      if (t.status === "running") runningTasks++;
      if (t.status === "blocked") blockedTasks++;
      if (t.status === "awaiting_approval") awaitingTasks++;
    }

    for (const approval of bundle.approvals) {
      if (approvalIsPending(approval, now)) pendingApprovals.push(approval);
    }
  }

  return {
    bundles,
    teams,
    bots,
    activeRuns: runningRuns,
    failedRuns,
    pendingApprovals,
    queuedTasks,
    runningTasks,
    blockedTasks,
    awaitingTasks,
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

export function useWorkspaceSummary() {
  const state = useAsync(async (): Promise<WorkspaceSummarySnapshot> => {
    const [projectsRes, teamsRes, botsRes] = await Promise.all([
      api.listProjects(),
      api.listTeams(),
      api.listAllTeammates(),
    ]);

    const bundles: ProjectBundle[] = await Promise.all(
      (projectsRes.projects ?? []).map(async (project) => {
        const [tasksRes, runsRes, approvalsRes, teammatesRes] = await Promise.all([
          api.projectTasks(project.id),
          api.projectRuns(project.id),
          api.projectApprovals(project.id),
          api.listTeammates(project.id),
        ]);
        return {
          project,
          tasks: tasksRes.tasks ?? [],
          runs: runsRes.runs ?? [],
          approvals: approvalsRes.approvals ?? [],
          teammates: teammatesRes.teammates ?? [],
        };
      }),
    );

    const teamBundles: TeamBundle[] = await Promise.all(
      (teamsRes.teams ?? []).map(async (team) => {
        const detail = await api.getTeam(team.id);
        return {
          team: {
            id: detail.team.id || team.id,
            name: detail.team.name || team.name || "Unnamed team",
            status: detail.team.status ?? team.status ?? "active",
          },
          projects: (detail.projects ?? []).map((p) => p.id),
          teammates: detail.teammates ?? [],
        };
      }),
    );

    return {
      summary: summarize({
        bundles,
        teams: teamBundles,
        bots: botsRes.teammates ?? [],
      }),
      loadFailed: false,
    };
  }, []);

  return {
    ...state,
    summary: state.data?.summary ?? emptySummary(),
    loadFailed: state.data?.loadFailed ?? Boolean(state.error),
  };
}
