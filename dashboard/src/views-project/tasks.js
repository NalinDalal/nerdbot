import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, EmptyState, ErrorState, Field, FORM_INPUT, LoadingState, Modal, PageSection, StatusBadge, ERROR_BOX, relativeTime, useAsync } from "../components";
import { DataTable } from "../DataTable";
import { EntityPicker } from "../EntityPicker";
import { taskTitle } from "../taskTitle";
import { explainRunError } from "../explainRunError";
const STATUS_FILTERS = [
    { id: "all", label: "All" },
    { id: "failed", label: "Failed" },
    { id: "running", label: "Running" },
    { id: "blocked", label: "Blocked" },
    { id: "done", label: "Done" },
];
export function TasksTab({ projectId, onOpenTask }) {
    const [showCreate, setShowCreate] = useState(false);
    const [statusFilter, setStatusFilter] = useState("all");
    /* New task drafts the two text fields (title + details), the executable
       command, and the owner/issue picks — the EntityPicker turns raw
       `owner_teammate_id` inputs into a searchable select. */
    const [title, setTitle] = useState("");
    const [details, setDetails] = useState("");
    const [command, setCommand] = useState("");
    const [ownerId, setOwnerId] = useState("");
    const [issueId, setIssueId] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const tasks = useAsync(() => api.projectTasks(projectId), [projectId]);
    const runs = useAsync(() => api.projectRuns(projectId), [projectId]);
    const mates = useAsync(() => api.listTeammates(projectId), [projectId]);
    const issues = useAsync(() => api.listIssues(projectId), [projectId]);
    const mateItems = (mates.data?.teammates ?? []).map((mate) => ({
        id: mate.id,
        name: mate.persona || "Unnamed teammate",
    }));
    const issueItems = (issues.data?.issues ?? []).map((issue) => ({
        id: issue.id,
        name: issue.title || issue.id,
    }));
    const resetDraft = () => {
        setTitle("");
        setDetails("");
        setCommand("");
        setOwnerId("");
        setIssueId("");
        setSaveError(null);
    };
    const createTask = async () => {
        if (!details.trim() || saving)
            return;
        setSaving(true);
        setSaveError(null);
        try {
            const trimmedTitle = title.trim();
            const description = trimmedTitle ? `${trimmedTitle}\n\n${details.trim()}` : details.trim();
            const task = await api.createTask(projectId, {
                title: trimmedTitle,
                description,
                command: command.trim(),
                owner_teammate_id: ownerId || null,
                issue_id: issueId || null,
            });
            setShowCreate(false);
            resetDraft();
            onOpenTask(task.id);
        }
        catch (err) {
            setSaveError(err);
            notifyError(err);
        }
        finally {
            setSaving(false);
        }
    };
    const ownerName = (id) => {
        if (!id)
            return "Unassigned";
        return mates.data?.teammates.find((m) => m.id === id)?.persona || "Assigned";
    };
    const reload = () => {
        tasks.reload();
        runs.reload();
    };
    /* --- Status filter --- */
    /** The task statuses each filter chip matches. `blocked` also covers
     *  awaiting_approval: the task is standstill either way, and the owner
     *  looks for it under Blocked. */
    const FILTER_STATUSES = {
        all: new Set(),
        failed: new Set(["failed"]),
        running: new Set(["running"]),
        blocked: new Set(["blocked", "awaiting_approval"]),
        done: new Set(["done"]),
    };
    const allTasks = tasks.data?.tasks ?? [];
    const filteredTasks = statusFilter === "all"
        ? allTasks
        : allTasks.filter((task) => FILTER_STATUSES[statusFilter].has(task.status));
    /**
     * The latest failed run recorded for a task (newest by start time), or
     * null when the runs have not loaded or this task never failed.
     */
    const latestFailedRun = (task) => {
        const failedRuns = (runs.data?.runs ?? []).filter((run) => run.task_id === task.id && run.status === "failed");
        if (failedRuns.length === 0)
            return null;
        return failedRuns.reduce((a, b) => (b.started_at > a.started_at ? b : a));
    };
    return (_jsxs("div", { children: [showCreate ? (_jsx(Modal, { title: "New task", onClose: () => setShowCreate(false), children: _jsxs("form", { className: "flex flex-col gap-1", onSubmit: (event) => {
                        event.preventDefault();
                        void createTask();
                    }, children: [saveError ? (_jsx("div", { className: `${ERROR_BOX} mb-3`, role: "alert", children: String(saveError) })) : null, _jsx(Field, { label: "Title", children: _jsx("input", { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "Short title shown in lists", className: FORM_INPUT }) }), _jsx(Field, { label: "Details", children: _jsx("textarea", { rows: 4, value: details, onChange: (e) => setDetails(e.target.value), required: true, placeholder: "What the bot should do, in full", className: `${FORM_INPUT} resize-y` }) }), _jsx(Field, { label: "Command", children: _jsx("input", { value: command, onChange: (e) => setCommand(e.target.value), placeholder: "echo ok", className: FORM_INPUT }) }), _jsx(Field, { label: "Owner", children: _jsx(EntityPicker, { items: mateItems, value: ownerId, onChange: setOwnerId, placeholder: "Search teammates" }) }), _jsx(Field, { label: "Issue", children: _jsx(EntityPicker, { items: issueItems, value: issueId, onChange: setIssueId, placeholder: "Search issues" }) }), _jsx("div", { className: "mt-2 flex justify-end", children: _jsx(Button, { variant: "primary", type: "submit", disabled: saving || !details.trim(), children: saving ? "Creating…" : "Create task" }) })] }) })) : null, _jsx(PageSection, { title: "Work", description: "Assignments, progress, blockers, and completed outcomes in this workspace.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: reload, children: "Refresh" }), _jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "Start new work" })] }), children: tasks.loading ? (_jsx(LoadingState, {})) : tasks.error ? (_jsx(ErrorState, { error: tasks.error, onRetry: tasks.reload })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-2 text-step--1 text-[var(--muted)]", children: [_jsxs("span", { children: [allTasks.filter((t) => ["running", "ready", "pending", "queued"].includes(t.status)).length, " in progress"] }), _jsx("span", { className: "text-[var(--faint)]", children: "\u00B7" }), _jsxs("span", { children: [allTasks.filter((t) => t.status === "blocked" || t.status === "awaiting_approval").length, " need attention"] }), _jsx("span", { className: "text-[var(--faint)]", children: "\u00B7" }), _jsxs("span", { children: [allTasks.filter((t) => t.status === "done").length, " completed"] }), _jsx("span", { className: "text-[var(--faint)]", children: "\u00B7" }), _jsxs("span", { children: [allTasks.filter((t) => t.status === "failed").length, " failed"] })] }), _jsx("div", { className: "mb-3 flex flex-wrap items-center gap-1.5", children: STATUS_FILTERS.map(({ id, label }) => {
                                const count = id === "all"
                                    ? allTasks.length
                                    : allTasks.filter((task) => FILTER_STATUSES[id].has(task.status)).length;
                                const active = statusFilter === id;
                                return (_jsxs("button", { type: "button", "aria-pressed": active, onClick: () => setStatusFilter(id), className: `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-step--2 font-medium transition-colors ${active
                                        ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                                        : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--text)]"}`, children: [label, _jsx("span", { className: "tabular-nums text-[var(--faint)]", children: count })] }, id));
                            }) }), filteredTasks.length > 0 ? (_jsx("div", { className: "flex flex-col divide-y divide-[var(--border-dim)] rounded-lg bg-[var(--surface)]", children: filteredTasks.map((task) => {
                                const failedRun = task.status === "failed" ? latestFailedRun(task) : null;
                                const failure = failedRun ? explainRunError(task, failedRun) : null;
                                const needsAction = ["blocked", "awaiting_approval", "failed"].includes(task.status);
                                const completed = task.status === "done";
                                return (_jsxs("button", { className: `flex w-full items-start justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] ${needsAction ? "bg-[var(--warn-dim)]/30" : ""}`, onClick: () => onOpenTask(task.id), children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("span", { className: "truncate text-step--1 font-medium text-[var(--text)]", children: task.title || taskTitle(task.description) }), _jsx(StatusBadge, { status: task.status })] }), _jsxs("div", { className: "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-step--2 text-[var(--muted)]", children: [_jsxs("span", { children: ["Owner: ", ownerName(task.owner_teammate_id)] }), completed ? _jsxs(_Fragment, { children: [_jsx("span", { children: "\u00B7" }), _jsx("span", { children: "Outcome ready for review" })] }) : null, task.blocked_reason ? _jsxs(_Fragment, { children: [_jsx("span", { children: "\u00B7" }), _jsx("span", { className: "truncate", children: task.blocked_reason })] }) : null, failure && failure.message ? _jsxs(_Fragment, { children: [_jsx("span", { children: "\u00B7" }), _jsx("span", { className: "truncate max-w-[28rem]", title: failure.message, children: failure.message })] }) : null] })] }), _jsx("span", { className: "shrink-0 text-step--2 text-[var(--accent)]", children: "Open" })] }, task.id));
                            }) })) : (_jsx(EmptyState, { title: allTasks.length > 0 ? "No work matches this view" : "No work yet", hint: allTasks.length > 0
                                ? "Try another filter to see different assignments and outcomes."
                                : "Start work for this workspace or ask an AI teammate to help.", action: _jsx("div", { className: "flex flex-wrap justify-center gap-2", children: _jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "Start new work" }) }) }))] })) }), _jsx(PageSection, { title: "Execution evidence", description: "Run history and technical details, available when you need them.", children: runs.loading ? (_jsx(LoadingState, {})) : runs.error ? (_jsx(ErrorState, { error: runs.error, onRetry: runs.reload })) : runs.data && runs.data.runs.length > 0 ? (_jsx(DataTable, { columns: [
                        { key: "run", header: "Run", render: (run) => relativeTime(run.started_at) },
                        { key: "task", header: "Task", render: (run) => {
                                const taskData = tasks.data?.tasks.find((task) => task.id === run.task_id);
                                const label = taskData ? taskData.title || taskTitle(taskData.description) : "Task";
                                return _jsx("span", { className: "block truncate max-w-[24rem]", title: label, children: label });
                            } },
                        { key: "status", header: "Status", render: (run) => _jsx(StatusBadge, { status: run.status }) },
                        { key: "exit", header: "Exit", render: (run) => run.exit_code ?? "—" },
                        { key: "runtime", header: "Runtime", render: (run) => run.runtime },
                    ], rows: runs.data.runs, onRowClick: (run) => onOpenTask(run.task_id), stack: { title: "task", badge: "status", meta: ["run", "exit", "runtime"] } })) : (_jsx(EmptyState, { title: "No execution history yet", hint: "When work runs, its history and evidence will appear here." })) })] }));
}
