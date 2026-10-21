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
  Button,
  useTheme,
  ThemeButton,
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
  const { setTheme } = useTheme();

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

  return (
    <div className="layout h-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <button
        className="mobile-menu fixed top-4 left-4 z-70 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] hover:border-[var(--faint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1"
        aria-label="Open navigation"
        onClick={() => setDrawerOpen((d) => !d)}
      >
        ☰
      </button>

      <aside className={`sidebar border-r border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden ${drawerOpen ? "translate-x-0" : "-translate-x-full"} transition-transform duration-200 ease-[var(--ease-out)]`}>
        <div className="p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <div className="brand">
              <strong className="text-base font-semibold tracking-tight">NerdBot</strong>
              <div className="text-[var(--step-minus-1)] text-[var(--muted)] mt-0.5 uppercase tracking-widest">assistant</div>
            </div>
            {drawerOpen && (
              <button
                className="rounded-sm p-1.5 text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation"
              >
                ×
              </button>
            )}
          </div>

          <div className="mt-6">
            <Button
              variant="primary"
              className="w-full"
              onClick={openHome}
              aria-label="Start a new conversation"
            >
              New chat
            </Button>
          </div>

          <div className="mt-8">
            <div className="text-[var(--step-minus-2)] text-[var(--faint)] uppercase tracking-widest mb-2">Workspace</div>
            <nav className="space-y-0.5">
              <Button
                variant={route.name === "home" ? "primary" : "default"}
                className={`w-full text-left justify-start border-transparent bg-transparent hover:bg-[var(--surface-2)] ${route.name === "home" ? "bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--text)]" : "text-[var(--text-soft)]"}`}
                onClick={openHome}
              >
                Home
              </Button>
              <Button
                variant={route.name === "projects" || route.name === "project" ? "primary" : "default"}
                className={`w-full text-left justify-start border-transparent bg-transparent hover:bg-[var(--surface-2)] ${(route.name === "projects" || route.name === "project") ? "bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--text)]" : "text-[var(--text-soft)]"}`}
                onClick={() => navigate("#/projects")}
              >
                Workspaces
              </Button>
              <Button
                variant={route.name === "bots" || route.name === "bot" ? "primary" : "default"}
                className={`w-full text-left justify-start border-transparent bg-transparent hover:bg-[var(--surface-2)] ${(route.name === "bots" || route.name === "bot") ? "bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--text)]" : "text-[var(--text-soft)]"}`}
                onClick={() => navigate("#/bots")}
              >
                AI fleet
              </Button>
              <Button
                variant={route.name === "boards" || route.name === "board" ? "primary" : "default"}
                className={`w-full text-left justify-start border-transparent bg-transparent hover:bg-[var(--surface-2)] ${(route.name === "boards" || route.name === "board") ? "bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--text)]" : "text-[var(--text-soft)]"}`}
                onClick={() => navigate("#/boards")}
              >
                Boards
              </Button>
              <Button
                variant={route.name === "teams" || route.name === "team" ? "primary" : "default"}
                className={`w-full text-left justify-start border-transparent bg-transparent hover:bg-[var(--surface-2)] ${(route.name === "teams" || route.name === "team") ? "bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--text)]" : "text-[var(--text-soft)]"}`}
                onClick={() => navigate("#/teams")}
              >
                Teams
              </Button>
              <Button
                variant={route.name === "settings" ? "primary" : "default"}
                className={`w-full text-left justify-start border-transparent bg-transparent hover:bg-[var(--surface-2)] ${route.name === "settings" ? "bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--text)]" : "text-[var(--text-soft)]"}`}
                onClick={() => navigate("#/settings")}
              >
                Settings
              </Button>
            </nav>
          </div>

          <div className="mt-auto pt-6 border-t border-[var(--border-dim)]">
            <Button
              variant="default"
              className="w-full text-left"
              onClick={() => {
                setSession(null);
                setConnected(false);
                navigate("#/");
              }}
            >
              Disconnect
            </Button>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[var(--step-minus-2)] text-[var(--faint)]">Theme</span>
              <ThemeButton onThemeChange={setTheme} />
            </div>
          </div>
        </div>
      </aside>

      <div className="main flex flex-col h-full overflow-hidden relative">
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
            onBack={() => navigate(`#/p/${route.projectId}/t/${route.taskId}`)}
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
    <div className="layout h-full bg-[var(--bg)] text-[var(--text)]">
      <main className="flex flex-col items-center justify-center h-full px-6">
        <div className="w-full max-w-[460px]">
          <h1 className="text-[var(--step-4)] font-semibold tracking-tight mb-2">NerdBot</h1>
          <p className="text-[var(--step-0)] text-[var(--muted)] mb-6">Connect to a running NerdBot API server.</p>
          {error ? (
            <div className="rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-4 py-3 text-[var(--step-0)] mb-4" role="alert">
              {error}
            </div>
          ) : null}
          <form onSubmit={connect} className="space-y-4">
            <div className="mb-4">
              <span className="block text-[var(--step-minus-1)] font-medium text-[var(--muted)] mb-1.5 uppercase tracking-wide">API base URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] text-[var(--text)] w-full focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
              />
            </div>
            <div className="mb-4">
              <span className="block text-[var(--step-minus-1)] font-medium text-[var(--muted)] mb-1.5 uppercase tracking-wide">API token (kept in this browser's local storage only)</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                autoComplete="off"
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] text-[var(--text)] w-full focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
              />
            </div>
            <button className="button primary w-full" type="submit" disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>
        </div>
      </main>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

export function describeError(err: unknown): string {
  return apiDescribeError(err);
}

export function notifyError(err: unknown): void {
  toast.error(describeError(err));
}
