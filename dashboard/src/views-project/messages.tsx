import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, EmptyState, ErrorState, FORM_SELECT, LoadingState, PILL_SHELL, TABLE_TD, TABLE_TH, useAsync } from "../components";
export function MessagesTab({ projectId }: { projectId: string }) {
  const [scope, setScope] = useState("");
  const msgs = useAsync(() => api.projectMessages(projectId, scope || undefined), [projectId, scope]);
  const mates = useAsync(() => api.listTeammates(projectId), [projectId]);
  useEffect(() => {
    // Poll the response channel while the tab is open.
    const t = setInterval(msgs.reload, 5000);
    return () => clearInterval(t);
  }, [msgs.reload]);
  const nameOf = (id: string | null): string => {
    if (!id) return "—";
    return mates.data?.teammates.find((m) => m.id === id)?.persona || id.slice(0, 10);
  };
  const rows = msgs.data?.messages ?? [];
  return (
    <section>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <select className={FORM_SELECT} value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Filter by recipient">
          <option value="">All recipients</option>
          {(mates.data?.teammates ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              To: {m.persona}
            </option>
          ))}
        </select>
        <Button onClick={msgs.reload}>Refresh</Button>
      </div>
      {msgs.loading && !msgs.data ? (
        <LoadingState />
      ) : msgs.error ? (
        <ErrorState error={msgs.error} onRetry={msgs.reload} />
      ) : rows.length === 0 ? (
        <EmptyState title="No messages yet" hint="Bot-to-bot responses and board messages appear here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={TABLE_TH}>Kind</th>
                <th className={TABLE_TH}>From</th>
                <th className={TABLE_TH}>To</th>
                <th className={TABLE_TH}>Board</th>
                <th className={TABLE_TH}>Content</th>
                <th className={TABLE_TH}>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr className="transition-colors hover:bg-[var(--surface-2)]" key={m.id}>
                  <td className={TABLE_TD}>
                    <span className={PILL_SHELL}>{m.kind}</span>
                  </td>
                  <td className={TABLE_TD}>{nameOf(m.from_teammate_id)}</td>
                  <td className={TABLE_TD}>{m.to_teammate_id ? nameOf(m.to_teammate_id) : "everyone"}</td>
                  <td className={TABLE_TD}>{m.board_name || "—"}</td>
                  <td style={{ maxWidth: 420, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</td>
                  <td className="text-[var(--muted)]">{new Date(m.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
