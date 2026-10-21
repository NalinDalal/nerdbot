import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, EmptyState, ErrorState, LoadingState, Modal, TABLE_TD, TABLE_TH, useAsync } from "../components";
import { EntityForm } from "../forms";
export function SchedulesTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.listSchedules(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);

  const fire = async (id: string) => {
    try {
      await api.fireSchedule(id);
      list.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          New schedule
        </Button>
        <Button onClick={list.reload}>Refresh</Button>
      </div>
      {showCreate ? (
        <Modal title="New schedule" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create schedule"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "cron", label: "Cron (5 fields)", required: true, placeholder: "0 9 * * *" },
              { name: "description", label: "Task description", required: true },
              { name: "command", label: "Task command", required: true },
            ]}
            onSubmit={async (values) => {
              await api.createSchedule(projectId, {
                name: values.name,
                cron: values.cron,
                task_template: { description: values.description, command: values.command },
              });
              setShowCreate(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.schedules.length > 0 ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={TABLE_TH}>Name</th>
              <th className={TABLE_TH}>Cron</th>
              <th className={TABLE_TH}>Next run</th>
              <th className={TABLE_TH}>Fired</th>
              <th className={TABLE_TH}></th>
            </tr>
          </thead>
          <tbody>
            {list.data.schedules.map((schedule) => (
              <tr className="transition-colors hover:bg-[var(--surface-2)]" key={schedule.id}>
                <td className={TABLE_TD}>{schedule.name}</td>
                <td className={`${TABLE_TD} mono`}>{schedule.cron}</td>
                <td className="mono text-[var(--muted)]">{schedule.next_run_at ?? "—"}</td>
                <td className={TABLE_TD}>{schedule.fire_count}×</td>
                <td className={TABLE_TD}>
                  <Button onClick={() => fire(schedule.id)}>Fire now</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No schedules" hint="Schedules fire tasks on a cron." />
      )}
    </div>
  );
}
