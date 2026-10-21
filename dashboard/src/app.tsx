import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { ApiError, api, describeError as apiDescribeError, getSession, setSession } from "./api";
import { ConversationView } from "./views-chat";
import { CapabilitiesView } from "./views-projects";
import { ProjectDetailView } from "./views-project";
import { ProjectsView } from "./views-projects";
import { TaskDetailView } from "./views-task";
import { SettingsView } from "./views-settings";
import { TeamsView, TeamDetailView } from "./views-teams";
import { BotDetailView, BotsView } from "./views-bot";
import { BoardsView, BoardDetailView } from "./views-boards";
import {
  EmptyState,
} from "./components";

export type Route =
  | { name: "home" }
  | { name: "chat"; projectId?: string }
  | { name: "teams" }
  | { name: "team"; teamId: string }
  | { name: "bot"; teammateId: string }
  | { name: "boards" }
  | { name: "board"; boardId: string }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "project"; projectId: string }
  | { name: "task"; projectId: string; taskId: string }
  | { name: "capabilities" }
  | { name: "bots" };

export function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "chat") {
    return parts[1] ? { name: "chat", projectId: parts[1] } : { name: "chat" };
  }
  if (parts[0] === "teams") return { name: "teams" };
  if (parts[0] === "team" && parts[1]) return { name: "team", teamId: parts[1] };
  if (parts[0] === "bot" && parts[1]) return { name: "bot", teammateId: parts[1] };
  if (parts[0] === "boards") return { name: "boards" };
  if (parts[0] === "board" && parts[1]) return { name: "board", boardId: parts[1] };
  if (parts[0] === "projects") return { name: "projects" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "p" && parts[1] && parts[2] === "t" && parts[3]) {
    return { name: "task", projectId: parts[1], taskId: parts[3] };
  }
  if (parts[0] === "p" && parts[1]) {
    return { name: "project", projectId: parts[1] };
  }
  if (parts[0] === "capabilities") return { name: "capabilities" };
  if (parts[0] === "bots") return { name: "bots" };
  return { name: "home" };
}

