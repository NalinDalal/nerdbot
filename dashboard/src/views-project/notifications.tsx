import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, CARD_SHELL, EmptyState, ErrorState, LoadingState, Modal, ShortId, StatusBadge, TABLE_TD, TABLE_TH, useAsync } from "../components";
import { EntityForm } from "../forms";
export function NotificationsTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.listNotifications(projectId), [projectId]);
  const [showSend, setShowSend] = useState(false);
  const [showTarget, setShowTarget] = useState(false);
  const targets = useAsync(() => api.listWebhookTargets(projectId), [projectId]);

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
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowSend(true)}>
          Send notification
        </Button>
        <Button onClick={() => setShowTarget(true)}>Add webhook target</Button>
        <Button onClick={() => act(() => api.sweepWebhooks())}>Sweep due webhooks</Button>
        <Button onClick={list.reload}>Refresh</Button>
      </div>
      <p className="text-[var(--muted)]" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
        Deliveries run only when swept here or by OS cron (nerdbot deliveries-sweep).
        There is no background delivery recovery in NerdBot.
      </p>
      {showSend ? (
        <Modal title="Send notification" onClose={() => setShowSend(false)}>
          <EntityForm
            submitLabel="Send"
            fields={[
              { name: "channel", label: "Channel", type: "select", options: ["outbox", "webhook-out"] },
              { name: "kind", label: "Kind", required: true, placeholder: "deploy.done" },
              { name: "payload", label: "Payload (JSON object)", placeholder: '{"ref": "main"}' },
              { name: "target_url", label: "Target URL override (webhook-out only)" },
            ]}
            onSubmit={async (values) => {
              let payload: Record<string, unknown> = {};
              try {
                payload = values.payload ? (JSON.parse(values.payload) as Record<string, unknown>) : {};
              } catch {
                throw new Error("Payload is not valid JSON");
              }
              await api.sendNotification(projectId, { ...values, payload });
              setShowSend(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {showTarget ? (
        <Modal title="Add webhook target" onClose={() => setShowTarget(false)}>
          <EntityForm
            submitLabel="Add target"
            fields={[{ name: "url", label: "HTTPS URL (public hosts only)", required: true }]}
            onSubmit={async (values) => {
              await api.addWebhookTarget(projectId, values.url);
              setShowTarget(false);
              targets.reload();
            }}
          />
        </Modal>
      ) : null}
      {targets.data && targets.data.targets.length > 0 ? (
        <div className={CARD_SHELL}>
          <strong>Targets</strong>
          {targets.data.targets.map((target) => (
            <div className="flex items-center gap-3 mono text-[var(--muted)]" key={String(target.id)} style={{ justifyContent: "space-between" }}>
              <span>{String(target.url)}</span>
              <Button
                onClick={() =>
                  act(async () => {
                    await api.deleteWebhookTarget(String(target.id));
                    targets.reload();
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.notifications.length > 0 ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={TABLE_TH}>ID</th>
              <th className={TABLE_TH}>Channel</th>
              <th className={TABLE_TH}>Kind</th>
              <th className={TABLE_TH}>Status</th>
              <th className={TABLE_TH}>Attempts</th>
              <th className={TABLE_TH}>Next attempt</th>
              <th className={TABLE_TH}>Last error</th>
              <th className={TABLE_TH}></th>
            </tr>
          </thead>
          <tbody>
            {list.data.notifications.map((note) => (
              <tr className="transition-colors hover:bg-[var(--surface-2)]" key={note.id}>
                <td className={TABLE_TD}>
                  <ShortId id={note.id} />
                </td>
                <td className="text-[var(--muted)]">{note.channel}</td>
                <td className={TABLE_TD}>{note.kind}</td>
                <td className={TABLE_TD}>
                  <div className="flex items-center gap-3" style={{ gap: 6 }}>
                    <StatusBadge status={note.status} />
                    {note.locked ? (
                      <span className="inline-flex items-center rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-step--2 font-medium text-[var(--muted)]">locked</span>
                    ) : null}
                  </div>
                </td>
                <td className={`${TABLE_TD} mono`}>{note.attempts}</td>
                <td className="mono text-[var(--muted)]">{note.next_attempt_at ?? ""}</td>
                <td
                  className="mono text-[var(--muted)]"
                  style={{ maxWidth: 320, overflowWrap: "anywhere" }}
                  title={note.last_error || undefined}
                >
                  {note.last_error}
                </td>
                <td className={TABLE_TD}>
                  <div className="flex items-center gap-3">
                    <Button onClick={() => act(() => api.deliverNotification(note.id))}>Deliver</Button>
                    <Button onClick={() => act(() => api.unlockNotification(note.id))}>Unlock</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No notifications" hint="Send one to record or deliver it." />
      )}
    </div>
  );
}
