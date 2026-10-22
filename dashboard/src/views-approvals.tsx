import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import {
  ApprovalRow,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  PageHeader,
  approvalState,
  useAsync,
} from "./components";
import type { ApprovalInboxItem } from "./types";

/**
 * The owner's inbox of approvals.
 *
 * One place for every request that is waiting on a human answer, across all
 * the workspaces: what was asked, which bot asked, which task it is for, and
 * what it will do once the answer is yes. An expired request is not hidden —
 * it is shown as expired, with the way to ask again.
 */
export function ApprovalsView() {
  const [state, setState] = useState<"pending" | "expired" | "resolved">("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inbox = useAsync(() => api.approvalsInbox(state), [state]);
  const counts = useAsync(async () => {
    const [pending, expired, resolved] = await Promise.all([
      api.approvalsInbox("pending"),
      api.approvalsInbox("expired"),
      api.approvalsInbox("resolved"),
    ]);
    return {
      pending: pending.approvals.length,
      expired: expired.approvals.length,
      resolved: resolved.approvals.length,
    };
  }, []);

  const decide = async (
    item: ApprovalInboxItem,
    decision: "approved" | "approved_forever" | "denied",
  ) => {
    setBusy(item.id);
    setNotice(null);
    try {
      const result = await api.decideApproval(item.id, decision);
      const resume = result.resume;
      if (resume && resume.outcome === "carried_out") {
        setNotice(`Approved — ${item.action} was carried out.`);
      } else if (resume && resume.outcome === "refused") {
        setNotice(`Approved, but the action did not run: ${resume.output}`);
      } else if (resume && resume.outcome === "waiting") {
        setNotice("Approved — one more decision is still needed.");
      } else if (decision === "denied") {
        setNotice("Rejected — nothing was performed.");
      }
      inbox.reload();
      counts.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };

  const reask = async (item: ApprovalInboxItem) => {
    setBusy(item.id);
    setNotice(null);
    try {
      await api.reaskApproval(item.id);
      setNotice("Asked again — a new request is waiting for you.");
      inbox.reload();
      counts.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };

  const sweep = async () => {
    setBusy("sweep");
    try {
      const result = await api.sweepApprovals();
      setNotice(
        result.count === 0
          ? "Nothing had expired."
          : `${result.count} expired request(s) closed. Nothing was performed.`,
      );
      inbox.reload();
      counts.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };

  const items = inbox.data?.approvals ?? [];

  return (
    <Page>
      <PageHeader
        eyebrow="Oversight"
        title="Approvals"
        description="Every request waiting on your answer, across your workspaces. Approving carries the exact action out — once, and only the action that was asked for."
        actions={
          <>
            <Button onClick={() => void sweep()} disabled={busy === "sweep"}>
              Close expired
            </Button>
            <Button onClick={() => { inbox.reload(); counts.reload(); }}>Refresh</Button>
          </>
        }
      />

      {counts.data ? (
        <div className="mb-5 flex flex-wrap gap-1.5">
          <Badge variant={counts.data.pending > 0 ? "warn" : "neutral"}>
            {counts.data.pending} awaiting you
          </Badge>
          <Badge variant={counts.data.expired > 0 ? "bad" : "neutral"}>
            {counts.data.expired} expired
          </Badge>
          <Badge variant="neutral">{counts.data.resolved} decided</Badge>
        </div>
      ) : null}

      {notice ? (
        <div
          className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--text-soft)]"
          role="status"
        >
          {notice}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {(["pending", "expired", "resolved"] as const).map((tab) => (
          <Button
            key={tab}
            variant={state === tab ? "primary" : undefined}
            onClick={() => setState(tab)}
          >
            {tab === "pending" ? "Awaiting you" : tab === "expired" ? "Expired" : "Decided"}
          </Button>
        ))}
      </div>

      {inbox.loading ? (
        <LoadingState lines={3} />
      ) : inbox.error ? (
        <ErrorState error={inbox.error} onRetry={inbox.reload} />
      ) : items.length === 0 ? (
        <EmptyState
          title={state === "pending" ? "Nothing is waiting on you" : "Nothing here"}
          hint={
            state === "pending"
              ? "When a bot asks for a privileged action, it appears here."
              : state === "expired"
                ? "Requests nobody answered in time would be listed here."
                : "Decided requests are kept as the record."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <ApprovalRow
              key={item.id}
              approval={item}
              busy={busy === item.id}
              onDecide={(decision) => void decide(item, decision)}
              onReask={() => void reask(item)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

/** The approvals a task is holding, with the state each one is in.
 *
 *  The server's rule and the dashboard's agree on what "pending" means: an
 *  undecided request whose time is up is dead, and offering a decision on it
 *  would be offering one that fails. */
export function taskApprovalStates(
  approvals: Array<{ decision: string; expires_at: string | null }>,
): Array<"pending" | "expired" | "resolved"> {
  return approvals.map((a) => approvalState(a));
}