export function navigate(route: string): void {
  window.location.hash = route;
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [connected, setConnected] = useState(() => getSession() !== null);
  const [activeThreadId, setActiveThread] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    const mq = window.matchMedia("(max-width: 760px)");
    const onResize = () => setDrawerOpen(false);
    mq.addEventListener("change", onResize);
    return () => {
      window.removeEventListener("hashchange", onHash);
      mq.removeEventListener("change", onResize);
    };
  }, []);

  const openProject = (id: string) => {
    navigate(`#/chat/${id}`);
  };

  const openHome = () => navigate("#/");

  if (!connected) {
    return <ConnectScreen onConnected={() => setConnected(true)} />;
  }

  const isChatRoute = route.name === "home" || route.name === "chat";

  const nav = (href: string, label: string, active: boolean) => (
    <button
      key={href}
      className={`nav-item${active ? " active" : ""}`}
      onClick={() => navigate(href)}
    >
      {label}
    </button>
  );

  return (
    <div className="layout">
      <button
        className="mobile-menu"
        aria-label="Open navigation"
        onClick={() => setDrawerOpen((d) => !d)}
      >
        ☰
      </button>

      <aside className={`sidebar${drawerOpen ? " open" : ""}`}>
        <div className="sidebar-inner">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="brand">
              <strong>NerdBot</strong>
              <div className="brand-sub">personal assistant</div>
            </div>
            {drawerOpen && (
              <button
                className="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation"
                style={{ padding: "6px 10px", fontSize: 12 }}
              >
                Close
              </button>
            )}
          </div>

          <div className="sidebar-section">
            <button
              className="button primary"
              onClick={openHome}
              aria-label="Start a new conversation"
            >
              New chat
            </button>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-label">Workspace</div>
            {nav("#/", "Home", route.name === "home")}
            {nav("#/projects", "Projects", route.name === "projects" || route.name === "project")}
            {nav("#/bots", "Bots", route.name === "bots" || route.name === "bot")}
            {nav("#/boards", "Boards", route.name === "boards" || route.name === "board")}
            {nav("#/teams", "Teams", route.name === "teams" || route.name === "team")}
            {nav("#/settings", "Settings", route.name === "settings")}
          </div>

          <div style={{ padding: "16px 12px", marginTop: "auto" }}>
            <button
              className="button"
              onClick={() => {
                setSession(null);
                setConnected(false);
                navigate("#/");
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      </aside>

      <div className={`main${drawerOpen ? " dimmed" : ""}`}>
        {isChatRoute && (
          <ConversationView
            projectId={route.name === "chat" ? route.projectId : undefined}
            initialThreadId={activeThreadId}
            onSetActiveThread={setActiveThread}
          />
        )}
        {route.name === "teams" && <TeamsView />}
        {route.name === "team" && (
          <TeamDetailView teamId={route.teamId} onOpenProject={openProject} />
        )}
        {route.name === "bot" && <BotDetailView teammateId={route.teammateId} />}
        {route.name === "boards" && <BoardsView />}
        {route.name === "board" && <BoardDetailView boardId={route.boardId} />}
        {route.name === "projects" && <ProjectsView onOpen={openProject} />}
        {route.name === "settings" && <SettingsView />}
        {route.name === "project" && (
          <ProjectDetailView
            projectId={route.projectId}
            onOpenTask={(taskId) => navigate(`#/p/${route.projectId}/t/${taskId}`)}
          />
        )}
        {route.name === "task" && (
          <TaskDetailView
            projectId={route.projectId}
            taskId={route.taskId}
            onBack={() => navigate(`#/p/${route.projectId}`)}
          />
        )}
        {route.name === "capabilities" && <CapabilitiesView />}
        {route.name === "bots" && <BotsView />}
        {!isChatRoute &&
          route.name !== "teams" &&
          route.name !== "team" &&
          route.name !== "bot" &&
          route.name !== "boards" &&
          route.name !== "board" &&
          route.name !== "projects" &&
          route.name !== "settings" &&
          route.name !== "project" &&
          route.name !== "task" &&
          route.name !== "capabilities" &&
          route.name !== "bots" && (
          <EmptyState title="Workspace" hint="Select a workspace area from the sidebar." />
        )}
        <Toaster position="bottom-right" richColors closeButton />
      </div>
    </div>
  );
}

/** The dashboard is normally served by the API itself (e.g. localhost:8080,
 *  documented in the README). Defaulting the API base to the current origin
 *  keeps that flow same-origin (no CORS involved); only when the page is
 *  served elsewhere (the vite dev server) does the local default remain. */
export function defaultApiBase(): string {
  const loc = typeof window !== "undefined" ? window.location : null;
  if (loc && (loc.protocol === "http:" || loc.protocol === "https:") && loc.port !== "5173") {
    return loc.origin;
  }
  return "http://127.0.0.1:8080";
}

function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const [baseUrl, setBaseUrl] = useState(defaultApiBase);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    setSession({ baseUrl: baseUrl.replace(/\/+$/, ""), token });
    try {
      const health = await api.health();
      if (health.status !== "ok") throw new Error("Server reported unhealthy status");
      onConnected();
    } catch (err) {
      setSession(null);
      setError(err instanceof ApiError ? `Error ${err.status}: ${err.detail}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="layout" style={{ gridTemplateColumns: "1fr" }}>
      <main className="main" style={{ margin: "60px auto", width: "100%", maxWidth: 460 }}>
        <h1>NerdBot</h1>
        <p className="subtitle">Connect to a running NerdBot API server.</p>
        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : null}
        <form onSubmit={connect}>
          <label className="field">
            <span>API base URL</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </label>
          <label className="field">
            <span>API token (kept in this browser's local storage only)</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      </main>
    </div>
  );
}

/** Human-readable form for any thrown error (see api.describeError). */
export function describeError(err: unknown): string {
  return apiDescribeError(err);
}

export function notifyError(err: unknown): void {
  toast.error(describeError(err));
}
