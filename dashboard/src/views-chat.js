import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { api, ApiError, getSession } from "./api";
import { notifyError, navigate } from "./app";
import { TeamView } from "./team-view";
import { useWorkspaceSummary } from "./views-home";
import { Markdown } from "./markdown";
import { insertMention, mentionHandle, splitMentions } from "./mentions";
import { explainRunError } from "./explainRunError";
import { usableProviders } from "./readiness";
import { EmptyState, ErrorState, LoadingState, Modal, BotFace, Button, Field, FORM_INPUT, FORM_SELECT, StatusBadge, StatusDot, SectionLabel, relativeTime, useAsync, taskStatusLabel, runStatusLabel, } from "./components";
function openTask(projectId, taskId) {
    navigate(`/p/${projectId}/t/${taskId}`);
}
function ActivityRailContent({ summary, onOpenTask, onReload, }) {
    if (summary.loading && !summary.data)
        return _jsx(LoadingState, { lines: 2 });
    if (summary.loadFailed) {
        return (_jsx("div", { className: "flex flex-col gap-2", children: _jsx(ErrorState, { error: new Error("Couldn't load activity"), onRetry: onReload }) }));
    }
    const s = summary.summary;
    const { activeRuns, failedRuns, pendingApprovals, queuedTasks } = s;
    const hasAnything = activeRuns.length > 0 ||
        failedRuns.length > 0 ||
        pendingApprovals.length > 0 ||
        queuedTasks > 0;
    if (!hasAnything) {
        return (_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "No work running. Delegate a task from chat to see progress here." }));
    }
    return (_jsxs("div", { className: "flex flex-col gap-4", children: [pendingApprovals.length > 0 ? (_jsxs("section", { children: [_jsxs("div", { className: "mb-1 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--warn)]", children: ["Needs approval (", pendingApprovals.length, ")"] }), _jsx("ul", { className: "flex flex-col gap-1.5", children: pendingApprovals.slice(0, 5).map(({ approval, projectName }) => (_jsxs("li", { className: "rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-2.5 py-2 text-step--1", children: [_jsx("div", { className: "truncate font-medium text-[var(--text)]", children: approval.action || "approval requested" }), _jsx("div", { className: "truncate text-step--2 text-[var(--muted)]", children: projectName }), approval.task_id && approval.project_id ? (_jsx("button", { type: "button", onClick: () => onOpenTask(approval.project_id, approval.task_id), className: "mt-1 text-step--2 text-[var(--accent)] hover:underline", children: "Open task \u2192" })) : null] }, approval.id))) })] })) : null, activeRuns.length > 0 ? (_jsxs("section", { children: [_jsxs("div", { className: "mb-1 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]", children: ["Running (", activeRuns.length, ")"] }), _jsx("ul", { className: "flex flex-col gap-1.5", children: activeRuns.slice(0, 6).map(({ run, task, projectName, projectId }) => (_jsxs("li", { className: "rounded-md bg-[var(--surface-2)] px-2.5 py-2 text-step--1", children: [_jsx("div", { className: "truncate text-[var(--text)]", children: task?.description || run.task_id }), _jsxs("div", { className: "truncate text-step--2 text-[var(--muted)]", children: [projectName, " \u00B7 ", run.status] }), task ? (_jsx("button", { type: "button", onClick: () => onOpenTask(projectId, task.id), className: "mt-1 text-step--2 text-[var(--accent)] hover:underline", children: "Open task \u2192" })) : null] }, run.id))) })] })) : null, queuedTasks > 0 ? (_jsxs("div", { className: "text-step--1 text-[var(--muted)]", children: [queuedTasks, " task", queuedTasks === 1 ? "" : "s", " queued"] })) : null, failedRuns.length > 0 ? (_jsxs("section", { children: [_jsxs("div", { className: "mb-1 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--danger)]", children: ["Recent failures (", failedRuns.length, ")"] }), _jsx("ul", { className: "flex flex-col gap-1.5", children: failedRuns.slice(0, 4).map(({ run, task, projectName, projectId }) => (_jsxs("li", { className: "rounded-md bg-[var(--danger-dim)] px-2.5 py-2 text-step--1 text-[var(--danger)]", children: [_jsx("div", { className: "truncate", children: task?.description || run.task_id }), _jsx("div", { className: "truncate text-step--2 opacity-80", children: projectName }), task ? (_jsx("button", { type: "button", onClick: () => onOpenTask(projectId, task.id), className: "mt-1 text-step--2 text-[var(--accent)] hover:underline", children: "Open task \u2192" })) : null] }, run.id))) })] })) : null] }));
}
export function ConversationView({ projectId, initialThreadId, onSetActiveThread, }) {
    const home = useAsync(() => api.getHome(), []);
    const summary = useWorkspaceSummary();
    const resolvedProjectId = projectId ?? (home.data?.id ?? "");
    const [search, setSearch] = useState("");
    const [showArchivedThreads, setShowArchivedThreads] = useState(false);
    const threads = useAsync(() => resolvedProjectId
        ? api.listThreads(resolvedProjectId, {
            q: search.trim() || undefined,
            include_archived: showArchivedThreads,
        })
        : Promise.resolve({ threads: [] }), [resolvedProjectId, search, showArchivedThreads]);
    const providers = useAsync(() => resolvedProjectId
        ? api.listProviders(resolvedProjectId)
        : Promise.resolve({ providers: [] }), [resolvedProjectId]);
    /* Home is a real project, but the owner thinks of models as belonging to
       the machine. On Home, offer every usable model across projects and route
       the new conversation to the project that owns the chosen one. */
    const allProviders = useAsync(async () => {
        if (projectId)
            return [];
        const { projects } = await api.listProjects();
        const groups = await Promise.all(projects.map(async (project) => {
            try {
                const result = await api.listProviders(project.id);
                return result.providers.map((provider) => ({
                    ...provider,
                    project_id: project.id,
                    project_name: project.repository,
                }));
            }
            catch {
                return [];
            }
        }));
        return groups.flat();
    }, [projectId]);
    // The Command Center resume list spans every project the owner owns, so a
    // conversation started in another workspace is still reachable from here.
    const [recentSearch, setRecentSearch] = useState("");
    const [showArchivedRecent, setShowArchivedRecent] = useState(false);
    const recentThreads = useAsync(() => api.listRecentThreads(50, { q: recentSearch.trim() || undefined, include_archived: showArchivedRecent }), [recentSearch, showArchivedRecent]);
    const [activeId, setActiveId] = useState(initialThreadId ?? null);
    const [objectiveId, setObjectiveId] = useState(null);
    const [showNew, setShowNew] = useState(false);
    const [railOpen, setRailOpen] = useState(true);
    const [mobileRailOpen, setMobileRailOpen] = useState(false);
    useEffect(() => {
        if (activeId) {
            onSetActiveThread?.(activeId);
        }
    }, [activeId, onSetActiveThread]);
    if (!resolvedProjectId) {
        return _jsx(LoadingState, { lines: 2 });
    }
    const isHome = !projectId;
    const workspaceName = summary.data?.summary.bundles.find((bundle) => bundle.project.id === resolvedProjectId)?.project.repository;
    return (_jsxs("div", { className: "flex h-full flex-col overflow-hidden", children: [_jsxs("header", { className: "flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border-dim)] py-3 pl-14 pr-4 md:px-6", children: [_jsx("div", { className: "min-w-0", children: isHome ? (_jsxs(_Fragment, { children: [_jsx("h1", { className: "text-step-1 font-semibold tracking-tight", children: "Chat" }), _jsx("p", { className: "mt-0.5 text-step-0 text-[var(--muted)]", children: "Global chat across your workspaces. Ask, delegate, or pick up where you left off." })] })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "mb-1 text-step--2 uppercase tracking-[0.16em] text-[var(--faint)]", children: "Workspace chat" }), _jsx("h1", { className: "text-step-1 font-semibold tracking-tight", children: workspaceName || "Workspace" }), _jsx("p", { className: "mt-0.5 text-step-0 text-[var(--muted)]", children: "Conversations scoped to this workspace. Model choices and some actions stay within workspace boundaries." })] })) }), _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [!isHome && activeId ? (_jsx(Button, { variant: "ghost", onClick: () => { setActiveId(null); onSetActiveThread?.(null); }, children: "Conversations" })) : null, _jsx(Button, { variant: "primary", onClick: () => setShowNew(true), disabled: !home.data, children: "New chat" })] })] }), _jsx("div", { className: "px-4 pt-3 md:px-6", children: _jsxs("div", { className: "mx-auto w-full max-w-[860px]", children: [summary.loadFailed && !summary.loading ? (_jsxs("div", { className: "mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]", children: [_jsx("span", { children: "Couldn't load some fleet data. This page may be incomplete." }), _jsx(Button, { onClick: summary.reload, children: "Retry" })] })) : null, (() => {
                            const s = summary.data?.summary;
                            if (!s)
                                return null;
                            const parts = [];
                            if (s.pendingApprovals.length)
                                parts.push(`${s.pendingApprovals.length} need${s.pendingApprovals.length === 1 ? "s" : ""} approval`);
                            if (s.failedRuns.length)
                                parts.push(`${s.failedRuns.length} failed`);
                            if (s.activeRuns.length)
                                parts.push(`${s.activeRuns.length} running`);
                            if (parts.length === 0)
                                return null;
                            return (_jsxs("div", { className: "mb-2 text-step--1 text-[var(--muted)]", children: [parts.join(" · "), " ", _jsx("button", { type: "button", onClick: () => navigate("/approvals"), className: "text-[var(--accent)] hover:underline", children: "Open activity \u2192" })] }));
                        })()] }) }), _jsxs("div", { className: "flex min-h-0 flex-1", children: [_jsx("section", { className: "flex min-w-0 flex-1 flex-col", children: activeId ? (_jsx(ThreadPane, { threadId: activeId, projectId: resolvedProjectId, workspaceName: isHome ? "Home" : (workspaceName || "Workspace"), providers: providers.data?.providers ?? [], onPlanApproved: (id) => setObjectiveId(id), onReload: () => threads.reload() })) : isHome ? (_jsx(CommandCenter, { summary: summary, projectId: resolvedProjectId, recentThreads: recentThreads.data?.threads ?? [], projects: (allProviders.data ? undefined : undefined), recentSearch: recentSearch, onRecentSearch: setRecentSearch, showArchivedRecent: showArchivedRecent, onShowArchivedRecent: setShowArchivedRecent, providers: (isHome ? allProviders.data : providers.data?.providers) ?? [], onThreadCreated: (threadId, targetProjectId) => {
                                if (targetProjectId && targetProjectId !== resolvedProjectId) {
                                    navigate(`/chat/${targetProjectId}?thread=${threadId}`);
                                    return;
                                }
                                setActiveId(threadId);
                                onSetActiveThread?.(threadId);
                            }, onOpenThread: (thread) => {
                                setActiveId(thread.id);
                                onSetActiveThread?.(thread.id);
                                if (thread.project_id !== resolvedProjectId) {
                                    navigate(`/chat/${thread.project_id}`);
                                }
                            }, refreshProviders: () => {
                                providers.reload();
                                allProviders.reload();
                            }, refreshThreads: () => recentThreads.reload() })) : (_jsx("div", { className: "flex flex-1 flex-col overflow-y-auto px-4 py-6 md:px-6", children: _jsxs("div", { className: "mx-auto w-full max-w-[860px]", children: [_jsxs("div", { className: "mb-4 flex flex-wrap items-end justify-between gap-3", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-step-1 font-semibold tracking-tight text-[var(--text)]", children: "Conversations" }), _jsxs("p", { className: "mt-1 text-step--1 text-[var(--muted)]", children: ["Scoped to ", workspaceName || "this workspace", ". Search, resume, or start a new conversation."] })] }), _jsx(Button, { variant: "primary", onClick: () => setShowNew(true), children: "New chat" })] }), _jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-3", children: [_jsx("input", { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search conversations", "aria-label": "Search conversations", className: "h-9 w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-step--1 outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" }), _jsxs("label", { className: "flex items-center gap-2 text-step--2 text-[var(--muted)]", children: [_jsx("input", { type: "checkbox", checked: showArchivedThreads, onChange: (e) => setShowArchivedThreads(e.target.checked) }), "Show archived"] })] }), threads.loading ? _jsx(LoadingState, { lines: 4 }) : threads.error ? _jsx(ErrorState, { error: threads.error, onRetry: threads.reload }) : null, !threads.loading && !threads.error && (threads.data?.threads ?? []).length === 0 ? (_jsx(EmptyState, { title: showArchivedThreads ? "No conversations found" : "No conversations yet", hint: showArchivedThreads ? "Try a different search or clear filters." : `Start a conversation in ${workspaceName || "this workspace"}.`, action: _jsx(Button, { variant: "primary", onClick: () => setShowNew(true), children: "New chat" }) })) : (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: (threads.data?.threads ?? []).map((thread, index) => (_jsxs("div", { className: `flex items-center gap-2 px-2 py-1.5 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsxs("button", { type: "button", onClick: () => { setActiveId(thread.id); onSetActiveThread?.(thread.id); }, className: "min-w-0 flex-1 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--surface-2)]", children: [_jsxs("div", { className: "flex items-center gap-2 min-w-0", children: [thread.pinned ? _jsx("span", { className: "text-[10px] text-[var(--accent)]", title: "Pinned", children: "\u25CF" }) : null, _jsx("span", { className: "truncate text-step--1 font-medium text-[var(--text)]", children: thread.title || "Untitled" }), thread.archived ? _jsx("span", { className: "rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-step--2 text-[var(--faint)]", children: "archived" }) : null] }), _jsx("div", { className: "mt-0.5 text-step--2 text-[var(--faint)]", children: relativeTime((thread.updated_at || thread.created_at) ?? "") })] }), _jsx("div", { className: "shrink-0 pr-1", children: _jsx(ThreadRowActions, { thread: thread, onChanged: () => { threads.reload(); recentThreads.reload(); }, onMoved: (targetProjectId) => {
                                                            if (targetProjectId !== resolvedProjectId)
                                                                setActiveId((id) => (id === thread.id ? null : id));
                                                            threads.reload();
                                                            recentThreads.reload();
                                                        } }) })] }, thread.id))) }))] }) })) }), railOpen ? (_jsxs("aside", { "aria-label": "Activity", className: "hidden w-72 shrink-0 flex-col border-l border-[var(--border-dim)] bg-[var(--bg)] lg:flex", children: [_jsxs("div", { className: "flex items-center justify-between px-3 py-2.5", children: [_jsx("span", { className: "text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]", children: "Activity" }), _jsx("button", { type: "button", "aria-label": "Collapse activity rail", onClick: () => setRailOpen(false), className: "rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "\u203A" })] }), _jsx("div", { className: "flex-1 overflow-y-auto px-3 pb-4", children: objectiveId ? (_jsx(TeamView, { objectiveId: objectiveId, onOpenTask: openTask })) : (_jsx(ActivityRailContent, { summary: summary, onOpenTask: openTask, onReload: () => summary.reload() })) })] })) : (_jsx("button", { type: "button", "aria-label": "Expand activity rail", onClick: () => setRailOpen(true), className: "hidden w-8 shrink-0 items-center justify-center border-l border-[var(--border-dim)] bg-[var(--bg)] text-[var(--muted)] transition-colors hover:text-[var(--text)] lg:flex", children: "\u2039" }))] }), _jsx("button", { type: "button", "aria-label": "Open activity", onClick: () => setMobileRailOpen(true), className: "fixed bottom-20 right-4 z-40 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 text-[var(--text-soft)] shadow-lg transition-colors hover:text-[var(--text)] lg:hidden", children: "Activity" }), mobileRailOpen ? (_jsx("div", { className: "fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] lg:hidden", onClick: () => setMobileRailOpen(false), children: _jsxs("aside", { className: "absolute right-0 top-0 flex h-full w-full max-w-sm flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-lg", onClick: (e) => e.stopPropagation(), role: "dialog", "aria-modal": "true", "aria-label": "Activity", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-3", children: [_jsx("span", { className: "text-step-0 font-semibold", children: "Activity" }), _jsx("button", { onClick: () => setMobileRailOpen(false), "aria-label": "Close", className: "rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "\u00D7" })] }), _jsx("div", { className: "flex-1 overflow-y-auto px-4 py-3", children: _jsx(ActivityRailContent, { summary: summary, onOpenTask: (pid, tid) => {
                                    setMobileRailOpen(false);
                                    openTask(pid, tid);
                                }, onReload: () => summary.reload() }) })] }) })) : null, showNew ? (_jsx(NewThreadModal, { projectId: resolvedProjectId, providers: providers.data?.providers ?? [], onClose: () => setShowNew(false), onCreated: (thread) => {
                    setShowNew(false);
                    threads.reload();
                    setActiveId(thread.id);
                    onSetActiveThread?.(thread.id);
                } })) : null] }));
}
function NewThreadModal({ projectId, providers, onClose, onCreated, }) {
    const [title, setTitle] = useState("");
    const [providerId, setProviderId] = useState("__default__");
    const [busy, setBusy] = useState(false);
    const create = async (e) => {
        e.preventDefault();
        if (!title.trim())
            return;
        setBusy(true);
        try {
            const thread = await api.createThread(projectId, {
                title: title.trim(),
                provider_id: providerId === "__default__" ? undefined : providerId,
            });
            onCreated(thread);
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx(Modal, { title: "New chat", onClose: onClose, children: _jsxs("form", { onSubmit: create, className: "flex flex-col gap-2", children: [_jsx(Field, { label: "Title", children: _jsx("input", { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "Evening check-in", autoFocus: true, className: "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" }) }), _jsxs(Field, { label: "Model provider", children: [_jsxs("select", { value: providerId, onChange: (e) => setProviderId(e.target.value), "aria-label": "Model provider", className: "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]", children: [_jsx("option", { value: "__default__", children: "Default model" }), providers.map((provider) => (_jsxs("option", { value: provider.id, children: [provider.name, " (", provider.kind, ")"] }, provider.id)))] }), _jsx("p", { className: "text-step--1 text-[var(--faint)]", children: "The conversation uses this model. You can change it from the thread header later." })] }), _jsxs("div", { className: "mt-2 flex justify-end gap-2", children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", disabled: busy || !title.trim(), children: busy ? "Creating…" : "Start chat" })] })] }) }));
}
/* --- Inline model chip (landing composer) --- */
/** Grok-pattern model switcher: a quiet chip in the composer that opens a
 *  small menu, so model selection lives in the composer instead of buried
 *  in the thread header. */
function ModelChip({ providers, value, onChange, disabled, }) {
    const [open, setOpen] = useState(false);
    const current = providers.find((p) => p.id === value);
    const label = current ? current.name : "Default model";
    const options = [
        { id: "__default__", label: "Default model" },
        ...providers.map((p) => ({ id: p.id, label: p.name, kind: p.kind })),
    ];
    return (_jsxs("div", { className: "relative", children: [_jsxs("button", { type: "button", disabled: disabled, "aria-haspopup": "menu", "aria-expanded": open, "aria-label": "Model provider", onClick: () => setOpen((v) => !v), className: "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-step--1 text-[var(--text-soft)] transition-colors hover:border-[var(--faint)] disabled:pointer-events-none disabled:opacity-50", children: [_jsx("span", { "aria-hidden": true, className: "text-[var(--faint)]", children: "Model:" }), " ", label, _jsx("span", { "aria-hidden": true, className: "text-[var(--faint)]", children: open ? "▴" : "▾" })] }), open ? (_jsxs(_Fragment, { children: [_jsx("div", { "aria-hidden": true, className: "fixed inset-0 z-20", onClick: () => setOpen(false) }), _jsx("div", { role: "menu", "aria-label": "Model provider options", className: "absolute bottom-full right-0 z-30 mb-2 w-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg", children: options.map((option) => {
                            const selected = option.id === value;
                            return (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": selected, onClick: () => {
                                    onChange(option.id);
                                    setOpen(false);
                                }, className: `flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-step--1 transition-colors ${selected
                                    ? "bg-[var(--surface-3)] text-[var(--text)]"
                                    : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"}`, children: [_jsx("span", { className: "truncate", children: option.label }), selected ? (_jsx("span", { "aria-hidden": true, className: "text-[var(--accent)]", children: "\u2713" })) : option.kind ? (_jsx("span", { className: "text-[var(--faint)]", children: option.kind })) : null] }, option.id));
                        }) })] })) : null] }));
}
/* --- Thread pane --- */
const PROVIDER_SELECT_CLASS = "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-step--1 text-[var(--text-soft)] outline-none transition-colors hover:border-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
function ThreadPane({ threadId, projectId, workspaceName, providers, onReload, onPlanApproved, }) {
    const view = useAsync(() => api.threadView(threadId, 50), [threadId]);
    const [draft, setDraft] = useState("");
    const [streaming, setStreaming] = useState("");
    const [streamStatus, setStreamStatus] = useState("");
    const [streamParts, setStreamParts] = useState([]);
    const [busy, setBusy] = useState(false);
    const [useStream, setUseStream] = useState(true);
    const [mode, setMode] = useState("chat");
    const [retryFrom, setRetryFrom] = useState(null);
    const [execView, setExecView] = useState(null);
    const [planPreview, setPlanPreview] = useState(null);
    const [planBusy, setPlanBusy] = useState(false);
    const [contextPanel, setContextPanel] = useState(null);
    const [attachedFiles, setAttachedFiles] = useState([]);
    const [mates, setMates] = useState([]);
    const [researchJobIds, setResearchJobIds] = useState([]);
    // Speaker announced by the stream's first event, so the in-flight bubble
    // already carries the teammate's face and name while the reply arrives.
    const [streamSpeaker, setStreamSpeaker] = useState(null);
    const [recalledThisTurn, setRecalledThisTurn] = useState([]);
    const fileInputRef = useRef(null);
    const composerRef = useRef(null);
    const abortRef = useRef(null);
    const scrollRef = useRef(null);
    useEffect(() => {
        let alive = true;
        api
            .listResearchJobs(projectId, 20)
            .then((res) => {
            if (!alive)
                return;
            const jobs = (res.jobs || []);
            const ids = jobs
                .filter((j) => j.thread_id === threadId || (j.thread_id === "" && researchJobIds.includes(j.id)))
                .map((j) => j.id);
            if (ids.length)
                setResearchJobIds((prev) => Array.from(new Set([...ids, ...prev])).slice(0, 8));
        })
            .catch(() => { });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, threadId]);
    const providerId = view.data?.thread.provider_id ?? "__default__";
    useEffect(() => {
        api
            .listTeammates(projectId)
            .then((res) => setMates(res.teammates || []))
            .catch(() => setMates([]));
    }, [projectId]);
    const mateOf = (teammateId) => (teammateId && mates.find((m) => m.id === teammateId)) || null;
    // Name + face to hang on an assistant message; null = the default bot.
    const speakerFor = (teammateId) => {
        const mate = mateOf(teammateId);
        return mate ? { name: mate.name || mate.slug || "teammate", face: mate.face } : null;
    };
    /* Stick to the newest message while streaming. */
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [view.data?.messages.length, streaming]);
    const send = async (e) => {
        e.preventDefault();
        const content = draft.trim();
        if (!content || busy)
            return;
        // Objective-like requests get a reviewable plan instead of a plain reply.
        const lower = content.toLowerCase();
        const adminVerb = /\b(create|configure|change|manage|rename|set|attach|update|edit|disable|archive|delete|remove)\b/;
        const managedNoun = /\b(bots?|teammates?|agents?|workspace|project|teams?)\b/;
        const adminLike = adminVerb.test(lower) && managedNoun.test(lower);
        const questionLike = /^(what|how|why|when|where|who|is|are|does|do|can|could|should|which)\b/.test(lower);
        const objectiveLike = /\b(build|create|research|launch|implement|design|compare|analyze|write|generate|develop|plan|delegate|investigate|review|evaluate|prepare|assign)\b/i.test(content) &&
            content.split(/\s+/).length >= 4 &&
            !adminLike &&
            !questionLike;
        if (objectiveLike && projectId) {
            setPlanBusy(true);
            try {
                const res = await api.createObjective(projectId, { objective: content, preview: true });
                setPlanPreview({ objective: content, plan: res.plan });
                setDraft("");
                return;
            }
            catch (err) {
                notifyError(err);
            }
            finally {
                setPlanBusy(false);
            }
            return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setStreaming("");
        setStreamSpeaker(null);
        setRecalledThisTurn([]);
        setRetryFrom(null);
        let stopped = false;
        try {
            let fullContent = content;
            if (attachedFiles.length > 0) {
                const fileText = attachedFiles
                    .map((f) => `\n\n[Attachment: ${f.name}]\n${f.content}`)
                    .join("");
                fullContent = content + fileText;
                setAttachedFiles([]);
            }
            if (useStream) {
                setStreamStatus("");
                setStreamParts([]);
                await api.sendChatStream(threadId, fullContent, (chunk) => {
                    setStreaming((prev) => prev + chunk);
                }, (status) => setStreamStatus(status), (parts) => setStreamParts(parts), mode, {
                    signal: controller.signal,
                    onSpeaker: setStreamSpeaker,
                    onMemoryUsed: setRecalledThisTurn,
                });
            }
            else {
                const res = await api.sendChat(threadId, fullContent, mode);
                setRecalledThisTurn(res?.memory_used || []);
            }
            setDraft("");
            await view.reload();
            await onReload();
        }
        catch (err) {
            if (controller.signal.aborted && err instanceof ApiError && err.detail === "Stream stopped") {
                stopped = true;
                setStreaming((prev) => (prev ? `${prev}\n[stopped]` : ""));
            }
            else {
                notifyError(err);
            }
        }
        finally {
            abortRef.current = null;
            setBusy(false);
            if (!stopped) {
                setStreaming("");
                setStreamStatus("");
                setStreamParts([]);
                setStreamSpeaker(null);
            }
        }
    };
    const stop = () => {
        abortRef.current?.abort();
    };
    const retry = async () => {
        if (!view.data)
            return;
        const target = retryFrom ?? view.data.messages[view.data.messages.length - 1]?.id;
        if (!target)
            return;
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setStreaming("");
        setStreamSpeaker(null);
        setRecalledThisTurn([]);
        let stopped = false;
        try {
            const content = view.data.messages.find((m) => m.id === target)?.content ?? "";
            if (useStream) {
                setStreamStatus("");
                setStreamParts([]);
                await api.sendChatStream(threadId, content, (chunk) => {
                    setStreaming((prev) => prev + chunk);
                }, (status) => setStreamStatus(status), (parts) => setStreamParts(parts), mode, {
                    signal: controller.signal,
                    onSpeaker: setStreamSpeaker,
                    onMemoryUsed: setRecalledThisTurn,
                });
            }
            else {
                const res = await api.sendChat(threadId, content, mode);
                setRecalledThisTurn(res?.memory_used || []);
            }
            setRetryFrom(null);
            await view.reload();
            await onReload();
        }
        catch (err) {
            if (controller.signal.aborted && err instanceof ApiError && err.detail === "Stream stopped") {
                stopped = true;
                setStreaming((prev) => (prev ? `${prev}\n[stopped]` : ""));
            }
            else {
                notifyError(err);
            }
        }
        finally {
            abortRef.current = null;
            setBusy(false);
            if (!stopped) {
                setStreaming("");
                setStreamStatus("");
                setStreamParts([]);
                setStreamSpeaker(null);
            }
        }
    };
    const switchProvider = async (id) => {
        try {
            await api.updateThread(threadId, {
                provider_id: id === "__default__" ? null : id,
            });
            onReload();
            view.reload();
        }
        catch (err) {
            notifyError(err);
            view.reload();
        }
    };
    const startDeepResearch = async () => {
        const query = draft.trim();
        if (!query) {
            toast.error("Enter a research question first.");
            return;
        }
        setBusy(true);
        try {
            const res = await api.createProjectResearchJob(projectId, {
                query,
                thread_id: threadId,
            });
            const job = res.job;
            if (job?.id) {
                setResearchJobIds((prev) => [job.id, ...prev.filter((id) => id !== job.id)].slice(0, 8));
                setDraft("");
                setMode("research");
                toast.success("Deep research started in the background.");
            }
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    const summarize = async () => {
        setBusy(true);
        try {
            await api.summarizeThread(threadId);
            toast.success("Summary saved");
            view.reload();
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    const createTaskFromChat = async () => {
        if (!view.data)
            return;
        const last = view.data.messages[view.data.messages.length - 1];
        if (!last)
            return;
        const description = `From chat: ${last.content.slice(0, 120)}`;
        try {
            const task = await api.createTask(projectId, {
                description,
                owner_teammate_id: null,
            });
            setExecView({ kind: "task", taskId: task.id, projectId });
            toast.success("Task created. Live execution is open below the conversation.");
            await onReload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const handleAttachFile = () => {
        fileInputRef.current?.click();
    };
    const handleFileSelect = (e) => {
        const files = e.target.files;
        if (!files)
            return;
        const promises = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            promises.push(new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => {
                    setAttachedFiles((prev) => [
                        ...prev,
                        { name: file.name, content: String(reader.result ?? "") },
                    ]);
                    resolve();
                };
                reader.onerror = () => resolve();
                reader.readAsText(file);
            }));
        }
        Promise.all(promises).then(() => {
            e.target.value = "";
        });
    };
    const handleBotSelect = (mate) => {
        // Mention, don't navigate: picking a teammate here addresses a reply to
        // it, so the handle goes into the composer and the panel closes.
        setContextPanel(null);
        setDraft((prev) => insertMention(prev, mentionHandle(mate)));
        requestAnimationFrame(() => composerRef.current?.focus());
    };
    const handleBotOpen = (teammateId) => {
        setContextPanel(null);
        navigate(`/bot/${teammateId}`);
    };
    const thread = view.data?.thread;
    const [threadMenuOpen, setThreadMenuOpen] = useState(false);
    const [moveProjects, setMoveProjects] = useState([]);
    const [showMove, setShowMove] = useState(false);
    const threadToken = getSession()?.token || "";
    const runThreadAction = async (fn, ok) => {
        try {
            await fn();
            if (ok)
                toast.success(ok);
            await view.reload();
            onReload();
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setThreadMenuOpen(false);
        }
    };
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col", children: [_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-dim)] px-4 py-2.5 md:px-6", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 min-w-0", children: [thread?.pinned ? _jsx("span", { className: "text-[10px] text-[var(--accent)]", title: "Pinned", children: "\u25CF" }) : null, _jsx("div", { className: "truncate text-step-0 font-semibold", children: thread?.title || "Untitled" }), thread?.archived ? _jsx("span", { className: "rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-step--2 text-[var(--faint)]", children: "archived" }) : null] }), _jsxs("div", { className: "mono text-step--2 text-[var(--faint)]", children: [_jsxs("span", { className: "rounded bg-[var(--surface-2)] px-1 py-0.5", title: thread?.project_id || "", children: ["Scope: ", workspaceName || (thread?.project_id === projectId ? "This workspace" : "Workspace")] }), ` · ${relativeTime((thread?.updated_at || thread?.created_at) ?? "")}`, ` · Model: ${providers.find((provider) => provider.id === thread?.provider_id)?.name ?? "Default"}`] })] }), _jsxs("div", { className: "flex flex-wrap items-center gap-1.5", children: [_jsxs("select", { value: providerId, onChange: (e) => void switchProvider(e.target.value), "aria-label": "Model provider", className: PROVIDER_SELECT_CLASS, children: [_jsx("option", { value: "__default__", children: "Default model" }), providers.map((provider) => (_jsxs("option", { value: provider.id, children: [provider.name, " (", provider.kind, ")"] }, provider.id)))] }), _jsx(Button, { variant: "ghost", onClick: view.reload, title: "Refresh", children: "\u27F3" }), _jsx(Button, { variant: "ghost", onClick: summarize, disabled: busy, title: "Summarize thread", children: "Summarize" }), _jsx(Button, { variant: "ghost", onClick: () => setContextPanel("files"), title: "Project files", children: "Files" }), _jsx(Button, { variant: "ghost", onClick: () => setContextPanel("bots"), title: "Teammates", children: "Teammates" }), _jsxs("div", { className: "relative", children: [_jsx(Button, { variant: "ghost", onClick: () => setThreadMenuOpen((v) => !v), "aria-label": "Conversation actions", title: "Conversation actions", children: "\u22EF" }), threadMenuOpen && thread ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-20", onClick: () => { setThreadMenuOpen(false); setShowMove(false); } }), _jsxs("div", { className: "absolute right-0 top-full z-30 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 text-step--1 shadow-lg", children: [_jsx("button", { className: "w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: () => void runThreadAction(async () => { const t = window.prompt("Rename conversation", thread.title || ""); if (t == null)
                                                            return; await api.renameThread(thread.id, t.trim() || "Untitled"); }, "Renamed"), children: "Rename" }), _jsx("button", { className: "w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: () => void runThreadAction(() => api.pinThread(thread.id, !thread.pinned).then(() => undefined), thread.pinned ? "Unpinned" : "Pinned"), children: thread.pinned ? "Unpin" : "Pin" }), _jsx("button", { className: "w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: () => void runThreadAction(async () => { if (thread.archived)
                                                            await api.unarchiveThread(thread.id);
                                                        else
                                                            await api.archiveThread(thread.id); }, thread.archived ? "Unarchived" : "Archived"), children: thread.archived ? "Unarchive" : "Archive" }), _jsx("a", { className: "block w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", href: api.exportThreadUrl(thread.id, threadToken), target: "_blank", rel: "noreferrer", children: "Export (JSON)" }), _jsx("button", { className: "w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: async () => { setShowMove(true); try {
                                                            const r = await api.listProjects();
                                                            setMoveProjects(r.projects.map((p) => ({ id: p.id, repository: p.repository })));
                                                        }
                                                        catch (e) {
                                                            notifyError(e);
                                                        } }, children: "Move to workspace\u2026" }), _jsx("button", { className: "w-full rounded px-2 py-1.5 text-left text-[var(--danger)] hover:bg-[var(--danger-dim)]", onClick: () => void runThreadAction(async () => { if (!window.confirm("Remove this conversation from your lists? This is a safe delete (it can be restored via API)."))
                                                            return; await api.deleteThread(thread.id); navigate("/"); }, "Removed"), children: "Delete" }), showMove ? (_jsxs("div", { className: "mt-1 border-t border-[var(--border-dim)] pt-1", children: [_jsx("div", { className: "px-2 py-1 text-step--2 text-[var(--muted)]", children: "Move to workspace (clears workspace-scoped model binding)" }), moveProjects.filter((p) => p.id !== thread.project_id).map((p) => (_jsx("button", { className: "w-full truncate rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: () => void runThreadAction(async () => { await api.moveThread(thread.id, p.id); navigate(`/chat/${p.id}?thread=${thread.id}`); }, "Moved"), children: p.repository || p.id }, p.id))), moveProjects.filter((p) => p.id !== thread.project_id).length === 0 ? _jsx("div", { className: "px-2 py-1 text-[var(--faint)]", children: "No other workspaces" }) : null] })) : null] })] })) : null] })] })] }), view.data?.thread.summary ? (_jsxs("details", { className: "mx-4 mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 md:mx-6", children: [_jsx("summary", { className: "cursor-pointer text-step--2 uppercase tracking-wider text-[var(--faint)]", children: "Summary \u00B7 recalled by other threads" }), _jsx("div", { className: "mt-1 whitespace-pre-wrap text-step--1 text-[var(--text-soft)]", children: view.data.thread.summary })] })) : null, execView && _jsx(ExecutionView, { state: execView, onClose: () => setExecView(null) }), planPreview && (_jsxs("div", { className: "mx-4 mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 md:mx-6", children: [_jsx("div", { className: "mb-2 text-step-1 font-semibold text-[var(--text)]", children: "Plan preview" }), _jsx("div", { className: "mb-2 text-step--1 text-[var(--muted)]", children: planPreview.objective }), _jsx("ol", { className: "mb-3 list-decimal pl-5 text-step--1 text-[var(--text-soft)]", children: planPreview.plan.tasks.map((t, i) => (_jsxs("li", { className: "mb-1", children: [t.description, t.owner_teammate_id ? _jsxs("span", { className: "ml-2 text-[var(--faint)]", children: ["(", t.owner_teammate_id, ")"] }) : null, t.depends_on?.length ? _jsxs("span", { className: "ml-2 text-[var(--faint)]", children: ["depends on ", t.depends_on.map((d) => d + 1).join(", ")] }) : null] }, i))) }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { variant: "primary", disabled: planBusy, onClick: async () => {
                                    setPlanBusy(true);
                                    try {
                                        await api.createObjective(projectId, {
                                            objective: planPreview.objective,
                                            plan: planPreview.plan,
                                            create_board: true,
                                        });
                                        setPlanPreview(null);
                                        toast.success("Plan approved; tasks created.");
                                    }
                                    catch (err) {
                                        notifyError(err);
                                    }
                                    finally {
                                        setPlanBusy(false);
                                    }
                                }, children: "Approve & execute" }), _jsx(Button, { onClick: () => setPlanPreview(null), disabled: planBusy, children: "Cancel" })] })] })), _jsx("div", { ref: scrollRef, className: "min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6", children: _jsx("div", { className: "mx-auto flex w-full max-w-[var(--max-width-read)] flex-col gap-4", children: view.loading ? (_jsx(LoadingState, { lines: 4 })) : view.error ? (_jsx(ErrorState, { error: view.error, onRetry: view.reload })) : view.data ? (_jsxs(_Fragment, { children: [view.data.messages.length === 0 && !streaming && (_jsx(EmptyState, { title: "Empty conversation", hint: "Say hello to begin." })), view.data.messages.map((message) => (_jsx(Message, { message: message, parts: message.parts, projectId: projectId, speaker: speakerFor(message.teammate_id), onPlanApproved: (id) => onPlanApproved?.(id), onCreateTask: async (proposal) => {
                                    try {
                                        const task = await api.createTask(projectId, {
                                            description: proposal.title,
                                            command: "",
                                        });
                                        toast.success("Task created");
                                        await view.reload();
                                        return task;
                                    }
                                    catch (err) {
                                        notifyError(err);
                                        return null;
                                    }
                                } }, message.id))), streaming ? (_jsxs("div", { className: "flex flex-col gap-1.5", children: [recalledThisTurn.length > 0 ? (_jsxs("details", { className: "rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] px-2.5 py-1.5 text-step--2 text-[var(--faint)]", children: [_jsxs("summary", { className: "cursor-pointer select-none", children: ["Recalled this turn: ", recalledThisTurn.length, " item", recalledThisTurn.length === 1 ? '' : 's', " (untrusted context)"] }), _jsx("ul", { className: "mt-1.5 space-y-1 text-[var(--muted)]", children: recalledThisTurn.map((m, i) => (_jsxs("li", { className: "break-words", children: [_jsx("span", { className: "font-medium text-[var(--text-soft)]", children: m.kind || 'memory' }), m.source ? _jsxs("span", { children: [" \u00B7 ", m.source] }) : null, m.scope ? _jsxs("span", { className: "mono", children: [" \u00B7 ", m.scope] }) : null, m.tier ? _jsxs("span", { children: [" \u00B7 ", m.tier] }) : null, typeof m.confidence === 'number' ? _jsxs("span", { children: [" \u00B7 conf ", m.confidence.toFixed(2)] }) : null, m.pinned ? _jsx("span", { children: " \u00B7 pinned" }) : null, m.snippet ? _jsx("div", { className: "mt-0.5 text-[var(--faint)]", children: m.snippet }) : null] }, m.id || i))) })] })) : null, _jsxs("div", { className: "flex items-center gap-2 text-step--2 text-[var(--muted)]", "aria-live": "polite", children: [_jsxs("span", { className: "inline-flex gap-1", "aria-hidden": true, children: [_jsx("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" }), _jsx("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:120ms]" }), _jsx("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:240ms]" })] }), _jsx("span", { children: streamStatus || "Thinking…" })] }), _jsx(Message, { message: {
                                            id: "streaming",
                                            thread_id: threadId,
                                            role: "assistant",
                                            content: streaming,
                                            created_at: "",
                                        }, streaming: true, speaker: streamSpeaker
                                            ? {
                                                name: streamSpeaker.name || "nerdbot",
                                                face: mateOf(streamSpeaker.teammate_id)?.face,
                                            }
                                            : { name: "NerdBot" }, parts: streamParts }, "streaming")] })) : busy && !streaming ? (_jsxs("div", { className: "flex items-center gap-2 rounded-xl border border-[var(--border-dim)] bg-[var(--surface-2)] px-3 py-2 text-step--2 text-[var(--muted)]", children: [_jsxs("span", { className: "inline-flex gap-1", "aria-hidden": true, children: [_jsx("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" }), _jsx("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:120ms]" }), _jsx("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:240ms]" })] }), _jsx("span", { children: streamStatus || "Working…" })] })) : null] })) : null }) }), researchJobIds.length > 0 ? (_jsx("div", { className: "border-t border-[var(--border-dim)] px-4 py-3 md:px-6", children: _jsx("div", { className: "mx-auto flex w-full max-w-[var(--max-width-read)] flex-col gap-3", children: researchJobIds.map((id) => (_jsx(ResearchJobCard, { jobId: id, projectId: projectId, threadId: threadId, onClose: () => setResearchJobIds((prev) => prev.filter((x) => x !== id)) }, id))) }) })) : null, _jsx("form", { onSubmit: send, className: "border-t border-[var(--border-dim)] px-4 py-3 md:px-6", children: _jsxs("div", { className: "mx-auto w-full max-w-[var(--max-width-read)]", children: [attachedFiles.length > 0 && (_jsx("div", { className: "mb-2 flex flex-wrap gap-1.5", children: attachedFiles.map((f, i) => (_jsxs("span", { className: "inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-step--2 text-[var(--muted)]", children: [_jsx("span", { className: "mono", children: f.name }), _jsx("button", { type: "button", "aria-label": `Remove attachment ${f.name}`, onClick: () => setAttachedFiles(attachedFiles.filter((_, j) => j !== i)), className: "text-[var(--danger)] hover:text-[var(--text)]", children: "\u00D7" })] }, i))) })), _jsxs("div", { className: "flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-sm focus-within:border-[var(--border-focus)] sm:flex-row sm:items-end", children: [_jsxs("div", { className: "flex items-center gap-1 pb-1 pl-1", children: [_jsx("button", { type: "button", onClick: () => setContextPanel("bots"), title: "Mention a teammate", "aria-label": "Mention a teammate", className: "rounded-md px-2 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "\u221E Teammates" }), _jsx("button", { type: "button", onClick: () => setContextPanel("files"), title: "Project files", "aria-label": "Project files", className: "rounded-md px-2 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "Files" }), _jsx("button", { type: "button", onClick: handleAttachFile, title: "Attach local file", "aria-label": "Attach local file", className: "rounded-md px-2 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "+" }), _jsx("button", { type: "button", onClick: () => setContextPanel("refs"), title: "Insert Library/Gallery reference", "aria-label": "Insert Library or Gallery reference", className: "rounded-md px-2 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "Ref" }), _jsx("input", { type: "file", ref: fileInputRef, style: { display: "none" }, onChange: handleFileSelect, multiple: true })] }), _jsx("textarea", { ref: composerRef, value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => {
                                        if (e.key === "Enter" && !e.shiftKey) {
                                            e.preventDefault();
                                            void send(e);
                                        }
                                    }, placeholder: "Talk to NerdBot\u2026", "aria-label": "Chat message", disabled: busy, spellCheck: true, rows: 1, autoComplete: "off", className: "max-h-40 min-h-[36px] w-full min-w-0 resize-none bg-transparent py-1.5 text-step-0 leading-relaxed outline-none placeholder:text-[var(--faint)] disabled:opacity-50 sm:w-auto sm:flex-1" }), _jsxs("div", { className: "flex items-center gap-1.5 justify-end pb-0.5", children: [_jsx("button", { type: "button", onClick: () => void startDeepResearch(), disabled: !draft.trim() || busy, title: "Run multi-source deep research in the background with citations", className: "rounded-md px-2.5 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-50", children: "Deep research" }), _jsx("button", { type: "button", onClick: createTaskFromChat, title: "Create a task from this conversation", className: "rounded-md px-2.5 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "Task" }), busy ? (_jsx(Button, { variant: "danger", onClick: stop, title: "Stop streaming", children: "\u25A0 Stop" })) : (_jsxs(_Fragment, { children: [retryFrom ? (_jsx(Button, { onClick: retry, title: "Retry last message", children: "Retry" })) : null, _jsx(Button, { variant: "primary", type: "submit", disabled: !draft.trim() || busy, children: "Send \u23CE" })] }))] })] }), _jsxs("div", { className: "mt-1.5 flex items-center justify-between px-1", children: [_jsx("span", { className: "text-step--2 text-[var(--faint)]", children: "Enter to send \u00B7 Shift+Enter for a new line" }), _jsxs("select", { value: mode, onChange: (e) => setMode(e.target.value), className: "h-6 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 text-step--2 text-[var(--text-soft)]", "aria-label": "Chat mode", children: [_jsx("option", { value: "chat", children: "Chat" }), _jsx("option", { value: "research", children: "Research" }), _jsx("option", { value: "delegate", children: "Delegate" })] }), _jsxs("label", { className: "flex cursor-pointer items-center gap-1.5 text-step--2 text-[var(--faint)]", children: [_jsx("input", { type: "checkbox", checked: useStream, onChange: (e) => setUseStream(e.target.checked), className: "h-3 w-3" }), "Stream"] })] })] }) }), contextPanel && (_jsx(ContextPanel, { type: contextPanel, projectId: projectId, onClose: () => setContextPanel(null), onSelectBot: handleBotSelect, onOpenBot: handleBotOpen, onAttachFile: (file) => {
                    setAttachedFiles((prev) => [...prev, file]);
                    setContextPanel(null);
                }, onInsertReference: (text) => {
                    setDraft((prev) => (prev ? `${prev}\n${text}` : text));
                    setContextPanel(null);
                    requestAnimationFrame(() => composerRef.current?.focus());
                } }))] }));
}
function TaskProposalCard({ proposal, onCreateTask }) {
    const [createdId, setCreatedId] = useState(null);
    const [task, setTask] = useState(null);
    const [retryBusy, setRetryBusy] = useState(false);
    const loadTask = async (id) => {
        try {
            const t = await api.taskView(id);
            setTask(t.task);
        }
        catch (err) {
            notifyError(err);
        }
    };
    useEffect(() => {
        if (!createdId)
            return;
        const id = createdId;
        queueMicrotask(() => {
            void loadTask(id);
        });
    }, [createdId]);
    if (!createdId) {
        return (_jsxs("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-step--1", children: [_jsx("div", { className: "font-semibold text-[var(--text)]", children: proposal.title }), proposal.body ? _jsx("div", { className: "mt-1 whitespace-pre-wrap text-[var(--text-soft)]", children: proposal.body }) : null, _jsx("div", { className: "mt-2", children: _jsx("button", { type: "button", className: "rounded-md bg-[var(--accent)] px-2.5 py-1 text-step--2 font-medium text-white", onClick: async () => {
                            const t = await onCreateTask?.(proposal);
                            if (t?.id)
                                setCreatedId(t.id);
                        }, children: "Create task" }) })] }));
    }
    const status = task?.status || "queued";
    const failedRun = task?.latest_run?.status === "failed" ? task.latest_run : null;
    return (_jsxs("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-step--1", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("div", { className: "font-semibold text-[var(--text)]", children: proposal.title }), _jsx("span", { className: "text-step--2 text-[var(--muted)]", children: status })] }), failedRun ? (_jsxs("div", { className: "mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-2.5 py-2 text-[var(--danger)]", children: [_jsx("div", { className: "font-medium", children: explainRunError({ command: task?.command || "", project_id: task?.project_id || "" }, { stderr: failedRun.stderr || "", output_excerpt: failedRun.output_excerpt || "" }).message || "Run failed." }), _jsxs("div", { className: "mt-2 flex gap-2", children: [_jsx("button", { type: "button", disabled: retryBusy, className: "rounded-md bg-[var(--accent)] px-2.5 py-1 text-step--2 font-medium text-white disabled:opacity-50", onClick: async () => {
                                    if (!createdId)
                                        return;
                                    setRetryBusy(true);
                                    try {
                                        await api.retryTask(createdId);
                                        await loadTask(createdId);
                                    }
                                    catch (err) {
                                        notifyError(err);
                                    }
                                    finally {
                                        setRetryBusy(false);
                                    }
                                }, children: retryBusy ? "Retrying…" : "Retry" }), _jsx("button", { type: "button", className: "text-step--2 text-[var(--accent)] hover:underline", onClick: () => task?.project_id && task?.id && openTask(task.project_id, task.id), children: "Open task \u2192" })] })] })) : (_jsx("div", { className: "mt-2", children: _jsx("button", { type: "button", className: "text-step--2 text-[var(--accent)] hover:underline", onClick: () => task?.project_id && task?.id && openTask(task.project_id, task.id), children: "Open task \u2192" }) }))] }));
}
function ResearchJobCard({ jobId, initialJob, onClose, projectId, threadId, }) {
    const [job, setJob] = useState(initialJob ?? null);
    const [events, setEvents] = useState([]);
    const [busy, setBusy] = useState(false);
    const [saveOpen, setSaveOpen] = useState(false);
    const terminal = job?.status === "done" || job?.status === "failed" || job?.status === "cancelled";
    useEffect(() => {
        let alive = true;
        let after = 0;
        const tick = async () => {
            try {
                const [jr, er] = await Promise.all([
                    api.getResearchJob(jobId),
                    api.getResearchJobEvents(jobId, after),
                ]);
                if (!alive)
                    return;
                setJob(jr.job);
                const evs = (er.events || []);
                if (evs.length) {
                    after = Math.max(after, ...evs.map((e) => e.seq || 0));
                    setEvents((prev) => {
                        const seen = new Set(prev.map((e) => e.seq));
                        return [...prev, ...evs.filter((e) => !seen.has(e.seq))].slice(-120);
                    });
                }
            }
            catch {
                /* best effort while polling */
            }
        };
        void tick();
        if (terminal)
            return () => { alive = false; };
        const t = setInterval(() => { void tick(); }, 1500);
        return () => { alive = false; clearInterval(t); };
    }, [jobId, terminal]);
    const cancel = async () => {
        setBusy(true);
        try {
            const res = await api.cancelResearchJob(jobId);
            setJob(res.job);
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    const statusLabel = {
        queued: "Queued", planning: "Planning", searching: "Searching", reading: "Reading sources",
        synthesizing: "Synthesizing", done: "Complete", failed: "Failed", cancelled: "Cancelled",
    };
    const s = job?.status || "queued";
    const sources = (job?.sources || []);
    const readOk = sources.filter((x) => x.read_ok).length;
    return (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-step--1", children: [_jsxs("div", { className: "flex flex-wrap items-start justify-between gap-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "font-semibold text-[var(--text)]", children: "Deep research" }), _jsx(StatusBadge, { status: s, label: statusLabel[s] || s })] }), _jsx("p", { className: "mt-1 text-[var(--muted)]", children: job?.query || "Research job" })] }), _jsxs("div", { className: "flex items-center gap-2", children: [!terminal ? (_jsx(Button, { variant: "danger", disabled: busy, onClick: () => void cancel(), children: busy ? "Stopping…" : "Stop" })) : null, onClose ? _jsx(Button, { variant: "ghost", onClick: onClose, children: "Close" }) : null] })] }), !terminal ? (_jsxs("div", { className: "mt-3 rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)] px-3 py-2", children: [_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: events.length ? events[events.length - 1]?.content : "Starting…" }), sources.length > 0 ? (_jsxs("div", { className: "mt-1 text-step--2 text-[var(--faint)]", children: [sources.length, " sources found \u00B7 ", readOk, " read"] })) : null] })) : null, job?.status === "failed" && job.error ? (_jsx("div", { className: "mt-3 rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]", children: job.error })) : null, job?.status === "done" ? (_jsxs("div", { className: "mt-3", children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-center gap-2", children: [job.library_doc_id ? (_jsx(Button, { variant: "primary", onClick: () => navigate(`/library/${job.library_doc_id}`), children: "Open in Library" })) : null, job.report_markdown && (projectId || job.project_id) && !job.library_doc_id ? (_jsx(Button, { onClick: () => setSaveOpen(true), children: "Save to Library" })) : null, job.report_markdown ? (_jsx(Button, { onClick: () => navigator.clipboard?.writeText(job.report_markdown || ""), children: "Copy report" })) : null] }), job.report_markdown ? (_jsx(SaveToLibraryModal, { open: saveOpen, projectId: projectId || job.project_id, initialTitle: job.report_title || job.query || "Research report", initialContent: job.report_markdown, initialFormat: "md", source: "research report", threadId: threadId || job.thread_id || "", metadata: { provenance: "research_report", job_id: job.id, query: job.query || "" }, onClose: () => setSaveOpen(false), onSaved: (id) => navigate(`/library/${id}`) })) : null, sources.length > 0 ? (_jsxs("details", { className: "mb-3 rounded-lg border border-[var(--border-dim)]", children: [_jsxs("summary", { className: "cursor-pointer px-3 py-2 text-step--1 font-medium text-[var(--text-soft)]", children: ["Citations (", sources.length, ")"] }), _jsx("ol", { className: "border-t border-[var(--border-dim)] px-3 py-2 text-step--2 text-[var(--muted)]", children: sources.map((src, i) => (_jsxs("li", { className: "mb-1.5 break-all", children: [_jsxs("span", { className: "text-[var(--faint)]", children: ["[", i + 1, "]"] }), " ", src.url ? (_jsx("a", { className: "text-[var(--accent)] hover:underline", href: String(src.final_url || src.url), target: "_blank", rel: "noreferrer", children: String(src.title || src.url) })) : (String(src.title || "Source")), src.read_ok === false && src.read_error ? _jsx("span", { className: "text-[var(--faint)]", children: " (unread)" }) : null] }, `${src.url}-${i}`))) })] })) : null, job.report_markdown ? (_jsx("div", { className: "max-h-[28rem] overflow-y-auto rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)] p-3", children: _jsx(Markdown, { text: job.report_markdown }) })) : null] })) : null] }));
}
function SaveToLibraryModal({ open, projectId, initialTitle, initialContent, initialFormat = "md", source, threadId, metadata, onClose, onSaved, }) {
    const [title, setTitle] = useState(initialTitle);
    const [format, setFormat] = useState(initialFormat);
    const [saving, setSaving] = useState(false);
    useEffect(() => { if (open) {
        setTitle(initialTitle || "Untitled");
        setFormat(initialFormat || "md");
    } }, [open, initialTitle, initialFormat]);
    if (!open)
        return null;
    return (_jsx(Modal, { title: "Save to Library", onClose: onClose, children: !projectId ? (_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "No project context available for this chat. Open a project-scoped chat to save to Library." })) : (_jsxs("form", { className: "flex flex-col gap-1", onSubmit: async (e) => {
                e.preventDefault();
                if (!projectId || !title.trim())
                    return;
                setSaving(true);
                try {
                    const doc = await api.createLibraryDoc(projectId, {
                        title: title.trim(),
                        content: initialContent || "",
                        kind: "doc",
                        format,
                        source,
                        thread_id: threadId || "",
                        metadata: metadata || {},
                    });
                    toast.success("Saved to Library", { action: { label: "Open", onClick: () => navigate(`/library/${doc.id}`) } });
                    onSaved(doc.id);
                    onClose();
                }
                catch (err) {
                    notifyError(err);
                }
                finally {
                    setSaving(false);
                }
            }, children: [_jsx(Field, { label: "Title", children: _jsx("input", { className: FORM_INPUT, value: title, onChange: (e) => setTitle(e.target.value), required: true }) }), _jsx(Field, { label: "Format", children: _jsxs("select", { className: FORM_SELECT, value: format, onChange: (e) => setFormat(e.target.value), children: [_jsx("option", { value: "md", children: "Markdown" }), _jsx("option", { value: "csv", children: "CSV" }), _jsx("option", { value: "html", children: "HTML" }), _jsx("option", { value: "text", children: "Text" })] }) }), _jsxs("div", { className: "text-step--2 text-[var(--faint)]", children: ["Source: ", source, threadId ? ` · linked to thread ${threadId}` : ""] }), _jsxs("div", { className: "mt-2 flex justify-end gap-2", children: [_jsx(Button, { variant: "ghost", onClick: onClose, children: "Cancel" }), _jsx(Button, { type: "submit", variant: "primary", disabled: saving || !title.trim(), children: saving ? "Saving…" : "Save & open" })] })] })) }));
}
function ReminderCard({ part }) {
    const due = part.due_at ? new Date(part.due_at).toLocaleString() : "unknown time";
    return (_jsxs("div", { className: "rounded-lg border border-[var(--info)] bg-[var(--info-dim)] p-3 text-step--1", children: [_jsx("div", { className: "font-semibold text-[var(--text)]", children: "Reminder set" }), _jsx("div", { className: "mt-1 text-[var(--text-soft)]", children: part.message || "Reminder" }), _jsxs("div", { className: "mt-1 text-step--2 text-[var(--muted)]", children: ["Due: ", due] }), part.reminder_id ? _jsx("div", { className: "mono mt-1 text-step--2 text-[var(--faint)]", children: part.reminder_id }) : null] }));
}
function ReportCard({ part, projectId, threadId, sourceLabel }) {
    const [open, setOpen] = useState(false);
    const [saveOpen, setSaveOpen] = useState(false);
    const content = part.content || "";
    return (_jsxs("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-step--1", children: [_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2", children: [_jsx("div", { className: "font-semibold text-[var(--text)]", children: part.title || "Report" }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsx("button", { type: "button", className: "text-step--2 text-[var(--accent)] hover:underline", onClick: () => setOpen((v) => !v), children: open ? "Hide" : "Open" }), projectId ? _jsx("button", { type: "button", className: "text-step--2 text-[var(--accent)] hover:underline", onClick: () => setSaveOpen(true), children: "Save to Library" }) : null, _jsx("button", { type: "button", className: "text-step--2 text-[var(--accent)] hover:underline", onClick: () => navigator.clipboard?.writeText(content), children: "Copy" }), _jsx("button", { type: "button", className: "text-step--2 text-[var(--accent)] hover:underline", onClick: () => {
                                    const blob = new Blob([content], { type: "text/markdown" });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement("a");
                                    a.href = url;
                                    a.download = `${(part.title || "report").replace(/[^a-z0-9]+/gi, "-")}.md`;
                                    a.click();
                                    URL.revokeObjectURL(url);
                                }, children: "Export" })] })] }), open ? (_jsx("pre", { className: "mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-step--1 text-[var(--text-soft)]", children: content })) : (_jsx("div", { className: "mt-1 line-clamp-3 whitespace-pre-wrap text-[var(--text-soft)]", children: content.slice(0, 200) })), _jsx(SaveToLibraryModal, { open: saveOpen, projectId: projectId, initialTitle: part.title || "Report", initialContent: content, initialFormat: "md", source: sourceLabel || "chat report", threadId: threadId, metadata: { provenance: "chat_report", thread_id: threadId || "", saved_from: "chat" }, onClose: () => setSaveOpen(false), onSaved: (id) => navigate(`/library/${id}`) })] }));
}
function PlanCard({ part, threadId, projectId, onApproved }) {
    const [approved, setApproved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [steps, setSteps] = useState(part.steps || []);
    const [mates, setMates] = useState([]);
    useEffect(() => {
        if (!projectId)
            return;
        api.listTeammates(projectId).then((r) => setMates(r.teammates || [])).catch(() => { });
    }, [projectId]);
    return (_jsxs("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-step--1", children: [_jsx("div", { className: "font-semibold text-[var(--text)]", children: part.objective || "Plan" }), _jsx("ul", { className: "mt-2 flex flex-col gap-1.5", children: steps.map((st, i) => (_jsxs("li", { className: "rounded-md bg-[var(--surface)] px-2.5 py-1.5", children: [_jsx("input", { value: st.title, onChange: (e) => {
                                const next = [...steps];
                                next[i] = { ...next[i], title: e.target.value };
                                setSteps(next);
                            }, className: "w-full bg-transparent text-[var(--text)] outline-none" }), _jsxs("select", { value: st.assignee_slug || "", onChange: (e) => {
                                const next = [...steps];
                                next[i] = { ...next[i], assignee_slug: e.target.value };
                                setSteps(next);
                            }, className: "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 text-step--2 text-[var(--muted)]", children: [_jsx("option", { value: "", children: "unassigned" }), mates.map((m) => (_jsx("option", { value: m.slug, children: m.slug || m.id }, m.id)))] }), _jsx("button", { type: "button", className: "mt-1 text-step--2 text-[var(--danger)] hover:underline", onClick: () => setSteps(steps.filter((_, j) => j !== i)), children: "Remove" })] }, i))) }), !approved && !part.approved ? (_jsx("div", { className: "mt-3", children: _jsx("button", { type: "button", disabled: busy, className: "rounded-md bg-[var(--accent)] px-2.5 py-1 text-step--2 font-medium text-white disabled:opacity-50", onClick: async () => {
                        setBusy(true);
                        try {
                            const obj = await api.approvePlan?.(threadId, part.plan_id, { steps });
                            setApproved(true);
                            if (obj?.id)
                                onApproved?.(obj.id);
                            toast.success("Plan approved");
                        }
                        catch (err) {
                            notifyError(err);
                        }
                        finally {
                            setBusy(false);
                        }
                    }, children: busy ? "Approving…" : "Approve plan" }) })) : (_jsx("div", { className: "mt-2 text-step--2 text-[var(--muted)]", children: "Approved" }))] }));
}
/** Split text on @handles so a mention reads as an address, not prose. */
function renderMentions(text) {
    return splitMentions(text).map((chunk, i) => chunk.mention ? (_jsx("span", { className: "rounded bg-[var(--accent-dim)] px-0.5 font-medium text-[var(--accent)]", children: chunk.text }, i)) : (_jsx("span", { children: chunk.text }, i)));
}
function Message({ message, streaming = false, parts, projectId, speaker, onCreateTask, onPlanApproved, }) {
    const isUser = message.role === "user";
    const [expanded, setExpanded] = useState(false);
    const [saveOpen, setSaveOpen] = useState(false);
    // Long assistant replies (e.g. a model dumping a whole file) flood the
    // conversation the way a raw tool log would. Collapse them behind a toggle
    // so the chat stays scannable, like Grok/ChatGPT collapsing tool output.
    const COLLAPSE_AT = 6000;
    const isLong = !isUser && !streaming && message.content.length > COLLAPSE_AT;
    const displayContent = isLong && !expanded
        ? `${message.content.slice(0, COLLAPSE_AT)}\n\n…`
        : message.content;
    return (_jsxs("div", { className: `flex flex-col ${isUser ? "items-end" : "items-start"}`, children: [_jsxs("div", { className: `max-w-[85%] rounded-2xl px-4 py-3 text-step-0 leading-relaxed ${isUser
                    ? "border border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--text)]"
                    : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text-soft)]"} ${streaming ? "animate-pulse" : ""}`, children: [isUser ? (_jsx("div", { className: "whitespace-pre-wrap break-words", children: renderMentions(message.content) })) : (_jsxs(_Fragment, { children: [_jsx(Markdown, { text: displayContent }), isLong ? (_jsx("button", { type: "button", onClick: () => setExpanded((v) => !v), className: "mt-2 text-step--1 font-medium text-[var(--accent)] hover:underline", children: expanded ? "Show less" : `Show more (${Math.round(message.content.length / 1000 * 10) / 10}k chars)` })) : null] })), streaming ? (_jsx("div", { className: "mt-2 inline-block h-4 w-2 animate-pulse rounded-[1px] bg-[var(--accent)]", "aria-hidden": true })) : null] }), parts && parts.length > 0 ? (_jsx("div", { className: "mt-3 flex flex-col gap-2", children: parts.map((p, i) => (_jsx("div", { children: p.type === "report" ? (_jsx(ReportCard, { part: p, projectId: projectId, threadId: message.thread_id, sourceLabel: "chat report" })) : p.type === "task" && p.proposal ? (_jsx(TaskProposalCard, { proposal: p.proposal, onCreateTask: onCreateTask })) : p.type === "plan" ? (_jsx(PlanCard, { part: p, threadId: message.thread_id, projectId: projectId, onApproved: onPlanApproved })) : p.type === "reminder" ? (_jsx(ReminderCard, { part: p })) : (_jsx("pre", { className: "whitespace-pre-wrap text-[var(--text-soft)]", children: JSON.stringify(p) })) }, i))) })) : null, _jsxs("div", { className: `mono mt-1 flex flex-wrap items-center gap-1.5 text-step--2 text-[var(--faint)] ${isUser ? "mr-1 justify-end" : "ml-1"}`, children: [!isUser ? _jsx(BotFace, { face: speaker?.face ?? null, size: 18, animated: streaming }) : null, _jsx("span", { children: isUser ? "you" : speaker?.name || "NerdBot" }), streaming ? " · streaming…" : "", !streaming && projectId && (message.content || "").trim() ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "ml-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--accent)] hover:bg-[var(--accent-dim)]", onClick: () => setSaveOpen(true), title: "Save this message to Library as a living document", children: "Save to Library" }), _jsx(SaveToLibraryModal, { open: saveOpen, projectId: projectId, initialTitle: (isUser ? "Chat: " : "") + ((message.content || "").slice(0, 60).replace(/\s+/g, " ").trim() || "Chat note"), initialContent: message.content || "", initialFormat: "md", source: isUser ? "chat message" : "assistant message", threadId: message.thread_id || "", metadata: { provenance: "chat_message", message_id: message.id, role: message.role, thread_id: message.thread_id || "" }, onClose: () => setSaveOpen(false), onSaved: (id) => navigate(`/library/${id}`) })] })) : null] })] }));
}
/* --- Inline execution view (live task status inside the chat) --- */
function ExecutionView({ state, onClose, }) {
    const view = useAsync(() => api.taskView(state.taskId), [state.taskId]);
    const [poll, setPoll] = useState(0);
    const [mates, setMates] = useState(null);
    const [retryBusy, setRetryBusy] = useState(false);
    const [showOutput, setShowOutput] = useState(false);
    useEffect(() => {
        if (view.error)
            return;
        if (!view.data ||
            (view.data.task.status !== "done" &&
                view.data.task.status !== "failed" &&
                view.data.task.status !== "blocked")) {
            const t = setTimeout(() => setPoll((n) => n + 1), 3000);
            return () => clearTimeout(t);
        }
    }, [view.data, view.error, poll]);
    useEffect(() => {
        if (view.data?.task.owner_teammate_id && !mates) {
            api.listTeammates(state.projectId)
                .then((res) => setMates(res.teammates))
                .catch(() => setMates([]));
        }
    }, [view.data?.task.owner_teammate_id, state.projectId, mates]);
    const task = view.data?.task;
    const runs = view.data?.runs ?? [];
    const artifacts = view.data?.artifacts ?? [];
    const latestRun = runs[runs.length - 1];
    const owner = task?.owner_teammate_id
        ? mates?.find((m) => m.id === task.owner_teammate_id)
        : null;
    const awaitingDecision = task?.status === "blocked" || task?.status === "awaiting_approval";
    if (view.error) {
        return (_jsxs("div", { className: "mx-4 mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm md:mx-6", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-2", children: [_jsx("span", { className: "text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]", children: "Execution" }), _jsx("button", { onClick: onClose, "aria-label": "Close execution view", className: "rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "\u00D7" })] }), _jsx("div", { className: "px-4 py-4", children: _jsx(ErrorState, { error: view.error, onRetry: view.reload }) })] }));
    }
    return (_jsxs("div", { className: "mx-4 mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm md:mx-6", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-2", children: [_jsx("span", { className: "text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]", children: "Execution" }), _jsxs("div", { className: "flex items-center gap-2", children: [task ? (_jsx("button", { onClick: () => openTask(task.project_id, task.id), className: "text-step--1 text-[var(--accent)] hover:underline", children: "Open task \u2192" })) : null, _jsx("button", { onClick: onClose, "aria-label": "Close execution view", className: "rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "\u00D7" })] })] }), _jsxs("div", { className: "flex flex-col gap-3 px-4 py-3 text-step--1", children: [_jsxs("div", { children: [_jsx("div", { className: "font-medium text-[var(--text)]", children: task?.description || "Loading task…" }), _jsxs("div", { className: "mt-1.5 flex flex-wrap items-center gap-3", children: [_jsx(StatusBadge, { status: task?.status || "pending", label: taskStatusLabel(task?.status || "pending") }), owner && (_jsxs("span", { className: "text-[var(--muted)]", children: [owner.persona || "bot", " is responsible"] })), latestRun && (_jsx(StatusDot, { status: latestRun.status, label: `run ${runStatusLabel(latestRun.status)}`, pulse: latestRun.status === "running" }))] })] }), awaitingDecision && (_jsx("div", { className: "rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-[var(--warn)]", children: "This run needs your decision. It appears in the banner above." })), latestRun && latestRun.status === "failed" && (_jsxs("div", { className: "rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]", children: [_jsx("div", { className: "font-medium", children: explainRunError({ command: task?.command || "", project_id: task?.project_id || state.projectId }, { stderr: latestRun.stderr || "", output_excerpt: latestRun.output_excerpt || "" }).message || "Run failed." }), _jsxs("div", { className: "mt-2 flex flex-wrap gap-2", children: [_jsx(Button, { variant: "primary", disabled: retryBusy, onClick: async () => {
                                            if (!task)
                                                return;
                                            setRetryBusy(true);
                                            try {
                                                await api.retryTask(task.id);
                                                toast.message("Retry started.");
                                            }
                                            catch (err) {
                                                notifyError(err);
                                            }
                                            finally {
                                                setRetryBusy(false);
                                            }
                                        }, children: retryBusy ? "Retrying…" : "Retry" }), _jsx("button", { onClick: () => openTask(task.project_id, task.id), className: "text-step--1 text-[var(--accent)] hover:underline", children: "Open task \u2192" })] })] })), latestRun && (_jsxs("div", { className: "rounded-lg bg-[var(--surface-2)] px-3 py-2", children: [_jsx("div", { className: "mono truncate text-[var(--text-soft)]", children: latestRun.command || "(no command)" }), latestRun.status === "failed" ? (_jsx("button", { type: "button", onClick: () => setShowOutput((v) => !v), className: "mt-1 text-step--2 text-[var(--accent)] hover:underline", children: showOutput ? "Hide output" : "Show output" })) : null, (latestRun.status !== "failed" || showOutput) && (_jsx("div", { className: "mono mt-1 line-clamp-3 text-step--2 text-[var(--faint)]", children: latestRun.output_excerpt?.slice(0, 240) || "(no output)" }))] })), artifacts.length > 0 && (_jsxs("div", { children: [_jsx(SectionLabel, { className: "mb-1.5", children: "Artifacts" }), _jsx("div", { className: "flex flex-col gap-1.5", children: artifacts.map((art) => (_jsxs("div", { className: "rounded-md bg-[var(--surface-2)] px-3 py-1.5", children: [_jsxs("div", { className: "mono text-step--2 text-[var(--faint)]", children: [art.type, " \u00B7 ", art.location] }), _jsx("div", { className: "text-[var(--text-soft)]", children: art.summary })] }, art.id))) })] })), !task && view.loading ? _jsx(LoadingState, { lines: 2 }) : null] })] }));
}
/* --- Bots context drawer --- */
function ContextPanel({ type, projectId, onClose, onSelectBot, onOpenBot, onAttachFile, onInsertReference, }) {
    const bots = useAsync(async () => {
        if (type !== "bots")
            return { teammates: [], scope: "none" };
        try {
            const res = await api.listTeammates(projectId);
            if ((res.teammates || []).length > 0)
                return { teammates: res.teammates, scope: "project" };
        }
        catch { }
        try {
            const all = await api.listAllTeammates();
            return { teammates: all.teammates || [], scope: "all" };
        }
        catch {
            return { teammates: [], scope: "project" };
        }
    }, [projectId, type]);
    const files = useAsync(() => type === "files" ? api.projectWorkspaceFiles(projectId) : Promise.resolve({ checkouts: [], file_count: 0 }), [projectId, type]);
    const refs = useAsync(async () => {
        if (type !== "refs")
            return { docs: [], assets: [] };
        const [docsRes, assetsRes] = await Promise.all([
            api.listLibrary(projectId).catch(() => ({ docs: [] })),
            api.listGallery(projectId, { limit: 50 }).catch(() => ({ assets: [] })),
        ]);
        return { docs: docsRes.docs || [], assets: assetsRes.assets || [] };
    }, [projectId, type]);
    const token = getSession()?.token || "";
    const [attaching, setAttaching] = useState(null);
    const [attachError, setAttachError] = useState(null);
    const attach = async (taskId, path) => {
        setAttaching(path);
        setAttachError(null);
        try {
            const file = await api.workspaceFile(taskId, path);
            onAttachFile({ name: path, content: file.content });
        }
        catch (err) {
            setAttachError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setAttaching(null);
        }
    };
    const mateList = bots.data?.teammates ?? [];
    const scope = bots.data?.scope;
    return (_jsx("div", { className: "fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]", onClick: onClose, onKeyDown: (e) => {
            if (e.key === "Escape")
                onClose();
        }, children: _jsxs("aside", { className: "absolute right-0 top-0 flex h-full w-full flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-lg sm:w-[360px]", onClick: (e) => e.stopPropagation(), role: "dialog", "aria-modal": "true", "aria-label": type === "bots" ? "Teammates" : type === "refs" ? "Insert reference" : "Project files", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-3", children: [_jsx("span", { className: "text-step-0 font-semibold", children: type === "bots" ? "Teammates" : type === "refs" ? "Insert reference" : "Project files" }), _jsx("button", { onClick: onClose, "aria-label": "Close", className: "rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]", children: "\u00D7" })] }), type === "bots" ? (bots.loading ? (_jsx(LoadingState, { lines: 3 })) : bots.error ? (_jsx(ErrorState, { error: bots.error, onRetry: bots.reload })) : (_jsxs("div", { className: "flex flex-1 flex-col gap-2 overflow-y-auto p-4", children: [scope === "all" && mateList.length > 0 ? (_jsx("div", { className: "rounded-xl bg-[var(--surface-2)] px-3 py-2 text-step--2 text-[var(--muted)]", children: "Showing teammates from all workspaces (this workspace has none). \u201CMention\u201D inserts their handle into this chat." })) : null, mateList.length === 0 ? (_jsx(EmptyState, { title: "No teammates yet", hint: "Create a teammate from Team in the sidebar (or this workspace\u2019s Team tab), connect a model in Settings, then mention them here.", action: _jsx(Button, { onClick: () => navigate("/bots"), children: "Open Team" }) })) : null, mateList.map((mate) => (_jsxs("div", { className: "flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-2.5", children: [_jsx(BotFace, { face: mate.face, size: 34, status: mate.status, animated: true }), _jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate text-step--1 font-medium text-[var(--text)]", children: mate.name || mate.slug || mate.persona || mate.id }), _jsx("div", { className: "truncate text-step--2 text-[var(--faint)]", children: mate.persona?.slice(0, 80) || mate.instructions?.slice(0, 80) || mate.id })] })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-1.5", children: [_jsx(Button, { variant: "primary", onClick: () => onSelectBot(mate), children: "Mention" }), _jsx(Button, { variant: "ghost", onClick: () => onOpenBot(mate.id), children: "Open" })] })] }, mate.id)))] }))) : type === "refs" ? (refs.loading ? _jsx(LoadingState, { lines: 3 }) : refs.error ? _jsx(ErrorState, { error: refs.error, onRetry: refs.reload }) : (_jsxs("div", { className: "flex-1 overflow-y-auto p-3", children: [_jsx("p", { className: "mb-3 text-step--2 text-[var(--muted)]", children: "Insert a markdown reference to a Library document or Gallery asset into your message." }), _jsxs("div", { className: "mb-4", children: [_jsx("div", { className: "mb-1.5 text-step--2 font-medium uppercase tracking-wider text-[var(--faint)]", children: "Library docs" }), (refs.data?.docs || []).length === 0 ? _jsx("div", { className: "text-step--2 text-[var(--faint)]", children: "No documents" }) : (_jsx("div", { className: "flex flex-col gap-1", children: (refs.data?.docs || []).slice(0, 30).map((d) => (_jsxs("button", { type: "button", className: "rounded-md border border-[var(--border-dim)] px-2.5 py-2 text-left hover:bg-[var(--surface-2)]", onClick: () => onInsertReference?.(`[${d.title || 'Untitled'}](/library/${d.id})`), children: [_jsx("div", { className: "truncate text-step--1 text-[var(--text)]", children: d.title || "Untitled" }), _jsxs("div", { className: "text-step--2 text-[var(--faint)]", children: [(d.format || "md").toUpperCase(), " \u00B7 ", d.id] })] }, d.id))) }))] }), _jsxs("div", { children: [_jsx("div", { className: "mb-1.5 text-step--2 font-medium uppercase tracking-wider text-[var(--faint)]", children: "Gallery assets" }), (refs.data?.assets || []).length === 0 ? _jsx("div", { className: "text-step--2 text-[var(--faint)]", children: "No assets" }) : (_jsx("div", { className: "flex flex-col gap-1", children: (refs.data?.assets || []).slice(0, 30).map((a) => {
                                        const url = api.galleryAssetContentUrl(a.id, token);
                                        const ref = (a.mime_type || "").startsWith("image/") ? `![${a.name || "asset"}](${url})` : `[${a.name || "asset"}](${url})`;
                                        return (_jsxs("button", { type: "button", className: "rounded-md border border-[var(--border-dim)] px-2.5 py-2 text-left hover:bg-[var(--surface-2)]", onClick: () => onInsertReference?.(ref), children: [_jsx("div", { className: "truncate text-step--1 text-[var(--text)]", children: a.name || "Asset" }), _jsxs("div", { className: "text-step--2 text-[var(--faint)]", children: [a.mime_type || "file", " \u00B7 ", a.id] })] }, a.id));
                                    }) }))] })] }))) : files.loading ? (_jsx(LoadingState, { lines: 3 })) : files.error ? (_jsx(ErrorState, { error: files.error, onRetry: files.reload })) : (files.data?.checkouts ?? []).length === 0 ? (_jsx("div", { className: "p-4", children: _jsx(EmptyState, { title: "No task files to attach yet", hint: "This panel attaches files from task checkouts. To browse or edit workspace files, use the workspace\u2019s Files tab. After a task writes files, you can attach them here.", action: _jsx(Button, { onClick: () => navigate(`/p/${projectId}?tab=Files`), children: "Open workspace Files" }) }) })) : (_jsxs("div", { className: "flex-1 overflow-y-auto p-3", children: [attachError ? (_jsx("div", { className: "mb-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]", children: attachError })) : null, _jsx("p", { className: "mb-3 text-step--2 text-[var(--muted)]", children: "Files produced by tasks (attach as chat context)." }), (files.data?.checkouts ?? []).map((checkout) => (_jsxs("div", { className: "mb-4 last:mb-0", children: [_jsx("a", { href: `/p/${projectId}/t/${checkout.task_id}`, className: "block truncate text-step--1 font-medium text-[var(--text)] hover:underline", children: checkout.task_description || "Untitled task" }), _jsx("div", { className: "mono mb-1.5 truncate text-step--2 text-[var(--faint)]", children: checkout.branch || "checkout" }), _jsx("div", { className: "flex flex-col gap-0.5", children: (checkout.files || []).map((f) => (_jsxs("button", { type: "button", disabled: attaching === f.path, onClick: () => void attach(checkout.task_id, f.path), className: "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-step--2 hover:bg-[var(--surface-2)] disabled:opacity-50", children: [_jsx("span", { className: "mono truncate text-[var(--text-soft)]", children: f.path }), _jsx("span", { className: "shrink-0 text-[var(--faint)]", children: attaching === f.path ? "Attaching…" : "Attach" })] }, f.path))) })] }, checkout.task_id)))] }))] }) }));
}
function ThreadRowActions({ thread, onChanged, onMoved }) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [moving, setMoving] = useState(false);
    const [projects, setProjects] = useState([]);
    const run = async (fn, ok) => {
        setBusy(true);
        try {
            await fn();
            if (ok)
                toast.success(ok);
            onChanged();
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
            setOpen(false);
        }
    };
    return (_jsxs("div", { className: "relative", children: [_jsx("button", { type: "button", "aria-label": "Conversation actions", disabled: busy, onClick: () => setOpen((v) => !v), className: "rounded px-2 py-1 text-[var(--faint)] hover:bg-[var(--surface)] hover:text-[var(--text)]", children: "\u22EF" }), open ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-20", onClick: () => { setOpen(false); setMoving(false); } }), _jsxs("div", { className: "absolute right-0 top-full z-30 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 text-step--1 shadow-lg", children: [_jsx("button", { className: "w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: () => void run(async () => { const t = window.prompt("Rename conversation", thread.title || ""); if (t == null)
                                    return; await api.renameThread(thread.id, t.trim() || "Untitled"); }, "Renamed"), children: "Rename" }), _jsx("button", { className: "w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: () => void run(() => api.pinThread(thread.id, !thread.pinned).then(() => undefined), thread.pinned ? "Unpinned" : "Pinned"), children: thread.pinned ? "Unpin" : "Pin" }), _jsx("button", { className: "w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: () => void run(async () => { if (thread.archived)
                                    await api.unarchiveThread(thread.id);
                                else
                                    await api.archiveThread(thread.id); }, thread.archived ? "Unarchived" : "Archived"), children: thread.archived ? "Unarchive" : "Archive" }), _jsx("a", { className: "block w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", href: api.exportThreadUrl(thread.id, getSession()?.token || ""), target: "_blank", rel: "noreferrer", children: "Export (JSON)" }), _jsx("button", { className: "w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: async () => { setMoving(true); try {
                                    const r = await api.listProjects();
                                    setProjects(r.projects.map((p) => ({ id: p.id, repository: p.repository })));
                                }
                                catch (e) {
                                    notifyError(e);
                                } }, children: "Move to workspace\u2026" }), _jsx("button", { className: "w-full rounded px-2 py-1.5 text-left text-[var(--danger)] hover:bg-[var(--danger-dim)]", onClick: () => void run(async () => { if (!window.confirm("Delete this conversation? (safe delete)"))
                                    return; await api.deleteThread(thread.id); }, "Deleted"), children: "Delete" }), moving ? (_jsxs("div", { className: "mt-1 border-t border-[var(--border-dim)] pt-1", children: [_jsx("div", { className: "px-2 py-1 text-step--2 text-[var(--muted)]", children: "Move to" }), projects.filter((p) => p.id !== thread.project_id).map((p) => (_jsx("button", { className: "w-full truncate rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", onClick: () => void run(async () => { const r = await api.moveThread(thread.id, p.id); if (r.provider_cleared)
                                            toast.message("Moved; model binding cleared."); onMoved?.(p.id); }, "Moved"), children: p.repository || p.id }, p.id))), projects.filter((p) => p.id !== thread.project_id).length === 0 ? _jsx("div", { className: "px-2 py-1 text-[var(--faint)]", children: "No other workspaces" }) : null] })) : null] })] })) : null] }));
}
function CommandCenter({ projectId, recentThreads, providers, summary, onThreadCreated, onOpenThread, refreshProviders, refreshThreads, recentSearch, onRecentSearch, showArchivedRecent, onShowArchivedRecent, }) {
    const usable = usableProviders(providers);
    const hasProvider = usable.length > 0;
    const [draft, setDraft] = useState("");
    /* The owner's explicit choice wins; until they make one, start on the
       project's default model when it has one, otherwise on the first usable
       model anywhere so Home is never disabled above a working machine. A
       real model beats a demo one when both exist: defaulting to canned
       replies while a working model is connected is what let Home print
       "Everything is connected" above "Demo mode" at the same time. The
       chosen model decides which project the thread belongs to. */
    const [explicitProviderId, setExplicitProviderId] = useState(null);
    const homeHasProvider = providers.some((provider) => provider.project_id === projectId);
    const realFirst = usable.filter((provider) => provider.kind !== "mock");
    const selectedProviderId = explicitProviderId ??
        (homeHasProvider
            ? "__default__"
            : (realFirst[0]?.id ?? usable[0]?.id ?? "__default__"));
    // A mock provider answers with canned text and executes nothing. The reply
    // says so, and this says so too, so the interface can label it instead of
    // passing it off as work.
    const isMockModel = providers.some((p) => p.kind === "mock" && (p.id === selectedProviderId || selectedProviderId === "__default__"));
    /* Discovery data for the getting-started path: what workspaces exist,
     * which bots are available, and which models are connected. */
    const workspacesLoader = useAsync(() => api.listProjects(), []);
    const botsLoader = useAsync(() => api.listAllTeammates(), []);
    const workspaces = workspacesLoader.data?.projects ?? [];
    void workspacesLoader.data?.counts;
    const bots = botsLoader.data?.teammates ?? [];
    const providersByProjectLoader = useAsync(async () => {
        const result = {};
        for (const project of workspaces) {
            try {
                const res = await api.listProviders(project.id);
                result[project.id] = res.providers;
            }
            catch {
                result[project.id] = [];
            }
        }
        return result;
    }, [workspaces]);
    void providersByProjectLoader.data;
    const [busy, setBusy] = useState(false);
    const [streaming, setStreaming] = useState("");
    const [planDraft, setPlanDraft] = useState(null);
    const [planObjective, setPlanObjective] = useState("");
    const [researchJobIds, setResearchJobIds] = useState([]);
    const abortRef = useRef(null);
    const scrollRef = useRef(null);
    const [showConfigure, setShowConfigure] = useState(false);
    const [provName, setProvName] = useState("");
    const [provBaseUrl, setProvBaseUrl] = useState("");
    const [provModel, setProvModel] = useState("");
    const [provApiKey, setProvApiKey] = useState("");
    const [provBusy, setProvBusy] = useState(false);
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [streaming]);
    const send = async (e) => {
        e.preventDefault();
        const content = draft.trim();
        if (!content || busy)
            return;
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setStreaming("");
        let stopped = false;
        try {
            const selected = providers.find((provider) => provider.id === selectedProviderId);
            const targetProjectId = selected?.project_id ?? projectId;
            const thread = await api.createThread(targetProjectId, {
                title: content.slice(0, 60),
                provider_id: selected?.id,
            });
            try {
                await api.sendChatStream(thread.id, content, (chunk) => {
                    setStreaming((prev) => prev + chunk);
                }, undefined, undefined, "chat", { signal: controller.signal });
            }
            catch (err) {
                if (err instanceof ApiError && err.detail === "Stream stopped") {
                    stopped = true;
                    setStreaming((prev) => (prev ? `${prev}\n[stopped]` : ""));
                }
                else {
                    throw err;
                }
            }
            setDraft("");
            refreshThreads?.();
            onThreadCreated(thread.id, targetProjectId);
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            abortRef.current = null;
            setBusy(false);
            if (!stopped)
                setStreaming("");
        }
    };
    const stop = () => {
        abortRef.current?.abort();
    };
    const startDeepResearch = async () => {
        const query = draft.trim();
        if (!query) {
            toast.error("Enter a research question first.");
            return;
        }
        setBusy(true);
        try {
            const res = await api.createProjectResearchJob(projectId, { query });
            const job = res.job;
            if (job?.id) {
                setResearchJobIds((prev) => [job.id, ...prev.filter((id) => id !== job.id)].slice(0, 6));
                setDraft("");
                toast.success("Deep research started in the background.");
            }
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    // The resume list spans every project the owner owns, so a conversation
    // started elsewhere is still one click away from here. Backend orders by
    // pinned then recency; preserve that order.
    const sorted = recentThreads;
    const projectLabel = (id) => {
        const bundle = summary.data?.summary.bundles.find((b) => b.project.id === id);
        if (id === projectId)
            return "Home";
        return bundle?.project.repository || "workspace";
    };
    return (_jsx("div", { ref: scrollRef, className: "min-h-0 flex-1 overflow-y-auto", children: _jsxs("div", { className: "mx-auto flex w-full max-w-[860px] flex-col gap-6 px-4 py-8 md:px-6", children: [_jsxs("div", { className: "space-y-2", children: [_jsx("h1", { className: "text-step-3 font-semibold tracking-tight text-[var(--text)]", children: "Chat with your AI team" }), _jsx("p", { className: "max-w-2xl text-step-0 text-[var(--text-soft)]", children: "Start a conversation, ask for research, or plan work with your teammates. NerdBot shows what is running, what needs your approval, and what finished." })] }), (summary.summary.bots.length > 0 || bots.length > 0) ? (_jsxs("section", { "aria-label": "Your team", className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsxs("div", { className: "mb-2 flex items-center justify-between gap-2", children: [_jsx(SectionLabel, { children: "Your team" }), _jsx(Button, { variant: "ghost", onClick: () => navigate("/bots"), children: "View all" })] }), _jsx("div", { className: "flex flex-wrap gap-2", children: (summary.summary.bots.length > 0 ? summary.summary.bots : bots).slice(0, 8).map((bot) => {
                                const handle = mentionHandle(bot);
                                return (_jsxs("div", { className: "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] pr-1", children: [_jsxs("button", { type: "button", className: "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-step--1 text-[var(--text)] hover:bg-[var(--surface-3)]", onClick: () => navigate(`/bot/${bot.id}`), title: "Open teammate", children: [_jsx(BotFace, { face: bot.face, size: 18, status: bot.status }), _jsx("span", { className: "max-w-[10rem] truncate", children: bot.persona || bot.name || "Teammate" }), _jsx(StatusDot, { status: bot.status })] }), handle ? (_jsx("button", { type: "button", className: "rounded-full px-1.5 py-0.5 text-step--2 text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]", onClick: () => setDraft((d) => insertMention(d, handle)), title: `Mention @${handle}`, "aria-label": `Mention @${handle}`, children: "@" })) : null] }, bot.id));
                            }) })] })) : null, _jsxs("section", { "aria-label": "What you can do now", className: "flex flex-wrap gap-2", children: [_jsx("span", { className: "inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-step--2 text-[var(--text-soft)]", children: "Chat" }), _jsx("span", { className: "inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-step--2 text-[var(--text-soft)]", title: "Available in conversation mode when tools are enabled", children: "Research (web search)" }), _jsx("span", { className: "inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-step--2 text-[var(--text-soft)]", title: "Available in conversation mode", children: "Delegate work" }), _jsx("span", { className: "inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-step--2 text-[var(--text-soft)]", children: "Plan & run tasks" })] }), planDraft?.plan?.tasks ? (_jsxs("section", { className: "rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between", children: [_jsx("h3", { className: "text-step-1 font-semibold", children: "Plan preview" }), _jsx(Button, { variant: "ghost", onClick: () => { setPlanDraft(null); setPlanObjective(""); }, children: "Cancel" })] }), _jsx("p", { className: "mb-3 text-step--1 text-[var(--muted)]", children: planObjective }), _jsx("div", { className: "space-y-3", children: (planDraft.plan?.tasks ?? []).map((task, idx) => (_jsxs("div", { className: "rounded-lg border border-[var(--border-dim)] p-3", children: [_jsx("input", { className: "mb-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-step--1", value: task.description, onChange: (e) => {
                                            const next = { ...planDraft };
                                            if (next.plan?.tasks?.[idx])
                                                next.plan.tasks[idx] = { ...next.plan.tasks[idx], description: e.target.value };
                                            setPlanDraft(next);
                                        } }), _jsx("input", { className: "w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-step--2", value: task.command || "", placeholder: "command (optional)", onChange: (e) => {
                                            const next = { ...planDraft };
                                            if (next.plan?.tasks?.[idx])
                                                next.plan.tasks[idx] = { ...next.plan.tasks[idx], command: e.target.value };
                                            setPlanDraft(next);
                                        } })] }, idx))) }), _jsx("div", { className: "mt-4 flex justify-end", children: _jsx(Button, { variant: "primary", disabled: busy, onClick: async () => {
                                    setBusy(true);
                                    try {
                                        const result = await api.createObjective(projectId, {
                                            objective: planObjective,
                                            plan: planDraft.plan,
                                            create_board: true,
                                        });
                                        toast.success("Plan executed");
                                        setPlanDraft(null);
                                        setPlanObjective("");
                                        const boardId = result?.board?.id;
                                        if (boardId)
                                            navigate(`/p/${projectId}?tab=tasks`);
                                    }
                                    catch (err) {
                                        notifyError(err);
                                    }
                                    finally {
                                        setBusy(false);
                                    }
                                }, children: "Execute plan" }) })] })) : null, _jsxs("div", { className: "scroll-mt-6", children: [_jsxs("form", { onSubmit: send, children: [_jsxs("div", { className: "flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-sm focus-within:border-[var(--border-focus)] sm:flex-row sm:items-end", children: [_jsx("textarea", { value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => {
                                                if (e.key === "Enter" && !e.shiftKey) {
                                                    e.preventDefault();
                                                    void send(e);
                                                }
                                            }, placeholder: hasProvider
                                                ? "Message your team, ask for research, or describe work to plan…"
                                                : "Connect a model to start chatting.", disabled: busy || !hasProvider, spellCheck: true, rows: 3, "aria-label": "Start a conversation", className: "max-h-48 min-h-[64px] w-full min-w-0 resize-none bg-transparent p-2.5 leading-relaxed outline-none placeholder:text-[var(--faint)] disabled:opacity-50 sm:w-auto sm:flex-1" }), _jsxs("div", { className: "flex items-center gap-2 justify-end", children: [_jsx(ModelChip, { providers: providers, value: selectedProviderId, onChange: setExplicitProviderId, disabled: busy || !hasProvider }), busy ? (_jsx(Button, { variant: "danger", type: "button", onClick: stop, disabled: !streaming, children: "\u25A0 Stop" })) : (_jsxs(_Fragment, { children: [_jsx(Button, { type: "button", disabled: busy || !draft.trim(), onClick: () => void startDeepResearch(), title: "Run multi-source deep research in the background with citations", children: "Deep research" }), _jsx(Button, { type: "button", disabled: busy || !draft.trim() || !hasProvider, onClick: async () => {
                                                                const content = draft.trim();
                                                                if (!content)
                                                                    return;
                                                                setBusy(true);
                                                                try {
                                                                    const result = await api.createObjective(projectId, { objective: content, preview: true });
                                                                    setPlanObjective(content);
                                                                    setPlanDraft(result);
                                                                    setDraft("");
                                                                }
                                                                catch (err) {
                                                                    notifyError(err);
                                                                }
                                                                finally {
                                                                    setBusy(false);
                                                                }
                                                            }, title: "Create a plan preview from your message", children: "Plan & execute" }), _jsx(Button, { variant: "primary", type: "submit", disabled: busy || !draft.trim() || !hasProvider, children: "Send \u23CE" })] }))] })] }), streaming && (_jsxs("div", { className: "mt-2 max-h-60 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 text-[var(--text-soft)]", children: [_jsx(Markdown, { text: streaming }), _jsx("span", { className: "ml-0.5 inline-block h-4 w-2 animate-pulse rounded-[1px] bg-[var(--accent)] align-middle", "aria-hidden": true })] })), researchJobIds.length > 0 ? (_jsx("div", { className: "mt-3 flex flex-col gap-3", children: researchJobIds.map((id) => (_jsx(ResearchJobCard, { jobId: id, projectId: projectId, onClose: () => setResearchJobIds((prev) => prev.filter((x) => x !== id)) }, id))) })) : null] }), !hasProvider ? (_jsxs("div", { className: "mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-step--1", children: [_jsx("p", { className: "font-medium text-[var(--text)]", children: "Connect a model to start" }), _jsx("p", { className: "mt-1 text-[var(--muted)]", children: "NerdBot needs a model connection to chat, research, or run work. Your data stays in your workspaces." }), _jsxs("div", { className: "mt-2 flex flex-wrap gap-2", children: [_jsx(Button, { variant: "primary", type: "button", onClick: () => setShowConfigure((v) => !v), children: "Connect a model" }), _jsx(Button, { type: "button", onClick: () => navigate("/settings"), children: "Open settings" })] })] })) : hasProvider && isMockModel ? (_jsxs("div", { className: "mt-3 rounded-lg border border-[var(--info)] bg-[var(--info-dim)] px-4 py-3", role: "status", children: [_jsx("p", { className: "text-step--1 font-medium text-[var(--text)]", children: "Demo mode" }), _jsx("p", { className: "mt-1 text-step--1 text-[var(--text-soft)]", children: "Replies are simulated and no real work runs. Connect a model to use your team for real tasks." }), _jsx("button", { type: "button", onClick: () => setShowConfigure((v) => !v), className: "mt-2 text-step--1 font-medium text-[var(--text)] underline underline-offset-4", children: "Connect a real model" })] })) : (_jsx("p", { className: "mt-2 text-step--2 text-[var(--faint)]", children: "New messages start in chat. Inside a conversation you can switch to Research (web search) or Delegate work when available." })), showConfigure && (_jsxs("div", { className: "mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4", children: [_jsx(SectionLabel, { className: "mb-3", children: "Configure model connection" }), _jsxs("form", { onSubmit: async (e) => {
                                        e.preventDefault();
                                        setProvBusy(true);
                                        try {
                                            await api.createProvider(projectId, {
                                                kind: "openai-compatible",
                                                name: provName.trim() || "model",
                                                config: {
                                                    base_url: provBaseUrl.trim(),
                                                    model: provModel.trim() || undefined,
                                                    ...(provApiKey.trim() ? { api_key: provApiKey.trim() } : {}),
                                                },
                                            });
                                            setShowConfigure(false);
                                            setProvName("");
                                            setProvBaseUrl("");
                                            setProvModel("");
                                            setProvApiKey("");
                                            refreshProviders?.();
                                        }
                                        catch (err) {
                                            notifyError(err);
                                        }
                                        finally {
                                            setProvBusy(false);
                                        }
                                    }, className: "flex flex-wrap items-end gap-3", children: [_jsx("input", { value: provName, onChange: (e) => setProvName(e.target.value), placeholder: "Name (e.g. groq)", "aria-label": "Provider name", className: "w-40 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" }), _jsx("input", { value: provBaseUrl, onChange: (e) => setProvBaseUrl(e.target.value), placeholder: "Base URL (e.g. https://api.groq.com/openai/v1)", "aria-label": "Base URL", required: true, className: "mono min-w-64 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" }), _jsx("input", { value: provModel, onChange: (e) => setProvModel(e.target.value), placeholder: "Model (optional)", "aria-label": "Model", className: "w-44 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" }), _jsx("input", { type: "password", value: provApiKey, onChange: (e) => setProvApiKey(e.target.value), placeholder: "API key", "aria-label": "API key", autoComplete: "off", className: "w-48 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" }), _jsx(Button, { variant: "primary", type: "submit", disabled: provBusy || !provBaseUrl.trim(), children: provBusy ? "Connecting…" : "Connect" }), _jsx(Button, { type: "button", onClick: () => setShowConfigure(false), children: "Cancel" })] }), _jsx("p", { className: "mt-2 text-step--2 text-[var(--faint)]", children: "Keys are stored encrypted at rest when the server has NERDBOT_SECRET_KEY set." })] }))] }), _jsxs("section", { children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-center justify-between gap-3", children: [_jsxs("div", { className: "flex flex-wrap items-baseline gap-2", children: [_jsx(SectionLabel, { children: "Conversations" }), _jsx("span", { className: "text-step--2 text-[var(--faint)]", children: "Home + all workspaces" })] }), _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("input", { value: recentSearch ?? "", onChange: (e) => onRecentSearch?.(e.target.value), placeholder: "Search conversations", "aria-label": "Search recent conversations", className: "h-8 w-44 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 text-step--1 outline-none focus:border-[var(--border-focus)]" }), _jsxs("label", { className: "flex items-center gap-1.5 text-step--2 text-[var(--muted)]", children: [_jsx("input", { type: "checkbox", checked: !!showArchivedRecent, onChange: (e) => onShowArchivedRecent?.(e.target.checked) }), "Archived"] }), refreshThreads ? _jsx(Button, { variant: "ghost", onClick: () => void refreshThreads(), children: "Refresh" }) : null] })] }), sorted.length === 0 ? (_jsx("p", { className: "rounded-xl border border-dashed border-[var(--border-dim)] px-4 py-6 text-center text-step--1 text-[var(--faint)]", children: recentSearch || showArchivedRecent ? "No conversations match." : "No recent conversations yet. Start one above." })) : (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: sorted.slice(0, 20).map((t) => (_jsxs("div", { className: "flex items-center gap-2 border-t border-[var(--border-dim)] first:border-t-0 px-2 py-1 hover:bg-[var(--surface-2)]", children: [_jsx("button", { type: "button", onClick: () => onOpenThread(t), "aria-label": `Resume: ${t.title || "Untitled"}`, className: "flex min-w-0 flex-1 items-center gap-3 px-2 py-1.5 text-left", children: _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-1.5", children: [t.pinned ? _jsx("span", { className: "text-[10px] text-[var(--accent)]", title: "Pinned", children: "\u25CF" }) : null, _jsx("span", { className: "truncate text-step--1 text-[var(--text)]", children: t.title || "Untitled" }), t.archived ? _jsx("span", { className: "rounded bg-[var(--surface-2)] px-1 text-[10px] text-[var(--faint)]", children: "archived" }) : null] }), _jsxs("div", { className: "flex items-center gap-2 text-step--2 text-[var(--faint)]", children: [_jsx("span", { className: `mono rounded px-1 ${t.project_id === projectId ? "bg-[var(--accent-dim,rgba(59,130,246,0.12))] text-[var(--accent)]" : "bg-[var(--surface-2)]"}`, children: projectLabel(t.project_id) }), _jsx("span", { className: "mono", children: relativeTime((t.updated_at || t.created_at) ?? "") })] })] }) }), _jsx("div", { className: "shrink-0 pr-1", children: _jsx(ThreadRowActions, { thread: t, onChanged: () => { refreshThreads?.(); }, onMoved: () => { refreshThreads?.(); } }) })] }, t.id))) }))] })] }) }));
}
