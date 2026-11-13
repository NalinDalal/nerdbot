import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import { ApprovalRow, Badge, EmptyState, ErrorState, LoadingState, Modal, ShortId, StatusBadge, TABLE_SHELL, TABLE_TD as TD, TABLE_TH as TH, FORM_INPUT_SM as FORM_INPUT, LOG_BLOCK, Button, BotChip, SectionLabel, approvalIsPending, Page, PageHeader, relativeTime, useAsync, runStatusLabel, } from "./components";
import { taskTitle } from "./taskTitle";
import { explainRunError } from "./explainRunError";
import { EntityForm } from "./forms";
import { Markdown } from "./markdown";
/** The runtime wraps provider output in prompt-injection markers before it
 *  goes back to a model. The owner is not a model; show the answer. */
function unwrapRunOutput(text) {
    return text
        .replace(/^<<<UNTRUSTED_RUN_OUTPUT>>>\s*/, "")
        .replace(/\s*<<<END_UNTRUSTED_RUN_OUTPUT>>>$/, "");
}
const runColumns = [
    {
        header: "Started",
        cell: (run) => _jsx("span", { className: "text-[var(--muted)]", children: relativeTime(run.started_at) }),
    },
    {
        header: "Status",
        cell: (run) => _jsx(StatusBadge, { status: run.status, label: runStatusLabel(run.status) }),
    },
    {
        header: "Exit",
        cell: (run) => _jsx("span", { className: "mono text-[var(--text-soft)]", children: run.exit_code ?? "—" }),
    },
    {
        header: "Runtime",
        cell: (run) => _jsx("span", { className: "text-[var(--muted)]", children: run.runtime }),
    },
    {
        header: "Secs",
        cell: (run) => (_jsx("span", { className: "mono text-[var(--text-soft)]", children: Number(run.duration_s ?? 0).toFixed(1) })),
    },
];
function RunsTable({ runs }) {
    if (runs.length === 0) {
        return _jsx(EmptyState, { title: "No runs yet", hint: "Run the task to produce execution evidence." });
    }
    return (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsx("tr", { children: runColumns.map((column) => (_jsx("th", { className: TH, children: column.header }, column.header))) }) }), _jsx("tbody", { children: runs.map((run) => (_jsx("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: runColumns.map((column) => (_jsx("td", { className: TD, children: column.cell(run) }, column.header))) }, run.id))) })] }) }));
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
function RunTimeline({ run, live }) {
    const [events, setEvents] = useState([]);
    const [error, setError] = useState(null);
    /** true: SSE connected · false: polling fallback · null: not connected yet */
    const [transport, setTransport] = useState(null);
    useEffect(() => {
        let cancelled = false;
        let timer;
        let next = 0;
        /* Events are ordered by seq; a stream reconnect (or a stream/poll pump
           racing in the same tick) may hand back a seq already appended. */
        const append = (items) => {
            setEvents((prev) => {
                const fresh = items.filter((event) => event.seq > next);
                if (fresh.length === 0)
                    return prev;
                next = Math.max(next, fresh[fresh.length - 1].seq);
                return [...prev, ...fresh];
            });
        };
        const poll = () => {
            setTransport("poll");
            timer = setTimeout(async () => {
                try {
                    const page = await api.runEvents(run.id, next);
                    if (cancelled)
                        return;
                    append(page.events);
                    const finished = TERMINAL_RUN_STATUSES.has(page.run.status) || !!page.run.finished_at;
                    if (finished)
                        return;
                    poll();
                }
                catch (err) {
                    if (!cancelled)
                        setError(err);
                }
            }, 2000);
        };
        void (async () => {
            try {
                const page = await api.runEvents(run.id, 0);
                if (cancelled)
                    return;
                append(page.events);
                next = Math.max(next, page.next);
                const finished = TERMINAL_RUN_STATUSES.has(page.run.status) || !!page.run.finished_at;
                if (!live || finished)
                    return;
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
                                    if (!cancelled)
                                        setTransport(null);
                                },
                            });
                            break;
                        }
                        catch (err) {
                            if (cancelled)
                                return;
                            attempt += 1;
                            if (attempt > 3)
                                throw err;
                            const delay = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 500;
                            await new Promise((resolve) => setTimeout(resolve, delay));
                        }
                    }
                    /* The stream resolved; its end frame already reset the transport. */
                }
                catch {
                    if (cancelled)
                        return;
                    setTransport("poll");
                    poll();
                }
            }
            catch (err) {
                if (!cancelled)
                    setError(err);
            }
        })();
        return () => {
            cancelled = true;
            if (timer)
                clearTimeout(timer);
        };
    }, [run.id, live]);
    return (_jsxs("section", { className: "mb-6", children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-baseline justify-between gap-2", children: [_jsx(SectionLabel, { children: "Execution timeline" }), _jsx("span", { className: "text-step--2 text-[var(--faint)]", children: live
                            ? transport === "stream"
                                ? "live · stream"
                                : transport === "poll"
                                    ? "live · refreshes every 2s"
                                    : `${events.length} event${events.length === 1 ? "" : "s"}`
                            : `${events.length} event${events.length === 1 ? "" : "s"}` })] }), _jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: error ? (_jsx("div", { className: "px-4 py-3", children: _jsx(ErrorState, { error: error, onRetry: () => setError(null) }) })) : events.length === 0 ? (_jsx("p", { className: "px-4 py-4 text-step--1 text-[var(--muted)]", children: live ? "Waiting for the first event…" : "This run recorded no events." })) : (_jsx("ol", { className: "max-h-[22rem] overflow-y-auto", children: events.map((event, index) => (_jsxs("li", { className: `flex gap-3 px-4 py-2.5 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsx("span", { className: "mono w-8 shrink-0 pt-0.5 text-step--2 text-[var(--faint)]", children: event.seq }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "mb-0.5 block text-step--2 font-medium uppercase tracking-[0.12em] text-[var(--faint)]", children: event.kind }), _jsx("span", { className: "block whitespace-pre-wrap break-words text-step--1 text-[var(--text-soft)]", children: event.content })] }), _jsx("span", { className: "mono shrink-0 pt-0.5 text-step--2 text-[var(--faint)]", children: relativeTime(event.timestamp) })] }, `${event.seq}-${index}`))) })) })] }));
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
function bestFailureExplanation(task, runs) {
    const failedRuns = runs.filter((run) => run.task_id === task.id && run.status === "failed");
    if (failedRuns.length === 0)
        return null;
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
function InstructionsSection({ description, command, parent, projectId, ownerSlot, expanded, onToggle, }) {
    const long = description.length > LONG_INSTRUCTIONS;
    const collapsed = long && !expanded;
    const parentTitle = parent?.description.trim() || "Untitled";
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(description);
            toast.success("Instructions copied.");
        }
        catch {
            toast.error("Copy failed. Select the text manually.");
        }
    };
    return (_jsxs("section", { className: "mb-6", children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-baseline justify-between gap-2", children: [_jsx(SectionLabel, { children: "Instructions" }), _jsxs("span", { className: "text-step--2 text-[var(--faint)]", children: [description.length.toLocaleString(), " chars"] })] }), _jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4", children: [_jsxs("div", { className: `relative ${collapsed
                            ? "max-h-40 overflow-hidden"
                            : "max-h-[320px] overflow-y-auto overflow-x-hidden"}`, children: [description ? (_jsx("pre", { className: "mono whitespace-pre-wrap break-words text-step--1 leading-relaxed text-[var(--text-soft)]", children: description })) : (_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "No written instructions." })), collapsed ? (_jsx("div", { "aria-hidden": true, className: "pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--surface)] to-transparent" })) : null] }), _jsxs("div", { className: "mt-2 flex flex-wrap items-center gap-2", children: [long ? (_jsx(Button, { onClick: onToggle, children: expanded ? "Collapse" : "Expand" })) : null, _jsx(Button, { onClick: () => void copy(), children: "Copy" })] }), _jsxs("div", { className: "mt-3 flex flex-col gap-1.5 border-t border-[var(--border-dim)] pt-3 text-step--1", children: [_jsxs("div", { className: "flex flex-wrap items-baseline gap-x-3 gap-y-0.5", children: [_jsx("span", { className: "w-32 shrink-0 text-[var(--muted)]", children: "Command" }), command ? (_jsx("code", { className: "mono min-w-0 break-all text-[var(--text)]", children: command })) : (_jsx("span", { className: "min-w-0 flex-1 text-[var(--muted)]", children: "none (when a model runs this task, the description is the instruction)" }))] }), _jsxs("div", { className: "flex flex-wrap items-baseline gap-x-3 gap-y-0.5", children: [_jsx("span", { className: "w-32 shrink-0 text-[var(--muted)]", children: "Delegated from" }), parent ? (_jsx("a", { className: "min-w-0 max-w-full truncate text-[var(--accent)] hover:underline", href: `/p/${projectId}/t/${parent.id}`, title: parentTitle, children: parentTitle })) : (_jsx("span", { className: "min-w-0 flex-1 text-[var(--muted)]", children: "none. This is a root task" }))] }), ownerSlot ? (_jsxs("div", { className: "flex flex-wrap items-baseline gap-x-3 gap-y-1.5", children: [_jsx("span", { className: "w-32 shrink-0 text-[var(--muted)]", children: "Owner" }), _jsx("div", { className: "flex min-w-0 flex-1 flex-wrap items-center gap-2", children: ownerSlot })] })) : null] })] })] }));
}
export function TaskDetailView({ projectId, taskId, onBack, }) {
    const view = useAsync(() => api.taskView(taskId), [taskId]);
    const [busy, setBusy] = useState(null);
    const [showMore, setShowMore] = useState(false);
    const [showInstructions, setShowInstructions] = useState(false);
    const [showReview, setShowReview] = useState(false);
    const [showPackage, setShowPackage] = useState(false);
    const [showKnowledge, setShowKnowledge] = useState(false);
    const [showBoard, setShowBoard] = useState(false);
    const [rollup, setRollup] = useState(null);
    const [assignDraft, setAssignDraft] = useState(null);
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
    const [boardDraft, setBoardDraft] = useState(null);
    const teammates = useAsync(() => api.listTeammates(projectId), [projectId]);
    const delegations = useAsync(() => api.listTaskDelegations(taskId), [taskId]);
    const projects = useAsync(() => api.listProjects(), [projectId]);
    const boards = useAsync(() => api.listBoards(projectId), [projectId]);
    /* A task in flight is followed by polling, not by holding the request open.
       The server records the run; this page just reads it back. A run started
       here is watched even before the task flips to `running`, so a fast
       transition cannot leave the page frozen on `pending`. The tick counter
       drives the loop; every stop condition is derived, never written back
       into state from inside the effect. */
    const viewData = view.data;
    const reloadView = view.reload;
    useEffect(() => {
        if (!viewData)
            return;
        const taskRunning = viewData.task.status === "running";
        const runRunning = viewData.runs.some((run) => run.status === "running" || run.status === "queued");
        const terminal = ["done", "failed", "cancelled", "blocked"].includes(viewData.task.status);
        if (terminal)
            return;
        if (!watch && !taskRunning && !runRunning)
            return;
        if (watch && watchTicks.current >= 80)
            return;
        const timer = setTimeout(() => {
            if (watch)
                watchTicks.current += 1;
            reloadView();
            setPollTick((count) => count + 1);
        }, 1500);
        return () => clearTimeout(timer);
    }, [viewData, reloadView, watch, pollTick]);
    const act = async (label, fn) => {
        setBusy(label);
        try {
            const result = await fn();
            view.reload();
            return result;
        }
        catch (err) {
            notifyError(err);
            return null;
        }
        finally {
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
        }
        catch (err) {
            notifyError(err);
        }
    };
    const decide = async (delegationId, decision) => {
        try {
            await api.decideDelegation(delegationId, decision);
            delegations.reload();
            view.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const cancelDelegation = async (delegationId) => {
        try {
            await api.cancelDelegation(delegationId, "cancelled from the task view");
            delegations.reload();
            view.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    if (view.loading || teammates.loading || delegations.loading) {
        return (_jsx(Page, { width: "data", children: _jsx(LoadingState, { lines: 6 }) }));
    }
    if (view.error || !view.data || teammates.error || delegations.error) {
        return (_jsx(Page, { children: _jsx(ErrorState, { error: view.error ?? teammates.error ?? delegations.error ?? "Task not found", onRetry: view.reload }) }));
    }
    const data = view.data;
    const { task, runs, artifacts, issue, reviews, pr_packages, approvals, children, parent } = data;
    // The approvals this task is holding. The owner decides them here, instead
    // of having to find them in the approvals view.
    const approvalRows = approvals ?? [];
    // Merge view-level delegations with the dedicated endpoint (deduped).
    const delegationRows = [
        ...data.delegations,
        ...(delegations.data?.delegations ?? []).filter((d) => !data.delegations.some((v) => v.id === d.id)),
    ];
    const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
    // The run that can still be stopped: the newest one that has not ended.
    const liveRun = [...runs].reverse().find((run) => run.status === "running") ?? null;
    const owner = task.owner_teammate_id
        ? teammates.data?.teammates.find((m) => m.id === task.owner_teammate_id)
        : undefined;
    const headingSource = task.title || taskTitle(task.description);
    const cut = headingSource.slice(0, 110);
    const heading = headingSource.length > 110
        ? `${cut.replace(/\s+\S*$/, "") || cut}…`
        : headingSource;
    const description = (task.description || "").trim();
    const pendingApprovals = approvalRows.filter((approval) => approvalIsPending(approval));
    const latestOutput = unwrapRunOutput(latestRun?.output_excerpt?.trim() ||
        latestRun?.stdout?.trim() ||
        latestRun?.stderr?.trim() ||
        "");
    const projectName = projects.data?.projects.find((project) => project.id === task.project_id)
        ?.repository || "Project";
    const terminal = ["done", "failed", "cancelled"].includes(task.status);
    /* A run started from this page keeps the page live until the task ends.
       `watch` is the request; whether the button still reads "Running…" is
       derived, so a finished task cannot leave a spinner behind. */
    const watching = watch && !terminal;
    /* The select follows the server unless the owner has changed it in this
       session; no effect is needed to mirror the loaded task back into state. */
    const assignTo = assignDraft ?? task.owner_teammate_id ?? "";
    const boardValue = boardDraft ?? task.board_id ?? "";
    const boardName = boards.data?.boards.find((b) => b.id === task.board_id)?.name || task.board_id;
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
    const failedExplanation = bestFailureExplanation(task, runs);
    const hasResults = Boolean(latestOutput ||
        (artifacts && artifacts.length > 0) ||
        (task.status === "done" && (pr_packages.length > 0 || reviews.some((r) => r.verdict === "accepted"))));
    const statusLabel = {
        pending: "Not started",
        ready: "Ready to start",
        queued: "Queued",
        running: "In progress",
        blocked: "Blocked",
        awaiting_approval: "Awaiting your decision",
        done: "Completed",
        failed: "Needs attention",
        cancelled: "Cancelled",
        paused: "Paused",
    };
    const humanStatus = statusLabel[task.status] || task.status.replace(/_/g, " ");
    let nextAction = "Review progress and details below.";
    if (task.status === "running" || (watch && !terminal))
        nextAction = "Work is in progress. You can monitor updates or stop it if needed.";
    else if (pendingApprovals.length > 0)
        nextAction = "Review and decide on the pending approval below to continue.";
    else if (task.status === "blocked")
        nextAction = task.blocked_reason?.includes("provider") ? "Connect a working model in this workspace, then run again." : "Resolve the blocker, then continue or run again.";
    else if (task.status === "failed")
        nextAction = "Review what happened and run again or adjust the request.";
    else if (task.status === "done")
        nextAction = "Review the results and deliverables below.";
    else if (!owner)
        nextAction = "Assign an owner, then start the work.";
    else
        nextAction = "Start or continue this work when ready.";
    const attentionItems = [];
    if (pendingApprovals.length > 0)
        attentionItems.push({ key: "approvals", title: `${pendingApprovals.length} decision${pendingApprovals.length === 1 ? "" : "s"} needed`, detail: "This work is waiting for your approval.", tone: "warn" });
    if (task.status === "blocked" && task.blocked_reason)
        attentionItems.push({ key: "blocked", title: "Blocked", detail: task.blocked_reason, tone: "warn" });
    if (task.status === "failed" && failedExplanation?.message)
        attentionItems.push({ key: "failed", title: "Last run did not complete", detail: failedExplanation.message, tone: "danger" });
    if (!owner)
        attentionItems.push({ key: "owner", title: "No owner assigned", detail: "Assign a teammate so this work has clear responsibility.", tone: "info" });
    const onDecideApproval = (id, decision) => void act(`approval-${id}`, async () => {
        await api.decideApproval(id, decision);
        view.reload();
        return null;
    });
    const onReaskApproval = (id) => void act(`reask-${id}`, async () => {
        await api.reaskApproval(id);
        view.reload();
        return null;
    });
    return (_jsxs(Page, { width: "data", children: [_jsx(PageHeader, { eyebrow: "Task", title: heading, description: _jsxs("span", { className: "flex flex-wrap items-center gap-x-2 gap-y-1", children: [_jsx("a", { className: "hover:text-[var(--text)] hover:underline", href: `/p/${projectId}`, children: projectName }), _jsx("span", { className: "text-[var(--faint)]", "aria-hidden": true, children: "\u00B7" }), _jsx("span", { children: humanStatus }), owner ? _jsxs(_Fragment, { children: [_jsx("span", { className: "text-[var(--faint)]", "aria-hidden": true, children: "\u00B7" }), _jsxs("span", { children: ["Owner: ", owner.persona || owner.name || "Teammate"] })] }) : null] }), back: { label: `Back to ${projectName}`, onClick: onBack }, actions: _jsxs(_Fragment, { children: [_jsx(StatusBadge, { status: task.status }), liveRun ? (_jsx(Button, { variant: "danger", disabled: !!busy, onClick: () => void act("stop", () => api.cancelRun(liveRun.id)), children: busy === "stop" ? "Stopping…" : "Stop" })) : (_jsx(Button, { variant: "primary", disabled: !!busy || watching || task.status === "running", onClick: runPrimary, children: busy === "run" || watching || task.status === "running" ? "Working…" : terminal ? "Run again" : "Start work" })), _jsx(Button, { onClick: () => setShowMore((value) => !value), children: showMore ? "Close" : "More actions" })] }) }), showMore ? (_jsxs("div", { className: "mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3", children: [_jsx(Button, { disabled: !!busy, onClick: () => void act("create", () => api.ensureWorkspace(taskId)), children: "Ensure workspace" }), _jsx(Button, { disabled: !!busy, onClick: () => setShowReview(true), children: "Review" }), _jsx(Button, { disabled: !!busy, onClick: () => setShowPackage(true), children: "PR package" }), _jsx(Button, { disabled: !!busy, onClick: () => void act("package-approval", () => api.requestPackageApproval(taskId)), children: "Request package approval" }), _jsx(Button, { disabled: !!busy, onClick: () => setShowKnowledge(true), children: "Attach knowledge" }), _jsx(Button, { disabled: !!busy, onClick: () => setShowBoard(true), children: "Set board" }), _jsx(Button, { disabled: !!busy, onClick: () => void act("rollup", async () => { const res = await api.buildRollup(taskId); setRollup(res); return null; }), children: "Load roll-up" })] })) : null, showBoard ? (_jsx(Modal, { title: "Task board", onClose: () => setShowBoard(false), children: _jsxs("form", { onSubmit: (e) => {
                        e.preventDefault();
                        void act("board", async () => {
                            await api.updateTask(taskId, { board_id: boardValue });
                            setBoardDraft(null);
                            setShowBoard(false);
                            toast.success(boardValue ? "Task board updated." : "Task detached from board.");
                            return null;
                        });
                    }, className: "flex flex-col gap-3", children: [_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "Attach, move, or detach this task within the same project. Active or approval-paused executions cannot be moved silently." }), _jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 font-medium text-[var(--text)]", children: "Board" }), _jsxs("select", { value: boardValue, onChange: (e) => setBoardDraft(e.target.value), className: FORM_INPUT, children: [_jsx("option", { value: "", children: "No board" }), (boards.data?.boards ?? []).map((b) => (_jsx("option", { value: b.id, children: b.name || b.id }, b.id)))] })] }), _jsxs("div", { className: "flex justify-end gap-2 pt-1", children: [_jsx(Button, { type: "button", onClick: () => { setBoardDraft(null); setShowBoard(false); }, children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", disabled: !!busy, children: busy === "board" ? "Saving…" : "Save" })] })] }) })) : null, _jsxs("div", { className: "grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]", children: [_jsxs("section", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5", children: [_jsxs("div", { className: "mb-4", children: [_jsx("div", { className: "text-step--2 font-medium uppercase tracking-wide text-[var(--muted)]", children: "Requested" }), _jsx("div", { className: "mt-1 whitespace-pre-wrap text-step-0 leading-relaxed text-[var(--text)]", children: description || "No description provided." })] }), _jsxs("div", { className: "grid gap-3 sm:grid-cols-2", children: [_jsxs("div", { children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "Status" }), _jsxs("div", { className: "mt-0.5 flex items-center gap-2 text-step--1 text-[var(--text)]", children: [_jsx(StatusBadge, { status: task.status }), _jsx("span", { children: humanStatus })] })] }), _jsxs("div", { children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "Owner" }), _jsx("div", { className: "mt-0.5 text-step--1 text-[var(--text)]", children: owner ? (owner.persona || owner.name || "Teammate") : "Unassigned" })] }), _jsxs("div", { children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "Board" }), _jsx("div", { className: "mt-0.5 text-step--1 text-[var(--text)]", children: task.board_id ? _jsx("a", { className: "text-[var(--accent)] hover:underline", href: `/board/${task.board_id}`, children: boardName }) : _jsx("span", { className: "text-[var(--muted)]", children: "No board" }) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "Workspace" }), _jsx("div", { className: "mt-0.5 text-step--1 text-[var(--text)]", children: _jsx("a", { className: "hover:underline", href: `/p/${projectId}`, children: projectName }) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "Task" }), _jsx("div", { className: "mt-0.5 mono text-step--2 text-[var(--faint)]", children: _jsx(ShortId, { id: task.id }) })] })] }), parent ? _jsxs("div", { className: "mt-3 text-step--2 text-[var(--muted)]", children: ["Part of: ", _jsx("a", { className: "text-[var(--accent)] hover:underline", href: `/p/${projectId}/t/${parent.id}`, children: parent.description || "Parent task" })] }) : null, issue ? _jsxs("div", { className: "mt-3 text-step--2 text-[var(--muted)]", children: ["Source: ", _jsx("span", { className: "text-[var(--text-soft)]", children: issue.title }), " ", _jsxs("span", { className: "mono text-[var(--faint)]", children: [issue.source, issue.external_id ? ` · ${issue.external_id}` : ""] })] }) : null] }), _jsxs("section", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5", children: [_jsx("div", { className: "text-step--2 font-medium uppercase tracking-wide text-[var(--muted)]", children: "Progress & next step" }), _jsx("div", { className: "mt-2 text-step-0 text-[var(--text)]", children: nextAction }), _jsx("div", { className: "mt-3 flex flex-wrap items-center gap-2", children: owner ? _jsx(BotChip, { persona: owner.persona || "bot", id: owner.id, status: owner.status, face: owner.face }) : _jsx(Badge, { variant: "warn", children: "Unassigned" }) }), _jsx("div", { className: "mt-4 flex flex-col gap-2", children: attentionItems.length === 0 ? (_jsx("div", { className: "rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1 text-[var(--muted)]", children: "No decisions needed right now." })) : attentionItems.map((item) => (_jsxs("div", { className: `rounded-lg border px-3 py-2 ${item.tone === "danger" ? "border-[var(--danger)] bg-[var(--danger-dim)]" : item.tone === "warn" ? "border-[var(--warn)] bg-[var(--warn-dim)]" : "border-[var(--border)] bg-[var(--surface-2)]"}`, children: [_jsx("div", { className: "text-step--1 font-medium text-[var(--text)]", children: item.title }), item.detail ? _jsx("div", { className: "mt-0.5 text-step--2 text-[var(--text-soft)]", children: item.detail }) : null, item.key === "blocked" && task.blocked_reason?.includes("provider") ? _jsx("a", { className: "mt-1 inline-block text-step--2 text-[var(--accent)] hover:underline", href: `/p/${task.project_id}?tab=Providers`, children: "Open Providers" }) : null] }, item.key))) })] })] }), pendingApprovals.length > 0 ? (_jsxs("section", { className: "mt-6 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] p-4 sm:p-5", children: [_jsx("div", { className: "mb-2 text-step--1 font-medium text-[var(--text)]", children: "Needs your decision" }), _jsx("div", { className: "flex flex-col gap-2", children: pendingApprovals.map((a) => (_jsx("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2", children: _jsx(ApprovalRow, { approval: a, onDecide: (d) => onDecideApproval(a.id, d), onReask: () => onReaskApproval(a.id), busy: !!busy }) }, a.id))) })] })) : null, _jsxs("section", { className: "mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5", children: [_jsxs("div", { className: "mb-3 flex flex-wrap items-center justify-between gap-2", children: [_jsxs("div", { children: [_jsx("div", { className: "text-step--1 font-medium text-[var(--text)]", children: "Results & deliverables" }), _jsx("div", { className: "text-step--2 text-[var(--muted)]", children: hasResults ? (task.status === "done" ? "Produced work and outputs for this task." : "Outputs so far. Work may still be in progress.") : "No results yet." })] }), task.status !== "done" && hasResults ? _jsx(Badge, { variant: "neutral", children: "In progress" }) : null, task.status === "done" && hasResults ? _jsx(Badge, { variant: "ok", children: "Ready for review" }) : null] }), latestOutput ? (_jsxs("div", { className: "mb-4", children: [_jsx("div", { className: "mb-1 text-step--2 font-medium text-[var(--muted)]", children: "Latest output" }), _jsxs("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3", children: [_jsx(Markdown, { text: latestOutput }), latestOutput.length > 4000 ? _jsx("div", { className: "mt-2 text-step--2 text-[var(--faint)]", children: "Showing the first 4000 characters. Full output is available in execution details below." }) : null] })] })) : null, artifacts && artifacts.length > 0 ? (_jsxs("div", { className: "mb-4", children: [_jsx("div", { className: "mb-1 text-step--2 font-medium text-[var(--muted)]", children: "Produced artifacts" }), _jsx("div", { className: "flex flex-col gap-2", children: artifacts.map((artifact) => (_jsxs("a", { href: `/artifacts/${artifact.id}`, className: "flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 transition-colors hover:border-[var(--border-strong)]", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "truncate text-step--1 font-medium text-[var(--text)]", children: artifact.summary || artifact.type }), _jsx(Badge, { variant: "neutral", children: artifact.type })] }), _jsxs("div", { className: "text-step--2 text-[var(--muted)]", children: ["Verification: ", artifact.verification_status] })] }), _jsx("span", { className: "text-step--2 text-[var(--accent)]", children: "Open" })] }, artifact.id))) })] })) : null, pr_packages.length > 0 ? (_jsxs("div", { className: "mb-4", children: [_jsx("div", { className: "mb-1 text-step--2 font-medium text-[var(--muted)]", children: "PR packages" }), _jsx("div", { className: "flex flex-col gap-2", children: pr_packages.map((pkg) => (_jsxs("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2", children: [_jsx("strong", { className: "text-[var(--text)]", children: pkg.title }), _jsxs("div", { className: "mono mt-1 text-step--2 text-[var(--faint)]", children: [pkg.base_branch, " \u2190 ", pkg.head_branch] }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--muted)]", children: pkg.patch_summary })] }, pkg.id))) })] })) : null, reviews.length > 0 ? (_jsxs("div", { children: [_jsx("div", { className: "mb-1 text-step--2 font-medium text-[var(--muted)]", children: "Reviews" }), _jsx("div", { className: "flex flex-col gap-2", children: reviews.map((review) => (_jsxs("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx(ShortId, { id: review.id }), _jsx(StatusBadge, { status: review.verdict })] }), _jsx("div", { className: "mt-1 text-step--1 text-[var(--text-soft)]", children: review.notes || "No notes" })] }, review.id))) })] })) : null, !hasResults ? (_jsx(EmptyState, { title: "No results yet", hint: owner ? "Start the work to produce outputs and deliverables." : "Assign an owner and start the work to produce outputs.", action: (!watching && task.status !== "running") ? _jsx(Button, { variant: "primary", disabled: !!busy, onClick: runPrimary, children: terminal ? "Run again" : "Start work" }) : undefined })) : null] }), _jsxs("details", { className: "mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: [_jsx("summary", { className: "cursor-pointer list-none px-4 py-3 text-step--1 font-medium text-[var(--text)]", children: "Task details & responsibility" }), _jsx("div", { className: "border-t border-[var(--border-dim)] p-3 sm:p-4", children: _jsx(InstructionsSection, { description: description, command: task.command, parent: parent, projectId: projectId, ownerSlot: _jsxs(_Fragment, { children: [owner ? _jsx(BotChip, { persona: owner.persona || "bot", id: owner.id, status: owner.status, face: owner.face }) : _jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Unassigned. Pick an owner for this task." }), _jsxs("select", { "aria-label": "Assign owner teammate", value: assignTo, onChange: (e) => setAssignDraft(e.target.value), className: `${FORM_INPUT} max-w-[14rem]`, children: [_jsx("option", { value: "", children: "Unassigned" }), teammates.data?.teammates.map((mate) => (_jsx("option", { value: mate.id, children: mate.persona || "Unnamed teammate" }, mate.id)))] }), _jsx(Button, { variant: "primary", disabled: !!busy || assignTo === (task.owner_teammate_id ?? ""), onClick: () => void act("assign", async () => { await api.assignTask(taskId, assignTo || null); toast.success(assignTo ? "Owner updated." : "Task unassigned."); return null; }), children: busy === "assign" ? "Saving…" : "Assign" })] }), expanded: showInstructions, onToggle: () => setShowInstructions((value) => !value) }) })] }), showReview ? (_jsx(Modal, { title: "Submit review", onClose: () => setShowReview(false), children: _jsxs("form", { className: "flex flex-col gap-3", onSubmit: (e) => { e.preventDefault(); if (!reviewerId) {
                        notifyError("Pick the teammate who reviewed this work.");
                        return;
                    } void act("review", async () => { await api.submitReview(taskId, { reviewer_teammate_id: reviewerId, verdict: reviewVerdict, notes: reviewNotes, risks: reviewRisks.split(",").map((item) => item.trim()).filter(Boolean), run_id: latestRun?.id ?? "" }); setShowReview(false); return null; }); }, children: [_jsxs("label", { className: "flex flex-col gap-1 text-step--1 text-[var(--muted)]", children: ["Reviewer", _jsxs("select", { value: reviewerId, onChange: (e) => setReviewerId(e.target.value), required: true, className: FORM_INPUT, children: [_jsx("option", { value: "", children: "(select a teammate)" }), teammates.data?.teammates.map((mate) => (_jsx("option", { value: mate.id, children: mate.persona || "Unnamed teammate" }, mate.id)))] })] }), _jsxs("label", { className: "flex flex-col gap-1 text-step--1 text-[var(--muted)]", children: ["Verdict", _jsxs("select", { value: reviewVerdict, onChange: (e) => setReviewVerdict(e.target.value), className: FORM_INPUT, children: [_jsx("option", { value: "accepted", children: "Accepted" }), _jsx("option", { value: "needs_work", children: "Needs work" }), _jsx("option", { value: "rejected", children: "Rejected" })] })] }), _jsxs("label", { className: "flex flex-col gap-1 text-step--1 text-[var(--muted)]", children: ["Notes", _jsx("textarea", { value: reviewNotes, onChange: (e) => setReviewNotes(e.target.value), rows: 3, className: FORM_INPUT })] }), _jsxs("label", { className: "flex flex-col gap-1 text-step--1 text-[var(--muted)]", children: ["Risks (comma separated)", _jsx("input", { value: reviewRisks, onChange: (e) => setReviewRisks(e.target.value), className: FORM_INPUT })] }), _jsxs("div", { className: "mt-1 flex justify-end gap-2", children: [_jsx(Button, { type: "button", onClick: () => setShowReview(false), children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", disabled: !reviewerId || busy === "review", children: busy === "review" ? "Submitting…" : "Submit review" })] })] }) })) : null, showPackage ? (_jsx(Modal, { title: "Generate PR package", onClose: () => setShowPackage(false), children: _jsx(EntityForm, { submitLabel: "Generate", fields: [{ name: "title", label: "Title", required: true, placeholder: task.description }, { name: "body", label: "Body", type: "textarea" }], onSubmit: async (values) => { await api.generatePackage(taskId, values); setShowPackage(false); } }) })) : null, showKnowledge ? (_jsx(Modal, { title: "Attach knowledge evidence", onClose: () => setShowKnowledge(false), children: _jsx(EntityForm, { submitLabel: "Search and attach", fields: [{ name: "query", label: "Query", required: true }], onSubmit: async (values) => { await api.attachKnowledge(taskId, values.query, latestRun?.id ?? ""); setShowKnowledge(false); } }) })) : null, _jsxs("details", { className: "mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: [_jsx("summary", { className: "cursor-pointer list-none px-4 py-3 text-step--1 font-medium text-[var(--text)]", children: "Execution evidence" }), _jsxs("div", { className: "flex flex-col gap-4 border-t border-[var(--border-dim)] p-3 sm:p-4", children: [latestRun ? (_jsxs("div", { children: [_jsx("div", { className: "mb-2 text-step--2 font-medium text-[var(--muted)]", children: "Latest run timeline & live updates" }), _jsx("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 sm:p-3", children: _jsx(RunTimeline, { run: latestRun, live: latestRun.status === "running" || latestRun.status === "queued" || watching }, latestRun.id) }), latestOutput ? _jsxs("details", { className: "mt-2", children: [_jsx("summary", { className: "cursor-pointer text-step--2 text-[var(--muted)]", children: "Raw latest output" }), _jsx("pre", { className: `${LOG_BLOCK} mt-2`, children: latestOutput.slice(0, 8000) })] }) : null] })) : null, _jsxs("details", { children: [_jsxs("summary", { className: "cursor-pointer text-step--2 font-medium text-[var(--muted)]", children: ["Run history (", runs.length, ")"] }), _jsx("div", { className: "mt-2", children: _jsx(RunsTable, { runs: runs }) })] }), _jsxs("details", { children: [_jsx("summary", { className: "cursor-pointer text-step--2 font-medium text-[var(--muted)]", children: "Files and checkout" }), _jsx("div", { className: "mt-2", children: _jsx(WorkspacePanel, { taskId: taskId }) })] }), _jsxs("details", { children: [_jsxs("summary", { className: "cursor-pointer text-step--2 font-medium text-[var(--muted)]", children: ["Artifact records (", artifacts.length, ")"] }), _jsx("div", { className: "mt-2", children: artifacts.length > 0 ? (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TH, children: "ID" }), _jsx("th", { className: TH, children: "Type" }), _jsx("th", { className: TH, children: "Verification" }), _jsx("th", { className: TH, children: "Summary" })] }) }), _jsx("tbody", { children: artifacts.map((artifact) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: TD, children: _jsx(ShortId, { id: artifact.id }) }), _jsx("td", { className: `${TD} mono`, children: artifact.type }), _jsx("td", { className: TD, children: _jsx(StatusBadge, { status: artifact.verification_status }) }), _jsx("td", { className: `${TD} text-[var(--muted)]`, children: artifact.summary })] }, artifact.id))) })] }) })) : _jsx(EmptyState, { title: "No artifact records", hint: "Runs produce test-log and transcript artifacts." }) })] }), _jsxs("details", { children: [_jsxs("summary", { className: "cursor-pointer text-step--2 font-medium text-[var(--muted)]", children: ["Approvals & decisions (", approvalRows.length, ")"] }), _jsx("div", { className: "mt-2 flex flex-col gap-2", children: approvalRows.length > 0 ? approvalRows.map((a) => (_jsx("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2", children: _jsx(ApprovalRow, { approval: a, onDecide: (d) => onDecideApproval(a.id, d), onReask: () => onReaskApproval(a.id), busy: !!busy }) }, a.id))) : _jsx("div", { className: "text-step--2 text-[var(--muted)]", children: "No approvals for this task." }) })] }), _jsxs("details", { children: [_jsxs("summary", { className: "cursor-pointer text-step--2 font-medium text-[var(--muted)]", children: ["Handoffs and delegation (", delegationRows.length, ")"] }), _jsxs("div", { className: "mt-2 space-y-4", children: [_jsxs("section", { children: [_jsx(SectionLabel, { className: "mb-2", children: "Handoffs" }), _jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4", children: [_jsxs("form", { onSubmit: (e) => { e.preventDefault(); void delegate(); }, className: "flex flex-wrap items-end gap-2", children: [_jsxs("select", { "aria-label": "Delegate to teammate", value: delegateTo, onChange: (e) => setDelegateTo(e.target.value), className: `${FORM_INPUT} max-w-[14rem]`, children: [_jsx("option", { value: "", children: "Select a teammate" }), teammates.data?.teammates.filter((mate) => mate.id !== task.owner_teammate_id).map((mate) => (_jsx("option", { value: mate.id, children: mate.persona || "Unnamed teammate" }, mate.id)))] }), _jsx("input", { "aria-label": "Reason", value: delegateReason, onChange: (e) => setDelegateReason(e.target.value), placeholder: "Why hand off?", className: `${FORM_INPUT} min-w-56 flex-1` }), _jsx("input", { type: "number", min: "1", max: "5", value: delegateDepth, onChange: (e) => setDelegateDepth(e.target.value), "aria-label": "Depth", className: `${FORM_INPUT} w-20` }), _jsx(Button, { variant: "primary", type: "submit", disabled: !delegateTo, children: "Delegate" })] }), delegationRows.length > 0 ? (_jsx("div", { className: `mt-3 ${TABLE_SHELL}`, children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TH, children: "From" }), _jsx("th", { className: TH, children: "To" }), _jsx("th", { className: TH, children: "Depth" }), _jsx("th", { className: TH, children: "Status" }), _jsx("th", { className: TH, children: "Reason" }), _jsx("th", { className: TH, children: "Child task" }), _jsx("th", { className: TH, children: "Result" }), _jsx("th", { className: TH })] }) }), _jsx("tbody", { children: delegationRows.map((d) => { const pending = d.status === "pending"; const open = d.status === "pending" || d.status === "accepted"; const fromName = teammates.data?.teammates.find((m) => m.id === d.from_teammate_id)?.persona || _jsx(ShortId, { id: d.from_teammate_id }); const toName = teammates.data?.teammates.find((m) => m.id === d.to_teammate_id)?.persona || _jsx(ShortId, { id: d.to_teammate_id }); return (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: `${TD} mono text-[var(--text-soft)]`, children: fromName }), _jsx("td", { className: `${TD} mono text-[var(--text-soft)]`, children: toName }), _jsx("td", { className: `${TD} mono`, children: d.depth }), _jsx("td", { className: TD, children: _jsx(StatusBadge, { status: d.status }) }), _jsx("td", { className: `${TD} text-[var(--muted)]`, children: d.reason || "—" }), _jsx("td", { className: TD, children: d.child_task_id ? _jsx("a", { className: "text-[var(--accent)] hover:underline", href: `/p/${projectId}/t/${d.child_task_id}`, children: _jsx(ShortId, { id: d.child_task_id }) }) : "—" }), _jsxs("td", { className: `${TD} max-w-[260px] text-[var(--muted)]`, children: [d.result ? d.result.slice(0, 200) : "—", d.finished_at ? _jsxs("div", { className: "mt-0.5 text-step--2 text-[var(--faint)]", children: ["finished ", relativeTime(d.finished_at)] }) : null] }), _jsx("td", { className: TD, children: pending ? _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(Button, { variant: "primary", onClick: () => void decide(d.id, "accepted"), children: "Accept" }), _jsx(Button, { variant: "danger", onClick: () => void decide(d.id, "declined"), children: "Decline" }), _jsx(Button, { onClick: () => void cancelDelegation(d.id), children: "Cancel" })] }) : open ? _jsx(Button, { onClick: () => void cancelDelegation(d.id), children: "Cancel" }) : _jsx("span", { className: "text-[var(--muted)]", children: d.decided_at ?? "" }) })] }, d.id)); }) })] }) })) : _jsx(EmptyState, { title: "No delegations yet", hint: "Hand a task from one bot to another here." })] })] }), _jsxs("section", { children: [_jsx(SectionLabel, { className: "mb-2", children: "Delegation tree" }), _jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2 text-step--1", children: [_jsx("span", { className: "text-[var(--muted)]", children: "Parent:" }), parent ? _jsx("a", { className: "text-[var(--accent)] hover:underline", href: `/p/${projectId}/t/${parent.id}`, children: parent.description || "Untitled" }) : _jsx("span", { className: "text-[var(--muted)]", children: "none. This is a root task" })] }), _jsxs("div", { className: "mt-3", children: [_jsxs("span", { className: "text-step--1 text-[var(--muted)]", children: ["Children (", children.length, "):"] }), children.length === 0 ? _jsx("div", { className: "mt-1 text-step--1 text-[var(--faint)]", children: "No child tasks yet. Bots create them when they delegate with a command." }) : _jsx("div", { className: "mt-1.5 flex flex-col gap-1", children: children.map((child) => { const link = delegationRows.find((d) => d.child_task_id === child.id); return (_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-step--1 transition-colors hover:bg-[var(--surface)]", children: [_jsxs("span", { className: "min-w-0", children: [_jsx("a", { className: "text-[var(--accent)] hover:underline", href: `/p/${projectId}/t/${child.id}`, children: child.description || "Untitled" }), " ", _jsxs("span", { className: "mono text-step--2 text-[var(--faint)]", children: ["via ", link ? (_jsxs(_Fragment, { children: [teammates.data?.teammates.find((m) => m.id === link.to_teammate_id)?.persona || _jsx(ShortId, { id: link.to_teammate_id }), " \u00B7 ", link.status] })) : "delegation"] })] }), _jsx(StatusBadge, { status: child.status })] }, child.id)); }) })] })] })] })] })] }), rollup ? (_jsxs("details", { children: [_jsx("summary", { className: "cursor-pointer text-step--2 font-medium text-[var(--muted)]", children: "Roll-up" }), _jsx("pre", { className: `${LOG_BLOCK} mt-2`, children: JSON.stringify(rollup, null, 2) })] })) : null] })] }), _jsx("div", { className: "mt-6 text-step--1", children: _jsx("a", { href: `/p/${projectId}`, className: "text-[var(--muted)] hover:text-[var(--text)] hover:underline", children: "Back to workspace" }) })] }));
}
/** Isolated workspace browser: file list → content, plus the uncommitted diff. */
function WorkspacePanel({ taskId }) {
    const files = useAsync(() => api.workspaceFiles(taskId), [taskId]);
    const diff = useAsync(() => api.workspaceDiff(taskId), [taskId]);
    const [openPath, setOpenPath] = useState(null);
    const [content, setContent] = useState(null);
    const [contentError, setContentError] = useState(null);
    const [showDiff, setShowDiff] = useState(false);
    const openFile = async (path) => {
        setOpenPath(path);
        setContent(null);
        setContentError(null);
        try {
            const res = await api.workspaceFile(taskId, path);
            setContent(res.content);
        }
        catch (err) {
            setContentError(err instanceof Error ? err.message : String(err));
        }
    };
    return (_jsxs("section", { className: "mb-6", children: [_jsxs("div", { className: "mb-2 flex items-center justify-between gap-3", children: [_jsxs("div", { className: "flex items-baseline gap-2", children: [_jsx(SectionLabel, { children: "Task checkout" }), _jsx("span", { className: "text-step--2 text-[var(--faint)]", children: "this task's isolated working copy" })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Button, { onClick: () => {
                                    setShowDiff((v) => !v);
                                    diff.reload();
                                }, children: showDiff ? "Hide diff" : "Show diff" }), _jsx(Button, { onClick: () => {
                                    files.reload();
                                    diff.reload();
                                }, children: "Refresh" })] })] }), showDiff ? (_jsxs("div", { className: "mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4", children: [_jsx("strong", { className: "text-[var(--text)]", children: "Uncommitted changes" }), diff.loading ? (_jsx(LoadingState, { lines: 3 })) : diff.error ? (_jsx(ErrorState, { error: diff.error, onRetry: diff.reload })) : diff.data?.exists && diff.data.diff ? (_jsx("pre", { className: LOG_BLOCK, children: diff.data.diff.slice(0, 8000) })) : (_jsx("div", { className: "mt-2 text-step--1 text-[var(--muted)]", children: "No uncommitted changes (or the workspace does not exist yet; use Ensure workspace)." }))] })) : null, files.loading && !files.data ? (_jsx(LoadingState, { lines: 4 })) : files.error ? (_jsx(ErrorState, { error: files.error, onRetry: files.reload })) : files.data && files.data.files.length > 0 ? (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4", children: [_jsx("div", { className: "mono mb-3 text-step--2 text-[var(--faint)]", children: files.data.root }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: files.data.files.map((f) => (_jsx(Button, { variant: openPath === f.path ? "primary" : "default", onClick: () => void openFile(f.path), title: `${f.size} bytes`, children: f.path }, f.path))) }), openPath ? (_jsxs("div", { className: "mt-3", children: [_jsx("strong", { className: "mono text-step--1 text-[var(--text)]", children: openPath }), contentError ? (_jsx("div", { className: "mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]", role: "alert", children: contentError })) : content === null ? (_jsx(LoadingState, { lines: 3 })) : (_jsx("pre", { className: LOG_BLOCK, children: content.slice(0, 8000) }))] })) : null] })) : (_jsx(EmptyState, { title: "No workspace files", hint: "Run the task or press \u201CEnsure workspace\u201D to materialize its isolated checkout." }))] }));
}
