import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import {
  ApiError,
  api,
  autoConnectDev,
  describeError as apiDescribeError,
  getSession,
  setSession,
} from "./api";
import type { ChatThread, Project } from "./types";
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
import {
  EmptyState,
  Icon,
  Kbd,
  Page,
  useTheme,
} from "./components";
import type { IconName } from "./components";
import { onRouteChange, navigate } from "./router";

export type Route =
  | { name: "overview" }
  | { name: "work" }
  | { name: "activity" }
  | { name: "workspace"; projectId?: string }
  | { name: "chat"; projectId?: string; threadId?: string }
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
  | { name: "library" }
  | { name: "libraryDoc"; docId: string }
  | { name: "gallery" }
  | { name: "approvals" };

export function parseRoute(): Route {
  /* A query carries the tab to open, so a recovery link can land on the
  exact screen the owner needs: /p/<id>?tab=Providers */
  const params = new URLSearchParams(window.location.search);
  const parts = window.location.pathname.split("/").filter(Boolean);
  // The workspace opens on the operating overview, not the chat: the owner
  // lands on what the org is doing, and conversations are one click away.
  if (parts.length === 0) return { name: "overview" };
  if (parts[0] === "overview" || parts[0] === "home") return { name: "overview" };
  // Work is the execution center. /activity is the old name and keeps working
  // so a bookmark or a notification link still lands on the same screen.
  if (parts[0] === "work" || parts[0] === "activity") return { name: "activity" };
  if (parts[0] === "workspace" || parts[0] === "workbench") {
    return {
      name: "workspace",
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
  if (parts[0] === "teams") return { name: "teams" };
  if (parts[0] === "team" && parts[1])
    return { name: "team", teamId: parts[1] };
  // Agents are the canonical name for the AI workforce. /bots stays valid
  // because every existing link and notification uses it.
  if (parts[0] === "agents" && parts[1])
    return { name: "bot", teammateId: parts[1] };
  if (parts[0] === "agents") return { name: "bots" };
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
  if (parts[0] === "library") {
    return parts[1] ? { name: "libraryDoc", docId: parts[1] } : { name: "library" };
  }
  if (parts[0] === "gallery") return { name: "gallery" };
  if (parts[0] === "approvals") return { name: "approvals" };
  // An unknown path is not a conversation. Land on the command center so a
  // stale bookmark shows the org's real state instead of an empty chat.
  return { name: "overview" };
}

export { navigate } from "./router";

/* --- Sidebar --- */

function NavItem({
  label,
  icon,
  active,
  badge,
  onClick,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`group relative flex h-8 w-full items-center gap-2.5 rounded-[var(--radius-sm)] pl-2.5 pr-2 text-left text-step--1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--border-focus)] ${
        active
          ? "bg-[var(--surface-2)] font-medium text-[var(--text)]"
          : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
      }`}
    >
      <span
        aria-hidden
        className={`absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full transition-opacity ${
          active ? "bg-[var(--accent)] opacity-100" : "opacity-0"
        }`}
      />
      <Icon
        name={icon}
        className={`h-[15px] w-[15px] transition-colors ${
          active ? "text-[var(--text-soft)]" : "text-[var(--faint)] group-hover:text-[var(--muted)]"
        }`}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge && badge > 0 ? (
        <span
          className="inline-flex min-w-[18px] items-center justify-center rounded-[4px] bg-[var(--warn-dim)] px-1 text-[10px] font-semibold tabular-nums text-[var(--warn)]"
          aria-label={`${badge} waiting`}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-4 first:mt-0">
      <div className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--faint)]">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

interface NavData {
  threads: ChatThread[];
  projects: Project[];
  pendingApprovals: number;
}

const EMPTY_NAV: NavData = { threads: [], projects: [], pendingApprovals: 0 };

/** The rail's live data: recent conversations and the number of decisions
 *  waiting. It refreshes whenever the route changes, so paging back from a
 *  decision never shows a stale badge. */
function useNavData(route: Route): NavData {
  const [data, setData] = useState<NavData>(EMPTY_NAV);
  const routeKey = Object.values(route).join(":");
  useEffect(() => {
    let live = true;
    Promise.all([
      api.listRecentThreads(6).catch(() => ({ threads: [] as ChatThread[] })),
      api.listProjects().catch(() => ({ projects: [] as Project[] })),
      api.approvalsInbox("pending").catch(() => ({ approvals: [] })),
    ]).then(([threads, projects, inbox]) => {
      if (!live) return;
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

function ThemeControl({
  theme,
  onChange,
}: {
  theme: "dark" | "light" | "system";
  onChange: (theme: "dark" | "light" | "system") => void;
}) {
  const options: Array<{ id: "dark" | "light" | "system"; label: string; icon: IconName }> = [
    { id: "dark", label: "Dark theme", icon: "moon" },
    { id: "light", label: "Light theme", icon: "sun" },
    { id: "system", label: "Match system", icon: "monitor" },
  ];
  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border-dim)] bg-[var(--surface)] p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          aria-pressed={theme === option.id}
          aria-label={option.label}
          title={option.label}
          className={`flex h-6 w-6 items-center justify-center rounded-[4px] transition-colors ${
            theme === option.id
              ? "bg-[var(--surface-3)] text-[var(--text)]"
              : "text-[var(--faint)] hover:text-[var(--text-soft)]"
          }`}
        >
          <Icon name={option.icon} className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

function Sidebar({
  route,
  drawerOpen,
  theme,
  onNavigate,
  onDisconnect,
  onThemeChange,
  onClose,
  onOpenPalette,
}: {
  route: Route;
  drawerOpen: boolean;
  theme: "dark" | "light" | "system";
  onNavigate: (href: string) => void;
  onDisconnect: () => void;
  onThemeChange: (theme: "dark" | "light" | "system") => void;
  onClose: () => void;
  onOpenPalette: () => void;
}) {
  const nav = useNavData(route);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const projectName = (id: string) =>
    nav.projects.find((project) => project.id === id)?.repository || "Project";

  const activeProjectId = "projectId" in route ? route.projectId : undefined;
  const activeProject = activeProjectId
    ? nav.projects.find((project) => project.id === activeProjectId)
    : undefined;
  const workspaceLabel = activeProject?.repository || "All projects";

  const primary: Array<{
    label: string;
    icon: IconName;
    routes: Array<Route["name"]>;
    href: string;
    badge?: number;
  }> = [
    { label: "Home", icon: "home", routes: ["overview"], href: "/" },
    { label: "Chat", icon: "chat", routes: ["chat"], href: "/chat" },
    { label: "Work", icon: "work", routes: ["activity", "work", "task"], href: "/work", badge: nav.pendingApprovals },
    { label: "Agents", icon: "agents", routes: ["bots", "bot"], href: "/agents" },
    { label: "Teams", icon: "teams", routes: ["teams", "team"], href: "/teams" },
    { label: "Projects", icon: "projects", routes: ["projects", "project"], href: "/projects" },
    { label: "Library", icon: "library", routes: ["library", "libraryDoc"], href: "/library" },
  ];
  const secondary: Array<{ label: string; icon: IconName; routes: Array<Route["name"]>; href: string }> = [
    { label: "Approvals", icon: "inbox", routes: ["approvals"], href: "/approvals" },
    { label: "Boards", icon: "layers", routes: ["boards", "board"], href: "/boards" },
    { label: "Workspace", icon: "command", routes: ["workspace"], href: "/workspace" },
    { label: "Gallery", icon: "folder", routes: ["gallery"], href: "/gallery" },
    { label: "Capabilities", icon: "cpu", routes: ["capabilities"], href: "/capabilities" },
  ];

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-[var(--width-sidebar)] shrink-0 flex-col border-r border-[var(--border-dim)] bg-[var(--bg)] transition-transform duration-200 ease-[var(--ease-out)] md:static md:translate-x-0 ${
        drawerOpen ? "translate-x-0" : "-translate-x-full"
      }`}
      aria-label="Application"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <img src="/nerdbot-mark.svg" alt="" className="h-5 w-5" />
        <span className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--text)]">
          Nerdbot
        </span>
        <span className="ml-1 rounded-[4px] border border-[var(--border-dim)] px-1 py-px text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--faint)]">
          OS
        </span>
        <button
          className="ml-auto rounded-[var(--radius-sm)] p-1.5 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] md:hidden"
          onClick={onClose}
          aria-label="Close navigation"
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>

      <div className="px-3">
        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={workspaceOpen}
            onClick={() => setWorkspaceOpen((open) => !open)}
            className="flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-dim)] bg-[var(--surface)] px-2.5 text-left transition-colors hover:border-[var(--border)] hover:bg-[var(--surface-2)]"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-[4px] bg-[var(--surface-3)] text-[10px] font-semibold uppercase text-[var(--text-soft)]">
              {(workspaceLabel || "A").slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1 truncate text-step--1 text-[var(--text-soft)]">
              {workspaceLabel}
            </span>
            <Icon name="chevron-down" className="h-3.5 w-3.5 text-[var(--faint)]" />
          </button>
          {workspaceOpen ? (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setWorkspaceOpen(false)} aria-hidden />
              <div
                role="menu"
                aria-label="Switch project"
                className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)]"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceOpen(false);
                    onNavigate("/projects");
                  }}
                  className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-step--1 text-[var(--text-soft)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                >
                  <Icon name="projects" className="h-3.5 w-3.5 text-[var(--faint)]" />
                  All projects
                </button>
                {nav.projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setWorkspaceOpen(false);
                      onNavigate(`/p/${project.id}`);
                    }}
                    className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-step--1 hover:bg-[var(--surface-2)] ${
                      project.id === activeProjectId
                        ? "text-[var(--text)]"
                        : "text-[var(--text-soft)]"
                    }`}
                  >
                    <Icon name="folder" className="h-3.5 w-3.5 text-[var(--faint)]" />
                    <span className="truncate">{project.repository || "Untitled project"}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => {
            onNavigate("/");
            window.dispatchEvent(new Event("nerdbot:compose"));
          }}
          className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 text-step--1 font-medium text-[var(--accent-ink)] transition-colors hover:bg-[var(--accent-hover)] active:bg-[var(--accent-press)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          New objective
        </button>
      </div>

      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <NavGroup label="Operate">
          {primary.slice(0, 3).map((item) => (
            <NavItem
              key={item.label}
              label={item.label}
              icon={item.icon}
              active={item.routes.includes(route.name)}
              badge={item.badge}
              onClick={() => onNavigate(item.href)}
            />
          ))}
        </NavGroup>
        <NavGroup label="Workforce">
          {primary.slice(3, 5).map((item) => (
            <NavItem
              key={item.label}
              label={item.label}
              icon={item.icon}
              active={item.routes.includes(route.name)}
              onClick={() => onNavigate(item.href)}
            />
          ))}
        </NavGroup>
        <NavGroup label="Manage">
          {primary.slice(5).map((item) => (
            <NavItem
              key={item.label}
              label={item.label}
              icon={item.icon}
              active={item.routes.includes(route.name)}
              onClick={() => onNavigate(item.href)}
            />
          ))}
        </NavGroup>

        <div className="mt-4">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex h-7 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--faint)] transition-colors hover:text-[var(--text-soft)]"
          >
            <Icon
              name="chevron-right"
              className={`h-3 w-3 transition-transform ${advancedOpen ? "rotate-90" : ""}`}
            />
            More
          </button>
          {advancedOpen ? (
            <div className="mt-0.5 flex flex-col gap-0.5">
              {secondary.map((item) => (
                <NavItem
                  key={item.label}
                  label={item.label}
                  icon={item.icon}
                  active={item.routes.includes(route.name)}
                  onClick={() => onNavigate(item.href)}
                />
              ))}
            </div>
          ) : null}
        </div>

        {nav.threads.length > 0 ? (
          <section className="mt-5" aria-label="Recent conversations">
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--faint)]">
                Recent
              </span>
              <button
                onClick={() => onNavigate("/chat")}
                className="text-step--2 text-[var(--faint)] transition-colors hover:text-[var(--text)]"
              >
                All
              </button>
            </div>
            <div className="flex flex-col">
              {nav.threads.slice(0, 4).map((thread) => {
                const active = route.name === "chat" && route.threadId === thread.id;
                return (
                  <button
                    key={thread.id}
                    onClick={() => onNavigate(`/chat/${thread.project_id}?thread=${thread.id}`)}
                    aria-current={active ? "page" : undefined}
                    className={`flex flex-col rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors ${
                      active
                        ? "bg-[var(--surface-2)] text-[var(--text)]"
                        : "text-[var(--text-soft)] hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    <span className="truncate text-step--1">
                      {thread.title || "Untitled conversation"}
                    </span>
                    <span className="truncate text-[11px] text-[var(--faint)]">
                      {projectName(thread.project_id)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}
      </nav>

      <div className="shrink-0 border-t border-[var(--border-dim)] px-3 py-2.5">
        <button
          type="button"
          onClick={onOpenPalette}
          className="mb-2 flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-dim)] bg-[var(--surface)] px-2.5 text-step--1 text-[var(--faint)] transition-colors hover:border-[var(--border)] hover:text-[var(--text-soft)]"
        >
          <Icon name="search" className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--faint)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" aria-hidden />
            Connected
          </span>
          <ThemeControl theme={theme} onChange={onThemeChange} />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={() => onNavigate("/settings")}
            className="inline-flex items-center gap-1.5 text-[11px] text-[var(--faint)] transition-colors hover:text-[var(--text-soft)]"
          >
            <Icon name="settings" className="h-3 w-3" />
            Settings
          </button>
          <button
            onClick={onDisconnect}
            className="text-[11px] text-[var(--faint)] transition-colors hover:text-[var(--text-soft)]"
          >
            Disconnect
          </button>
        </div>
      </div>
    </aside>
  );
}

const SECTION_TITLE: Record<Route["name"], string> = {
  overview: "Command center",
  work: "Work",
  activity: "Work",
  workspace: "Workspace",
  chat: "Chat",
  teams: "Teams",
  team: "Team",
  bot: "Agent",
  boards: "Boards",
  board: "Board",
  projects: "Projects",
  settings: "Settings",
  project: "Project",
  task: "Task",
  capabilities: "Capabilities",
  bots: "Agents",
  library: "Library",
  libraryDoc: "Library",
  gallery: "Gallery",
  approvals: "Approvals",
};

function TopBar({
  route,
  onMenu,
  onPalette,
}: {
  route: Route;
  onMenu: () => void;
  onPalette: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border-dim)] bg-[var(--bg)] px-4 md:px-6">
      <button
        type="button"
        onClick={onMenu}
        className="-ml-1 rounded-[var(--radius-sm)] p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] md:hidden"
        aria-label="Open navigation"
      >
        <Icon name="menu" className="h-4 w-4" />
      </button>
      <div className="flex min-w-0 items-center gap-2 text-step--1">
        <span className="hidden text-[var(--faint)] sm:inline">Nerdbot</span>
        <Icon name="chevron-right" className="hidden h-3 w-3 text-[var(--faint)] sm:block" />
        <span className="truncate font-medium text-[var(--text-soft)]">
          {SECTION_TITLE[route.name] ?? "Nerdbot"}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onPalette}
          className="hidden h-8 w-56 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-dim)] bg-[var(--surface)] px-2.5 text-step--1 text-[var(--faint)] transition-colors hover:border-[var(--border)] hover:text-[var(--text-soft)] lg:flex"
        >
          <Icon name="search" className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Search or jump to</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button
          type="button"
          onClick={onPalette}
          className="rounded-[var(--radius-sm)] p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] lg:hidden"
          aria-label="Search or jump to"
        >
          <Icon name="search" className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            navigate("/");
            window.dispatchEvent(new Event("nerdbot:compose"));
          }}
          className="hidden h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-dim)] bg-[var(--surface)] px-2.5 text-step--1 text-[var(--text-soft)] transition-colors hover:border-[var(--border)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] sm:flex"
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          New objective
        </button>
      </div>
    </header>
  );
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  section: string;
  run: () => void;
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const nav = useNavData({ name: "overview" });
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(id);
  }, []);

  const go = useCallback(
    (href: string) => {
      onClose();
      navigate(href);
    },
    [onClose],
  );

  const items: PaletteItem[] = useMemo(() => {
    const base: PaletteItem[] = [
      { id: "home", label: "Home", hint: "Command center", icon: "home", section: "Go to", run: () => go("/") },
      { id: "chat", label: "Chat", hint: "Conversations and objectives", icon: "chat", section: "Go to", run: () => go("/chat") },
      { id: "work", label: "Work", hint: "Execution center", icon: "work", section: "Go to", run: () => go("/work") },
      { id: "agents", label: "Agents", hint: "Workforce directory", icon: "agents", section: "Go to", run: () => go("/agents") },
      { id: "teams", label: "Teams", hint: "Groups of agents", icon: "teams", section: "Go to", run: () => go("/teams") },
      { id: "projects", label: "Projects", hint: "All projects", icon: "projects", section: "Go to", run: () => go("/projects") },
      { id: "library", label: "Library", hint: "Documents and deliverables", icon: "library", section: "Go to", run: () => go("/library") },
      { id: "settings", label: "Settings", hint: "Providers, limits, governance", icon: "settings", section: "Go to", run: () => go("/settings") },
      {
        id: "compose",
        label: "New objective",
        hint: "Plan work before anything runs",
        icon: "spark",
        section: "Actions",
        run: () => {
          onClose();
          navigate("/");
          window.dispatchEvent(new Event("nerdbot:compose"));
        },
      },
      {
        id: "new-task",
        label: "New task",
        hint: "Create work directly",
        icon: "plus",
        section: "Actions",
        run: () => {
          onClose();
          navigate("/work");
          window.dispatchEvent(new Event("nerdbot:new-task"));
        },
      },
    ];
    const projects = nav.projects.map<PaletteItem>((project) => ({
      id: `project-${project.id}`,
      label: project.repository || "Untitled project",
      hint: "Open project",
      icon: "folder",
      section: "Projects",
      run: () => go(`/p/${project.id}`),
    }));
    const threads = nav.threads.map<PaletteItem>((thread) => ({
      id: `thread-${thread.id}`,
      label: thread.title || "Untitled conversation",
      hint: "Open conversation",
      icon: "chat",
      section: "Recent conversations",
      run: () => go(`/chat/${thread.project_id}?thread=${thread.id}`),
    }));
    return [...base, ...projects, ...threads];
  }, [go, nav.projects, nav.threads, onClose]);

  const needle = query.trim().toLowerCase();
  const results = needle
    ? items.filter((item) =>
        `${item.label} ${item.hint ?? ""} ${item.section}`.toLowerCase().includes(needle),
      )
    : items;
  const grouped = results.reduce<Record<string, PaletteItem[]>>((acc, item) => {
    (acc[item.section] ??= []).push(item);
    return acc;
  }, {});
  const flat = Object.values(grouped).flat();

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/55 px-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        className="animate-fade-in w-full max-w-[560px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setIndex((current) => (flat.length ? (current + 1) % flat.length : 0));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((current) => (flat.length ? (current - 1 + flat.length) % flat.length : 0));
          }
          if (event.key === "Enter") {
            event.preventDefault();
            flat[index]?.run();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border-dim)] px-3">
          <Icon name="search" className="h-4 w-4 text-[var(--faint)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            placeholder="Search pages, projects, and conversations"
            aria-label="Search pages, projects, and conversations"
            className="h-11 w-full bg-transparent text-step-0 text-[var(--text)] outline-none placeholder:text-[var(--faint)]"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {flat.length === 0 ? (
            <div className="px-3 py-8 text-center text-step--1 text-[var(--muted)]">
              Nothing matches “{query}”.
            </div>
          ) : (
            Object.entries(grouped).map(([section, sectionItems]) => (
              <div key={section} className="mb-1">
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--faint)]">
                  {section}
                </div>
                {sectionItems.map((item) => {
                  const itemIndex = flat.indexOf(item);
                  const active = itemIndex === index;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onMouseEnter={() => setIndex(itemIndex)}
                      onClick={item.run}
                      className={`flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left transition-colors ${
                        active ? "bg-[var(--surface-2)]" : ""
                      }`}
                    >
                      <Icon
                        name={item.icon}
                        className={`h-3.5 w-3.5 ${active ? "text-[var(--text-soft)]" : "text-[var(--faint)]"}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-step--1 text-[var(--text)]">
                          {item.label}
                        </span>
                        {item.hint ? (
                          <span className="block truncate text-[11px] text-[var(--faint)]">
                            {item.hint}
                          </span>
                        ) : null}
                      </span>
                      {active ? <Kbd>↵</Kbd> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [connected, setConnected] = useState(() => getSession() !== null);
  // Without a stored session there may still be one to obtain silently:
  // a dev-token server publishes it in /health, so probe once before
  // showing the Connect form.
  const [probing, setProbing] = useState(() => getSession() === null);
  const [activeThreadId, setActiveThread] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { theme, setTheme } = useTheme();

  // Always try to establish the session on mount, overriding any stale
  // session data from localStorage. This is critical because the backend
  // has been restarted 30+ times (restarts: 30), meaning the dev token
  // may have changed and old session data will prevent re-connection.
  useEffect(() => {
    let alive = true;
    autoConnectDev(defaultApiBase()).then((ok) => {
      if (!alive) return;
      if (ok) setConnected(true);
      setProbing(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Keep old /workbench links working; canonical route is /workspace.
  useEffect(() => {
    if (window.location.pathname.startsWith("/workbench")) {
      navigate(window.location.pathname.replace(/^\/workbench/, "/workspace") + window.location.search + window.location.hash);
    }
  }, []);

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openProject = (id: string) => {
    navigate(`/p/${id}`);
  };

  if (!connected) {
    if (probing) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--bg)] text-[var(--muted)]">
          <img src="/nerdbot-mark.svg" alt="" className="h-8 w-8" />
          <p className="text-step--1">Connecting to {defaultApiBase()}</p>
          <Toaster position="bottom-right" richColors closeButton />
        </div>
      );
    }
    return <ConnectScreen onConnected={() => setConnected(true)} />;
  }

  /* Route → view. Home is the operating overview; Chat is the
   * conversational surface. All other routes render full-page views. */
  let content: ReactNode;
  switch (route.name) {
    case "overview":
      content = <HomeOverviewView />;
      break;
    case "chat":
      content = (
        <ConversationView
          key={`${route.projectId ?? "global"}:${route.threadId ?? "none"}`}
          projectId={route.projectId}
          initialThreadId={route.threadId ?? (route.projectId ? activeThreadId : undefined)}
          onSetActiveThread={setActiveThread}
        />
      );
      break;
    case "work":
    case "activity":
      content = <WorkView />;
      break;
    case "workspace":
      content = (
        <WorkbenchView
          initialProjectId={
            route.name === "workspace" ? route.projectId : undefined
          }
        />
      );
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
            navigate(`/p/${route.projectId}/t/${taskId}`)
          }
        />
      );
      break;
    case "task":
      content = (
        <TaskDetailView
          projectId={route.projectId}
          taskId={route.taskId}
          onBack={() => navigate(`/p/${route.projectId}`)}
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
    case "library":
      content = <LibraryView />;
      break;
    case "libraryDoc":
      content = <LibraryDocView docId={route.docId} />;
      break;
    case "gallery":
      content = <GalleryView />;
      break;
    default:
      content = (
        <Page width="data">
          <EmptyState
            title="Nothing here"
            hint="Select an area from the navigation."
          />
        </Page>
      );
  }

  const mobileNav: Array<{ label: string; icon: IconName; href: string; routes: Array<Route["name"]> }> = [
    { label: "Home", icon: "home", href: "/", routes: ["overview"] },
    { label: "Chat", icon: "chat", href: "/chat", routes: ["chat"] },
    { label: "Work", icon: "work", href: "/work", routes: ["activity", "work", "task"] },
    { label: "Agents", icon: "agents", href: "/agents", routes: ["bots", "bot"] },
  ];

  return (
    <div className="flex h-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      {drawerOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[1px] md:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      ) : null}

      <Sidebar
        route={route}
        drawerOpen={drawerOpen}
        theme={theme}
        onNavigate={(href) => {
          setDrawerOpen(false);
          navigate(href);
        }}
        onDisconnect={() => {
          setSession(null);
          setConnected(false);
          navigate("/");
        }}
        onThemeChange={setTheme}
        onClose={() => setDrawerOpen(false)}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          route={route}
          onMenu={() => setDrawerOpen(true)}
          onPalette={() => setPaletteOpen(true)}
        />
        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden pb-14 md:pb-0">
          {content}
        </main>
      </div>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex h-14 items-stretch border-t border-[var(--border-dim)] bg-[var(--bg)] md:hidden"
      >
        {mobileNav.map((item) => {
          const active = item.routes.includes(route.name);
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setDrawerOpen(false);
                navigate(item.href);
              }}
              aria-current={active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors ${
                active ? "text-[var(--accent)]" : "text-[var(--muted)]"
              }`}
            >
              <Icon name={item.icon} className="h-4 w-4" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-[var(--muted)]"
          aria-label="More destinations"
        >
          <Icon name="more" className="h-4 w-4" />
          <span>More</span>
        </button>
      </nav>

      {paletteOpen ? (
        <CommandPalette onClose={() => setPaletteOpen(false)} />
      ) : null}
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

/** The dashboard normally talks to the API through a same-origin proxy path.
 *
 *  The compose deployment serves the built dashboard from nginx and proxies
 *  ``/api`` to the backend, so the browser never makes a cross-origin
 *  request (which Chrome's local-network policy can block outright). The
 *  vite dev server has no such proxy, so it keeps the local default. When
 *  this process serves the built dashboard itself, the same ``/api`` path is
 *  accepted by the API, so one default covers both shapes. */
export function defaultApiBase(): string {
  const loc = typeof window !== "undefined" ? window.location : null;
  if (import.meta.env.DEV && (!loc || loc.port === "5173")) {
    return "http://127.0.0.1:8080";
  }
  if (loc && (loc.protocol === "http:" || loc.protocol === "https:")) {
    return `${loc.origin}/api`;
  }
  return "http://127.0.0.1:8080";
}

/** The dev server hands back its well-known token so the owner never has to
 *  retype a value everyone can read in the docs. Any other auth mode says
 *  nothing about its token, so a blank field stays a blank field. */
export function resolveConnectToken(health: unknown, typed: string): string {
  if (typed) return typed;
  if (
    typeof health === "object" &&
    health !== null &&
    (health as { auth?: unknown }).auth === "dev" &&
    typeof (health as { dev_token?: unknown }).dev_token === "string" &&
    (health as { dev_token?: string }).dev_token
  ) {
    return (health as { dev_token: string }).dev_token;
  }
  return "";
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
    try {
      // Probe first: in dev mode the server hands back the well-known token so
      // the owner never has to type it. The probe is best-effort  a failure
      // here just means the real connect attempt below will surface the error.
      let tokenToUse = token;
      try {
        const health = await api.health();
        tokenToUse = resolveConnectToken(health, tokenToUse);
      } catch {
        // fall through
      }
      setSession({ baseUrl: baseUrl.replace(/\/+$/, ""), token: tokenToUse });
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
      <main className="flex h-full flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-[440px] rounded-xl border border-[var(--border-dim)] bg-[var(--surface)] p-6 shadow-sm md:p-8">
          <div className="mb-6">
            <div className="mb-2 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">NerdBot</div>
            <h1 className="text-step-2 font-semibold tracking-[-0.02em] text-[var(--text)]">Connect to Nerdbot</h1>
            <p className="mt-2 text-step-0 leading-relaxed text-[var(--muted)]">
              Enter your API server to continue.
            </p>
          </div>
          {error ? (
            <div
              className="mb-4 rounded-lg border border-[var(--danger-dim)] bg-[var(--danger-dim)] px-4 py-3 text-step--1 text-[var(--text)]"
              role="alert"
            >
              {error}
            </div>
          ) : null}
          <form onSubmit={connect} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-step--1 font-medium text-[var(--text-soft)]">
                API base URL
              </span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-step-0 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                placeholder="http://localhost:8080"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-step--1 font-medium text-[var(--text-soft)]">
                API token <span className="font-normal text-[var(--faint)]">(optional in dev mode)</span>
              </span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-step-0 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
              />
            </label>
            <button
              className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-2.5 text-step--1 font-semibold text-white transition-colors hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)] disabled:pointer-events-none disabled:opacity-50"
              type="submit"
              disabled={busy}
            >
              {busy ? "Connecting..." : "Connect"}
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
