import { useState } from "react";
import { api } from "../api";
import { Button, CHIP_SHELL, EmptyState, ErrorState, LoadingState, Modal, PageSection, StatusBadge, relativeTime, useAsync } from "../components";
import { DataTable } from "../DataTable";
import { taskTitle, taskPreview } from "../taskTitle";
import { EntityForm } from "../forms";

export function TasksTab({ projectId, onOpenTask }: { projectId: string; onOpenTask: (id: string) => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const tasks = useAsync(() => api.projectTasks(projectId), [projectId]);
  const runs = useAsync(() => api.projectRuns(projectId), [projectId]);
  const mates = useAsync(() => api.listTeammates(projectId), [projectId]);
  const ownerName = (id: string | null): string => {
    if (!id) return "Unassigned";
    return mates.data?.teammates.find((m) => m.id === id)?.persona || "Assigned";
  };
  const reload = () => {
    tasks.reload();
    runs.reload();
  };

  return (
    <div>
      {showCreate ? (
        <Modal title="New task" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create task"
            fields={[
              { name: "description", label: "Description", required: true, type: "textarea" },
              { name: "command", label: "Command", placeholder: "echo ok" },
              { name: "owner_teammate_id", label: "Owner teammate ID (optional)" },
              { name: "issue_id", label: "Issue ID (optional)" },
            ]}
            onSubmit={async (values) => {
              const task = await api.createTask(projectId, values);
              setShowCreate(false);
              onOpenTask(task.id);
            }}
          />
        </Modal>
      ) : null}
      <PageSection
        title="Tasks"
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              New task
            </Button>
            <Button onClick={reload}>Refresh</Button>
          </>
        }
      >
        {tasks.loading ? (
          <LoadingState />
        ) : tasks.error ? (
          <ErrorState error={tasks.error} onRetry={tasks.reload} />
        ) : tasks.data && tasks.data.tasks.length > 0 ? (
          <DataTable
            columns={[
              { key: "task", header: "Task", render: (task) => (
                <div>
                  <a href={`/p/${projectId}/t/${task.id}`} onClick={() => onOpenTask(task.id)} className="line-clamp-2 break-words">
                    {task.title || taskTitle(task.description)}
                  </a>
                  <div className="text-[var(--muted)] text-step--2 truncate">{taskPreview(task.description)}</div>
                  {task.description && task.description.length > 1000 ? <span className={CHIP_SHELL}>{(task.description.length/1000).toFixed(1)}k chars</span> : null}
                </div>
              ) },
              { key: "status", header: "Status", render: (task) => (
                <div>
                  <StatusBadge status={task.status} />
                  {task.blocked_reason ? <div className="text-step--2 text-[var(--muted)]">{task.blocked_reason}</div> : null}
                </div>
              ) },
              { key: "owner", header: "Owner", render: (task) => ownerName(task.owner_teammate_id) },
            ]}
            rows={tasks.data.tasks}
            onRowClick={(task) => onOpenTask(task.id)}
          />
        ) : (
          <EmptyState title="No tasks yet" hint="Create a task above, or let a bot decompose an objective into one." />
        )}
      </PageSection>

      <PageSection
        title="Runs across tasks"
        description="Execution evidence for every task in this project."
      >
        {runs.loading ? (
          <LoadingState />
        ) : runs.error ? (
          <ErrorState error={runs.error} onRetry={runs.reload} />
        ) : runs.data && runs.data.runs.length > 0 ? (
          <DataTable
            columns={[
              { key: "run", header: "Run", render: (run) => relativeTime(run.started_at) },
              { key: "task", header: "Task", render: (run) => {
                const taskData = tasks.data?.tasks.find((task) => task.id === run.task_id);
                const label = taskData ? taskData.title || taskTitle(taskData.description) : "Task";
                return <span className="block truncate max-w-[24rem]" title={label}>{label}</span>;
              } },
              { key: "status", header: "Status", render: (run) => <StatusBadge status={run.status} /> },
              { key: "exit", header: "Exit", render: (run) => run.exit_code ?? "—" },
              { key: "runtime", header: "Runtime", render: (run) => run.runtime },
            ]}
            rows={runs.data.runs}
            onRowClick={(run) => onOpenTask(run.task_id)}
          />
        ) : (
          <EmptyState title="No runs yet" hint="Create a task, then run it from the task page." />
        )}
      </PageSection>
    </div>
  );
}
