import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../api";
import { navigate } from "../app";
import { Button, EmptyState, ErrorState, LoadingState, Page, useAsync } from "../components";
import { ConversationView } from "../views-chat";
import { ProjectOperatingOverview } from "./overview";
import { TasksTab } from "./tasks";
import { TeammatesTab } from "./teammates";
import { ProvidersTab } from "./providers";
import { IssuesTab } from "./issues";
import { KnowledgeTab } from "./knowledge";
import { SchedulesTab } from "./schedules";
import { ApprovalsTab } from "./approvals";
import { MessagesTab } from "./messages";
import { NotificationsTab } from "./notifications";
import { MemoryTab } from "./memory";
import { FilesTab } from "./files";
import { BackupTab } from "./backup";
import { MetricsTab } from "./metrics";
import { EventsTab } from "./events";
const PRIMARY_TABS = ["Overview", "Work", "Agents", "Chat", "Knowledge", "Files"];
const PRIMARY_TAB_LABELS = {
    Overview: "Overview",
    Work: "Work",
    Agents: "Agents",
    Chat: "Chat",
    Knowledge: "Library",
    Files: "Files & tools",
};
// Backward-compatible aliases: keep old tab names working for deep links.
const TAB_ALIASES = {
    Tasks: "Work",
    Teammates: "Agents",
    Team: "Agents",
};
const ADVANCED_TABS = [
    "Providers",
    "Issues",
    "Schedules",
    "Approvals",
    "Messages",
    "Notifications",
    "Memory",
    "Backup",
    "Metrics",
    "Events",
    "Boards",
];
const TABS = [...PRIMARY_TABS, ...ADVANCED_TABS];
function resolveTab(value) {
    if (!value)
        return "Overview";
    if (TABS.includes(value))
        return value;
    const aliased = TAB_ALIASES[value];
    if (aliased && TABS.includes(aliased))
        return aliased;
    return "Overview";
}
export function ProjectDetailView({ projectId, initialTab, onOpenTask, }) {
    const projects = useAsync(() => api.listProjects(), []);
    const project = projects.data?.projects.find((item) => item.id === projectId);
    const workspaceName = project?.repository || "Project";
    /* The tab lives in the hash, so a shared link, a refresh, and the browser
       back button all land on the section the owner was looking at. Deriving
       it instead of mirroring it in state means there is one source of truth. */
    const tab = resolveTab(initialTab);
    const selectTab = (name) => {
        setAdvancedOpen(false);
        navigate(`/p/${projectId}?tab=${encodeURIComponent(name)}`);
    };
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const advancedActive = ADVANCED_TABS.includes(tab);
    return (_jsxs(Page, { width: "fill", children: [_jsxs("div", { className: "mb-4 flex flex-wrap items-center justify-between gap-3", children: [_jsxs("a", { href: "/projects", className: "inline-flex items-center gap-1 text-step--1 text-[var(--muted)] transition-colors hover:text-[var(--text)]", children: [_jsx("span", { "aria-hidden": true, children: "\u2190" }), " Workspaces"] }), tab !== "Overview" ? (_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Button, { onClick: () => selectTab("Chat"), children: "Chat" }), _jsx(Button, { variant: "primary", onClick: () => selectTab("Work"), children: "Start work" })] })) : null] }), tab !== "Overview" ? (_jsxs("div", { className: "mb-4 min-w-0", children: [_jsx("div", { className: "mb-1 text-step--2 uppercase tracking-[0.16em] text-[var(--faint)]", children: "Workspace" }), _jsx("h1", { className: "truncate text-step-2 font-semibold tracking-tight text-[var(--text)]", children: workspaceName })] })) : null, _jsxs("div", { role: "tablist", "aria-label": "Workspace sections", className: "mb-6 flex flex-nowrap items-center gap-1 overflow-x-auto rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] p-1 md:flex-wrap md:overflow-visible", children: [PRIMARY_TABS.map((name) => (_jsx("button", { role: "tab", id: `project-tab-${name}`, "aria-controls": "project-tab-panel", "aria-selected": tab === name, onClick: () => selectTab(name), className: `shrink-0 rounded-md px-3 py-1.5 text-step--1 font-medium transition-colors ${tab === name
                            ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                            : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"}`, children: PRIMARY_TAB_LABELS[name] }, name))), _jsxs("div", { className: "relative ml-auto", children: [_jsxs("button", { type: "button", "aria-haspopup": "menu", "aria-expanded": advancedOpen, onClick: () => setAdvancedOpen((v) => !v), className: `shrink-0 rounded-md px-3 py-1.5 text-step--1 font-medium transition-colors ${advancedActive
                                    ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                                    : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"}`, children: ["Advanced ", advancedOpen ? "▴" : "▾"] }), advancedOpen ? (_jsxs(_Fragment, { children: [_jsx("div", { "aria-hidden": true, className: "fixed inset-0 z-20", onClick: () => setAdvancedOpen(false) }), _jsx("div", { role: "menu", className: "absolute right-0 top-full z-30 mt-1 w-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg", children: ADVANCED_TABS.map((name) => (_jsx("button", { type: "button", role: "menuitem", onClick: () => selectTab(name), className: `flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-step--1 transition-colors ${tab === name
                                                ? "bg-[var(--surface-3)] text-[var(--text)]"
                                                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"}`, children: name }, name))) })] })) : null] })] }), _jsxs("div", { role: "tabpanel", id: "project-tab-panel", "aria-labelledby": `project-tab-${tab}`, className: "min-h-0", children: [tab === "Overview" && (_jsx(ProjectOperatingOverview, { projectId: projectId, workspaceName: workspaceName, onOpenTask: onOpenTask, onSelectTab: (t) => selectTab(resolveTab(t)) })), tab === "Chat" && _jsx(ConversationView, { projectId: projectId }), tab === "Work" && _jsx(TasksTab, { projectId: projectId, onOpenTask: onOpenTask }), tab === "Agents" && _jsx(TeammatesTab, { projectId: projectId }), tab === "Providers" && _jsx(ProvidersTab, { projectId: projectId }), tab === "Issues" && _jsx(IssuesTab, { projectId: projectId }), tab === "Knowledge" && _jsx(KnowledgeTab, { projectId: projectId }), tab === "Schedules" && _jsx(SchedulesTab, { projectId: projectId }), tab === "Approvals" && _jsx(ApprovalsTab, { projectId: projectId }), tab === "Messages" && _jsx(MessagesTab, { projectId: projectId }), tab === "Notifications" && _jsx(NotificationsTab, { projectId: projectId }), tab === "Memory" && _jsx(MemoryTab, { projectId: projectId }), tab === "Files" && _jsx(FilesTab, { projectId: projectId }), tab === "Backup" && _jsx(BackupTab, { projectId: projectId }), tab === "Metrics" && _jsx(MetricsTab, { projectId: projectId }), tab === "Events" && _jsx(EventsTab, { projectId: projectId }), tab === "Boards" && _jsx(ProjectBoardsTab, { projectId: projectId })] }), projects.loading ? _jsx(LoadingState, { lines: 1 }) : null] }));
}
/* ProjectOperatingOverview (R3) replaces the previous tabbed-admin overview.
   Legacy capabilities remain available via existing tabs/sections. */
