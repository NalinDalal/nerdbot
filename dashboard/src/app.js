import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { ApiError, api, autoConnectDev, describeError as apiDescribeError, getSession, setSession, } from "./api";
import { ConversationView } from "./views-chat";
import { HomeOverviewView } from "./views-home-overview";
import { ApprovalsView } from "./views-approvals";
import { LibraryView, LibraryDocView } from "./views-library";
import { GalleryView } from "./views-gallery";
import { CapabilitiesView } from "./views-projects";
import { ProjectDetailView } from "./views-project";
import { ProjectsView } from "./views-projects";
import { TaskDetailView } from "./views-task";
import { SettingsView } from "./views-settings";
import { TeamsView, TeamDetailView } from "./views-teams";
import { BotDetailView, BotsView } from "./views-bot";
import { BoardsView, BoardDetailView } from "./views-boards";
import { WorkView } from "./views-work";
import { WorkbenchView } from "./views-workbench";
import { EmptyState, useTheme, ThemeButton } from "./components";
import { onRouteChange, navigate } from "./router";
export function parseRoute() {
    /* A query carries the tab to open, so a recovery link can land on the
    exact screen the owner needs: /p/<id>?tab=Providers */
    const params = new URLSearchParams(window.location.search);
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length === 0)
        return { name: "chat" };
    if (parts[0] === "overview" || parts[0] === "home")
        return { name: "overview" };
    if (parts[0] === "work") {
        // Compatibility redirect: /work -> /activity (Phase 1).
        if (typeof window !== "undefined") {
            window.history.replaceState(null, "", "/activity" + window.location.search + window.location.hash);
        }
        return { name: "activity" };
    }
    if (parts[0] === "activity")
        return { name: "activity" };
    if (parts[0] === "workbench") {
        return {
            name: "workbench",
            projectId: parts[1] ?? params.get("project") ?? undefined,
        };
    }
    if (parts[0] === "chat") {
        return parts[1]
            ? {
                name: "chat",
                projectId: parts[1],
                threadId: params.get("thread") ?? undefined,
            }
            : { name: "chat" };
    }
    if (parts[0] === "teams")
        return { name: "teams" };
    if (parts[0] === "team" && parts[1])
        return { name: "team", teamId: parts[1] };
    if (parts[0] === "bot" && parts[1])
        return { name: "bot", teammateId: parts[1] };
    if (parts[0] === "boards")
        return { name: "boards" };
    if (parts[0] === "board" && parts[1])
        return { name: "board", boardId: parts[1] };
    if (parts[0] === "projects")
        return { name: "projects" };
    if (parts[0] === "settings")
        return { name: "settings" };
    if (parts[0] === "p" && parts[1] && parts[2] === "t" && parts[3]) {
        return { name: "task", projectId: parts[1], taskId: parts[3] };
    }
    if (parts[0] === "p" && parts[1]) {
        return {
            name: "project",
            projectId: parts[1],
            tab: params.get("tab") ?? undefined,
        };
    }
    if (parts[0] === "capabilities")
        return { name: "capabilities" };
    if (parts[0] === "bots")
        return { name: "bots" };
    if (parts[0] === "library") {
        return parts[1] ? { name: "libraryDoc", docId: parts[1] } : { name: "library" };
    }
    if (parts[0] === "gallery")
        return { name: "gallery" };
    if (parts[0] === "approvals")
        return { name: "approvals" };
    return { name: "chat" };
}
export { navigate } from "./router";
/* --- Sidebar --- */
/** Small line icons keep the rail scannable without adding a dependency.
 *  They are ornamental: every item keeps its visible label. */
