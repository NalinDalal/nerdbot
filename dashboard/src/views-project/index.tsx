import { api } from "../api";
import { navigate } from "../app";
import { Button, LoadingState, Page, useAsync } from "../components";
import { ConversationView } from "../views-chat";
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

const TABS = [
  "Tasks",
  "Chat",
  "Teammates",
  "Providers",
  "Issues",
  "Knowledge",
  "Schedules",
  "Approvals",
  "Messages",
  "Notifications",
  "Memory",
  "Files",
  "Backup",
  "Metrics",
  "Events",
] as const;

type Tab = (typeof TABS)[number];

function isTab(value: string | undefined): value is Tab {
  return (TABS as readonly string[]).includes(value ?? "");
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
  const tab: Tab = isTab(initialTab) ? initialTab : "Tasks";

  const selectTab = (name: Tab) => {
    navigate(`/p/${projectId}?tab=${encodeURIComponent(name)}`);
  };

  return (
    <Page width="fill">
      <a
        href="/projects"
        className="mb-3 inline-flex items-center gap-1 text-step--1 text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <span aria-hidden>←</span> Projects
      </a>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 text-step--2 uppercase tracking-[0.16em] text-[var(--faint)]">
            Project
          </div>
          <h1 className="truncate text-step-2 font-semibold tracking-tight text-[var(--text)]">
            {workspaceName}
          </h1>
          <p className="mt-1 text-step--1 text-[var(--muted)]">
            {counts
              ? `${counts.bots} teammate${counts.bots === 1 ? "" : "s"} · ${counts.tasks} task${
                  counts.tasks === 1 ? "" : "s"
                } · ${counts.running} running`
              : "\u00a0"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => navigate(`/chat/${projectId}`)}>Open chat</Button>
          <Button onClick={() => navigate(`/workbench?project=${projectId}`)}>
            Workbench
          </Button>
        </div>
      </div>
      <div
        role="tablist"
        aria-label="Project sections"
        className="mb-6 flex flex-nowrap gap-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 md:flex-wrap md:overflow-visible"
      >
        {TABS.map((name) => (
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
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="project-tab-panel" aria-labelledby={`project-tab-${tab}`} className="min-h-0">
        {tab === "Tasks" && <TasksTab projectId={projectId} onOpenTask={onOpenTask} />}
        {tab === "Chat" && <ConversationView projectId={projectId} />}
        {tab === "Teammates" && <TeammatesTab projectId={projectId} />}
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
      </div>
      {projects.loading ? <LoadingState lines={1} /> : null}
    </Page>
  );
}
