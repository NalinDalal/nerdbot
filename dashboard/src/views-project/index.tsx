import { useState } from "react";
import { ShortId } from "../components";
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
  "Backup",
  "Metrics",
  "Events",
] as const;

export function ProjectDetailView({
  projectId,
  onOpenTask,
}: {
  projectId: string;
  onOpenTask: (taskId: string) => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Tasks");
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[var(--max-width-wide)] px-6 py-6 md:px-8 md:py-8">
        <div className="mono mb-1 text-[var(--step-minus-2)] text-[var(--faint)]">
          <a href="#/" className="hover:text-[var(--text-soft)]">
            projects
          </a>{" "}
          / {projectId}
        </div>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[var(--step-2)] font-semibold tracking-tight text-[var(--text)]">
            Project <ShortId id={projectId} />
          </h1>
        </div>
        <div
          role="tablist"
          aria-label="Project sections"
          className="mb-6 flex flex-wrap gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1"
        >
          {TABS.map((name) => (
            <button
              key={name}
              role="tab"
              id={`project-tab-${name}`}
              aria-controls="project-tab-panel"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
              className={`rounded-md px-3 py-1.5 text-[var(--step-minus-1)] font-medium transition-colors ${
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
          {tab === "Chat" && (
            <div className="h-[75vh] min-h-[480px] overflow-hidden rounded-xl border border-[var(--border)]">
              <ConversationView projectId={projectId} />
            </div>
          )}
          {tab === "Teammates" && <TeammatesTab projectId={projectId} />}
          {tab === "Providers" && <ProvidersTab projectId={projectId} />}
          {tab === "Issues" && <IssuesTab projectId={projectId} />}
          {tab === "Knowledge" && <KnowledgeTab projectId={projectId} />}
          {tab === "Schedules" && <SchedulesTab projectId={projectId} />}
          {tab === "Approvals" && <ApprovalsTab projectId={projectId} />}
          {tab === "Messages" && <MessagesTab projectId={projectId} />}
          {tab === "Notifications" && <NotificationsTab projectId={projectId} />}
          {tab === "Memory" && <MemoryTab projectId={projectId} />}
          {tab === "Backup" && <BackupTab projectId={projectId} />}
          {tab === "Metrics" && <MetricsTab projectId={projectId} />}
          {tab === "Events" && <EventsTab projectId={projectId} />}
        </div>
      </div>
    </div>
  );
}
