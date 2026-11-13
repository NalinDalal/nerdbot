import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo } from "react";
import { api } from "../api";
import { navigate } from "../app";
import { Badge, BotFace, Button, EmptyState, ErrorState, LoadingState, StatusBadge, relativeTime, useAsync, } from "../components";
import { taskTitle } from "../taskTitle";
function settled(promise) {
    return promise.then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error }));
}
export function computeWorkspaceOverviewModel(result) {
    const tasks = result.tasks.ok ? (result.tasks.value.tasks ?? []) : [];
    const runs = result.runs.ok ? (result.runs.value.runs ?? []) : [];
    const teammates = result.teammates.ok ? (result.teammates.value.teammates ?? []) : [];
    const approvals = result.approvals.ok ? (result.approvals.value.approvals ?? []) : [];
    const libraryDocs = result.library.ok ? (result.library.value.docs ?? []) : [];
    const galleryAssets = result.gallery.ok ? (result.gallery.value.assets ?? []) : [];
    const failedSources = [];
    if (!result.tasks.ok)
        failedSources.push("tasks");
    if (!result.runs.ok)
        failedSources.push("runs");
    if (!result.teammates.ok)
        failedSources.push("agents");
    if (!result.approvals.ok)
        failedSources.push("approvals");
    if (!result.library.ok)
        failedSources.push("library");
    if (!result.gallery.ok)
        failedSources.push("gallery");
    const runningTasks = tasks.filter((t) => t.status === "running");
    const queuedTasks = tasks.filter((t) => ["ready", "pending", "queued"].includes(t.status));
    const blockedTasks = tasks.filter((t) => t.status === "blocked");
    const awaitingTasks = tasks.filter((t) => t.status === "awaiting_approval");
    const failedTasks = tasks.filter((t) => t.status === "failed");
    const attentionApprovals = approvals.filter((a) => {
        const decision = String(a.decision ?? a.status ?? "").toLowerCase();
        return !decision || decision === "pending" || decision === "awaiting_approval";
    });
    const deliverables = [
        ...libraryDocs.map((doc) => ({
            id: `doc:${doc.id}`,
            kind: "Document",
            name: doc.title || doc.source || "Untitled document",
            when: doc.updated_at || doc.created_at || "",
            href: `/library/${doc.id}`,
            meta: doc.format || doc.kind || doc.source || "Library",
            source: "Library",
        })),
        ...galleryAssets.map((asset) => ({
            id: `asset:${asset.id}`,
            kind: "Asset",
            name: asset.name || "Untitled asset",
            when: asset.created_at || "",
            href: `/gallery`,
            meta: asset.mime_type || "Gallery",
            source: "Gallery",
        })),
    ]
        .sort((a, b) => String(b.when).localeCompare(String(a.when)))
        .slice(0, 8);
    return {
        tasks, runs, teammates, approvals, libraryDocs, galleryAssets, failedSources,
        runningTasks, queuedTasks, blockedTasks, awaitingTasks, failedTasks, attentionApprovals, deliverables,
    };
}
function useWorkspaceOperatingData(projectId) {
    return useAsync(async () => {
        const [tasks, runs, teammates, approvals, library, gallery] = await Promise.all([
            settled(api.projectTasks(projectId)),
            settled(api.projectRuns(projectId)),
            settled(api.listTeammates(projectId)),
            settled(api.projectApprovals(projectId).catch(() => ({ approvals: [] }))),
            settled(api.listLibrary(projectId).catch(() => ({ docs: [] }))),
            settled(api.listGallery(projectId, { limit: 12 }).catch(() => ({ assets: [], total: 0 }))),
        ]);
        return { tasks, runs, teammates, approvals, library, gallery };
    }, [projectId]);
}
function Section({ title, description, action, children, className = "", }) {
    return (_jsxs("section", { className: className, children: [_jsxs("div", { className: "mb-3 flex flex-wrap items-end justify-between gap-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("h3", { className: "text-step-0 font-semibold tracking-tight text-[var(--text)]", children: title }), description ? _jsx("p", { className: "mt-0.5 max-w-2xl text-step--1 text-[var(--muted)]", children: description }) : null] }), action ? _jsx("div", { className: "flex flex-wrap gap-2", children: action }) : null] }), children] }));
}
function PartialLoadNotice({ failed, onRetry }) {
    if (failed.length === 0)
        return null;
    return (_jsxs("div", { className: "mb-5 rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-step--1 text-[var(--text)]", role: "status", children: ["Some workspace information could not be loaded: ", failed.join(", "), ". Showing available data only.", " ", _jsx("button", { className: "underline underline-offset-4", onClick: onRetry, children: "Retry" })] }));
}
function isActiveTaskStatus(status) {
    return ["running", "ready", "pending", "queued"].includes(status);
}
function isBlockedTaskStatus(status) {
    return status === "blocked" || status === "awaiting_approval";
}
export function observedAgentState(teammateId, tasks) {
    const mine = tasks.filter((t) => t.owner_teammate_id === teammateId);
    const running = mine.filter((t) => t.status === "running").length;
    const queued = mine.filter((t) => ["ready", "pending", "queued"].includes(t.status)).length;
    const blocked = mine.filter((t) => isBlockedTaskStatus(t.status)).length;
    const failed = mine.filter((t) => t.status === "failed").length;
    if (running > 0)
        return { label: "Working now", tone: "info", detail: `${running} running${queued ? ` · ${queued} queued` : ""}` };
    if (blocked > 0)
        return { label: "Blocked", tone: "warn", detail: `${blocked} blocked or awaiting approval` };
    if (queued > 0)
        return { label: "Queued work", tone: "neutral", detail: `${queued} queued` };
    if (failed > 0)
        return { label: "Needs review", tone: "bad", detail: `${failed} failed task${failed === 1 ? "" : "s"}` };
    if (mine.length > 0)
        return { label: "No active assignment observed", tone: "neutral", detail: "Has task history in this workspace" };
    return { label: "No active assignment observed", tone: "neutral", detail: "No tasks assigned yet" };
}
export function ProjectOperatingOverview({ projectId, workspaceName, onOpenTask, onSelectTab, }) {
    const load = useWorkspaceOperatingData(projectId);
    const result = load.data;
    const model = useMemo(() => (result ? computeWorkspaceOverviewModel(result) : null), [result]);
    const { tasks = [], runs = [], teammates = [], approvals = [], failedSources = [], runningTasks = [], queuedTasks = [], blockedTasks = [], awaitingTasks = [], failedTasks = [], attentionApprovals = [], deliverables = [], } = model ?? {};
    const runsByTask = useMemo(() => {
        const map = new Map();
        for (const run of runs) {
            const arr = map.get(run.task_id) || [];
            arr.push(run);
            map.set(run.task_id, arr);
        }
        for (const arr of map.values())
            arr.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
        return map;
    }, [runs]);
    if (load.loading && !load.data) {
        return _jsx(LoadingState, { lines: 8 });
    }
    if (load.error && !load.data) {
        return _jsx(ErrorState, { error: load.error, onRetry: load.reload });
    }
    const attentionCount = attentionApprovals.length + failedTasks.length + blockedTasks.length + awaitingTasks.length;
    const resumeTasks = [...runningTasks, ...blockedTasks, ...awaitingTasks, ...queuedTasks, ...failedTasks]
        .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
        .slice(0, 5);
    return (_jsxs("div", { className: "flex flex-col gap-8", children: [_jsx(PartialLoadNotice, { failed: failedSources, onRetry: load.reload }), _jsxs("section", { className: "flex flex-col gap-4", children: [_jsxs("div", { className: "flex flex-wrap items-start justify-between gap-4", children: [_jsxs("div", { className: "min-w-0 max-w-3xl", children: [_jsx("p", { className: "text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Workspace" }), _jsx("h2", { className: "mt-1 text-step-3 font-semibold tracking-tight text-[var(--text)]", children: workspaceName }), _jsx("p", { className: "mt-2 text-step-0 text-[var(--muted)]", children: "Resume work, make decisions, and review what your AI teammates have produced." })] }), _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Button, { onClick: () => onSelectTab("Chat"), children: "Ask or delegate" }), _jsx(Button, { variant: "primary", onClick: () => onSelectTab("Work"), children: "Start work" })] })] }), attentionCount > 0 || resumeTasks.length > 0 || deliverables.length > 0 ? (_jsxs("div", { className: "grid gap-3 sm:grid-cols-3", children: [_jsxs("button", { className: "rounded-lg bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]", onClick: () => attentionCount > 0 ? undefined : onSelectTab("Work"), children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "Needs attention" }), _jsx("div", { className: `mt-1 text-step-1 font-semibold ${attentionCount > 0 ? "text-[var(--warn)]" : "text-[var(--text)]"}`, children: failedSources.includes("approvals") && failedSources.includes("tasks") ? "—" : attentionCount }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--faint)]", children: "Approvals, blockers, failures" })] }), _jsxs("button", { className: "rounded-lg bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]", onClick: () => onSelectTab("Work"), children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "In progress" }), _jsx("div", { className: "mt-1 text-step-1 font-semibold text-[var(--text)]", children: failedSources.includes("tasks") ? "—" : runningTasks.length + queuedTasks.length }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--faint)]", children: "Running and queued work" })] }), _jsxs("button", { className: "rounded-lg bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]", onClick: () => onSelectTab("Knowledge"), children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "Recent outcomes" }), _jsx("div", { className: "mt-1 text-step-1 font-semibold text-[var(--text)]", children: failedSources.includes("library") && failedSources.includes("gallery") ? "—" : deliverables.length }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--faint)]", children: "Openable deliverables" })] })] })) : null] }), _jsxs("div", { className: "grid gap-8 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]", children: [_jsxs("div", { className: "flex flex-col gap-8", children: [_jsx(Section, { title: "Continue work", description: "Pick up what\u2019s underway or needs a next step.", children: failedSources.includes("tasks") ? (_jsx(EmptyState, { title: "Work status unavailable", hint: "Tasks could not be loaded.", action: _jsx(Button, { onClick: load.reload, children: "Retry" }) })) : resumeTasks.length === 0 ? (_jsx(EmptyState, { title: "Nothing in progress", hint: "Start by asking in chat or creating work for a teammate.", action: _jsxs("div", { className: "flex flex-wrap justify-center gap-2", children: [_jsx(Button, { onClick: () => onSelectTab("Chat"), children: "Ask or delegate" }), _jsx(Button, { variant: "primary", onClick: () => onSelectTab("Work"), children: "Start work" })] }) })) : (_jsx("div", { className: "flex flex-col divide-y divide-[var(--border-dim)] rounded-lg bg-[var(--surface)]", children: resumeTasks.map((t) => {
                                        const owner = teammates.find((m) => m.id === t.owner_teammate_id);
                                        const latestRun = (runsByTask.get(t.id) || [])[0];
                                        const label = t.status === "awaiting_approval" ? "Awaiting approval" : t.status === "blocked" ? "Blocked" : t.status === "failed" ? "Needs review" : t.status === "running" ? "In progress" : "Queued";
                                        return (_jsxs("button", { className: "flex items-start justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]", onClick: () => onOpenTask(t.id), children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate text-step--1 font-medium text-[var(--text)]", children: t.title || taskTitle(t.description) }), _jsxs("div", { className: "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-step--2 text-[var(--muted)]", children: [_jsx("span", { children: label }), _jsx("span", { children: "\u00B7" }), _jsx("span", { children: owner?.persona || owner?.name || "Unassigned" }), t.blocked_reason ? _jsxs(_Fragment, { children: [_jsx("span", { children: "\u00B7" }), _jsx("span", { className: "truncate", children: t.blocked_reason })] }) : latestRun?.status ? _jsxs(_Fragment, { children: [_jsx("span", { children: "\u00B7" }), _jsxs("span", { children: ["Latest run: ", latestRun.status] })] }) : null] })] }), _jsx("span", { className: "shrink-0 text-step--2 text-[var(--accent)]", children: "Open" })] }, t.id));
                                    }) })) }), _jsx(Section, { title: "Needs attention", description: "Decisions and blockers that affect progress.", action: attentionCount > 0 ? _jsx(Button, { onClick: () => onSelectTab("Work"), children: "View work" }) : undefined, children: attentionCount === 0 ? (failedSources.includes("tasks") && failedSources.includes("approvals") ? (_jsx(EmptyState, { title: "Attention status unavailable", hint: "Task or approval data could not be loaded.", action: _jsx(Button, { onClick: load.reload, children: "Retry" }) })) : (_jsx("div", { className: "rounded-lg bg-[var(--surface)] px-4 py-3 text-step--1 text-[var(--muted)]", children: "No approvals, blockers, or failures need attention right now." }))) : (_jsxs("div", { className: "flex flex-col gap-2", children: [attentionApprovals.slice(0, 4).map((a) => (_jsx("div", { className: "rounded-lg border border-[var(--warn)]/40 bg-[var(--warn-dim)] px-4 py-3", children: _jsxs("div", { className: "flex flex-wrap items-start justify-between gap-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "font-medium text-[var(--text)]", children: a.action || "Approval requested" }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--muted)]", children: a.reason || a.message || "A decision is required to continue." })] }), _jsx(Button, { variant: "primary", onClick: () => a.task_id ? onOpenTask(a.task_id) : onSelectTab("Approvals"), children: "Review" })] }) }, a.id))), failedTasks.slice(0, 3).map((t) => (_jsxs("button", { className: "rounded-lg border border-[var(--danger)]/40 bg-[var(--danger-dim)] px-4 py-3 text-left", onClick: () => onOpenTask(t.id), children: [_jsx("div", { className: "font-medium text-[var(--text)]", children: t.title || taskTitle(t.description) }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--muted)]", children: "Failed \u2014 open to review what happened and try again." })] }, t.id))), [...blockedTasks, ...awaitingTasks].filter((t) => !failedTasks.some(f => f.id === t.id)).slice(0, 3).map((t) => (_jsxs("button", { className: "rounded-lg bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]", onClick: () => onOpenTask(t.id), children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "font-medium text-[var(--text)]", children: t.title || taskTitle(t.description) }), _jsx(StatusBadge, { status: t.status })] }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--muted)]", children: t.blocked_reason || (t.status === "awaiting_approval" ? "Waiting for approval." : "Blocked and needs input.") })] }, t.id)))] })) }), _jsx(Section, { title: "Recent outcomes", description: "Deliverables produced in this workspace.", action: _jsx(Button, { onClick: () => onSelectTab("Knowledge"), children: "Open library" }), children: failedSources.includes("library") && failedSources.includes("gallery") ? (_jsx(EmptyState, { title: "Outcomes unavailable", hint: "Library and gallery data could not be loaded.", action: _jsx(Button, { onClick: load.reload, children: "Retry" }) })) : deliverables.length === 0 ? (_jsx(EmptyState, { title: "No outcomes yet", hint: "Documents and assets produced here will appear for review.", action: _jsx(Button, { onClick: () => onSelectTab("Chat"), children: "Ask a teammate to produce something" }) })) : (_jsx("div", { className: "flex flex-col divide-y divide-[var(--border-dim)] rounded-lg bg-[var(--surface)]", children: deliverables.map((d) => (_jsxs("button", { className: "flex items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]", onClick: () => navigate(d.href), children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "truncate text-step--1 font-medium text-[var(--text)]", children: d.name }), _jsx(Badge, { variant: "neutral", children: d.kind })] }), _jsxs("div", { className: "mt-0.5 text-step--2 text-[var(--muted)]", children: [d.meta, d.when ? ` · ${relativeTime(d.when)}` : ""] })] }), _jsx("span", { className: "shrink-0 text-step--2 text-[var(--accent)]", children: "Open" })] }, d.id))) })) })] }), _jsx("div", { className: "flex flex-col gap-8", children: _jsx(Section, { title: "AI teammates", description: "Collaborators in this workspace.", action: _jsx(Button, { onClick: () => onSelectTab("Agents"), children: "View agents" }), children: failedSources.includes("agents") ? (_jsx(EmptyState, { title: "Agents unavailable", hint: "Teammate data could not be loaded.", action: _jsx(Button, { onClick: load.reload, children: "Retry" }) })) : teammates.length === 0 ? (_jsx(EmptyState, { title: "No teammates yet", hint: "Add an AI teammate to start delegating work.", action: _jsx(Button, { variant: "primary", onClick: () => onSelectTab("Agents"), children: "Add agent" }) })) : (_jsx("div", { className: "flex flex-col gap-2", children: teammates.slice(0, 6).map((t) => {
                                    const observed = failedSources.includes("tasks") ? null : observedAgentState(t.id, tasks);
                                    const mine = tasks.filter((x) => x.owner_teammate_id === t.id && (isActiveTaskStatus(x.status) || isBlockedTaskStatus(x.status)));
                                    const current = mine[0];
                                    return (_jsxs("button", { className: "flex items-start gap-3 rounded-lg bg-[var(--surface)] px-3 py-3 text-left transition-colors hover:bg-[var(--surface-2)]", onClick: () => navigate(`/bot/${t.id}`), children: [_jsx(BotFace, { face: t.face, size: 30, status: t.status, animated: true }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-step--1 font-medium text-[var(--text)]", children: t.persona || t.name || "Teammate" }), _jsx("div", { className: "mt-0.5 text-step--2 text-[var(--muted)]", children: observed ? observed.label : "Status unavailable" }), current ? _jsxs("div", { className: "mt-1 truncate text-step--2 text-[var(--text-soft)]", children: ["On: ", taskTitle(current.description)] }) : null] })] }, t.id));
                                }) })) }) })] }), tasks.length === 0 && teammates.length === 0 && approvals.length === 0 && deliverables.length === 0 && !load.loading ? (_jsx(EmptyState, { title: "This workspace is ready", hint: "Start by chatting with an AI teammate, adding an agent, or creating work.", action: _jsxs("div", { className: "flex flex-wrap justify-center gap-2", children: [_jsx(Button, { onClick: () => onSelectTab("Agents"), children: "Add agent" }), _jsx(Button, { onClick: () => onSelectTab("Chat"), children: "Open chat" }), _jsx(Button, { variant: "primary", onClick: () => onSelectTab("Work"), children: "Start work" })] }) })) : null] }));
}
