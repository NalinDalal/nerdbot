import { useState } from "react";
import { api } from "../api";
import { Button, CARD_SHELL, EmptyState, ErrorState, LoadingState, Modal, ShortId, StatusBadge, TABLE_TD, TABLE_TH, useAsync } from "../components";
import { EntityForm } from "../forms";

export function TasksTab({ projectId, onOpenTask }: { projectId: string; onOpenTask: (id: string) => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<string[]>([]);
  const tasks = useAsync(() => api.projectTasks(projectId), [projectId]);
  const runs = useAsync(() => api.projectRuns(projectId), [projectId]);
  const mates = useAsync(() => api.listTeammates(projectId), [projectId]);
  const ownerName = (id: string | null): string => {
    if (!id) return "—";
    return mates.data?.teammates.find((m) => m.id === id)?.persona || id.slice(0, 10);
  };
  const reload = () => {
    tasks.reload();
    runs.reload();
  };

  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          New task
        </Button>
        <Button onClick={reload}>Refresh</Button>
      </div>
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
              setCreated((prev) => [task.id, ...prev]);
              setShowCreate(false);
              onOpenTask(task.id);
            }}
          />
        </Modal>
      ) : null}
      {created.length > 0 ? (
        <div className={CARD_SHELL}>
          <strong>Created this session</strong>
          {created.map((id) => (
            <div key={id}>
              <a href={`#/p/${projectId}/t/${id}`}>
                <ShortId id={id} />
              </a>
            </div>
          ))}
        </div>
      ) : null}

      <h2>Tasks</h2>
      {tasks.loading ? (
        <LoadingState />
      ) : tasks.error ? (
        <ErrorState error={tasks.error} onRetry={tasks.reload} />
      ) : tasks.data && tasks.data.tasks.length > 0 ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={TABLE_TH}>Task</th>
              <th className={TABLE_TH}>Status</th>
              <th className={TABLE_TH}>Owner</th>
              <th className={TABLE_TH}>Delegated from</th>
              <th className={TABLE_TH}>Command</th>
            </tr>
          </thead>
          <tbody>
            {tasks.data.tasks.map((task) => (
              <tr className="transition-colors hover:bg-[var(--surface-2)]" key={task.id}>
                <td className={TABLE_TD}>
                  <a href={`#/p/${projectId}/t/${task.id}`} onClick={() => onOpenTask(task.id)}>
                    {task.description || "Untitled task"}
                  </a>
                </td>
                <td className={TABLE_TD}>
                  <StatusBadge status={task.status} />
                  {task.blocked_reason ? (
                    <span className="ml-2 text-[var(--step-minus-1)] text-[var(--muted)]">
                      {task.blocked_reason}
                    </span>
                  ) : null}
                </td>
                <td className="text-[var(--muted)]">{ownerName(task.owner_teammate_id)}</td>
                <td className={TABLE_TD}>
                  {task.parent_task_id ? (
                    <a href={`#/p/${projectId}/t/${task.parent_task_id}`}>
                      <ShortId id={task.parent_task_id} />
                    </a>
                  ) : (
                    <span className="text-[var(--muted)]">—</span>
                  )}
                </td>
                <td className="mono text-[var(--muted)]" style={{ maxWidth: 260, overflowWrap: "anywhere" }}>
                  {task.command || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No tasks yet" hint="Create a task above, or let a bot decompose an objective into one." />
      )}

      <h2>Runs across tasks</h2>
      {runs.loading ? (
        <LoadingState />
      ) : runs.error ? (
        <ErrorState error={runs.error} onRetry={runs.reload} />
      ) : runs.data && runs.data.runs.length > 0 ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={TABLE_TH}>Run</th>
              <th className={TABLE_TH}>Task</th>
              <th className={TABLE_TH}>Status</th>
              <th className={TABLE_TH}>Exit</th>
              <th className={TABLE_TH}>Runtime</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.runs.map((run) => (
              <tr className="transition-colors hover:bg-[var(--surface-2)]" key={run.id}>
                <td className={TABLE_TD}>
                  <ShortId id={run.id} />
                </td>
                <td className={TABLE_TD}>
                  <a href={`#/p/${projectId}/t/${run.task_id}`}>
                    <ShortId id={run.task_id} />
                  </a>
                </td>
                <td className={TABLE_TD}>
                  <StatusBadge status={run.status} />
                </td>
                <td className={`${TABLE_TD} mono`}>{run.exit_code ?? "—"}</td>
                <td className="text-[var(--muted)]">{run.runtime}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No runs yet" hint="Create a task, then run it from the task page." />
      )}
    </div>
  );
}
