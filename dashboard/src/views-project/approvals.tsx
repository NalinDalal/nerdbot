import { useEffect } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Approval } from "../types";
import { Button, CARD_SHELL, EmptyState, ErrorState, LoadingState, PILL_SHELL, ShortId, StatusBadge, TABLE_TD, TABLE_TH, approvalIsPending, useAsync } from "../components";
export function ApprovalsTab({ projectId }: { projectId: string }) {
  // Merge project-wide approvals with per-run ones: legacy rows may have an
  // empty project_id, so the project query alone can miss them.
  const inbox = useAsync(async () => {
    const byId = new Map<string, Approval>();
    const projectRows = (await api.projectApprovals(projectId)).approvals;
    for (const approval of projectRows) byId.set(approval.id, approval);
    const runList = (await api.projectRuns(projectId)).runs;
    for (const run of runList) {
      const list = await api.listRunApprovals(run.id);
      for (const approval of list.approvals) {
        if (!byId.has(approval.id)) byId.set(approval.id, approval);
      }
    }
    return [...byId.values()];
  }, [projectId]);

  // Poll while anything awaits a decision so bot requests show up unprompted.
  // Only genuinely actionable approvals count: an expired one can never be
  // decided, so polling for it would spin forever.
  useEffect(() => {
    const pendingCount = (inbox.data ?? []).filter((a) => approvalIsPending(a)).length;
    if (!pendingCount) return;
    const t = setInterval(inbox.reload, 8000);
    return () => clearInterval(t);
  }, [inbox.data, inbox.reload]);

  const decide = async (
    id: string,
    decision: "approved" | "approved_forever" | "denied",
  ) => {
    try {
      await api.decideApproval(id, decision);
      inbox.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const rows = inbox.data ?? [];
  // Actionable: still pending and not past its expiry.
  const pending = rows.filter((approval) => approvalIsPending(approval));
  // Dead: never decided and past its expiry. The API answers 410 for these,
  // so they are shown as history, never as a decision to make.
  const expired = rows.filter(
    (approval) => !approvalIsPending(approval) && (approval.decision ?? "pending") === "pending",
  );
  const expiredIds = new Set(expired.map((approval) => approval.id));
  const decided = rows.filter((approval) => (approval.decision ?? "pending") !== "pending");
  const history = [...decided, ...expired];

  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button
          onClick={async () => {
            try {
              await api.purgeApprovals(projectId);
              inbox.reload();
            } catch (err) {
              notifyError(err);
            }
          }}
        >
          Purge expired
        </Button>
        <Button onClick={inbox.reload}>Refresh</Button>
      </div>
      {inbox.loading && !inbox.data ? (
        <LoadingState />
      ) : inbox.error ? (
        <ErrorState error={inbox.error} onRetry={inbox.reload} />
      ) : pending.length > 0 ? (
        pending.map((approval) => (
          <div className={CARD_SHELL} key={approval.id}>
            <div className="flex items-center gap-3" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{approval.action || "approval"}</strong>{" "}
                <span className="mono text-[var(--muted)]">{approval.id}</span>{" "}
                <span className={PILL_SHELL}>{approval.requester}</span>{" "}
                {approval.task_id ? (
                  <a href={`#/p/${projectId}/t/${approval.task_id}`}>
                    task <ShortId id={approval.task_id} />
                  </a>
                ) : null}
                <div className="mono text-[var(--muted)]" style={{ fontSize: 12 }}>
                  digest: {approval.digest || "—"}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button variant="primary" onClick={() => void decide(approval.id, "approved")}>
                  Approve
                </Button>
                <Button variant="primary"
                  onClick={() => void decide(approval.id, "approved_forever")}
                >
                  Approve Forever
                </Button>
                <Button variant="danger" onClick={() => void decide(approval.id, "denied")}>
                  Deny
                </Button>
              </div>
            </div>
          </div>
        ))
      ) : (
        <EmptyState title="Inbox empty" hint="No pending approvals. Decided ones stay queryable per run." />
      )}
      {history.length > 0 ? (
        <>
          <h2>Decision history</h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TABLE_TH}>ID</th>
                  <th className={TABLE_TH}>Action</th>
                  <th className={TABLE_TH}>Requester</th>
                  <th className={TABLE_TH}>Decision</th>
                  <th className={TABLE_TH}>Executed</th>
                </tr>
              </thead>
              <tbody>
                {history.map((approval) => (
                  <tr className="transition-colors hover:bg-[var(--surface-2)]" key={approval.id}>
                    <td className={TABLE_TD}>
                      <ShortId id={approval.id} />
                    </td>
                    <td className={TABLE_TD}>{approval.action}</td>
                    <td className={TABLE_TD}>{approval.requester}</td>
                    <td className={TABLE_TD}>
                      <StatusBadge
                        status={expiredIds.has(approval.id) ? "expired" : approval.decision}
                      />
                    </td>
                    <td className="text-[var(--muted)]">
                      {approval.executed_at ? new Date(approval.executed_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
