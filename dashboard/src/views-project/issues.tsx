import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, CARD_SHELL, ERROR_BOX, EmptyState, ErrorState, LoadingState, Modal, StatusBadge, useAsync } from "../components";
import { EntityForm } from "../forms";
export function IssuesTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.listIssues(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  const [showGithub, setShowGithub] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          New issue
        </Button>
        <Button onClick={() => setShowGithub(true)}>Fetch from GitHub</Button>
        <Button onClick={list.reload}>Refresh</Button>
      </div>
      {showCreate ? (
        <Modal title="New issue" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create issue"
            fields={[
              { name: "title", label: "Title", required: true },
              { name: "body", label: "Body", type: "textarea" },
              { name: "acceptance_criteria", label: "Acceptance criteria (comma separated)" },
              { name: "priority", label: "Priority", type: "select", options: ["low", "medium", "high"] },
            ]}
            onSubmit={async (values) => {
              await api.createIssue(projectId, {
                ...values,
                acceptance_criteria: values.acceptance_criteria.split(",").map((s) => s.trim()).filter(Boolean),
              });
              setShowCreate(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {showGithub ? (
        <Modal title="Preview GitHub issue" onClose={() => setShowGithub(false)}>
          <GithubPreview projectId={projectId} onIngested={list.reload} />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.issues.length > 0 ? (
        list.data.issues.map((issue) => (
          <div className={CARD_SHELL} key={issue.id}>
            <div className="flex items-center gap-3" style={{ justifyContent: "space-between" }}>
              <strong>{issue.title}</strong>
              <StatusBadge status={issue.status} />
            </div>
            <div className="mono text-[var(--muted)]">{issue.id} · {issue.source}{issue.external_id ? ` · ${issue.external_id}` : ""}</div>
            {issue.body ? <div style={{ marginTop: 8 }}>{issue.body}</div> : null}
          </div>
        ))
      ) : (
        <EmptyState title="No issues" hint="Ingest one manually or preview from GitHub." />
      )}
    </div>
  );
}

function GithubPreview({ projectId, onIngested }: { projectId: string; onIngested: () => void }) {
  const [repository, setRepository] = useState("");
  const [number, setNumber] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchPreview = async () => {
    setError(null);
    setBusy(true);
    try {
      const data = await api.previewGithubIssue(projectId, repository.trim(), Number(number));
      setPreview(data);
    } catch (err) {
      notifyError(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const ingest = async () => {
    if (!preview) return;
    const suggested = preview.suggested_ingest as Record<string, unknown>;
    try {
      await api.createIssue(projectId, suggested);
      onIngested();
      setPreview(null);
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3">
        <input value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="owner/repo" aria-label="Repository" />
        <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="7" aria-label="Issue number" style={{ maxWidth: 100 }} />
        <Button variant="primary" onClick={fetchPreview} disabled={busy}>
          {busy ? "Fetching…" : "Preview"}
        </Button>
      </div>
      {error ? <div className={ERROR_BOX} style={{ marginTop: 12 }}>{error}</div> : null}
      {preview ? (
        <div className={CARD_SHELL} style={{ marginTop: 12 }}>
          <div className="text-[var(--muted)]" style={{ fontSize: 12 }}>Untrusted preview — confirm before ingesting.</div>
          <strong>{String(preview.title ?? "")}</strong>
          <div className="text-[var(--muted)]">{String(preview.body ?? "").slice(0, 400)}</div>
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={ingest}>
              Confirm and ingest
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