function ProjectBoardsTab({ projectId }) {
    const boards = useAsync(() => api.listBoards(), [projectId]);
    const filtered = (boards.data?.boards ?? []).filter((b) => b.project_id === projectId);
    return (_jsxs("div", { children: [_jsxs("div", { className: "mb-3 flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Boards scoped to this project. Manage all boards from Workspace \u2192 Advanced." }), _jsx(Button, { onClick: () => navigate("/boards"), children: "All boards \u2192" })] }), boards.loading ? (_jsx(LoadingState, {})) : boards.error ? (_jsx(ErrorState, { error: boards.error, onRetry: boards.reload })) : filtered.length > 0 ? (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: filtered.map((board, index) => (_jsxs("div", { className: `flex items-center justify-between gap-3 px-4 py-3 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsxs("div", { className: "min-w-0", children: [_jsx("a", { href: `/board/${board.id}`, className: "font-medium text-[var(--text)] hover:underline", children: board.name || "Unnamed board" }), _jsx("div", { className: "mono text-step--2 text-[var(--faint)]", children: board.id })] }), _jsx(Button, { variant: "ghost", onClick: () => navigate(`/board/${board.id}`), children: "Open \u2192" })] }, board.id))) })) : (_jsx(EmptyState, { title: "No boards for this project", hint: "Create one from the Boards page; it will appear here.", action: _jsx(Button, { variant: "primary", onClick: () => navigate("/boards"), children: "Create board" }) }))] }));
}
