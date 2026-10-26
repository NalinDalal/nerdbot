import { useEffect, useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import {
  ApprovalRow,
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

  /**
   * Ask the server to heal what it can, once, when the inbox opens.
   *
   * A decision that landed but was never carried out — the server died
   * between the two — is only found by the sweep, and nobody is going to
   * press a button for it. The sweep is idempotent and it is the owner's
   * own server, so asking on the way in is the honest thing to do.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .sweepApprovals()
      .then((result) => {
        if (cancelled) return;
        if (result.count || result.recovered?.length) {
          inbox.reload();
          counts.reload();
        }
      })
      .catch(() => {
        /* A sweep that fails is not the inbox's problem to report. */
      });
    return () => {
      cancelled = true;
    };
    // Once, when the inbox opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setNotice(`Approved. ${item.action} was carried out.`);
      } else if (resume && resume.outcome === "refused") {
        setNotice(`Approved, but the action did not run: ${resume.output}`);
      } else if (resume && resume.outcome === "waiting") {
        setNotice("Approved. One more decision is still needed.");
      } else if (decision === "denied") {
        setNotice("Rejected. Nothing was performed.");
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
      setNotice("Asked again. A new request is waiting for you.");
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
        title="Approvals"
        description="Requests that need your answer. Approving carries out only the exact action that was asked for."
        actions={
          <>
            <Button onClick={() => void sweep()} disabled={busy === "sweep"}>
              Close expired
            </Button>
            <Button onClick={() => { inbox.reload(); counts.reload(); }}>Refresh</Button>
          </>
        }
      />

      {notice ? (
        <div
          className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 text-[var(--text-soft)]"
          role="status"
        >
          {notice}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Approval state">
        {(["pending", "expired", "resolved"] as const).map((tab) => {
          const label = tab === "pending" ? "Awaiting you" : tab === "expired" ? "Expired" : "Decided";
          const count = counts.data?.[tab] ?? 0;
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={state === tab}
              onClick={() => setState(tab)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-step--1 transition-colors ${
                state === tab
                  ? "bg-[var(--surface-3)] text-[var(--text)]"
                  : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
              }`}
            >
              {label}
              <span className="text-step--2 text-[var(--faint)]">{count}</span>
            </button>
          );
        })}
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
