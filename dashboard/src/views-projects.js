import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import { EmptyState, ErrorState, LoadingState, Modal, Button, Page, PageHeader, Badge, useAsync, TABLE_SHELL, TABLE_TD, TABLE_TH } from "./components";
import { EntityForm } from "./forms";
export function ProjectsView({ onOpen }) {
    const list = useAsync(() => api.listProjects(), []);
    const [showCreate, setShowCreate] = useState("");
    const [query, setQuery] = useState("");
    const [showEmpty, setShowEmpty] = useState(false);
    const create = async (values) => {
        const project = await api.createProject(values.repository || "repo");
        setShowCreate("");
        onOpen(project.id);
    };
    const allProjects = list.data?.projects ?? [];
    const counts = list.data?.counts ?? {};
    const needle = query.trim().toLowerCase();
    const filteredByQuery = needle
        ? allProjects.filter((p) => (p.repository || "").toLowerCase().includes(needle))
        : allProjects;
    const projects = showEmpty
        ? filteredByQuery
        : filteredByQuery.filter((p) => {
            const c = counts[p.id];
            if (!c)
                return true;
            return (c.bots || 0) + (c.tasks || 0) + (c.objectives || 0) + (c.approvals || 0) + (c.blocked || 0) > 0;
        });
    return (_jsxs(Page, { children: [_jsx(PageHeader, { eyebrow: "Workspaces", title: "Workspaces", description: "Where your teammates, conversations, tasks, files, and model connections live.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "primary", onClick: () => setShowCreate("create"), children: "New workspace" }), _jsx(Button, { onClick: list.reload, children: "Refresh" })] }) }), _jsxs("div", { className: "mb-3 flex items-center gap-4", children: [_jsx("input", { value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Search workspaces", "aria-label": "Search workspaces", className: "h-9 w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-step--1 outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" }), _jsxs("label", { className: "flex items-center gap-1.5 text-step--2 text-[var(--faint)]", children: [_jsx("input", { type: "checkbox", checked: showEmpty, onChange: (e) => setShowEmpty(e.target.checked), className: "h-3 w-3" }), "Show empty"] })] }), list.loading ? (_jsx(LoadingState, {})) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : projects.length === 0 ? (_jsx(EmptyState, { title: "No workspaces yet", hint: "Create a workspace to organize teammates, tasks, and files.", action: _jsx(Button, { variant: "primary", onClick: () => setShowCreate("create"), children: "New workspace" }) })) : (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full min-w-[720px] table-fixed", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: `${TABLE_TH} w-[24%]`, children: "Project" }), _jsx("th", { className: `${TABLE_TH} w-[5rem]`, children: "Bots" }), _jsx("th", { className: `${TABLE_TH} w-[6rem]`, children: "Tasks" }), _jsx("th", { className: `${TABLE_TH} w-[6rem]`, children: "Objectives" }), _jsx("th", { className: `${TABLE_TH} w-[10rem]`, children: "Needs you" }), _jsx("th", { className: `${TABLE_TH} w-[7rem]`, children: _jsx("span", { className: "sr-only", children: "Open" }) })] }) }), _jsx("tbody", { children: projects.map((project) => {
                                const count = counts[project.id];
                                const needsYou = (count?.approvals ?? 0) + (count?.blocked ?? 0);
                                return (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: TABLE_TD, children: _jsxs("button", { className: "text-left text-[var(--text)] hover:underline", onClick: () => onOpen(project.id), children: [project.repository || "Untitled project", project.repository === "Home" ? _jsx("span", { className: "ml-2 text-step--2 text-[var(--faint)]", children: "(default)" }) : null] }) }), _jsx("td", { className: TABLE_TD, children: count?.bots ?? 0 }), _jsx("td", { className: TABLE_TD, children: count?.tasks ?? 0 }), _jsx("td", { className: TABLE_TD, children: count?.objectives ?? 0 }), _jsx("td", { className: TABLE_TD, children: needsYou ? (_jsxs("span", { className: "text-step--1 text-[var(--warn)]", children: [count?.approvals ? `${count.approvals} approval` : "", count?.approvals && count?.blocked ? " and " : "", count?.blocked ? `${count?.blocked} blocked` : ""] })) : (_jsx("span", { className: "text-[var(--faint)]", children: "nothing" })) }), _jsx("td", { className: `${TABLE_TD} whitespace-nowrap`, children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Button, { variant: "ghost", onClick: () => onOpen(project.id), children: "Open \u2192" }), project.repository !== "Home" ? (_jsx(Button, { variant: "ghost", onClick: async () => {
                                                            if (!confirm(`Delete project ${project.repository || project.id}?`))
                                                                return;
                                                            try {
                                                                await api.deleteProject(project.id);
                                                                list.reload();
                                                            }
                                                            catch (err) {
                                                                notifyError(err);
                                                            }
                                                        }, children: "Delete" })) : null] }) })] }, project.id));
                            }) })] }) })), showCreate ? (_jsx(Modal, { title: "New workspace", onClose: () => setShowCreate(""), children: _jsx(EntityForm, { submitLabel: "Create workspace", fields: [
                        { name: "repository", label: "Name", required: true, placeholder: "demo-repo" },
                        { name: "owner_note", label: "Note (owner is always your token identity)" },
                    ], onSubmit: create }) })) : null] }));
}
export function CapabilitiesView() {
    const caps = useAsync(() => api.capabilities());
    const health = useAsync(() => api.health());
    const refresh = async () => {
        try {
            const h = await api.health();
            if (h.db !== "ok")
                notifyError(new Error("Database reports an error"));
        }
        catch (err) {
            notifyError(err);
        }
        caps.reload();
        health.reload();
    };
    return (_jsxs(Page, { children: [_jsx(PageHeader, { eyebrow: "Server", title: "Capabilities", description: "What this server build can actually do. Stubs stay stubs.", actions: _jsx(Button, { onClick: refresh, children: "Refresh" }) }), health.loading ? (_jsx(LoadingState, { lines: 1 })) : health.error ? (_jsx(ErrorState, { error: health.error, onRetry: health.reload })) : health.data ? (_jsxs("div", { className: "mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3", children: [_jsx(Badge, { variant: health.data.status === "ok" ? "ok" : "bad", children: health.data.status }), _jsxs("span", { className: "mono text-step--1 text-[var(--muted)]", children: ["version ", health.data.version] }), _jsxs("span", { className: "mono text-step--1 text-[var(--muted)]", children: ["db ", health.data.db] }), _jsxs("span", { className: "mono text-step--1 text-[var(--muted)]", children: ["restarts ", health.data.restarts] }), health.data.secret_key ? (_jsxs(Badge, { variant: "info", children: ["secret key ", health.data.secret_key] })) : (_jsx(Badge, { variant: "warn", children: "secret key absent" }))] })) : null, caps.loading ? (_jsx(LoadingState, { lines: 6 })) : caps.error ? (_jsx(ErrorState, { error: caps.error, onRetry: caps.reload })) : caps.data && caps.data.capabilities.length > 0 ? (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: caps.data.capabilities.map((cap, index) => (_jsxs("div", { className: `flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsx("span", { className: "mono w-56 shrink-0 text-step--1 text-[var(--text)]", children: cap.id }), _jsx(Badge, { variant: cap.status === "ready" ? "ok" : cap.status === "stub" ? "warn" : "neutral", children: cap.status }), _jsx("span", { className: "text-step--1 text-[var(--muted)]", children: cap.description })] }, cap.id))) })) : (_jsx(EmptyState, { title: "No capabilities reported", hint: "The server returned an empty list." }))] }));
}
