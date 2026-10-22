import { useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import type { Run } from "./types";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  ShortId,
  StatusBadge,
  TABLE_SHELL,
  TABLE_TD as TD,
  TABLE_TH as TH,
  FORM_INPUT_SM as FORM_INPUT,
  LOG_BLOCK,
  Button,
  BotChip,
  SectionLabel,
  Page,
  PageHeader,
  relativeTime,
  useAsync,
  runStatusLabel,
} from "./components";
import { EntityForm } from "./forms";

/* Plain render columns over the static runs data — the core-row-model only
 * treatment TanStack was giving this table, without the dependency. */
interface RunColumn {
  header: string;
  cell: (run: Run) => ReactNode;
}

const runColumns: RunColumn[] = [
  { header: "Run", cell: (run) => <ShortId id={run.id} /> },
  {
    header: "Status",
    cell: (run) => <StatusBadge status={run.status} label={runStatusLabel(run.status)} />,
  },
  {
    header: "Exit",
    cell: (run) => <span className="mono text-[var(--text-soft)]">{run.exit_code ?? "—"}</span>,
  },
  {
    header: "Runtime",
    cell: (run) => <span className="text-[var(--muted)]">{run.runtime}</span>,
  },
  {
    header: "Secs",
    cell: (run) => (
      <span className="mono text-[var(--text-soft)]">{Number(run.duration_s ?? 0).toFixed(1)}</span>
    ),
  },
];

function RunsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return <EmptyState title="No runs yet" hint="Run the task to produce execution evidence." />;
  }
  return (
    <div className={TABLE_SHELL}>
      <table className="w-full">
        <thead>
          <tr>
            {runColumns.map((column) => (
              <th key={column.header} className={TH}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="transition-colors hover:bg-[var(--surface-2)]">
              {runColumns.map((column) => (
                <td key={column.header} className={TD}>
                  {column.cell(run)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TaskDetailView({
  projectId,
  taskId,
  onBack,
}: {
  projectId: string;
  taskId: string;
  onBack: () => void;
}) {
  const view = useAsync(() => api.taskView(taskId), [taskId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [showPackage, setShowPackage] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [rollup, setRollup] = useState<Record<string, unknown> | null>(null);
  const teammates = useAsync(() => api.listTeammates(projectId), [projectId]);
  const delegations = useAsync(() => api.listTaskDelegations(taskId), [taskId]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const result = await fn();
      view.reload();
      return result;
    } catch (err) {
      notifyError(err);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const delegate = async () => {
    const toEl = document.getElementById("delegate-to") as HTMLSelectElement | null;
    const reasonEl = document.getElementById("delegate-reason") as HTMLInputElement | null;
    const depthEl = document.getElementById("delegate-depth") as HTMLInputElement | null;
    const to = toEl?.value || null;
    if (!toEl || !reasonEl || !to) return notifyError("Pick a bot to delegate to");
    try {
      await api.delegateTask(taskId, {
        from_teammate_id: task.owner_teammate_id ?? "",
        to_teammate_id: to,
        reason: reasonEl?.value || "",
        depth: Number(depthEl?.value || 1),
      });
      toEl.value = "";
      reasonEl.value = "";
      delegations.reload();
      view.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const decide = async (delegationId: string, decision: "accepted" | "declined") => {
    try {
      await api.decideDelegation(delegationId, decision);
      delegations.reload();
      view.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const cancelDelegation = async (delegationId: string) => {
    try {
      await api.cancelDelegation(delegationId, "cancelled from the task view");
      delegations.reload();
      view.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  if (view.loading || teammates.loading || delegations.loading) {
    return (
      <Page>
        <LoadingState lines={6} />
      </Page>
    );
  }
  if (view.error || !view.data || teammates.error || delegations.error) {
    return (
      <Page>
        <ErrorState error={view.error ?? teammates.error ?? delegations.error ?? "Task not found"} onRetry={view.reload} />
      </Page>
    );
  }

  const data = view.data;
  const { task, runs, artifacts, issue, reviews, pr_packages, approvals, children, parent } = data;
  // The approval this task is waiting on, if any: the owner decides it here
  // instead of having to find it in the approvals view.
  const pendingApproval = approvals?.find((a) => a.decision === "pending") ?? null;
  // Merge view-level delegations with the dedicated endpoint (deduped).
  const delegationRows = [
    ...data.delegations,
    ...(delegations.data?.delegations ?? []).filter(
      (d) => !data.delegations.some((v) => v.id === d.id),
    ),
  ];
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
  // The run that can still be stopped: the newest one that has not ended.
  const liveRun = [...runs].reverse().find((run) => run.status === "running") ?? null;
  const latestPackage = pr_packages.length > 0 ? pr_packages[pr_packages.length - 1] : null;
  const owner = task.owner_teammate_id
    ? teammates.data?.teammates.find((m) => m.id === task.owner_teammate_id)
    : undefined;

  return (
    <Page>
      <PageHeader
        eyebrow="Task"
        title={task.description || "Untitled task"}
        description={task.branch ? `branch ${task.branch}` : undefined}
        back={{ label: "Back to project", onClick: onBack }}
        actions={
          <>
            <span className="mono text-[var(--step-minus-1)] text-[var(--faint)]" title={task.id}>
              {task.id.slice(0, 10)}…
            </span>
            <StatusBadge status={task.status} />
            {task.blocked_reason ? (
              <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
                {task.blocked_reason}
              </span>
            ) : null}
          </>
        }
      />

      {pendingApproval ? (
        <div
          className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3"
          role="status"
        >
          <div className="min-w-0">
            <strong className="text-[var(--step-minus-1)] text-[var(--text)]">
              This task is waiting for your decision
            </strong>
            <div className="mt-0.5 text-[var(--step-minus-1)] text-[var(--muted)]">
              {pendingApproval.action}
              {pendingApproval.requester ? ` · asked by ${pendingApproval.requester}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() => void act("approval", () => api.decideApproval(pendingApproval.id, "approved"))}
            >
              Approve once
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() => void act("approval", () => api.decideApproval(pendingApproval.id, "approved_forever"))}
            >
              Forever
            </Button>
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() => void act("approval", () => api.decideApproval(pendingApproval.id, "denied"))}
            >
              Reject
            </Button>
          </div>
        </div>
      ) : null}

      {task.blocked_reason ? (
        <div
          className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3"
          role="status"
        >
          <strong className="text-[var(--step-minus-1)] text-[var(--warn)]">
            This task is blocked
          </strong>
          <span className="text-[var(--step-minus-1)] text-[var(--text)]">
            {task.blocked_reason}
          </span>
          {task.blocked_reason.includes("provider") ? (
            <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
              Connect a working model key in{" "}
              <a
                className="text-[var(--accent)] hover:underline"
                href={`#/p/${task.project_id}?tab=Providers`}
              >
                this workspace&rsquo;s Providers tab
              </a>
              , then run it again.
            </span>
          ) : null}
        </div>
      ) : null}

      {issue ? (
        <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <strong className="text-[var(--text)]">{issue.title}</strong>
          <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
            {issue.source}
            {issue.external_id ? ` · ${issue.external_id}` : ""}
          </span>
        </div>
      ) : null}

      {/* Owner */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Owner</SectionLabel>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          {owner ? (
            <BotChip persona={owner.persona || "bot"} id={owner.id} status={owner.status} />
          ) : (
            <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
              Unassigned — pick a bot to own this task.
            </span>
          )}
          <div className="flex items-center gap-2">
            <select
              id="assign-teammate"
              aria-label="Assign owner teammate"
              className={`${FORM_INPUT} max-w-56`}
            >
              <option value="">(select bot)</option>
              {teammates.data?.teammates.map((mate) => (
                <option key={mate.id} value={mate.id}>
                  {mate.persona || "Unnamed bot"} ({mate.id.slice(0, 10)}…)
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              onClick={() => {
                const el = document.getElementById("assign-teammate") as HTMLSelectElement | null;
                const id = el?.value || null;
                void api.assignTask(taskId, id).then(() => view.reload());
              }}
            >
              Assign
            </Button>
          </div>
        </div>
      </section>

      {/* Actions */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Actions</SectionLabel>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <Button variant="primary" disabled={!!busy} onClick={() => void act("run", () => api.runTask(taskId))}>
            {busy === "run" ? "Running…" : "Run"}
          </Button>
          <Button disabled={!!busy} onClick={() => void act("retry", () => api.retryTask(taskId))}>
            {busy === "retry" ? "Retrying…" : "Retry (new run)"}
          </Button>
          <Button
            variant="danger"
            disabled={!!busy}
            onClick={() => void act("cancel", () => api.cancelTask(taskId, "cancelled from the task view"))}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel task"}
          </Button>
          {liveRun ? (
            <Button
              variant="danger"
              disabled={!!busy}
              onClick={() => void act("stop", () => api.cancelRun(liveRun.id))}
            >
              {busy === "stop" ? "Stopping…" : "Stop run"}
            </Button>
          ) : null}
          <span className="mx-1 h-4 w-px bg-[var(--border)]" aria-hidden />
          <Button disabled={!!busy} onClick={() => void act("workspace", () => api.ensureWorkspace(taskId))}>
            Ensure workspace
          </Button>
          <Button disabled={!!busy} onClick={() => setShowKnowledge(true)}>
            Attach knowledge
          </Button>
          <span className="mx-1 h-4 w-px bg-[var(--border)]" aria-hidden />
          <Button disabled={!!busy} onClick={() => setShowReview(true)}>
            Submit review
          </Button>
          <Button disabled={!!busy} onClick={() => setShowPackage(true)}>
            Generate PR package
          </Button>
          <Button
            disabled={!!busy || !latestPackage}
            onClick={() => void act("approval", () => api.requestPackageApproval(taskId))}
          >
            Request package approval
          </Button>
          <Button
            disabled={!!busy}
            onClick={() =>
              void act("rollup", async () => {
                setRollup((await api.buildRollup(taskId)) as Record<string, unknown>);
              })
            }
          >
            Build roll-up
          </Button>
          <Button disabled={!!busy} onClick={() => view.reload()}>
            Refresh
          </Button>
        </div>
      </section>

      {showReview ? (
        <Modal title="Submit review" onClose={() => setShowReview(false)}>
          <EntityForm
            submitLabel="Submit review"
            fields={[
              { name: "reviewer_teammate_id", label: "Reviewer teammate ID", required: true },
              { name: "verdict", label: "Verdict", type: "select", options: ["accepted", "needs_work", "rejected"] },
              { name: "notes", label: "Notes", type: "textarea" },
              { name: "risks", label: "Risks (comma separated)" },
              { name: "run_id", label: "Run ID (optional)", placeholder: latestRun?.id },
            ]}
            onSubmit={async (values) => {
              await api.submitReview(taskId, {
                ...values,
                risks: values.risks.split(",").map((s) => s.trim()).filter(Boolean),
                run_id: values.run_id || latestRun?.id || "",
              });
              setShowReview(false);
            }}
          />
        </Modal>
      ) : null}
      {showPackage ? (
        <Modal title="Generate PR package" onClose={() => setShowPackage(false)}>
          <EntityForm
            submitLabel="Generate"
            fields={[
              { name: "title", label: "Title", required: true, placeholder: task.description },
              { name: "body", label: "Body", type: "textarea" },
            ]}
            onSubmit={async (values) => {
              await api.generatePackage(taskId, values);
              setShowPackage(false);
            }}
          />
        </Modal>
      ) : null}
      {showKnowledge ? (
        <Modal title="Attach knowledge evidence" onClose={() => setShowKnowledge(false)}>
          <EntityForm
            submitLabel="Search and attach"
            fields={[{ name: "query", label: "Query", required: true }]}
            onSubmit={async (values) => {
              await api.attachKnowledge(taskId, values.query, latestRun?.id ?? "");
              setShowKnowledge(false);
            }}
          />
        </Modal>
      ) : null}

      {/* Runs */}
      <section className="mb-6">
        <div className="mb-2 flex items-baseline justify-between">
          <SectionLabel>Runs</SectionLabel>
          {latestRun ? (
            <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
              {runs.length} total · latest {relativeTime(latestRun.started_at)}
            </span>
          ) : null}
        </div>
        <RunsTable runs={runs} />
        {latestRun ? (
          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[var(--text)]">Latest run</strong>
              <ShortId id={latestRun.id} />
              <StatusBadge status={latestRun.status} label={runStatusLabel(latestRun.status)} />
            </div>
            <div className="mono mt-2 text-[var(--step-minus-2)] text-[var(--faint)]">
              command: {latestRun.command || "—"} · {Number(latestRun.duration_s ?? 0).toFixed(1)}s
              {latestRun.provider_id ? ` · provider ${latestRun.provider_id.slice(0, 12)}…` : ""}
            </div>
            {latestRun.status === "failed" && latestRun.exit_code !== null && (
              <div className="mt-3 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--danger)]">
                <div>
                  Run failed with exit code <span className="mono">{latestRun.exit_code}</span>.
                </div>
                {latestRun.stderr ? (
                  <>
                    <div className="mt-1">Error output:</div>
                    <pre className={LOG_BLOCK}>{latestRun.stderr.slice(0, 2000)}</pre>
                  </>
                ) : null}
                <Button
                  variant="danger"
                  onClick={() => void act("retry", () => api.retryTask(taskId))}
                >
                  Retry (new run)
                </Button>
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <Button
                onClick={() =>
                  void act("patch", () => api.capturePatch(taskId, latestRun.id).then(() => null))
                }
              >
                Capture patch
              </Button>
              <Button
                onClick={() =>
                  void act("approval", () =>
                    api.requestApproval(latestRun.id, "deploy").then(() => null),
                  )
                }
              >
                Request run approval
              </Button>
            </div>
            {latestRun.output_excerpt ? (
              <pre className={LOG_BLOCK}>{latestRun.output_excerpt.slice(0, 2000)}</pre>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Handoffs (delegation) */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Handoffs (delegation)</SectionLabel>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="text-[var(--text)]">Delegate to another bot</strong>
            <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
              Bounded depth (max 5), cycle-checked.
            </span>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); delegate(); }} className="flex flex-wrap items-end gap-2">
            <select id="delegate-to" aria-label="Delegate to teammate" className={`${FORM_INPUT} max-w-56`}>
              <option value="">(select bot)</option>
              {teammates.data?.teammates.map((mate) => (
                <option key={mate.id} value={mate.id}>
                  {mate.persona || "Unnamed bot"} ({mate.id.slice(0, 10)}…)
                </option>
              ))}
            </select>
            <input
              id="delegate-reason"
              aria-label="Reason"
              placeholder="Why hand off?"
              className={`${FORM_INPUT} min-w-56 flex-1`}
            />
            <input
              id="delegate-depth"
              type="number"
              min="1"
              max="5"
              defaultValue="1"
              aria-label="Depth"
              className={`${FORM_INPUT} w-20`}
            />
            <Button variant="primary" type="submit">
              Delegate
            </Button>
          </form>
          {delegationRows.length > 0 ? (
            <>
              <div className={`mt-3 ${TABLE_SHELL}`}>
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={TH}>From</th>
                      <th className={TH}>To</th>
                      <th className={TH}>Depth</th>
                      <th className={TH}>Status</th>
                      <th className={TH}>Reason</th>
                      <th className={TH}>Child task</th>
                      <th className={TH}>Result</th>
                      <th className={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {delegationRows.map((d) => {
                      const pending = d.status === "pending";
                      const open = d.status === "pending" || d.status === "accepted";
                      const fromName = teammates.data?.teammates.find((m) => m.id === d.from_teammate_id)?.persona || d.from_teammate_id.slice(0, 10);
                      const toName = teammates.data?.teammates.find((m) => m.id === d.to_teammate_id)?.persona || d.to_teammate_id.slice(0, 10);
                      return (
                        <tr key={d.id} className="transition-colors hover:bg-[var(--surface-2)]">
                          <td className={`${TD} mono text-[var(--text-soft)]`}>{fromName}</td>
                          <td className={`${TD} mono text-[var(--text-soft)]`}>{toName}</td>
                          <td className={`${TD} mono`}>{d.depth}</td>
                          <td className={TD}>
                            <StatusBadge status={d.status} />
                          </td>
                          <td className={`${TD} text-[var(--muted)]`}>{d.reason || "—"}</td>
                          <td className={TD}>
                            {d.child_task_id ? (
                              <a
                                className="text-[var(--accent)] hover:underline"
                                href={`#/p/${projectId}/t/${d.child_task_id}`}
                              >
                                <ShortId id={d.child_task_id} />
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className={`${TD} max-w-[260px] text-[var(--muted)]`}>
                            {d.result ? d.result.slice(0, 200) : "—"}
                            {d.finished_at ? (
                              <div className="mt-0.5 text-[var(--step-minus-2)] text-[var(--faint)]">
                                finished {relativeTime(d.finished_at)}
                              </div>
                            ) : null}
                          </td>
                          <td className={TD}>
                            {pending ? (
                              <div className="flex items-center gap-1.5">
                                <Button variant="primary" onClick={() => void decide(d.id, "accepted")}>
                                  Accept
                                </Button>
                                <Button variant="danger" onClick={() => void decide(d.id, "declined")}>
                                  Decline
                                </Button>
                                <Button onClick={() => void cancelDelegation(d.id)}>Cancel</Button>
                              </div>
                            ) : open ? (
                              <Button onClick={() => void cancelDelegation(d.id)}>Cancel</Button>
                            ) : (
                              <span className="text-[var(--muted)]">{d.decided_at ?? ""}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[var(--step-minus-1)] text-[var(--muted)]">
                Accepting a delegation makes the target bot the task owner. Child results flow back
                through the response channel (see the project&apos;s Messages tab).
              </p>
            </>
          ) : (
            <EmptyState title="No delegations yet" hint="Hand a task from one bot to another here." />
          )}
        </div>
      </section>

      {/* Delegation tree */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Delegation tree</SectionLabel>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center gap-2 text-[var(--step-minus-1)]">
            <span className="text-[var(--muted)]">Parent:</span>
            {parent ? (
              <a
                className="text-[var(--accent)] hover:underline"
                href={`#/p/${projectId}/t/${parent.id}`}
              >
                <ShortId id={parent.id} /> {parent.description || "Untitled"}
              </a>
            ) : (
              <span className="text-[var(--muted)]">none — this is a root task</span>
            )}
          </div>
          <div className="mt-3">
            <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
              Children ({children.length}):
            </span>
            {children.length === 0 ? (
              <div className="mt-1 text-[var(--step-minus-1)] text-[var(--faint)]">
                No child tasks yet — bots create them when they delegate with a command.
              </div>
            ) : (
              <div className="mt-1.5 flex flex-col gap-1">
                {children.map((child) => {
                  const link = delegationRows.find((d) => d.child_task_id === child.id);
                  return (
                    <div
                      key={child.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-[var(--step-minus-1)] transition-colors hover:bg-[var(--surface-2)]"
                    >
                      <span className="min-w-0">
                        <a
                          className="text-[var(--accent)] hover:underline"
                          href={`#/p/${projectId}/t/${child.id}`}
                        >
                          <ShortId id={child.id} />
                        </a>{" "}
                        <span className="text-[var(--text-soft)]">{child.description || "Untitled"}</span>{" "}
                        <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
                          via {link
                            ? `${teammates.data?.teammates.find((m) => m.id === link.to_teammate_id)?.persona || link.to_teammate_id.slice(0, 10)} · ${link.status}`
                            : "delegation"}
                        </span>
                      </span>
                      <StatusBadge status={child.status} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      <WorkspacePanel taskId={taskId} />

      {/* Artifacts */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Artifacts</SectionLabel>
        {artifacts.length > 0 ? (
          <div className={TABLE_SHELL}>
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>ID</th>
                  <th className={TH}>Type</th>
                  <th className={TH}>Verification</th>
                  <th className={TH}>Summary</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((artifact) => (
                  <tr key={artifact.id} className="transition-colors hover:bg-[var(--surface-2)]">
                    <td className={TD}>
                      <ShortId id={artifact.id} />
                    </td>
                    <td className={`${TD} mono`}>{artifact.type}</td>
                    <td className={TD}>
                      <StatusBadge status={artifact.verification_status} />
                    </td>
                    <td className={`${TD} text-[var(--muted)]`}>{artifact.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No artifacts" hint="Runs produce test-log and transcript artifacts." />
        )}
      </section>

      {/* Reviews */}
      <section className="mb-6">
        <SectionLabel className="mb-2">Reviews</SectionLabel>
        {reviews.length > 0 ? (
          <div className="flex flex-col gap-2">
            {reviews.map((review) => (
              <div key={review.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">{review.id}</span>
                  <StatusBadge status={review.verdict} />
                </div>
                <div className="mt-1.5 text-[var(--step-minus-1)] text-[var(--text-soft)]">
                  {review.notes || "No notes"}
                </div>
                {review.risks.length > 0 ? (
                  <div className="mt-1 text-[var(--step-minus-2)] text-[var(--faint)]">
                    Risks: {review.risks.join(", ")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No reviews" hint="A distinct reviewer records verdict and risks here." />
        )}
      </section>

      {/* PR packages */}
      <section className="mb-6">
        <SectionLabel className="mb-2">PR packages</SectionLabel>
        {pr_packages.length > 0 ? (
          <div className="flex flex-col gap-2">
            {pr_packages.map((pkg) => (
              <div key={pkg.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <strong className="text-[var(--text)]">{pkg.title}</strong>
                <div className="mono mt-1 text-[var(--step-minus-2)] text-[var(--faint)]">
                  {pkg.base_branch} ← {pkg.head_branch} · digest {pkg.digest.slice(0, 12)}…
                </div>
                <div className="mt-1 text-[var(--step-minus-2)] text-[var(--muted)]">{pkg.patch_summary}</div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No PR packages" hint="Generate a reviewable candidate package." />
        )}
      </section>

      {rollup ? (
        <section className="mb-6">
          <SectionLabel className="mb-2">Roll-up</SectionLabel>
          <pre className={LOG_BLOCK}>{JSON.stringify(rollup, null, 2)}</pre>
        </section>
      ) : null}
      <div className="mono mt-6 text-[var(--step-minus-2)] text-[var(--faint)]">
        Project <ShortId id={projectId} />
      </div>
    </Page>
  );
}

/** Isolated workspace browser: file list → content, plus the uncommitted diff. */
function WorkspacePanel({ taskId }: { taskId: string }) {
  const files = useAsync(() => api.workspaceFiles(taskId), [taskId]);
  const diff = useAsync(() => api.workspaceDiff(taskId), [taskId]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const openFile = async (path: string) => {
    setOpenPath(path);
    setContent(null);
    setContentError(null);
    try {
      const res = await api.workspaceFile(taskId, path);
      setContent(res.content);
    } catch (err) {
      setContentError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <SectionLabel>Task checkout</SectionLabel>
          <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
            this task&apos;s isolated working copy
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              setShowDiff((v) => !v);
              diff.reload();
            }}
          >
            {showDiff ? "Hide diff" : "Show diff"}
          </Button>
          <Button
            onClick={() => {
              files.reload();
              diff.reload();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>
      {showDiff ? (
        <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <strong className="text-[var(--text)]">Uncommitted changes</strong>
          {diff.loading ? (
            <LoadingState lines={3} />
          ) : diff.error ? (
            <ErrorState error={diff.error} onRetry={diff.reload} />
          ) : diff.data?.exists && diff.data.diff ? (
            <pre className={LOG_BLOCK}>{diff.data.diff.slice(0, 8000)}</pre>
          ) : (
            <div className="mt-2 text-[var(--step-minus-1)] text-[var(--muted)]">
              No uncommitted changes (or the workspace does not exist yet — use “Ensure workspace”).
            </div>
          )}
        </div>
      ) : null}
      {files.loading && !files.data ? (
        <LoadingState lines={4} />
      ) : files.error ? (
        <ErrorState error={files.error} onRetry={files.reload} />
      ) : files.data && files.data.files.length > 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mono mb-3 text-[var(--step-minus-2)] text-[var(--faint)]">{files.data.root}</div>
          <div className="flex flex-wrap gap-1.5">
            {files.data.files.map((f) => (
              <Button
                key={f.path}
                variant={openPath === f.path ? "primary" : "default"}
                onClick={() => void openFile(f.path)}
                title={`${f.size} bytes`}
              >
                {f.path}
              </Button>
            ))}
          </div>
          {openPath ? (
            <div className="mt-3">
              <strong className="mono text-[var(--step-minus-1)] text-[var(--text)]">{openPath}</strong>
              {contentError ? (
                <div className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--danger)]" role="alert">
                  {contentError}
                </div>
              ) : content === null ? (
                <LoadingState lines={3} />
              ) : (
                <pre className={LOG_BLOCK}>{content.slice(0, 8000)}</pre>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState
          title="No workspace files"
          hint="Run the task or press “Ensure workspace” to materialize its isolated checkout."
        />
      )}
    </section>
  );
}
