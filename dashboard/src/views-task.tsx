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
    cell: (info) => <StatusBadge status={info.getValue()} />,
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

  if (view.loading) {
    return (
      <div>
        <LoadingState lines={6} />
      </div>
    );
  }
  if (view.error || !view.data) {
    return (
      <div>
        <button onClick={onBack}>← Back to project</button>
        <ErrorState error={view.error ?? "Task not found"} onRetry={view.reload} />
      </div>
    );
  }

  const { task, runs, artifacts, issue, reviews, pr_packages } = view.data;
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

      <h2>Actions</h2>
      <div className="row">
        <button className="primary" disabled={!!busy} onClick={() => void act("run", () => api.runTask(taskId))}>
          {busy === "run" ? "Running…" : "Run"}
        </button>
        <button disabled={!!busy} onClick={() => void act("retry", () => api.retryTask(taskId))}>
          {busy === "retry" ? "Retrying…" : "Retry (new run)"}
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
          <StatusBadge status={latestRun.status} />
          <div className="muted" style={{ fontSize: 12, margin: "4px 0" }}>
            command: <span className="mono">{latestRun.command || "—"}</span> ·{" "}
            {Number(latestRun.duration_s ?? 0).toFixed(1)}s
            {latestRun.provider_id ? ` · provider ${latestRun.provider_id.slice(0, 12)}…` : ""}
          </div>
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
