import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Cross-workspace awareness for the Command Center.
 *
 *  The chat is project-scoped, but the owner needs to see what the fleet as a
 *  whole is doing: runs in flight, decisions pending, and how each team is
 *  executing. This module aggregates those signals across every project and
 *  team on the server (one personal workspace server — a handful of projects,
 *  so a bounded fan-out is fine). */
import { api } from "./api";
import { useAsync, statusTone, taskTally, approvalIsPending, Button, EmptyState } from "./components";
const count = (n, singular, plural) => `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;
export function summarize(data, now) {
    const taskById = new Map();
    for (const bundle of data.bundles) {
        for (const task of bundle.tasks)
            taskById.set(task.id, task);
    }
    const runningRunIds = new Set();
    const activeRuns = [];
    const failedRuns = [];
    const pendingApprovals = [];
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
                if (run.task_id && runningRunIds.has(run.task_id))
                    continue;
                if (run.task_id)
                    runningRunIds.add(run.task_id);
                activeRuns.push({ run, projectId: bundle.project.id, projectName: name, task: taskById.get(run.task_id) ?? null });
            }
            else if (run.status === "failed") {
                const task = taskById.get(run.task_id) ?? null;
                /* A failed attempt is history once the task succeeded, was cancelled,
                   or has a newer run in flight. Keeping those in the banner would
                   leave the owner looking at a solved problem forever. */
                if (task &&
                    (task.status === "done" || task.status === "cancelled" || task.status === "running")) {
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
export function useWorkspaceSummary() {
    const state = useAsync(async () => {
        let loadFailed = false;
        const soft = (p, fallback) => p.catch(() => {
            loadFailed = true;
            return fallback;
        });
        const [projectsRes, teamsRes, botsRes] = await Promise.all([
            soft(api.listProjects(), { projects: [], counts: {} }),
            soft(api.listTeams(), { teams: [], counts: {} }),
            soft(api.listAllTeammates(), { teammates: [] }),
        ]);
        const projectList = projectsRes.projects ?? [];
        const bundles = await Promise.all(projectList.map(async (project) => {
            const [tasks, runs, approvals, teammates] = await Promise.all([
                soft(api.projectTasks(project.id).then((r) => r.tasks), []),
                soft(api.projectRuns(project.id).then((r) => r.runs), []),
                soft(api.projectApprovals(project.id).then((r) => r.approvals), []),
                soft(api.listTeammates(project.id).then((r) => r.teammates), []),
            ]);
            return { project, tasks, runs, approvals, teammates };
        }));
        const teams = await Promise.all((teamsRes.teams ?? []).map(async (team) => {
            const detail = await soft(api.getTeam(team.id), null);
            if (!detail)
                return { team, projects: [], teammates: [] };
            return {
                team,
                projects: detail.projects.map((p) => p.id),
                teammates: detail.teammates,
            };
        }));
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
function emptySummary() {
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
/* --- Attention banner --- */
export function AttentionBanner({ summary, busy, onDecide, onOpenTask, }) {
    if (!summary)
        return null;
    const { activeRuns, pendingApprovals, failedRuns } = summary;
    if (activeRuns.length === 0 && pendingApprovals.length === 0 && failedRuns.length === 0) {
        return null;
    }
    const urgent = pendingApprovals.length > 0 || failedRuns.length > 0;
    /* Three failed attempts at one task are one thing to look at, not three.
       Keep the newest run per task and count the attempts. */
    const failuresByTask = new Map();
    for (const failure of failedRuns) {
        const key = failure.task?.id ?? failure.run.id;
        const seen = failuresByTask.get(key);
        if (seen)
            seen.attempts += 1;
        else
            failuresByTask.set(key, { ...failure, attempts: 1 });
    }
    const shownFailures = [...failuresByTask.values()].slice(0, 3);
    return (_jsxs("section", { "aria-label": "Attention", className: `order-3 rounded-xl border px-4 py-3 ${urgent
            ? "border-[var(--warn)] bg-[var(--warn-dim)]"
            : "border-[var(--border)] bg-[var(--surface)]"}`, children: [_jsxs("div", { className: "flex flex-wrap items-center gap-x-5 gap-y-2", children: [_jsxs("span", { className: `inline-flex items-center gap-2 text-step--1 font-medium uppercase tracking-[0.14em] ${urgent ? "text-[var(--warn)]" : "text-[var(--info)]"}`, children: [_jsx("span", { className: `h-2 w-2 rounded-full ${urgent ? "bg-[var(--warn)]" : "bg-[var(--info)]"}` }), urgent ? "Needs your attention" : "The fleet is working"] }), activeRuns.length > 0 && (_jsxs("span", { className: "text-step--1 text-[var(--text-soft)]", children: [_jsx("strong", { className: "text-[var(--text)]", children: count(activeRuns.length, "run") }), " in flight \u00B7", " ", summary.queuedTasks > 0 && count(summary.queuedTasks, "task queued"), " \u00B7", " ", activeRuns.slice(0, 2).map((run, idx) => (_jsxs("button", { className: "text-[var(--accent)] hover:underline", onClick: () => onOpenTask(run.projectId, run.run.task_id), children: [idx > 0 ? " · " : "", run.task?.description?.trim().slice(0, 40) || "Open task"] }, run.run.id)))] })), pendingApprovals.length > 0 && (_jsxs("span", { className: "text-step--1 text-[var(--text-soft)]", children: [_jsx("strong", { className: "text-[var(--warn)]", children: count(pendingApprovals.length, "decision", "decisions") }), " ", "awaiting your approval"] })), failedRuns.length > 0 && (_jsx("span", { className: "text-step--1 text-[var(--text-soft)]", children: _jsx("strong", { className: "text-[var(--danger)]", children: count(failedRuns.length, "failed run", "failed runs") }) }))] }), failedRuns.length > 0 && (_jsxs("div", { className: "mt-3 flex flex-col gap-1 border-t border-[var(--warn-dim)] pt-3", children: [shownFailures.map(({ run, task, projectName, projectId, attempts }) => (_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-step--1", children: [_jsxs("span", { className: "flex min-w-0 flex-1 items-baseline gap-2", children: [_jsx("span", { className: "truncate text-[var(--text)]", children: task?.description?.trim() || "A run failed" }), _jsxs("span", { className: "shrink-0 text-[var(--faint)]", children: [projectName, attempts > 1 ? ` · ${attempts} attempts` : ""] })] }), task ? (_jsx("button", { className: "shrink-0 font-medium text-[var(--text)] underline underline-offset-4 hover:text-[var(--text-soft)]", onClick: () => onOpenTask(projectId, task.id), children: "Open task" })) : null] }, run.id))), failuresByTask.size > 3 ? (_jsxs("span", { className: "text-step--2 text-[var(--faint)]", children: ["and ", failuresByTask.size - 3, " more"] })) : null] })), pendingApprovals.length > 0 && (_jsx("div", { className: "mt-3 border-t border-[var(--warn-dim)] pt-3 flex flex-col gap-2", children: pendingApprovals.map(({ approval, projectName }) => (_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-1.5 text-step--1", children: [_jsxs("div", { className: "flex min-w-0 flex-wrap items-baseline gap-x-2", children: [_jsx("span", { className: "text-[var(--text)]", children: approval.action }), _jsx("span", { className: "text-[var(--faint)]", children: projectName }), approval.task_id && approval.project_id ? (_jsx("button", { className: "text-[var(--accent)] hover:underline", onClick: () => onOpenTask(approval.project_id, approval.task_id), children: "open task \u2192" })) : null] }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(Button, { variant: "primary", disabled: busy, onClick: () => onDecide(approval.id, "approved"), children: "Approve once" }), _jsx(Button, { disabled: busy, onClick: () => onDecide(approval.id, "approved_forever"), children: "Forever" }), _jsx(Button, { variant: "danger", disabled: busy, onClick: () => onDecide(approval.id, "denied"), children: "Reject" })] })] }, approval.id))) }))] }));
}
/* --- Team-level execution rollup --- */
function perTeamCounts(team, bundles) {
    const inTeam = new Set(team.projects);
    const tasks = bundles.flatMap((bundle) => inTeam.has(bundle.project.id) ? bundle.tasks : []);
    const { running, queued, blocked } = taskTally(tasks);
    return { running, queued, blocked };
}
function botStatusFor(bot, bundles) {
    for (const bundle of bundles) {
        if (bundle.project.id !== bot.project_id)
            continue;
        const mine = bundle.tasks.filter((t) => t.owner_teammate_id === bot.id);
        if (mine.some((t) => t.status === "running"))
            return "running";
        if (mine.some((t) => t.status === "ready"))
            return "ready";
        if (mine.some((t) => t.status === "awaiting_approval"))
            return "blocked";
        if (mine.some((t) => t.status === "blocked"))
            return "blocked";
    }
    return bot.status;
}
function CountChip({ tone, n, children }) {
    if (n === 0)
        return null;
    const color = tone === "warn"
        ? "border-[var(--warn)] text-[var(--warn)] bg-[var(--warn-dim)]"
        : tone === "bad"
            ? "border-[var(--danger)] text-[var(--danger)] bg-[var(--danger-dim)]"
            : "border-[var(--info)] text-[var(--info)] bg-[var(--info-dim)]";
    return (_jsxs("span", { className: `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-step--1 font-medium ${color}`, children: [_jsx("strong", { children: n }), " ", children] }));
}
export function ExecutionRollup({ summary, onOpenTeam, }) {
    if (!summary)
        return _jsx(EmptyState, { title: "Loading execution state\u2026" });
    if (summary.teams.length === 0) {
        return (_jsx(EmptyState, { title: "No teams yet", hint: "Group bots into teams to get a live rollup of what each crew is running, queued, or waiting on." }));
    }
    return (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: summary.teams.map((bundle, index) => {
            const counts = perTeamCounts(bundle, summary.bundles);
            const busyBots = bundle.teammates.filter((bot) => statusTone(botStatusFor(bot, summary.bundles)) === "info").length;
            return (_jsxs("button", { onClick: () => onOpenTeam(bundle.team.id), className: `group flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "font-medium text-[var(--text)]", children: bundle.team.name || "Unnamed team" }), _jsx("span", { className: "text-step--1 text-[var(--faint)]", children: "team" })] }), _jsx("div", { className: "mt-0.5", children: bundle.teammates.length > 0 ? (_jsxs("span", { className: "text-step--1 text-[var(--muted)]", children: [counts.running > 0 ? `${counts.running} running · ` : "", count(busyBots, "bot"), " on deck"] })) : (_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "no bots assigned" })) })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(CountChip, { tone: "info", n: counts.running, children: "running" }), _jsx(CountChip, { tone: "bad", n: counts.blocked, children: "blocked" }), _jsx(CountChip, { tone: "warn", n: counts.queued, children: "queued" }), _jsx("span", { className: "text-[var(--faint)] transition-transform group-hover:translate-x-0.5", "aria-hidden": true, children: "\u2192" })] })] }, bundle.team.id));
        }) }));
}
