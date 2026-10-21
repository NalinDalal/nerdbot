import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useState } from "react";
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
  useAsync,
  runStatusLabel,
} from "./components";
import { EntityForm } from "./forms";

const runColumnsHelper = createColumnHelper<Run>();

const runColumns = [
  runColumnsHelper.accessor("id", {
    header: "Run",
    cell: (info) => <ShortId id={info.getValue()} />,
  }),
  runColumnsHelper.accessor("status", {
    header: "Status",
    cell: (info) => (
      <StatusBadge status={info.getValue()} label={runStatusLabel(info.getValue())} />
    ),
  }),
  runColumnsHelper.accessor("exit_code", {
    header: "Exit",
    cell: (info) => <span className="mono">{info.getValue() ?? "—"}</span>,
  }),
  runColumnsHelper.accessor("runtime", {
    header: "Runtime",
    cell: (info) => <span className="muted">{info.getValue()}</span>,
  }),
  runColumnsHelper.accessor("duration_s", {
    header: "Secs",
    cell: (info) => <span className="mono">{Number(info.getValue() ?? 0).toFixed(1)}</span>,
  }),
];

function RunsTable({ runs }: { runs: Run[] }) {
  // TanStack Table v8 is intentionally not compiler-memoized; data is static per render.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: runs,
    columns: runColumns,
    getCoreRowModel: getCoreRowModel(),
  });
  if (runs.length === 0) {
    return <EmptyState title="No runs yet" hint="Run the task to produce execution evidence." />;
  }
  return (
    <table className="data">
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th key={header.id}>
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
      <div>
        <LoadingState lines={6} />
      </div>
    );
  }
  if (view.error || !view.data || teammates.error || delegations.error) {
    return (
      <div>
        <button onClick={onBack}>← Back to project</button>
        <ErrorState error={view.error ?? teammates.error ?? delegations.error ?? "Task not found"} onRetry={view.reload} />
      </div>
    );
  }

  const data = view.data;
  const { task, runs, artifacts, issue, reviews, pr_packages, children, parent } = data;
  // Merge view-level delegations with the dedicated endpoint (deduped).
  const delegationRows = [
    ...data.delegations,
    ...(delegations.data?.delegations ?? []).filter(
      (d) => !data.delegations.some((v) => v.id === d.id),
    ),
  ];
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const latestPackage = pr_packages.length > 0 ? pr_packages[pr_packages.length - 1] : null;

  return (
    <div>
      <button onClick={onBack}>← Back to project</button>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <h1>{task.description || "Untitled task"}</h1>
        <StatusBadge status={task.status} />
      </div>
      <p className="subtitle mono">
        {task.id}
        {task.branch ? ` · branch ${task.branch}` : ""}
      </p>
      {issue ? (
        <div className="card">
          <strong>Issue:</strong> {issue.title}
          <div className="muted" style={{ fontSize: 12 }}>
            {issue.source}
            {issue.external_id ? ` · ${issue.external_id}` : ""}
          </div>
        </div>
      ) : null}

      <h2>Owner</h2>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            {task.owner_teammate_id ? (
              <>
                <strong>Owner:</strong>{" "}
                <span className="mono muted">{task.owner_teammate_id}</span>{" "}
                {teammates.data?.teammates.find((m) => m.id === task.owner_teammate_id) ? (
                  <span> · {teammates.data.teammates.find((m) => m.id === task.owner_teammate_id)!.persona || "bot"}</span>
                ) : null}
              </>
            ) : (
              <span>Unassigned — pick a bot to own this task.</span>
            )}
          </div>
          <div className="row">
            <select id="assign-teammate" aria-label="Assign owner teammate">
              <option value="">(select bot)</option>
              {teammates.data?.teammates.map((mate) => (
                <option key={mate.id} value={mate.id}>
                  {mate.persona || "Unnamed bot"} ({mate.id.slice(0, 10)}…)
                </option>
              ))}
            </select>
            <button
              className="primary"
              onClick={() => {
                const el = document.getElementById("assign-teammate") as HTMLSelectElement | null;
                const id = el?.value || null;
                void api.assignTask(taskId, id).then(() => view.reload());
              }}
            >
              Assign
            </button>
          </div>
        </div>
      </div>

      <h2>Actions</h2>
      <div className="row">
        <button className="primary" disabled={!!busy} onClick={() => void act("run", () => api.runTask(taskId))}>
          {busy === "run" ? "Running…" : "Run"}
        </button>
        <button disabled={!!busy} onClick={() => void act("retry", () => api.retryTask(taskId))}>
          {busy === "retry" ? "Retrying…" : "Retry (new run)"}
        </button>
        <button
          className="danger"
          disabled={!!busy}
          onClick={() => void act("cancel", () => api.cancelTask(taskId, "cancelled from the task view"))}
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel task"}
        </button>
        <button disabled={!!busy} onClick={() => void act("workspace", () => api.ensureWorkspace(taskId))}>
          Ensure workspace
        </button>
        <button disabled={!!busy} onClick={() => setShowKnowledge(true)}>
          Attach knowledge
        </button>
        <button disabled={!!busy} onClick={() => setShowReview(true)}>
          Submit review
        </button>
        <button disabled={!!busy} onClick={() => setShowPackage(true)}>
          Generate PR package
        </button>
        <button
          disabled={!!busy || !latestPackage}
          onClick={() => void act("approval", () => api.requestPackageApproval(taskId))}
        >
          Request package approval
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            void act("rollup", async () => {
              setRollup((await api.buildRollup(taskId)) as Record<string, unknown>);
            })
          }
        >
          Build roll-up
        </button>
        <button disabled={!!busy} onClick={() => view.reload()}>
          Refresh
        </button>
      </div>

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

      <h2>Runs</h2>
      <RunsTable runs={runs} />
      {latestRun ? (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>
            Latest run <ShortId id={latestRun.id} />
          </strong>{" "}
          <StatusBadge status={latestRun.status} label={runStatusLabel(latestRun.status)} />
          <div className="muted" style={{ fontSize: 12, margin: "4px 0" }}>
            command: <span className="mono">{latestRun.command || "—"}</span> ·{" "}
            {Number(latestRun.duration_s ?? 0).toFixed(1)}s
            {latestRun.provider_id ? ` · provider ${latestRun.provider_id.slice(0, 12)}…` : ""}
          </div>
          {latestRun.status === "failed" && latestRun.exit_code !== null && (
            <div className="error-box" style={{ marginTop: 8, padding: 8, fontSize: 12 }}>
              Run failed with exit code <span className="mono">{latestRun.exit_code}</span>.
              {latestRun.stderr ? (
                <>
                  <div style={{ marginTop: 4 }}>Error output:</div>
                  <pre className="log" style={{ marginTop: 4, fontSize: 11, maxHeight: 200, overflow: "auto" }}>
                    {latestRun.stderr.slice(0, 2000)}
                  </pre>
                </>
              ) : null}
              <button
                className="primary"
                style={{ marginTop: 6, padding: "4px 10px", fontSize: 12 }}
                onClick={() => void act("retry", () => api.retryTask(taskId))}
              >
                Retry (new run)
              </button>
            </div>
          )}
          <div className="row">
            <button
              onClick={() =>
                void act("patch", () => api.capturePatch(taskId, latestRun.id).then(() => null))
              }
            >
              Capture patch
            </button>
            <button
              onClick={() =>
                void act("approval", () =>
                  api.requestApproval(latestRun.id, "deploy").then(() => null),
                )
              }
            >
              Request run approval
            </button>
          </div>
          {latestRun.output_excerpt ? (
            <pre className="log" style={{ marginTop: 12 }}>
              {latestRun.output_excerpt.slice(0, 2000)}
            </pre>
          ) : null}
        </div>
      ) : null}

      <h2>Handoffs (delegation)</h2>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <strong>Delegate to another bot</strong>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            Bounded depth (max 5), cycle-checked.
          </span>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); delegate(); }} className="row" style={{ gap: 8, alignItems: "end" }}>
          <select id="delegate-to" aria-label="Delegate to teammate">
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
            style={{ minWidth: 220 }}
          />
          <input
            id="delegate-depth"
            type="number"
            min="1"
            max="5"
            value="1"
            aria-label="Depth"
            style={{ width: 70 }}
          />
          <button className="primary" type="submit">Delegate</button>
        </form>
        {delegationRows.length > 0 ? (
          <>
            <table className="data" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Depth</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th>Child task</th>
                  <th>Result</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {delegationRows.map((d) => {
                  const pending = d.status === "pending";
                  const open = d.status === "pending" || d.status === "accepted";
                  const fromName = teammates.data?.teammates.find((m) => m.id === d.from_teammate_id)?.persona || d.from_teammate_id.slice(0, 10);
                  const toName = teammates.data?.teammates.find((m) => m.id === d.to_teammate_id)?.persona || d.to_teammate_id.slice(0, 10);
                  return (
                    <tr key={d.id}>
                      <td className="mono muted">{fromName}</td>
                      <td className="mono muted">{toName}</td>
                      <td className="mono">{d.depth}</td>
                      <td><StatusBadge status={d.status} /></td>
                      <td className="muted">{d.reason || "—"}</td>
                      <td>
                        {d.child_task_id ? (
                          <a href={`#/p/${projectId}/t/${d.child_task_id}`}>
                            <ShortId id={d.child_task_id} />
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="muted" style={{ maxWidth: 260 }}>
                        {d.result ? d.result.slice(0, 200) : "—"}
                        {d.finished_at ? (
                          <div style={{ fontSize: 12 }}>finished {new Date(d.finished_at).toLocaleString()}</div>
                        ) : null}
                      </td>
                      <td>
                        {pending ? (
                          <div className="row" style={{ gap: 6 }}>
                            <button className="primary" onClick={() => void decide(d.id, "accepted")}>Accept</button>
                            <button className="danger" onClick={() => void decide(d.id, "declined")}>Decline</button>
                            <button onClick={() => void cancelDelegation(d.id)}>Cancel</button>
                          </div>
                        ) : open ? (
                          <button onClick={() => void cancelDelegation(d.id)}>Cancel</button>
                        ) : (
                          <span className="muted">{d.decided_at ?? ""}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="muted" style={{ marginTop: 8 }}>
              Accepting a delegation makes the target bot the task owner. Child results flow back
              through the response channel (see the project&apos;s Messages tab).
            </div>
          </>
        ) : (
          <EmptyState title="No delegations yet" hint="Hand a task from one bot to another here." />
        )}
      </div>

      <h2>Delegation tree</h2>
      <div className="card">
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <span className="muted">Parent:</span>
          {parent ? (
            <a href={`#/p/${projectId}/t/${parent.id}`}>
              <ShortId id={parent.id} /> {parent.description || "Untitled"}
            </a>
          ) : (
            <span className="muted">none — this is a root task</span>
          )}
        </div>
        <div style={{ marginTop: 8 }}>
          <span className="muted">Children ({children.length}):</span>
          {children.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              No child tasks yet — bots create them when they delegate with a command.
            </div>
          ) : (
            children.map((child) => {
              const link = delegationRows.find((d) => d.child_task_id === child.id);
              return (
                <div key={child.id} className="row" style={{ justifyContent: "space-between", padding: "6px 0" }}>
                  <span>
                    <a href={`#/p/${projectId}/t/${child.id}`}>
                      <ShortId id={child.id} />
                    </a>{" "}
                    {child.description || "Untitled"}{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      via {link
                        ? `${teammates.data?.teammates.find((m) => m.id === link.to_teammate_id)?.persona || link.to_teammate_id.slice(0, 10)} · ${link.status}`
                        : "delegation"}
                    </span>
                  </span>
                  <StatusBadge status={child.status} />
                </div>
              );
            })
          )}
        </div>
      </div>

      <WorkspacePanel taskId={taskId} />

      <h2>Artifacts</h2>
      {artifacts.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Verification</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map((artifact) => (
              <tr key={artifact.id}>
                <td>
                  <ShortId id={artifact.id} />
                </td>
                <td className="mono">{artifact.type}</td>
                <td>
                  <StatusBadge status={artifact.verification_status} />
                </td>
                <td className="muted">{artifact.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No artifacts" hint="Runs produce test-log and transcript artifacts." />
      )}

      <h2>Reviews</h2>
      {reviews.length > 0 ? (
        reviews.map((review) => (
          <div className="card" key={review.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="mono muted">{review.id}</span>
              <StatusBadge status={review.verdict} />
            </div>
            <div style={{ marginTop: 6 }}>{review.notes || "No notes"}</div>
            {review.risks.length > 0 ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Risks: {review.risks.join(", ")}
              </div>
            ) : null}
          </div>
        ))
      ) : (
        <EmptyState title="No reviews" hint="A distinct reviewer records verdict and risks here." />
      )}

      <h2>PR packages</h2>
      {pr_packages.length > 0 ? (
        pr_packages.map((pkg) => (
          <div className="card" key={pkg.id}>
            <strong>{pkg.title}</strong>
            <div className="muted mono" style={{ fontSize: 12 }}>
              {pkg.base_branch} ← {pkg.head_branch} · digest {pkg.digest.slice(0, 12)}…
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {pkg.patch_summary}
            </div>
          </div>
        ))
      ) : (
        <EmptyState title="No PR packages" hint="Generate a reviewable candidate package." />
      )}

      {rollup ? (
        <>
          <h2>Roll-up</h2>
          <pre className="log">{JSON.stringify(rollup, null, 2)}</pre>
        </>
      ) : null}
      <div className="muted" style={{ marginTop: 24, fontSize: 12 }}>
        Project <ShortId id={projectId} />
      </div>
    </div>
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
    <>
      <h2>Workspace</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <button
          onClick={() => {
            setShowDiff((v) => !v);
            diff.reload();
          }}
        >
          {showDiff ? "Hide diff" : "Show diff"}
        </button>
        <button
          onClick={() => {
            files.reload();
            diff.reload();
          }}
        >
          Refresh
        </button>
      </div>
      {showDiff ? (
        <div className="card">
          <strong>Uncommitted changes</strong>
          {diff.loading ? (
            <LoadingState lines={3} />
          ) : diff.error ? (
            <ErrorState error={diff.error} onRetry={diff.reload} />
          ) : diff.data?.exists && diff.data.diff ? (
            <pre className="log" style={{ marginTop: 8 }}>
              {diff.data.diff.slice(0, 8000)}
            </pre>
          ) : (
            <div className="muted" style={{ marginTop: 8 }}>
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
        <div className="card">
          <div className="muted mono" style={{ fontSize: 12, marginBottom: 8 }}>
            {files.data.root}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {files.data.files.map((f) => (
              <button
                key={f.path}
                className={openPath === f.path ? "primary" : ""}
                onClick={() => void openFile(f.path)}
                title={`${f.size} bytes`}
              >
                {f.path}
              </button>
            ))}
          </div>
          {openPath ? (
            <div style={{ marginTop: 12 }}>
              <strong className="mono">{openPath}</strong>
              {contentError ? (
                <div className="error-box" role="alert">
                  {contentError}
                </div>
              ) : content === null ? (
                <LoadingState lines={3} />
              ) : (
                <pre className="log" style={{ marginTop: 8 }}>
                  {content.slice(0, 8000)}
                </pre>
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
    </>
  );
}
