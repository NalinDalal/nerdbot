import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import type { Project } from "./types";
import { EmptyState, ErrorState, LoadingState, Modal, Button, SectionLabel, Page, PageHeader, Badge, ShortId, useAsync } from "./components";
import { EntityForm } from "./forms";

export function ProjectsView({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useAsync(() => api.listProjects(), []);
  const [projectId, setProjectId] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    const id = projectId.trim();
    if (id) onOpen(id);
  };

  const create = async (values: Record<string, string>) => {
    const project = await api.createProject(values.repository || "repo");
    setShowCreate(false);
    onOpen(project.id);
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Workspaces"
        description="Every workspace on this server: its bots, tasks, boards, memory, and approvals. Open one to manage the fleet inside it."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              New workspace
            </Button>
            <Button onClick={list.reload}>Refresh</Button>
          </>
        }
      />

      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.projects.length > 0 ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {list.data.projects.map((project) => (
            <button
              key={project.id}
              onClick={() => onOpen(project.id)}
              className="group rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left shadow-sm transition-colors hover:border-[var(--faint)] hover:bg-[var(--surface-2)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="mono truncate font-medium text-[var(--text)]">
                  {project.repository || "workspace"}
                </span>
                <span className="text-[var(--faint)] transition-transform group-hover:translate-x-0.5" aria-hidden>
                  →
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[var(--step-minus-1)] text-[var(--muted)]">owner {project.owner}</span>
                <ShortId id={project.id} />
              </div>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No workspaces yet"
          hint="Create one to start: a workspace owns its bots, tasks, boards, memory, and approvals."
          action={
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              Create your first workspace
            </Button>
          }
        />
      )}

      <form onSubmit={open} className="mt-8 flex items-center gap-2 border-t border-[var(--border-dim)] pt-6">
        <SectionLabel className="mr-2 shrink-0">Open by ID</SectionLabel>
        <input
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="prj_…"
          aria-label="Project ID"
          className="w-72 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
        />
        <Button type="submit" disabled={!projectId.trim()}>
          Open
        </Button>
      </form>

      {showCreate ? (
        <Modal title="New workspace" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create workspace"
            fields={[
              { name: "repository", label: "Repository", required: true, placeholder: "demo-repo" },
              { name: "owner_note", label: "Note (owner is always your token identity)" },
            ]}
            onSubmit={create}
          />
        </Modal>
      ) : null}
    </Page>
  );
}

export function CapabilitiesView() {
  const caps = useAsync(() => api.capabilities());
  const health = useAsync(() => api.health());

  const refresh = async () => {
    try {
      const h = await api.health();
      if (h.db !== "ok") notifyError(new Error("Database reports an error"));
    } catch (err) {
      notifyError(err);
    }
    caps.reload();
    health.reload();
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Server"
        title="Capabilities"
        description="What this server build can actually do. Stubs stay stubs."
        actions={<Button onClick={refresh}>Refresh</Button>}
      />

      {health.loading ? (
        <LoadingState lines={1} />
      ) : health.error ? (
        <ErrorState error={health.error} onRetry={health.reload} />
      ) : health.data ? (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <Badge variant={health.data.status === "ok" ? "ok" : "bad"}>{health.data.status}</Badge>
          <span className="mono text-[var(--step-minus-1)] text-[var(--muted)]">version {health.data.version}</span>
          <span className="mono text-[var(--step-minus-1)] text-[var(--muted)]">db {health.data.db}</span>
          <span className="mono text-[var(--step-minus-1)] text-[var(--muted)]">restarts {health.data.restarts}</span>
          {health.data.secret_key ? (
            <Badge variant="info">secret key {health.data.secret_key}</Badge>
          ) : (
            <Badge variant="warn">secret key absent</Badge>
          )}
        </div>
      ) : null}

      {caps.loading ? (
        <LoadingState lines={6} />
      ) : caps.error ? (
        <ErrorState error={caps.error} onRetry={caps.reload} />
      ) : caps.data && caps.data.capabilities.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {caps.data.capabilities.map((cap, index) => (
            <div
              key={cap.id}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 ${
                index > 0 ? "border-t border-[var(--border-dim)]" : ""
              }`}
            >
              <span className="mono w-56 shrink-0 text-[var(--step-minus-1)] text-[var(--text)]">{cap.id}</span>
              <Badge variant={cap.status === "ready" ? "ok" : cap.status === "stub" ? "warn" : "neutral"}>
                {cap.status}
              </Badge>
              <span className="text-[var(--step-minus-1)] text-[var(--muted)]">{cap.description}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No capabilities reported" hint="The server returned an empty list." />
      )}
    </Page>
  );
}

export type { Project };
