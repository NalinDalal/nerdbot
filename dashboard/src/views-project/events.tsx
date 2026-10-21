import { useState } from "react";
import { api } from "../api";
import { Button, EmptyState, ErrorState, LoadingState, TABLE_TD, TABLE_TH, useAsync } from "../components";
export function EventsTab({ projectId }: { projectId: string }) {
  const [entity, setEntity] = useState("");
  const events = useAsync(() => api.projectEvents(projectId, entity || undefined), [projectId, entity]);
  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entity filter" style={{ maxWidth: 220 }}>
          <option value="">All entities</option>
          <option value="task">task</option>
          <option value="run">run</option>
          <option value="approval">approval</option>
          <option value="teammate">teammate</option>
          <option value="notification">notification</option>
        </select>
        <Button onClick={events.reload}>Refresh</Button>
      </div>
      {events.loading ? (
        <LoadingState />
      ) : events.error ? (
        <ErrorState error={events.error} onRetry={events.reload} />
      ) : events.data && events.data.events.length > 0 ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={TABLE_TH}>Time</th>
              <th className={TABLE_TH}>Entity</th>
              <th className={TABLE_TH}>Event</th>
            </tr>
          </thead>
          <tbody>
            {events.data.events.slice(-100).reverse().map((event) => (
              <tr className="transition-colors hover:bg-[var(--surface-2)]" key={event.id}>
                <td className="mono text-[var(--muted)]">{event.timestamp}</td>
                <td className="text-[var(--muted)]">{event.entity}</td>
                <td className={`${TABLE_TD} mono`}>{event.event_type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No events" hint="State changes are recorded here." />
      )}
    </div>
  );
}
