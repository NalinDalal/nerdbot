import { useState } from "react";
import { api } from "../api";
import { navigate } from "../app";
import { Button, EmptyState, ErrorState, LoadingState, Page, useAsync } from "../components";
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

const PRIMARY_TABS = ["Overview", "Chat", "Work", "Team", "Files", "Knowledge"] as const;
// Backward-compatible aliases: keep old tab names working for deep links.
const TAB_ALIASES: Record<string, string> = {
  Tasks: "Work",
  Teammates: "Team",
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
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 text-step--2 uppercase tracking-[0.16em] text-[var(--faint)]">
            Workspace
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
          <Button onClick={() => selectTab("Chat")}>Open chat</Button>
          <Button onClick={() => navigate(`/workbench?project=${projectId}`)}>
            Workbench
          </Button>
        </div>
      </div>
      <div
        role="tablist"
        aria-label="Project sections"
        className="mb-6 flex flex-nowrap items-center gap-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 md:flex-wrap md:overflow-visible"
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
            {name}
          </button>
        ))}
        <div className="relative">
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
              <div
                aria-hidden
                className="fixed inset-0 z-20"
                onClick={() => setAdvancedOpen(false)}
              />
              <div
                role="menu"
                className="absolute left-0 top-full z-30 mt-1 w-44 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg"
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
        {tab === "Overview" && <ProjectOverviewTab projectId={projectId} onOpenTask={onOpenTask} />}
        {tab === "Chat" && <ConversationView projectId={projectId} />}
        {tab === "Work" && <TasksTab projectId={projectId} onOpenTask={onOpenTask} />}
        {tab === "Team" && <TeammatesTab projectId={projectId} />}
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

function ProjectOverviewTab({
  projectId,
  onOpenTask,
}: {
  projectId: string;
  onOpenTask: (taskId: string) => void;
}) {
  const project = useAsync(() => api.listProjects(), []);
  const tasks = useAsync(() => api.projectTasks(projectId), [projectId]);
  const teammates = useAsync(() => api.listTeammates(projectId), [projectId]);
  const approvals = useAsync(() => api.projectApprovals(projectId).catch(() => ({ approvals: [] })), [projectId]);

  const p = project.data?.projects.find((x) => x.id === projectId);
  const counts = project.data?.counts?.[projectId];
  const taskList = tasks.data?.tasks ?? [];
  const team = teammates.data?.teammates ?? [];
  const approvalList = approvals.data?.approvals ?? [];
  const running = taskList.filter((t) => t.status === "running");
  const queued = taskList.filter((t) => t.status === "pending" || t.status === "ready");
  const blocked = taskList.filter((t) => t.status === "blocked" || t.status === "awaiting_approval");
  const done = taskList.filter((t) => t.status === "done").slice(-5).reverse();
  const failed = taskList.filter((t) => t.status === "failed").slice(-5).reverse();

  if (project.loading || tasks.loading) return <LoadingState lines={4} />;
  if (project.error || tasks.error) {
    return <ErrorState error={project.error ?? tasks.error ?? "Failed to load"} onRetry={() => { project.reload(); tasks.reload(); }} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-step-1 font-semibold tracking-tight text-[var(--text)]">
            {p?.repository || "Workspace"}
          </h2>
          <p className="mt-1 text-step--1 text-[var(--muted)]">
            {counts
              ? `${counts.bots} teammate${counts.bots === 1 ? "" : "s"} · ${counts.tasks} task${
                  counts.tasks === 1 ? "" : "s"
                } · ${counts.running} running`
              : "Loading…"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => navigate(`/p/${projectId}?tab=Chat`)}>Open chat</Button>
          <Button onClick={() => navigate(`/p/${projectId}?tab=Work`)}>Tasks</Button>
          <Button onClick={() => navigate(`/p/${projectId}?tab=Files`)}>Files</Button>
        </div>
      </div>

      <section>
        <h3 className="mb-2 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
          AI team
        </h3>
        {team.length === 0 ? (
          <EmptyState title="No teammates yet" hint="Add a bot to this workspace." action={<Button onClick={() => navigate(`/p/${projectId}?tab=Team`)}>Add teammate</Button>} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {team.map((m) => (
              <button
                key={m.id}
                onClick={() => navigate(`/bot/${m.id}`)}
                className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 transition-colors hover:border-[var(--faint)]"
              >
                <span className="font-medium text-[var(--text)]">{m.persona || m.id}</span>
                <span className="text-step--2 text-[var(--faint)]">{m.status}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {approvalList.length > 0 ? (
        <section>
          <h3 className="mb-2 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--warn)]">
            Needs attention ({approvalList.length})
          </h3>
          <div className="flex flex-col gap-2">
            {approvalList.slice(0, 5).map((a) => (
              <div key={a.id} className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-step--1">
                <div className="font-medium text-[var(--text)]">{a.action || "approval requested"}</div>
                {a.task_id ? (
                  <button
                    onClick={() => onOpenTask(a.task_id!)}
                    className="mt-1 text-step--2 text-[var(--accent)] hover:underline"
                  >
                    Open task →
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {running.length > 0 ? (
        <section>
          <h3 className="mb-2 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
            Running now ({running.length})
          </h3>
          <ul className="flex flex-col gap-1.5">
            {running.map((t) => (
              <li key={t.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <button onClick={() => onOpenTask(t.id)} className="text-step--1 text-[var(--text)] hover:underline">
                  {t.description || t.id}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {queued.length > 0 ? (
        <div className="text-step--1 text-[var(--muted)]">
          {queued.length} task{queued.length === 1 ? "" : "s"} queued
        </div>
      ) : null}

      {blocked.length > 0 ? (
        <section>
          <h3 className="mb-2 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--danger)]">
            Blocked ({blocked.length})
          </h3>
          <ul className="flex flex-col gap-1.5">
            {blocked.map((t) => (
              <li key={t.id} className="rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]">
                <button onClick={() => onOpenTask(t.id)} className="text-[var(--danger)] hover:underline">
                  {t.description || t.id}
                </button>
                {t.blocked_reason ? <div className="mt-0.5 text-step--2 opacity-80">{t.blocked_reason}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {done.length > 0 ? (
        <section>
          <h3 className="mb-2 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
            Recently completed
          </h3>
          <ul className="flex flex-col gap-1.5">
            {done.map((t) => (
              <li key={t.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <button onClick={() => onOpenTask(t.id)} className="text-step--1 text-[var(--text)] hover:underline">
                  {t.description || t.id}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {failed.length > 0 ? (
        <section>
          <h3 className="mb-2 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--danger)]">
            Failed
          </h3>
          <ul className="flex flex-col gap-1.5">
            {failed.map((t) => (
              <li key={t.id} className="rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]">
                <button onClick={() => onOpenTask(t.id)} className="text-[var(--danger)] hover:underline">
                  {t.description || t.id}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="mb-2 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
          Deliverables
        </h3>
        <p className="text-step--1 text-[var(--muted)]">
          Files, patches and PR packages live in Files and task detail.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => navigate(`/p/${projectId}?tab=Files`)}>Open files</Button>
          <Button onClick={() => navigate(`/p/${projectId}?tab=Work`)}>All tasks</Button>
        </div>
      </section>
    </div>
  );
}

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
