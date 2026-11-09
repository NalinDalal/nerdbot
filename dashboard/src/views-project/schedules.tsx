import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import {
  Button,
  EmptyState,
  ErrorState,
  FORM_INPUT,
  FORM_SELECT,
  LoadingState,
  Modal,
  StatusBadge,
  TABLE_TD,
  TABLE_TH,
  useAsync,
} from "../components";

type ScheduleRow = any;

export function SchedulesTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.listSchedules(projectId), [projectId]);
  const presets = useAsync(() => api.schedulePresets(), []);
  const [showCreate, setShowCreate] = useState(false);
  const [edit, setEdit] = useState<ScheduleRow | null>(null);
  const [historyFor, setHistoryFor] = useState<ScheduleRow | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      list.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          New schedule
        </Button>
        <Button onClick={list.reload}>Refresh</Button>
      </div>

      {showCreate ? (
        <ScheduleModal
          title="New schedule"
          presets={(presets.data?.presets || []) as Array<{ id: string; cron: string; label: string }>}
          onClose={() => setShowCreate(false)}
          onSubmit={async (body) => {
            await api.createSchedule(projectId, body);
            setShowCreate(false);
            list.reload();
          }}
        />
      ) : null}

      {edit ? (
        <ScheduleModal
          title="Edit schedule"
          initial={edit}
          presets={(presets.data?.presets || []) as Array<{ id: string; cron: string; label: string }>}
          onClose={() => setEdit(null)}
          onSubmit={async (body) => {
            await api.updateSchedule(edit.id, body);
            setEdit(null);
            list.reload();
          }}
        />
      ) : null}

      {historyFor ? (
        <ScheduleHistoryModal schedule={historyFor} onClose={() => setHistoryFor(null)} />
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
              <th className={TABLE_TH}>Cron / TZ</th>
              <th className={TABLE_TH}>Next run</th>
              <th className={TABLE_TH}>Status</th>
              <th className={TABLE_TH}>Last result</th>
              <th className={TABLE_TH}></th>
            </tr>
          </thead>
          <tbody>
            {list.data.schedules.map((schedule: any) => (
              <tr className="transition-colors hover:bg-[var(--surface-2)]" key={schedule.id}>
                <td className={TABLE_TD}>
                  <div className="font-medium text-[var(--text)]">{schedule.name || "Schedule"}</div>
                  <div className="text-step--2 text-[var(--faint)]">{schedule.task_template?.description || ""}</div>
                </td>
                <td className={TABLE_TD}>
                  <div className="mono">{schedule.cron}</div>
                  <div className="text-step--2 text-[var(--faint)]">{schedule.timezone || "UTC"}</div>
                </td>
                <td className="mono text-[var(--muted)]">
                  {schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "—"}
                </td>
                <td className={TABLE_TD}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={schedule.paused ? "paused" : schedule.enabled ? "scheduled" : "disabled"} />
                    {schedule.locked ? <StatusBadge status="running" label="firing" /> : null}
                  </div>
                </td>
                <td className={TABLE_TD}>
                  <div className="text-step--2">
                    {schedule.last_fired_at ? new Date(schedule.last_fired_at).toLocaleString() : "Never"}
                    {schedule.fire_count ? ` · ${schedule.fire_count}×` : ""}
                  </div>
                  {schedule.last_error ? (
                    <div className="max-w-xs truncate text-step--2 text-[var(--danger)]" title={schedule.last_error}>
                      {schedule.last_error}
                    </div>
                  ) : schedule.last_run_status ? (
                    <div className="text-step--2 text-[var(--muted)]">{schedule.last_run_status}</div>
                  ) : null}
                </td>
                <td className={TABLE_TD}>
                  <div className="flex flex-wrap gap-1.5">
                    <Button onClick={() => void act(() => api.fireSchedule(schedule.id))}>Fire now</Button>
                    <Button onClick={() => setHistoryFor(schedule)}>History</Button>
                    <Button onClick={() => setEdit(schedule)}>Edit</Button>
                    {schedule.paused ? (
                      <Button onClick={() => void act(() => api.resumeSchedule(schedule.id))}>Resume</Button>
                    ) : (
                      <Button onClick={() => void act(() => api.pauseSchedule(schedule.id))}>Pause</Button>
                    )}
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm(`Delete schedule "${schedule.name || schedule.id}"?`)) {
                          void act(() => api.deleteSchedule(schedule.id));
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No schedules" hint="Create a schedule to run work on a cron or preset." />
      )}
    </div>
  );
}

function ScheduleModal({
  title,
  initial,
  presets,
  onClose,
  onSubmit,
}: {
  title: string;
  initial?: any;
  presets: Array<{ id: string; cron: string; label: string }>;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [preset, setPreset] = useState("");
  const [cron, setCron] = useState(initial?.cron || "0 9 * * *");
  const [timezone, setTimezone] = useState(initial?.timezone || "UTC");
  const [description, setDescription] = useState(initial?.task_template?.description || "");
  const [command, setCommand] = useState(initial?.task_template?.command || "");
  const [teammateId, setTeammateId] = useState(initial?.teammate_id || initial?.task_template?.owner_teammate_id || "");
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit({
              name,
              cron,
              timezone,
              teammate_id: teammateId || undefined,
              task_template: { description, command, ...(teammateId ? { owner_teammate_id: teammateId } : {}) },
            });
          } catch (err) {
            notifyError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="text-step--1">
          <div className="mb-1 font-medium">Name</div>
          <input className={FORM_INPUT} value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-step--1">
            <div className="mb-1 font-medium">Preset</div>
            <select
              className={FORM_SELECT}
              value={preset}
              onChange={(e) => {
                const v = e.target.value;
                setPreset(v);
                const p = presets.find((x) => x.id === v);
                if (p) setCron(p.cron);
              }}
            >
              <option value="">Custom cron</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.label} ({p.cron})</option>
              ))}
            </select>
          </label>
          <label className="text-step--1">
            <div className="mb-1 font-medium">Timezone</div>
            <input className={FORM_INPUT} value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC" />
          </label>
        </div>
        <label className="text-step--1">
          <div className="mb-1 font-medium">Cron (5 fields)</div>
          <input className={`${FORM_INPUT} mono`} value={cron} onChange={(e) => setCron(e.target.value)} required />
        </label>
        <label className="text-step--1">
          <div className="mb-1 font-medium">Task description</div>
          <input className={FORM_INPUT} value={description} onChange={(e) => setDescription(e.target.value)} required />
        </label>
        <label className="text-step--1">
          <div className="mb-1 font-medium">Command (optional)</div>
          <input className={`${FORM_INPUT} mono`} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="optional shell command" />
        </label>
        <label className="text-step--1">
          <div className="mb-1 font-medium">Teammate ID (optional)</div>
          <input className={`${FORM_INPUT} mono`} value={teammateId} onChange={(e) => setTeammateId(e.target.value)} placeholder="scope run to teammate" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ScheduleHistoryModal({ schedule, onClose }: { schedule: any; onClose: () => void }) {
  const runs = useAsync(() => api.listScheduleRuns(schedule.id, 50), [schedule.id]);
  return (
    <Modal title={`History: ${schedule.name || schedule.id}`} onClose={onClose}>
      {runs.loading ? <LoadingState lines={4} /> : runs.error ? <ErrorState error={runs.error} onRetry={runs.reload} /> : (
        <div className="flex flex-col gap-2">
          {(runs.data?.runs || []).length === 0 ? (
            <div className="text-step--1 text-[var(--muted)]">No runs recorded yet.</div>
          ) : (
            (runs.data?.runs || []).map((r: any) => (
              <div key={r.id} className="rounded-lg border border-[var(--border-dim)] px-3 py-2 text-step--1">
                <div className="flex items-center justify-between gap-2">
                  <StatusBadge status={r.status} />
                  <span className="mono text-step--2 text-[var(--faint)]">{new Date(r.fired_at).toLocaleString()}</span>
                </div>
                {r.task_id ? <div className="mt-1 text-step--2 text-[var(--muted)]">task {r.task_id} · run {r.run_id || "—"}</div> : null}
                {r.error ? <div className="mt-1 text-[var(--danger)]">{r.error}</div> : null}
              </div>
            ))
          )}
        </div>
      )}
    </Modal>
  );
}
