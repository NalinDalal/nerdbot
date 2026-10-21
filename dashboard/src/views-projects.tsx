import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import { EmptyState, ErrorState, LoadingState, ShortId, useAsync } from "./components";
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

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Workspaces</h1>
          <p className="subtitle">
            Every workspace on this server: its bots, tasks, boards, memory, and approvals.
            Open one to manage the fleet inside it.
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setShowCreate(true)}>New workspace</button>
          <button onClick={list.reload}>Refresh</button>
        </div>
      </div>

      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.projects.length > 0 ? (
        <div className="grid3">
          {list.data.projects.map((project) => (
            <div className="card" key={project.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <a href={`#/p/${project.id}`} onClick={() => onOpen(project.id)}>
                  <strong className="mono">{project.repository || "workspace"}</strong>
                </a>
                <ShortId id={project.id} />
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                owner {project.owner}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="primary" onClick={() => onOpen(project.id)}>
                  Open
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No workspaces yet"
          hint="Create one to start: a workspace owns its bots, tasks, boards, memory, and approvals."
        />
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <form onSubmit={open} className="row">
          <input
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="prj_…"
            aria-label="Project ID"
            style={{ maxWidth: 320 }}
          />
          <button className="primary" type="submit">
            Open by ID
          </button>
          <button type="button" onClick={() => setShowCreate((v) => !v)}>
            New workspace
          </button>
        </form>
        {showCreate ? (
          <div style={{ marginTop: 16 }}>
            <EntityForm
              submitLabel="Create workspace"
              fields={[
                { name: "repository", label: "Repository", placeholder: "demo-repo" },
                { name: "owner_note", label: "Note (owner is always your token identity)" },
              ]}
              onSubmit={async (values) => {
                const project = await api.createProject(values.repository || "repo");
                onOpen(project.id);
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
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
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Capabilities</h1>
          <p className="subtitle">What this server build can actually do. Stubs stay stubs.</p>
        </div>
        <button onClick={refresh}>Refresh</button>
      </div>
      {health.loading ? (
        <LoadingState lines={1} />
      ) : health.error ? (
        <ErrorState error={health.error} onRetry={health.reload} />
      ) : health.data ? (
        <div className="card">
          <div className="row">
            <span className="badge">
              <span className={`dot ${health.data.status === "ok" ? "ok" : "bad"}`} />
              {health.data.status}
            </span>
            <span className="muted">version {health.data.version}</span>
            <span className="muted">db {health.data.db}</span>
            <span className="muted">restarts {health.data.restarts}</span>
          </div>
        </div>
      ) : null}
      {caps.loading ? (
        <LoadingState lines={6} />
      ) : caps.error ? (
        <ErrorState error={caps.error} onRetry={caps.reload} />
      ) : caps.data && caps.data.capabilities.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Status</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {caps.data.capabilities.map((cap) => (
              <tr key={cap.id}>
                <td className="mono">{cap.id}</td>
                <td>
                  <span className="badge">
                    <span
                      className={`dot ${cap.status === "ready" ? "ok" : cap.status === "stub" ? "warn" : ""}`}
                    />
                    {cap.status}
                  </span>
                </td>
                <td className="muted">{cap.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No capabilities reported" hint="The server returned an empty list." />
      )}
    </div>
  );
}
