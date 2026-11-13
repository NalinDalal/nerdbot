import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/** The work inbox / Jobs & Activity (Phase 2).
 *
 *  Unified background job management: task runs, research jobs, schedules,
 *  reminders — with filters (running/queued/scheduled/failed/done), source
 *  type, open detail, and valid cancel/retry/pause/resume actions.
 *  Also keeps the task inbox for day-to-day work.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { navigate, notifyError } from "./app";
import { Button, EmptyState, ErrorState, FORM_INPUT, FORM_SELECT, LoadingState, Modal, Page, PageHeader, StatusBadge, StatusDot, useAsync, } from "./components";
const BUCKETS = [
    { id: "needs", label: "Needs you", hint: "Blocked, or waiting on a decision." },
    { id: "running", label: "Running", hint: "A teammate is working on it now." },
    { id: "queued", label: "Queued", hint: "Ready for a teammate to pick up." },
    { id: "done", label: "Done", hint: "Finished, failed, or cancelled." },
];
export function bucketOf(status) {
    if (status === "blocked" || status === "awaiting_approval")
        return "needs";
    if (status === "running")
        return "running";
    if (status === "done" || status === "failed" || status === "cancelled")
        return "done";
    return "queued";
}
const titleOf = (task) => task.description?.trim() || task.command?.trim() || "Untitled work";
function jobStateBucket(status) {
    const s = (status || "").toLowerCase();
    if (["running", "planning", "searching", "reading", "synthesizing"].includes(s))
        return "running";
    if (["queued", "pending", "ready", "awaiting_approval", "blocked"].includes(s))
        return "queued";
    if (["scheduled", "paused", "disabled"].includes(s))
        return "scheduled";
    if (["failed", "error", "cancelled", "canceled"].includes(s))
        return "failed";
    if (["done", "fired", "completed", "succeeded", "success"].includes(s))
        return "done";
    return "other";
}
export function WorkView() {
    const data = useAsync(async () => {
        const [projectsRes, botsRes, inbox, researchRes] = await Promise.all([
            api.listProjects(),
            api.listAllTeammates(),
            api.approvalsInbox("pending").catch(() => ({ approvals: [] })),
            api.listResearchJobs(undefined, 25).catch(() => ({ jobs: [] })),
        ]);
        const settled = await Promise.allSettled(projectsRes.projects.map(async (project) => {
            const res = await api.projectTasks(project.id);
            return { project, tasks: res.tasks };
        }));
        const tasks = [];
        const failedWorkspaces = [];
        for (const [index, result] of settled.entries()) {
            if (result.status === "fulfilled")
                tasks.push(...result.value.tasks);
            else
                failedWorkspaces.push(projectsRes.projects[index]?.repository || "one workspace");
        }
        return {
            projects: projectsRes.projects,
            counts: projectsRes.counts,
            tasks,
            bots: botsRes.teammates,
            decisions: inbox.approvals,
            researchJobs: (researchRes.jobs || []),
            failedWorkspaces,
        };
    }, []);
    const jobs = useAsync(async () => api.listJobs({ limit: 150 }), []);
    const [jobState, setJobState] = useState("all");
    const [jobSource, setJobSource] = useState("all");
    const [jobBusy, setJobBusy] = useState(null);
    const [expandedJob, setExpandedJob] = useState(null);
    const [filter, setFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [workspace, setWorkspace] = useState("all");
    const [agent, setAgent] = useState("all");
    const [showNew, setShowNew] = useState(false);
    const reload = () => { data.reload(); jobs.reload(); };
    useEffect(() => {
        let timer = setInterval(() => {
            if (document.visibilityState === "visible")
                reload();
        }, 5000);
        const onVis = () => {
            if (document.visibilityState === "visible") {
                reload();
                if (!timer)
                    timer = setInterval(() => { if (document.visibilityState === "visible")
                        reload(); }, 5000);
            }
            else if (timer) {
                clearInterval(timer);
                timer = null;
            }
        };
        document.addEventListener("visibilitychange", onVis);
        return () => { if (timer)
            clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const projectName = useMemo(() => new Map((data.data?.projects || []).map((p) => [p.id, p.repository || "Workspace"])), [data.data?.projects]);
    const botById = useMemo(() => new Map((data.data?.bots || []).map((b) => [b.id, b])), [data.data?.bots]);
    if (data.loading)
        return _jsx(Page, { width: "data", children: _jsx(LoadingState, { lines: 6 }) });
    if (data.error || !data.data)
        return _jsx(Page, { children: _jsx(ErrorState, { error: data.error ?? "Work could not be loaded", onRetry: data.reload }) });
    const { projects, tasks, bots, decisions } = data.data;
    const query = search.trim().toLowerCase();
    const queuedSorted = tasks.filter((t) => t.status === "pending" || t.status === "ready").sort((a, b) => a.id.localeCompare(b.id));
    const queuePos = new Map(queuedSorted.map((t, i) => [t.id, i + 1]));
    const matchesFilter = (task) => {
        if (filter === "all")
            return true;
        if (filter === "running")
            return task.status === "running";
        if (filter === "queued")
            return bucketOf(task.status) === "queued";
        if (filter === "completed")
            return task.status === "done";
        if (filter === "failed")
            return task.status === "failed";
        if (filter === "needs")
            return task.status === "blocked" || task.status === "awaiting_approval";
        return true;
    };
    const visible = tasks.filter((task) => {
        if (workspace !== "all" && task.project_id !== workspace)
            return false;
        if (agent !== "all" && task.owner_teammate_id !== agent)
            return false;
        if (!matchesFilter(task))
            return false;
        if (!query)
            return true;
        const owner = task.owner_teammate_id ? botById.get(task.owner_teammate_id)?.persona : "";
        return [titleOf(task), projectName.get(task.project_id), owner, task.blocked_reason].filter(Boolean).join(" ").toLowerCase().includes(query);
    });
    const FILTER_LABEL = { running: "Running", queued: "Queued", completed: "Completed", failed: "Failed", needs: "Needs attention" };
    const groups = filter === "all"
        ? BUCKETS.map((bucket) => ({ ...bucket, rows: visible.filter((task) => bucketOf(task.status) === bucket.id) })).filter((g) => g.rows.length > 0)
        : [{ id: filter, label: FILTER_LABEL[filter] ?? filter, hint: "", rows: visible }].filter((g) => g.rows.length > 0);
    const allJobs = (jobs.data?.jobs || []);
    const filteredJobs = allJobs.filter((j) => {
        if (jobSource !== "all" && j.source_type !== jobSource)
            return false;
        if (jobState === "all")
            return true;
        return jobStateBucket(j.status) === jobState;
    });
    const openJob = (j) => {
        if (j.source_type === "task_run" && j.project_id && j.task_id)
            return navigate(`/p/${j.project_id}/t/${j.task_id}`);
        if (j.source_type === "research") {
            const lib = j.detail?.library_doc_id;
            if (lib)
                return navigate(`/library/${lib}`);
            if (j.thread_id)
                return navigate(`/chat?thread=${j.thread_id}`);
            return navigate(`/chat`);
        }
        if (j.source_type === "reminder" && j.thread_id)
            return navigate(`/chat?thread=${j.thread_id}`);
        if (j.source_type === "schedule" && j.project_id)
            return navigate(`/p/${j.project_id}?tab=Schedules`);
    };
    const jobAction = async (j, action) => {
        setJobBusy(j.id + action);
        try {
            if (j.source_type === "research") {
                if (action === "cancel")
                    await api.cancelResearchJob(j.id);
                if (action === "retry")
                    await api.retryResearchJob(j.id);
            }
            else if (j.source_type === "reminder" && action === "cancel") {
                await api.cancelReminder(j.id);
            }
            else if (j.source_type === "schedule") {
                if (action === "pause")
                    await api.pauseSchedule(j.id);
                if (action === "resume")
                    await api.resumeSchedule(j.id);
            }
            else if (j.source_type === "task_run") {
                if (action === "retry" && j.task_id)
                    await api.retryTask(j.task_id);
                if (action === "cancel") {
                    // cancel the specific run by id if API supports; fall back to task context
                    try {
                        await api.cancelRun?.(j.id);
                    }
                    catch { /* best effort */ }
                }
            }
            reload();
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setJobBusy(null);
        }
    };
    return (_jsxs(Page, { children: [_jsx(PageHeader, { title: "Activity", description: "Jobs, schedules, reminders, and task work in one place.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: reload, children: "Refresh" }), _jsx(Button, { variant: "primary", onClick: () => setShowNew(true), children: "New task" })] }) }), decisions.length > 0 ? (_jsxs("button", { onClick: () => navigate("/approvals"), className: "mb-5 flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-left", children: [_jsxs("span", { className: "text-step--1 text-[var(--text)]", children: [_jsx("strong", { children: decisions.length }), " ", decisions.length === 1 ? "decision is" : "decisions are", " waiting for you"] }), _jsx("span", { className: "text-step--1 font-medium text-[var(--warn)]", children: "Review \u2192" })] })) : null, _jsxs("section", { className: "mb-8", "aria-label": "Background jobs", children: [_jsxs("div", { className: "mb-3 flex flex-wrap items-end justify-between gap-3", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-step-0 font-semibold tracking-tight text-[var(--text)]", children: "Jobs" }), _jsx("p", { className: "text-step--2 text-[var(--faint)]", children: "Unified statuses, timestamps, logs, and actions for all background work." })] }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsxs("select", { value: jobState, onChange: (e) => setJobState(e.target.value), className: `${FORM_SELECT} h-9`, "aria-label": "Job status filter", children: [_jsx("option", { value: "all", children: "All states" }), _jsx("option", { value: "running", children: "Running" }), _jsx("option", { value: "queued", children: "Queued" }), _jsx("option", { value: "scheduled", children: "Scheduled" }), _jsx("option", { value: "failed", children: "Failed" }), _jsx("option", { value: "done", children: "Done" })] }), _jsxs("select", { value: jobSource, onChange: (e) => setJobSource(e.target.value), className: `${FORM_SELECT} h-9`, "aria-label": "Job source filter", children: [_jsx("option", { value: "all", children: "All sources" }), _jsx("option", { value: "task_run", children: "Task runs" }), _jsx("option", { value: "research", children: "Research" }), _jsx("option", { value: "schedule", children: "Schedules" }), _jsx("option", { value: "reminder", children: "Reminders" })] })] })] }), jobs.loading ? _jsx(LoadingState, { lines: 4 }) : jobs.error ? _jsx(ErrorState, { error: jobs.error, onRetry: jobs.reload }) : filteredJobs.length === 0 ? (_jsx(EmptyState, { title: "No jobs match", hint: "Background work, research, schedules, and reminders will appear here." })) : (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: filteredJobs.slice(0, 80).map((j, i) => {
                            const key = `${j.source_type}-${j.id}`;
                            const expanded = expandedJob === key;
                            return (_jsxs("div", { className: i > 0 ? "border-t border-[var(--border-dim)]" : "", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-3 px-4 py-3", children: [_jsx(StatusDot, { status: j.status }), _jsxs("button", { type: "button", className: "min-w-0 flex-1 text-left", onClick: () => setExpandedJob(expanded ? null : key), children: [_jsx("div", { className: "truncate text-step-0 text-[var(--text)]", children: j.title || j.id }), _jsxs("div", { className: "mt-0.5 flex flex-wrap items-center gap-x-1.5 text-step--2 text-[var(--faint)]", children: [_jsx("span", { className: "rounded bg-[var(--surface-3)] px-1.5 py-0.5", children: j.source_type.replace("_", " ") }), _jsx("span", { className: "mono", children: j.status }), j.project_id ? _jsxs("span", { children: ["\u00B7 ", projectName.get(j.project_id) || "Workspace"] }) : null, j.created_at ? _jsxs("span", { children: ["\u00B7 created ", new Date(j.created_at).toLocaleString()] }) : null, j.updated_at ? _jsxs("span", { children: ["\u00B7 updated ", new Date(j.updated_at).toLocaleString()] }) : null, j.next_run_at ? _jsxs("span", { children: ["\u00B7 next ", new Date(j.next_run_at).toLocaleString()] }) : null, j.due_at ? _jsxs("span", { children: ["\u00B7 due ", new Date(j.due_at).toLocaleString()] }) : null] })] }), _jsx(StatusBadge, { status: j.status }), _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("button", { type: "button", className: "text-step--2 text-[var(--muted)] hover:underline", onClick: () => setExpandedJob(expanded ? null : key), children: expanded ? "Hide log" : "Log" }), j.actions?.open ? _jsx("button", { type: "button", className: "text-step--2 font-medium text-[var(--accent)] hover:underline", onClick: () => openJob(j), children: "Open" }) : null, j.actions?.cancel ? _jsx(Button, { disabled: jobBusy === j.id + "cancel", onClick: () => void jobAction(j, "cancel"), children: "Cancel" }) : null, j.actions?.retry ? _jsx(Button, { disabled: jobBusy === j.id + "retry", onClick: () => void jobAction(j, "retry"), children: "Retry" }) : null, j.actions?.pause ? _jsx(Button, { disabled: jobBusy === j.id + "pause", onClick: () => void jobAction(j, "pause"), children: "Pause" }) : null, j.actions?.resume ? _jsx(Button, { disabled: jobBusy === j.id + "resume", onClick: () => void jobAction(j, "resume"), children: "Resume" }) : null] })] }), expanded ? _jsx(JobDrilldown, { job: j }) : null] }, key));
                        }) }))] }), _jsxs("div", { className: "mb-4 flex flex-wrap items-end justify-between gap-3", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-1", role: "tablist", "aria-label": "Task state", children: [_jsx(FilterTab, { label: "All", count: tasks.length, active: filter === "all", onClick: () => setFilter("all") }), _jsx(FilterTab, { label: "Running", count: tasks.filter((t) => t.status === "running").length, active: filter === "running", onClick: () => setFilter("running") }), _jsx(FilterTab, { label: "Queued", count: tasks.filter((t) => bucketOf(t.status) === "queued").length, active: filter === "queued", onClick: () => setFilter("queued") }), _jsx(FilterTab, { label: "Completed", count: tasks.filter((t) => t.status === "done").length, active: filter === "completed", onClick: () => setFilter("completed") }), _jsx(FilterTab, { label: "Failed", count: tasks.filter((t) => t.status === "failed").length, active: filter === "failed", onClick: () => setFilter("failed") }), _jsx(FilterTab, { label: "Needs attention", count: tasks.filter((t) => t.status === "blocked" || t.status === "awaiting_approval").length, active: filter === "needs", onClick: () => setFilter("needs") })] }), _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("div", { className: "w-56 shrink-0", children: _jsx("input", { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Find task", "aria-label": "Find task", className: `${FORM_INPUT} h-9` }) }), _jsxs("select", { value: workspace, onChange: (e) => setWorkspace(e.target.value), "aria-label": "Filter by project", className: `${FORM_SELECT} h-9`, children: [_jsx("option", { value: "all", children: "All projects" }), projects.map((p) => _jsx("option", { value: p.id, children: p.repository || "Workspace" }, p.id))] }), _jsxs("select", { value: agent, onChange: (e) => setAgent(e.target.value), "aria-label": "Filter by agent", className: `${FORM_SELECT} h-9`, children: [_jsx("option", { value: "all", children: "All agents" }), bots.map((b) => _jsx("option", { value: b.id, children: b.persona || b.id }, b.id))] })] })] }), tasks.length === 0 ? (_jsx(EmptyState, { title: "No work yet", hint: "Start a task and a teammate will pick it up.", action: _jsx(Button, { variant: "primary", onClick: () => setShowNew(true), children: "New task" }) })) : visible.length === 0 ? (_jsx(EmptyState, { title: "Nothing matches", hint: "Try a different filter, project, or search." })) : (_jsx("div", { className: "flex flex-col gap-6", children: groups.map((group) => (_jsxs("section", { children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-baseline gap-2", children: [_jsx("h2", { className: "text-step-0 font-semibold tracking-tight text-[var(--text)]", children: group.label }), _jsx("span", { className: "text-step--2 text-[var(--faint)]", children: group.rows.length })] }), _jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: group.rows.map((task, index) => {
                                const owner = task.owner_teammate_id ? botById.get(task.owner_teammate_id) : undefined;
                                return (_jsxs("button", { onClick: () => navigate(`/p/${task.project_id}/t/${task.id}`), className: `flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsx(StatusDot, { status: task.status }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-step-0 text-[var(--text)]", children: titleOf(task) }), _jsxs("div", { className: "mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-step--2 text-[var(--faint)]", children: [_jsx("span", { className: "min-w-0 truncate", children: projectName.get(task.project_id) ?? "Workspace" }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsx("span", { className: "min-w-0 truncate", children: owner?.persona || "Unassigned" }), queuePos.has(task.id) ? _jsxs(_Fragment, { children: [_jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsxs("span", { className: "text-[var(--info)]", children: ["queue #", queuePos.get(task.id)] })] }) : null, task.blocked_reason ? _jsxs(_Fragment, { children: [_jsx("span", { "aria-hidden": true, className: "hidden sm:inline", children: "\u00B7" }), _jsx("span", { className: "min-w-0 basis-full truncate text-[var(--warn)] sm:basis-auto", title: task.blocked_reason, children: task.blocked_reason })] }) : null] })] }), _jsx(StatusBadge, { status: task.status }), _jsx("span", { "aria-hidden": true, className: "text-[var(--faint)]", children: "\u2192" })] }, task.id));
                            }) })] }, group.id))) })), showNew ? (_jsx(NewTaskModal, { projects: projects, bots: bots, onClose: () => setShowNew(false), onCreated: (projectId, taskId) => { setShowNew(false); reload(); navigate(`/p/${projectId}/t/${taskId}`); } })) : null] }));
}
function JobDrilldown({ job }) {
    const [events, setEvents] = useState([]);
    const [scheduleRuns, setScheduleRuns] = useState([]);
    const [runEvents, setRunEvents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        let alive = true;
        void (async () => {
            setLoading(true);
            setEvents([]);
            setScheduleRuns([]);
            setRunEvents([]);
            setError(null);
            try {
                if (job.source_type === "research") {
                    const r = await api.getResearchJobEvents(job.id, 0);
                    if (alive)
                        setEvents(r.events || []);
                }
                else if (job.source_type === "schedule") {
                    const r = await api.listScheduleRuns(job.id, 20);
                    if (alive)
                        setScheduleRuns(r.runs || []);
                }
                else if (job.source_type === "task_run") {
                    const r = await api.runEvents(job.id, 0);
                    if (alive)
                        setRunEvents((r.events || []));
                }
            }
            catch (e) {
                if (alive)
                    setError(e instanceof Error ? e.message : String(e));
            }
            finally {
                if (alive)
                    setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [job.id, job.source_type, job.status, job.updated_at]);
    const fmt = (v) => (v ? new Date(v).toLocaleString() : "—");
    return (_jsxs("div", { className: "border-t border-[var(--border-dim)] bg-[var(--surface-2)] px-4 py-3 text-step--1", children: [_jsxs("div", { className: "mb-2 grid gap-x-4 gap-y-1 text-[var(--faint)] sm:grid-cols-2 lg:grid-cols-3", children: [_jsxs("span", { children: ["ID: ", _jsx("span", { className: "mono text-[var(--text-soft)]", children: job.id })] }), _jsxs("span", { children: ["Source: ", _jsx("span", { className: "text-[var(--text-soft)]", children: job.source_type })] }), _jsxs("span", { children: ["Status: ", _jsx("span", { className: "text-[var(--text-soft)]", children: job.status })] }), _jsxs("span", { children: ["Created: ", _jsx("span", { className: "text-[var(--text-soft)]", children: fmt(job.created_at) })] }), _jsxs("span", { children: ["Updated: ", _jsx("span", { className: "text-[var(--text-soft)]", children: fmt(job.updated_at) })] }), job.next_run_at ? _jsxs("span", { children: ["Next run: ", _jsx("span", { className: "text-[var(--text-soft)]", children: fmt(job.next_run_at) })] }) : null, job.due_at ? _jsxs("span", { children: ["Due: ", _jsx("span", { className: "text-[var(--text-soft)]", children: fmt(job.due_at) })] }) : null, job.project_id ? _jsxs("span", { children: ["Workspace: ", _jsx("span", { className: "mono text-[var(--text-soft)]", children: job.project_id })] }) : null, job.task_id ? _jsxs("span", { children: ["Task: ", _jsx("span", { className: "mono text-[var(--text-soft)]", children: job.task_id })] }) : null, job.thread_id ? _jsxs("span", { children: ["Thread: ", _jsx("span", { className: "mono text-[var(--text-soft)]", children: job.thread_id })] }) : null, job.last_run_status ? _jsxs("span", { children: ["Last run: ", _jsx("span", { className: "text-[var(--text-soft)]", children: job.last_run_status })] }) : null] }), job.error ? _jsxs("div", { className: "mb-2 rounded-md bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]", children: ["Error: ", job.error] }) : null, job.detail ? (_jsxs("details", { className: "mb-2 rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-2", children: [_jsx("summary", { className: "cursor-pointer text-step--2 font-medium text-[var(--muted)]", children: "Details" }), _jsx("pre", { className: "mt-2 max-h-48 overflow-auto text-step--2 text-[var(--muted)]", children: JSON.stringify(job.detail, null, 2) })] })) : null, _jsxs("div", { className: "mb-3 flex flex-wrap gap-2", children: [job.source_type === "task_run" && job.project_id && job.task_id ? _jsx(Button, { onClick: () => navigate(`/p/${job.project_id}/t/${job.task_id}`), children: "Open task & run logs" }) : null, job.source_type === "research" && job.thread_id ? _jsx(Button, { onClick: () => navigate(`/chat?thread=${job.thread_id}`), children: "Open source chat" }) : null, job.source_type === "research" && job.detail?.library_doc_id ? _jsx(Button, { onClick: () => navigate(`/library/${job.detail.library_doc_id}`), children: "Open report doc" }) : null, job.source_type === "reminder" && job.thread_id ? _jsx(Button, { onClick: () => navigate(`/chat?thread=${job.thread_id}`), children: "Open source chat" }) : null, job.source_type === "reminder" && job.project_id ? _jsx(Button, { onClick: () => navigate(`/p/${job.project_id}`), children: "Open workspace" }) : null, job.source_type === "schedule" && job.project_id ? _jsx(Button, { onClick: () => navigate(`/p/${job.project_id}?tab=Schedules`), children: "Open schedule" }) : null] }), job.source_type === "research" ? (_jsx(LogSection, { title: "Event log", loading: loading, error: error, empty: !loading && !error && events.length === 0, emptyText: "No events yet.", children: _jsx("ul", { className: "max-h-56 space-y-1 overflow-auto rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-2", children: events.map((ev, idx) => (_jsxs("li", { className: "flex gap-2 text-step--2", children: [_jsx("span", { className: "mono shrink-0 text-[var(--faint)]", children: ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : "" }), _jsx("span", { className: "shrink-0 rounded bg-[var(--surface-3)] px-1 text-[var(--muted)]", children: ev.kind }), _jsxs("span", { className: "min-w-0 break-words text-[var(--text-soft)]", children: [ev.content, ev.data && Object.keys(ev.data).length ? _jsxs("span", { className: "text-[var(--faint)]", children: [" ", JSON.stringify(ev.data)] }) : null] })] }, ev.seq ?? idx))) }) })) : job.source_type === "schedule" ? (_jsx(LogSection, { title: "Recent runs", loading: loading, error: error, empty: !loading && !error && scheduleRuns.length === 0, emptyText: "No runs recorded yet.", children: _jsx("ul", { className: "max-h-56 space-y-1 overflow-auto rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-2", children: scheduleRuns.map((r) => (_jsxs("li", { className: "flex flex-wrap gap-x-3 gap-y-0.5 text-step--2", children: [_jsx("span", { className: "mono text-[var(--faint)]", children: r.fired_at ? new Date(r.fired_at).toLocaleString() : "" }), _jsx("span", { className: "rounded bg-[var(--surface-3)] px-1 text-[var(--muted)]", children: r.status }), r.task_id ? _jsxs("button", { className: "text-[var(--accent)] hover:underline", onClick: () => job.project_id && navigate(`/p/${job.project_id}/t/${r.task_id}`), children: ["task ", r.task_id] }) : null, r.error ? _jsx("span", { className: "text-[var(--danger)]", children: r.error }) : null] }, r.id))) }) })) : job.source_type === "task_run" ? (_jsx(LogSection, { title: "Run events", loading: loading, error: error, empty: !loading && !error && runEvents.length === 0, emptyText: "No events captured yet. Open task for full logs.", children: _jsx("ul", { className: "max-h-56 space-y-1 overflow-auto rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-2", children: runEvents.slice(-80).map((ev, idx) => (_jsxs("li", { className: "flex gap-2 text-step--2", children: [_jsx("span", { className: "mono shrink-0 text-[var(--faint)]", children: ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : "" }), _jsx("span", { className: "shrink-0 rounded bg-[var(--surface-3)] px-1 text-[var(--muted)]", children: ev.kind || "event" }), _jsx("span", { className: "min-w-0 break-words text-[var(--text-soft)]", children: ev.content || "" })] }, ev.seq ?? idx))) }) })) : job.source_type === "reminder" ? (_jsxs("div", { className: "rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-3 text-step--1 text-[var(--text-soft)]", children: [_jsxs("div", { children: ["Message: ", _jsx("span", { className: "text-[var(--text)]", children: job.title })] }), _jsxs("div", { className: "mt-1 text-[var(--faint)]", children: ["Status ", job.status, job.due_at ? ` · due ${fmt(job.due_at)}` : "", job.updated_at ? ` · updated ${fmt(job.updated_at)}` : ""] }), job.detail?.notify_channel ? _jsxs("div", { className: "mt-1 text-[var(--faint)]", children: ["Channel: ", job.detail.notify_channel] }) : null] })) : (_jsx("div", { className: "text-[var(--faint)]", children: "Open source for full logs and context." }))] }));
}
function LogSection({ title, loading, error, empty, emptyText, children }) {
    return (_jsxs("div", { children: [_jsx("div", { className: "mb-1 text-step--2 font-medium uppercase tracking-wider text-[var(--faint)]", children: title }), loading ? _jsx(LoadingState, { lines: 2 }) : error ? _jsx("div", { className: "rounded-md bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]", children: error }) : empty ? (_jsx("div", { className: "text-[var(--faint)]", children: emptyText })) : children] }));
}
function FilterTab({ label, count, active, onClick }) {
    return (_jsxs("button", { role: "tab", "aria-selected": active, onClick: onClick, className: `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-step--1 transition-colors ${active ? "bg-[var(--surface-3)] text-[var(--text)]" : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"}`, children: [label, count > 0 ? _jsx("span", { className: active ? "text-[var(--muted)]" : "text-[var(--faint)]", children: count }) : null] }));
}
function NewTaskModal({ projects, bots, onClose, onCreated }) {
    const [description, setDescription] = useState("");
    const [command, setCommand] = useState("");
    const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
    const [ownerId, setOwnerId] = useState("");
    const [busy, setBusy] = useState(false);
    const projectBots = bots.filter((b) => b.project_id === projectId);
    return (_jsx(Modal, { title: "New task", onClose: onClose, children: _jsxs("div", { className: "flex flex-col gap-3", children: [_jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Project" }), _jsx("select", { className: FORM_SELECT, value: projectId, onChange: (e) => setProjectId(e.target.value), children: projects.map((p) => _jsx("option", { value: p.id, children: p.repository || "Workspace" }, p.id)) })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "What needs doing" }), _jsx("textarea", { className: FORM_INPUT, value: description, onChange: (e) => setDescription(e.target.value), rows: 3 })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Command (optional)" }), _jsx("input", { className: `${FORM_INPUT} mono`, value: command, onChange: (e) => setCommand(e.target.value) })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Assign to (optional)" }), _jsxs("select", { className: FORM_SELECT, value: ownerId, onChange: (e) => setOwnerId(e.target.value), children: [_jsx("option", { value: "", children: "Unassigned" }), projectBots.map((b) => _jsx("option", { value: b.id, children: b.persona || b.id }, b.id))] })] }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: busy || !description.trim() || !projectId, onClick: async () => {
                                setBusy(true);
                                try {
                                    const task = await api.createTask(projectId, { description, command: command || undefined, owner_teammate_id: ownerId || undefined });
                                    onCreated(projectId, task.id);
                                }
                                catch (err) {
                                    notifyError(err);
                                }
                                finally {
                                    setBusy(false);
                                }
                            }, children: "Create task" })] })] }) }));
}
