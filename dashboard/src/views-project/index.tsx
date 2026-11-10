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

const PRIMARY_TABS = ["Overview", "Work", "Agents", "Chat", "Knowledge", "Files"] as const;
const PRIMARY_TAB_LABELS: Record<(typeof PRIMARY_TABS)[number], string> = {
  Overview: "Overview",
  Work: "Work",
  Agents: "Agents",
  Chat: "Chat",
  Knowledge: "Knowledge",
  Files: "Files & tools",
};
// Backward-compatible aliases: keep old tab names working for deep links.
const TAB_ALIASES: Record<string, string> = {
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
] as const;
const TABS = [...PRIMARY_TABS, ...ADVANCED_TABS] as const;

type Tab = (typeof TABS)[number];

function resolveTab(value: string | undefined): Tab {
  if (!value) return "Overview";
  if ((TABS as readonly string[]).includes(value)) return value as Tab;
  const aliased = TAB_ALIASES[value];
  if (aliased && (TABS as readonly string[]).includes(aliased)) return aliased as Tab;
  return "Overview";
}

export function ProjectDetailView({
  projectId,
  initialTab,
  onOpenTask,
}: {
  projectId: string;
  /** Open straight onto a tab, so a recovery link lands where it must. */
  initialTab?: string;
  onOpenTask: (taskId: string) => void;
}) {
  const projects = useAsync(() => api.listProjects(), []);
  const project = projects.data?.projects.find((item) => item.id === projectId);
  const counts = projects.data?.counts?.[projectId];
  const workspaceName = project?.repository || "Project";

  /* The tab lives in the hash, so a shared link, a refresh, and the browser
     back button all land on the section the owner was looking at. Deriving
     it instead of mirroring it in state means there is one source of truth. */
  const tab: Tab = resolveTab(initialTab);

  const selectTab = (name: Tab) => {
    setAdvancedOpen(false);
    navigate(`/p/${projectId}?tab=${encodeURIComponent(name)}`);
  };
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedActive = (ADVANCED_TABS as readonly string[]).includes(tab);

  return (
    <Page width="fill">
      <a
        href="/projects"
        className="mb-3 inline-flex items-center gap-1 text-step--1 text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <span aria-hidden>←</span> Workspaces
      </a>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 text-step--2 uppercase tracking-[0.16em] text-[var(--faint)]">
            Workspace
          </div>
          <h1 className="truncate text-step-2 font-semibold tracking-tight text-[var(--text)]">
            {workspaceName}
          </h1>
          <p className="mt-1 text-step--1 text-[var(--muted)]">
            {counts
              ? `${counts.bots} agent${counts.bots === 1 ? "" : "s"} · ${counts.tasks} task${
                  counts.tasks === 1 ? "" : "s"
                } · ${counts.running} running`
              : "Operating overview for this workspace"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => selectTab("Chat")}>Open chat</Button>
          <Button variant="primary" onClick={() => selectTab("Work")}>Open work</Button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Workspace sections"
        className="mb-6 flex flex-nowrap items-center gap-1 overflow-x-auto rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] p-1 md:flex-wrap md:overflow-visible"
      >
        {PRIMARY_TABS.map((name) => (
          <button
            key={name}
            role="tab"
            id={`project-tab-${name}`}
            aria-controls="project-tab-panel"
            aria-selected={tab === name}
            onClick={() => selectTab(name)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-step--1 font-medium transition-colors ${
              tab === name
                ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
            }`}
          >
            {PRIMARY_TAB_LABELS[name]}
          </button>
        ))}
        <div className="relative ml-auto">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-step--1 font-medium transition-colors ${
              advancedActive
                ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
            }`}
          >
            Advanced {advancedOpen ? "▴" : "▾"}
          </button>
          {advancedOpen ? (
            <>
              <div aria-hidden className="fixed inset-0 z-20" onClick={() => setAdvancedOpen(false)} />
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-1 w-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg"
              >
                {ADVANCED_TABS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="menuitem"
                    onClick={() => selectTab(name)}
                    className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-step--1 transition-colors ${
                      tab === name
                        ? "bg-[var(--surface-3)] text-[var(--text)]"
                        : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div role="tabpanel" id="project-tab-panel" aria-labelledby={`project-tab-${tab}`} className="min-h-0">
        {tab === "Overview" && (
          <ProjectOperatingOverview
            projectId={projectId}
            workspaceName={workspaceName}
            onOpenTask={onOpenTask}
            onSelectTab={(t) => selectTab(resolveTab(t))}
          />
        )}
        {tab === "Chat" && <ConversationView projectId={projectId} />}
        {tab === "Work" && <TasksTab projectId={projectId} onOpenTask={onOpenTask} />}
        {tab === "Agents" && <TeammatesTab projectId={projectId} />}
        {tab === "Providers" && <ProvidersTab projectId={projectId} />}
        {tab === "Issues" && <IssuesTab projectId={projectId} />}
        {tab === "Knowledge" && <KnowledgeTab projectId={projectId} />}
        {tab === "Schedules" && <SchedulesTab projectId={projectId} />}
        {tab === "Approvals" && <ApprovalsTab projectId={projectId} />}
        {tab === "Messages" && <MessagesTab projectId={projectId} />}
        {tab === "Notifications" && <NotificationsTab projectId={projectId} />}
        {tab === "Memory" && <MemoryTab projectId={projectId} />}
        {tab === "Files" && <FilesTab projectId={projectId} />}
        {tab === "Backup" && <BackupTab projectId={projectId} />}
        {tab === "Metrics" && <MetricsTab projectId={projectId} />}
        {tab === "Events" && <EventsTab projectId={projectId} />}
        {tab === "Boards" && <ProjectBoardsTab projectId={projectId} />}
      </div>
      {projects.loading ? <LoadingState lines={1} /> : null}
    </Page>
  );
}

/* ProjectOperatingOverview (R3) replaces the previous tabbed-admin overview.
   Legacy capabilities remain available via existing tabs/sections. */

function ProjectBoardsTab({ projectId }: { projectId: string }) {
  const boards = useAsync(() => api.listBoards(), [projectId]);
  const filtered = (boards.data?.boards ?? []).filter((b) => b.project_id === projectId);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-step--1 text-[var(--muted)]">
          Boards scoped to this project. Manage all boards from Workspace → Advanced.
        </span>
        <Button onClick={() => navigate("/boards")}>All boards →</Button>
      </div>
      {boards.loading ? (
        <LoadingState />
      ) : boards.error ? (
        <ErrorState error={boards.error} onRetry={boards.reload} />
      ) : filtered.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {filtered.map((board, index) => (
            <div
              key={board.id}
              className={`flex items-center justify-between gap-3 px-4 py-3 ${
                index > 0 ? "border-t border-[var(--border-dim)]" : ""
              }`}
            >
              <div className="min-w-0">
                <a
                  href={`/board/${board.id}`}
                  className="font-medium text-[var(--text)] hover:underline"
                >
                  {board.name || "Unnamed board"}
                </a>
                <div className="mono text-step--2 text-[var(--faint)]">{board.id}</div>
              </div>
              <Button variant="ghost" onClick={() => navigate(`/board/${board.id}`)}>
                Open →
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No boards for this project"
          hint="Create one from the Boards page; it will appear here."
          action={
            <Button variant="primary" onClick={() => navigate("/boards")}>
              Create board
            </Button>
          }
        />
      )}
    </div>
  );
}