const NAV_ICONS = {
    home: "M2.5 7 8 2.5 13.5 7v6.5h-4v-4h-3v4h-4z",
    work: "M2.5 3.5h11v9h-11zM5.5 3.5V2h5v1.5M2.5 7h11",
    teammates: "M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.5 13c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5M10.5 3.4a2 2 0 0 1 0 3.8M11.5 9.7c1.8.3 3 1.4 3 3.3",
    projects: "M2.5 4.5h4l1.2 1.5h5.8v7.5h-11zM2.5 4.5V3h4",
    approvals: "M8 1.8 13 4v4.2c0 3-2.1 5.2-5 6-2.9-.8-5-3-5-6V4zM5.6 7.8 7.3 9.5l3.2-3.4",
    workbench: "M2.5 3.5h11v9h-11zM5.5 6l1.8 1.8-1.8 1.8M8.5 9.5h3",
    teams: "M5.5 13.5V9.5h5v4M2 13.5V7l6-3 6 3v6.5M6.5 7h3",
    boards: "M2.5 3.5h11v9h-11zM5.5 3.5v9M10.5 3.5v9",
    library: "M2.5 3.5h3v9h-3zM6.5 3.5h3v9h-3zM10.9 4.1l2.6.7-2.3 8.3-2.6-.7z",
    gallery: "M3 3h10v10H3zM5 10l2-2 2 2 2-3 2 3M5.5 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    settings: "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8ZM8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1",
};
function NavIcon({ name }) {
    return (_jsx("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "h-3.5 w-3.5 shrink-0", children: _jsx("path", { d: NAV_ICONS[name] ?? NAV_ICONS.home }) }));
}
function NavItem({ label, icon, active, badge, onClick, }) {
    return (_jsxs("button", { onClick: onClick, "aria-current": active ? "page" : undefined, className: `relative flex w-full items-center gap-2.5 rounded-md py-1.5 pl-3 pr-2.5 text-left text-step--1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset ${active
            ? "bg-[var(--surface-2)] text-[var(--text)]"
            : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"}`, children: [_jsx("span", { "aria-hidden": true, className: `absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full ${active ? "bg-[var(--accent)]" : "bg-transparent"}` }), _jsx(NavIcon, { name: icon }), _jsx("span", { className: "min-w-0 flex-1 truncate", children: label }), badge && badge > 0 ? (_jsx("span", { className: "inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-[var(--warn-dim)] px-1.5 py-px text-step--2 font-medium tabular-nums text-[var(--warn)]", "aria-label": `${badge} waiting`, children: badge })) : null] }));
}
const EMPTY_NAV = { threads: [], projects: [], pendingApprovals: 0 };
/** The rail's live data: recent conversations and the number of decisions
 *  waiting. It refreshes whenever the route changes, so paging back from a
 *  decision never shows a stale badge. */
function useNavData(route) {
    const [data, setData] = useState(EMPTY_NAV);
    const routeKey = Object.values(route).join(":");
    useEffect(() => {
        let live = true;
        Promise.all([
            api.listRecentThreads(6).catch(() => ({ threads: [] })),
            api.listProjects().catch(() => ({ projects: [] })),
            api.approvalsInbox("pending").catch(() => ({ approvals: [] })),
        ]).then(([threads, projects, inbox]) => {
            if (!live)
                return;
            setData({
                threads: (threads.threads ?? []).filter((thread) => thread.title?.trim()),
                projects: projects.projects ?? [],
                pendingApprovals: (inbox.approvals ?? []).length,
            });
        });
        return () => {
            live = false;
        };
    }, [routeKey]);
    return data;
}
function Sidebar({ route, drawerOpen, onNavigate, onDisconnect, onThemeChange, onClose, }) {
    const nav = useNavData(route);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const projectName = (id) => nav.projects.find((project) => project.id === id)?.repository || "Project";
    const primary = [
        { label: "Home", icon: "home", routes: ["home"], href: "/" },
        {
            label: "Workspaces",
            icon: "projects",
            routes: ["projects", "project"],
            href: "/projects",
        },
        {
            label: "Agents",
            icon: "teammates",
            routes: ["bots", "bot", "teams", "team"],
            href: "/bots",
        },
        {
            label: "Work",
            icon: "work",
            routes: ["activity", "work", "task", "approvals", "boards", "board"],
            href: "/activity",
            badge: nav.pendingApprovals,
        },
        { label: "Chat", icon: "home", routes: ["chat"], href: "/chat" },
        {
            label: "Library",
            icon: "library",
            routes: ["library", "libraryDoc", "gallery"],
            href: "/library",
        },
        {
            label: "Settings",
            icon: "settings",
            routes: ["settings", "capabilities"],
            href: "/settings",
        },
    ];
    return (_jsx("aside", { className: `fixed inset-y-0 left-0 z-50 flex w-[var(--width-sidebar)] shrink-0 flex-col overflow-hidden border-r border-[var(--border-dim)] bg-[var(--bg)] transition-transform duration-200 ease-out md:static md:translate-x-0 ${drawerOpen ? "translate-x-0" : "-translate-x-full"}`, children: _jsxs("div", { className: "flex h-full flex-col overflow-y-auto px-3 py-4", children: [_jsxs("div", { className: "mb-4 flex items-center justify-between px-2", children: [_jsx("strong", { className: "font-semibold tracking-tight text-step-1 text-[var(--text)]", children: "NerdBot" }), _jsx("button", { className: "rounded-sm p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] md:hidden", onClick: onClose, "aria-label": "Close navigation", children: "\u00D7" })] }), _jsxs("button", { onClick: () => onNavigate("/chat"), className: "mb-4 flex w-full items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 font-medium text-[var(--text-soft)] transition-colors hover:border-[var(--faint)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset", children: [_jsx("span", { "aria-hidden": true, className: "text-[var(--accent)]", children: "+" }), "New chat"] }), _jsx("nav", { "aria-label": "Main", className: "flex flex-col gap-0.5", children: primary.map((item) => (_jsx(NavItem, { label: item.label, icon: item.icon, active: item.routes.includes(route.name), badge: item.badge, onClick: () => onNavigate(item.href) }, item.label))) }), _jsxs("div", { className: "mt-2", children: [_jsxs("button", { type: "button", "aria-expanded": advancedOpen, onClick: () => setAdvancedOpen((v) => !v), className: "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)] transition-colors hover:text-[var(--text-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset", children: [_jsx("span", { "aria-hidden": true, children: advancedOpen ? "▾" : "▸" }), "Advanced"] }), advancedOpen ? (_jsxs("div", { className: "mt-0.5 flex flex-col gap-0.5", children: [_jsx(NavItem, { label: "Teams & groups", icon: "teams", active: route.name === "teams" || route.name === "team", onClick: () => onNavigate("/teams") }), _jsx(NavItem, { label: "Boards", icon: "boards", active: route.name === "boards" || route.name === "board", onClick: () => onNavigate("/boards") }), _jsx(NavItem, { label: "Gallery", icon: "gallery", active: route.name === "gallery", onClick: () => onNavigate("/gallery") }), _jsx(NavItem, { label: "Workbench", icon: "workbench", active: route.name === "workbench", onClick: () => onNavigate("/workbench") }), _jsx(NavItem, { label: "Approvals inbox", icon: "approvals", active: route.name === "approvals", onClick: () => onNavigate("/approvals") }), _jsx(NavItem, { label: "Capabilities", icon: "settings", active: route.name === "capabilities", onClick: () => onNavigate("/capabilities") })] })) : null] }), nav.threads.length > 0 ? (_jsxs("section", { className: "mt-5", "aria-label": "Recent conversations", children: [_jsxs("div", { className: "mb-1 flex items-center justify-between px-3", children: [_jsx("span", { className: "text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]", children: "Recent" }), _jsx("button", { onClick: () => onNavigate("/"), className: "text-step--2 text-[var(--faint)] hover:text-[var(--text)]", children: "All" })] }), _jsx("div", { className: "flex flex-col", children: nav.threads.map((thread) => {
                                const active = route.name === "chat" && route.threadId === thread.id;
                                return (_jsxs("button", { onClick: () => onNavigate(`/chat/${thread.project_id}?thread=${thread.id}`), "aria-current": active ? "page" : undefined, className: `flex flex-col rounded-md px-3 py-1.5 text-left transition-colors ${active
                                        ? "bg-[var(--surface-3)] text-[var(--text)]"
                                        : "text-[var(--text-soft)] hover:bg-[var(--surface-2)]"}`, children: [_jsx("span", { className: "truncate text-step--1", children: thread.title || "Untitled conversation" }), _jsx("span", { className: "truncate text-step--2 text-[var(--faint)]", children: projectName(thread.project_id) })] }, thread.id));
                            }) })] })) : null, _jsxs("div", { className: "mt-auto flex flex-col gap-1 border-t border-[var(--border-dim)] pt-3", children: [_jsx("button", { onClick: onDisconnect, className: "flex w-full items-center rounded-md px-3 py-1.5 text-left text-[var(--muted)] text-step--1 transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]", children: "Disconnect" }), _jsxs("div", { className: "flex items-center gap-2 px-3 py-1.5", children: [_jsx("span", { className: "text-[var(--faint)] text-step--2", children: "Theme" }), _jsx(ThemeButton, { onThemeChange: onThemeChange })] })] })] }) }));
}
export default function App() {
    const [route, setRoute] = useState(parseRoute);
    const [connected, setConnected] = useState(() => getSession() !== null);
    // Without a stored session there may still be one to obtain silently:
    // a dev-token server publishes it in /health, so probe once before
    // showing the Connect form.
    const [probing, setProbing] = useState(() => getSession() === null);
    const [activeThreadId, setActiveThread] = useState(null);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const { setTheme } = useTheme();
    useEffect(() => {
        if (!probing)
            return;
        let alive = true;
        autoConnectDev(defaultApiBase()).then((ok) => {
            if (!alive)
                return;
            if (ok)
                setConnected(true);
            setProbing(false);
        });
        return () => {
            alive = false;
        };
    }, [probing]);
    useEffect(() => {
        const remove = onRouteChange(() => setRoute(parseRoute()));
        const mq = window.matchMedia("(max-width: 760px)");
        const onBreakpoint = () => setDrawerOpen(false);
        mq.addEventListener("change", onBreakpoint);
        return () => {
            remove();
            mq.removeEventListener("change", onBreakpoint);
        };
    }, []);
    const openProject = (id) => {
        navigate(`/p/${id}`);
    };
    if (!connected) {
        if (probing) {
            return (_jsxs("div", { className: "flex h-full flex-col items-center justify-center bg-[var(--bg)] text-[var(--muted)] text-[var(--text)]", children: [_jsxs("p", { className: "text-step-0", children: ["Connecting to ", defaultApiBase(), "."] }), _jsx(Toaster, { position: "bottom-right", richColors: true, closeButton: true })] }));
        }
        return _jsx(ConnectScreen, { onConnected: () => setConnected(true) });
    }
    /* Route → view. Home is the operating overview; Chat is the
     * conversational surface. All other routes render full-page views. */
    let content;
    switch (route.name) {
        case "home":
            content = _jsx(HomeOverviewView, {});
            break;
        case "chat":
            content = (_jsx(ConversationView, { projectId: route.projectId, initialThreadId: route.threadId ?? (route.projectId ? activeThreadId : undefined), onSetActiveThread: setActiveThread }, `${route.projectId ?? "global"}:${route.threadId ?? "none"}`));
            break;
        case "work":
        case "activity":
            content = _jsx(WorkView, {});
            break;
        case "workbench":
            content = (_jsx(WorkbenchView, { initialProjectId: route.name === "workbench" ? route.projectId : undefined }));
            break;
        case "teams":
            content = _jsx(TeamsView, {});
            break;
        case "team":
            content = (_jsx(TeamDetailView, { teamId: route.teamId, onOpenProject: openProject }));
            break;
        case "bot":
            content = _jsx(BotDetailView, { teammateId: route.teammateId });
            break;
        case "boards":
            content = _jsx(BoardsView, {});
            break;
        case "board":
            content = _jsx(BoardDetailView, { boardId: route.boardId });
            break;
        case "projects":
            content = _jsx(ProjectsView, { onOpen: openProject });
            break;
        case "settings":
            content = _jsx(SettingsView, {});
            break;
        case "project":
            content = (_jsx(ProjectDetailView, { projectId: route.projectId, initialTab: route.tab, onOpenTask: (taskId) => navigate(`/p/${route.projectId}/t/${taskId}`) }));
            break;
        case "task":
            content = (_jsx(TaskDetailView, { projectId: route.projectId, taskId: route.taskId, onBack: () => navigate(`/p/${route.projectId}`) }));
            break;
        case "capabilities":
            content = _jsx(CapabilitiesView, {});
            break;
        case "bots":
            content = _jsx(BotsView, {});
            break;
        case "approvals":
            content = _jsx(ApprovalsView, {});
            break;
        case "library":
            content = _jsx(LibraryView, {});
            break;
        case "libraryDoc":
            content = _jsx(LibraryDocView, { docId: route.docId });
            break;
        case "gallery":
            content = _jsx(GalleryView, {});
            break;
        default:
            content = (_jsx(EmptyState, { title: "Workspace", hint: "Select a workspace area from the sidebar." }));
    }
    return (_jsxs("div", { className: "flex h-full overflow-hidden bg-[var(--bg)] text-[var(--text)]", children: [drawerOpen ? (_jsx("div", { className: "fixed inset-0 z-40 bg-black/40 md:hidden", onClick: () => setDrawerOpen(false), "aria-hidden": true })) : null, _jsx(Sidebar, { route: route, drawerOpen: drawerOpen, onNavigate: (href) => {
                    setDrawerOpen(false);
                    navigate(href);
                }, onDisconnect: () => {
                    setSession(null);
                    setConnected(false);
                    navigate("/");
                }, onThemeChange: setTheme, onClose: () => setDrawerOpen(false) }), _jsxs("main", { className: "relative flex min-w-0 flex-1 flex-col overflow-hidden pb-14 md:pb-0", children: [_jsx("button", { className: "fixed top-3 left-3 z-40 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] transition-colors hover:border-[var(--faint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] md:hidden", "aria-label": "Open navigation", onClick: () => setDrawerOpen(true), children: "\u2630" }), content, _jsx(Toaster, { position: "bottom-right", richColors: true, closeButton: true })] }), _jsx("nav", { "aria-label": "Primary", className: "fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-[var(--border-dim)] bg-[var(--bg)]/95 backdrop-blur md:hidden", children: [
                    { label: "Home", icon: "home", href: "/", routes: ["home"] },
                    { label: "Workspaces", icon: "projects", href: "/projects", routes: ["projects", "project"] },
                    { label: "Agents", icon: "teammates", href: "/bots", routes: ["bots", "bot", "teams", "team"] },
                    { label: "Work", icon: "work", href: "/activity", routes: ["activity", "work", "task", "approvals", "boards", "board"] },
                    { label: "Chat", icon: "home", href: "/chat", routes: ["chat"] },
                ].map((item) => {
                    const active = item.routes.includes(route.name);
                    return (_jsxs("button", { type: "button", onClick: () => {
                            setDrawerOpen(false);
                            navigate(item.href);
                        }, "aria-current": active ? "page" : undefined, className: `flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-step--2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset ${active ? "text-[var(--accent)]" : "text-[var(--muted)]"}`, children: [_jsx(NavIcon, { name: item.icon }), _jsx("span", { className: "truncate", children: item.label })] }, item.label));
                }) })] }));
}
/** The dashboard is normally served by the API itself (e.g. localhost:8080,
 *  documented in external handoff/backup artifacts). Defaulting the API base to the current origin
 *  keeps that flow same-origin (no CORS involved); only when the page is
 *  served elsewhere (the vite dev server) does the local default remain. */
export function defaultApiBase() {
    const loc = typeof window !== "undefined" ? window.location : null;
    if (loc &&
        (loc.protocol === "http:" || loc.protocol === "https:") &&
        loc.port !== "5173") {
        return loc.origin;
    }
    return "http://127.0.0.1:8080";
}
/** The dev server hands back its well-known token so the owner never has to
 *  retype a value everyone can read in the docs. Any other auth mode says
 *  nothing about its token, so a blank field stays a blank field. */
export function resolveConnectToken(health, typed) {
    if (typed)
        return typed;
    if (typeof health === "object" &&
        health !== null &&
        health.auth === "dev" &&
        typeof health.dev_token === "string" &&
        health.dev_token) {
        return health.dev_token;
    }
    return "";
}
function ConnectScreen({ onConnected }) {
    const [baseUrl, setBaseUrl] = useState(defaultApiBase);
    const [token, setToken] = useState("");
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const connect = async (e) => {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            // Probe first: in dev mode the server hands back the well-known token so
            // the owner never has to type it. The probe is best-effort — a failure
            // here just means the real connect attempt below will surface the error.
            let tokenToUse = token;
            try {
                const health = await api.health();
                tokenToUse = resolveConnectToken(health, tokenToUse);
            }
            catch {
                // fall through
            }
            setSession({ baseUrl: baseUrl.replace(/\/+$/, ""), token: tokenToUse });
            const health = await api.health();
            if (health.status !== "ok")
                throw new Error("Server reported unhealthy status");
            onConnected();
        }
        catch (err) {
            setSession(null);
            setError(err instanceof ApiError
                ? `Error ${err.status}: ${err.detail}`
                : String(err));
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { className: "flex h-full bg-[var(--bg)] text-[var(--text)]", children: [_jsx("main", { className: "flex h-full flex-1 flex-col items-center justify-center px-6", children: _jsxs("div", { className: "w-full max-w-[460px]", children: [_jsx("h1", { className: "mb-2 font-semibold tracking-tight text-step-4", children: "NerdBot" }), _jsx("p", { className: "mb-6 text-[var(--muted)] text-step-0", children: "Connect to a running NerdBot API server." }), error ? (_jsx("div", { className: "mb-4 rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-4 py-3 text-step-0", role: "alert", children: error })) : null, _jsxs("form", { onSubmit: connect, className: "space-y-4", children: [_jsxs("div", { children: [_jsx("span", { className: "mb-1.5 block font-medium tracking-wide text-[var(--muted)] text-step--1 uppercase", children: "API base URL" }), _jsx("input", { value: baseUrl, onChange: (e) => setBaseUrl(e.target.value), required: true, className: "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 text-[var(--text)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" })] }), _jsxs("div", { children: [_jsxs("span", { className: "mb-1.5 block font-medium tracking-wide text-[var(--muted)] text-step--1 uppercase", children: ["API token", _jsx("span", { className: "ml-1 normal-case text-[var(--faint)]", children: "(optional in dev mode \u2014 the server hands one back)" })] }), _jsx("input", { type: "password", value: token, onChange: (e) => setToken(e.target.value), autoComplete: "off", className: "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 text-[var(--text)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" })] }), _jsx("button", { className: "mt-2 inline-flex w-full items-center justify-center rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-2 font-semibold text-step--1 text-[var(--text-inverse)] transition-colors hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)] disabled:pointer-events-none disabled:opacity-50", type: "submit", disabled: busy, children: busy ? "Connecting…" : "Connect" })] })] }) }), _jsx(Toaster, { position: "bottom-right", richColors: true, closeButton: true })] }));
}
export function describeError(err) {
    return apiDescribeError(err);
}
export function notifyError(err) {
    toast.error(describeError(err));
}
