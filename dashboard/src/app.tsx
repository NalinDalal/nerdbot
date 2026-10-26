import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import {
  ApiError,
  api,
  describeError as apiDescribeError,
  getSession,
  setSession,
} from "./api";
import { ConversationView } from "./views-chat";
import { ApprovalsView } from "./views-approvals";
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

export type Route =
  | { name: "home" }
  | { name: "work" }
  | { name: "workbench" }
  | { name: "chat"; projectId?: string }
  | { name: "teams" }
  | { name: "team"; teamId: string }
  | { name: "bot"; teammateId: string }
  | { name: "boards" }
  | { name: "board"; boardId: string }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "project"; projectId: string; tab?: string }
  | { name: "task"; projectId: string; taskId: string }
  | { name: "capabilities" }
  | { name: "bots" }
  | { name: "approvals" };

export function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  /* A query carries the tab to open, so a recovery link can land on the
  exact screen the owner needs: #/p/<id>?tab=Providers */
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query ?? "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "work") return { name: "work" };
  if (parts[0] === "workbench") return { name: "workbench" };
  if (parts[0] === "chat") {
    return parts[1]
      ? { name: "chat", projectId: parts[1] }
      : { name: "chat" };
  }
  if (parts[0] === "teams") return { name: "teams" };
  if (parts[0] === "team" && parts[1])
    return { name: "team", teamId: parts[1] };
  if (parts[0] === "bot" && parts[1])
    return { name: "bot", teammateId: parts[1] };
  if (parts[0] === "boards") return { name: "boards" };
  if (parts[0] === "board" && parts[1])
    return { name: "board", boardId: parts[1] };
  if (parts[0] === "projects") return { name: "projects" };
  if (parts[0] === "settings") return { name: "settings" };
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
  if (parts[0] === "capabilities") return { name: "capabilities" };
  if (parts[0] === "bots") return { name: "bots" };
  if (parts[0] === "approvals") return { name: "approvals" };
  return { name: "home" };
}

export function navigate(route: string): void {
  window.location.hash = route;
}

/* --- Sidebar --- */

function NavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`relative flex w-full items-center rounded-md py-1.5 pl-3 pr-2.5 text-left text-step--1 transition-colors ${
        active
          ? "bg-[var(--surface-2)] text-[var(--text)]"
          : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
      }`}
    >
      {/* The active item is marked by a rule in the margin, not by weight, so
     the navigation never competes with the page content. */}
      <span
        aria-hidden
        className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full ${
          active ? "bg-[var(--accent)]" : "bg-transparent"
        }`}
      />
      {label}
    </button>
  );
}

const NAV_ITEMS: Array<{
  label: string;
  routes: Array<Route["name"]>;
  href: string;
}> = [
  { label: "Home", routes: ["home"], href: "#/" },
  { label: "Work", routes: ["work", "task"], href: "#/work" },
  { label: "Workbench", routes: ["workbench"], href: "#/workbench" },
  { label: "Fleet", routes: ["bots", "bot"], href: "#/bots" },
  { label: "Approvals", routes: ["approvals"], href: "#/approvals" },
  {
    label: "Settings",
    routes: [
      "settings",
      "projects",
      "project",
      "boards",
      "board",
      "teams",
      "team",
      "capabilities",
    ],
    href: "#/settings",
  },
];

function Sidebar({
  route,
  drawerOpen,
  onNavigate,
  onDisconnect,
  onThemeChange,
  onClose,
}: {
  route: Route;
  drawerOpen: boolean;
  onNavigate: (href: string) => void;
  onDisconnect: () => void;
  onThemeChange: (theme: "light" | "dark" | "system") => void;
  onClose: () => void;
}) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-[var(--width-sidebar)] shrink-0 flex-col overflow-hidden border-r border-[var(--border-dim)] bg-[var(--bg)] transition-transform duration-200 ease-out md:static md:translate-x-0 ${
        drawerOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-full flex-col overflow-y-auto px-3 py-4">
        <div className="mb-5 flex items-center justify-between px-2">
          <strong className="font-semibold tracking-tight text-step-1 text-[var(--text)]">
            NerdBot
          </strong>
          <button
            className="rounded-sm p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] md:hidden"
            onClick={onClose}
            aria-label="Close navigation"
          >
            ×
          </button>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <NavItem
              key={item.label}
              label={item.label}
              active={item.routes.includes(route.name)}
              onClick={() => onNavigate(item.href)}
            />
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1 border-t border-[var(--border-dim)] pt-3">
          <button
            onClick={onDisconnect}
            className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-[var(--muted)] text-step--1 transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
          >
            Disconnect
          </button>
          <div className="flex items-center gap-2 px-3 py-1.5">
            <span className="text-[var(--faint)] text-step--2">
              Theme
            </span>
            <ThemeButton onThemeChange={onThemeChange} />
          </div>
        </div>
      </div>
    </aside>
  );
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
    const onBreakpoint = () => setDrawerOpen(false);
    mq.addEventListener("change", onBreakpoint);
    return () => {
      window.removeEventListener("hashchange", onHash);
      mq.removeEventListener("change", onBreakpoint);
    };
  }, []);

  const openProject = (id: string) => {
    navigate(`#/chat/${id}`);
  };

  if (!connected) {
    return <ConnectScreen onConnected={() => setConnected(true)} />;
  }

  /* Route → view. ConversationView is the home surface (Command Center
  * landing); every other route renders a full-page view that owns its
  * own scroll container. */
  let content: ReactNode;
  switch (route.name) {
    case "home":
    case "chat":
      content = (
        <ConversationView
          projectId={
            route.name === "chat" ? route.projectId : undefined
          }
          initialThreadId={activeThreadId}
          onSetActiveThread={setActiveThread}
        />
      );
      break;
    case "work":
      content = <WorkView />;
      break;
    case "workbench":
      content = <WorkbenchView />;
      break;
    case "teams":
      content = <TeamsView />;
      break;
    case "team":
      content = (
        <TeamDetailView
          teamId={route.teamId}
          onOpenProject={openProject}
        />
      );
      break;
    case "bot":
      content = <BotDetailView teammateId={route.teammateId} />;
      break;
    case "boards":
      content = <BoardsView />;
      break;
    case "board":
      content = <BoardDetailView boardId={route.boardId} />;
      break;
    case "projects":
      content = <ProjectsView onOpen={openProject} />;
      break;
    case "settings":
      content = <SettingsView />;
      break;
    case "project":
      content = (
        <ProjectDetailView
          projectId={route.projectId}
          initialTab={route.tab}
          onOpenTask={(taskId) =>
            navigate(`#/p/${route.projectId}/t/${taskId}`)
          }
        />
      );
      break;
    case "task":
      content = (
        <TaskDetailView
          projectId={route.projectId}
          taskId={route.taskId}
          onBack={() => navigate("#/work")}
        />
      );
      break;
    case "capabilities":
      content = <CapabilitiesView />;
      break;
    case "bots":
      content = <BotsView />;
      break;
    case "approvals":
      content = <ApprovalsView />;
      break;
    default:
      content = (
        <EmptyState
          title="Workspace"
          hint="Select a workspace area from the sidebar."
        />
      );
  }

  return (
    <div className="flex h-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      {/* Mobile drawer scrim */}
      {drawerOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      ) : null}

      <Sidebar
        route={route}
        drawerOpen={drawerOpen}
        onNavigate={(href) => {
          setDrawerOpen(false);
          navigate(href);
        }}
        onDisconnect={() => {
          setSession(null);
          setConnected(false);
          navigate("#/");
        }}
        onThemeChange={setTheme}
        onClose={() => setDrawerOpen(false)}
      />

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <button
          className="fixed top-3 left-3 z-40 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] transition-colors hover:border-[var(--faint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none md:hidden"
          aria-label="Open navigation"
          onClick={() => setDrawerOpen(true)}
        >
          ☰
        </button>
        {content}
        <Toaster position="bottom-right" richColors closeButton />
      </main>
    </div>
  );
}

/** The dashboard is normally served by the API itself (e.g. localhost:8080,
 *  documented in the README). Defaulting the API base to the current origin
 *  keeps that flow same-origin (no CORS involved); only when the page is
 *  served elsewhere (the vite dev server) does the local default remain. */
export function defaultApiBase(): string {
  const loc = typeof window !== "undefined" ? window.location : null;
  if (
    loc &&
    (loc.protocol === "http:" || loc.protocol === "https:") &&
    loc.port !== "5173"
  ) {
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
      if (health.status !== "ok")
        throw new Error("Server reported unhealthy status");
      onConnected();
    } catch (err) {
      setSession(null);
      setError(
        err instanceof ApiError
          ? `Error ${err.status}: ${err.detail}`
          : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full bg-[var(--bg)] text-[var(--text)]">
      <main className="flex h-full flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-[460px]">
          <h1 className="mb-2 font-semibold tracking-tight text-step-4">
            NerdBot
          </h1>
          <p className="mb-6 text-[var(--muted)] text-step-0">
            Connect to a running NerdBot API server.
          </p>
          {error ? (
            <div
              className="mb-4 rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-4 py-3 text-step-0"
              role="alert"
            >
              {error}
            </div>
          ) : null}
          <form onSubmit={connect} className="space-y-4">
            <div>
              <span className="mb-1.5 block font-medium tracking-wide text-[var(--muted)] text-step--1 uppercase">
                API base URL
              </span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 text-[var(--text)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
              />
            </div>
            <div>
              <span className="mb-1.5 block font-medium tracking-wide text-[var(--muted)] text-step--1 uppercase">
                API token (kept in this browser's local storage
                only)
              </span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                autoComplete="off"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 text-[var(--text)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
              />
            </div>
            <button
              className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-2 font-semibold text-step--1 text-[var(--text-inverse)] transition-colors hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)] disabled:pointer-events-none disabled:opacity-50"
              type="submit"
              disabled={busy}
            >
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
