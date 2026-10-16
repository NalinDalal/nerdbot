import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import { EmptyState, ErrorState, LoadingState, useAsync } from "./components";
import { EntityForm } from "./forms";

export function ProjectsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [projectId, setProjectId] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    const id = projectId.trim();
    if (id) onOpen(id);
  };

  return (
    <div>
      <h1>Projects</h1>
      <p className="subtitle">
        The API has no project listing, so open a project by ID or create a new one.
      </p>
      <div className="card">
        <form onSubmit={open} className="row">
          <input
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="prj_…"
            aria-label="Project ID"
            style={{ maxWidth: 320 }}
          />
          <button className="primary" type="submit">
            Open project
          </button>
          <button type="button" onClick={() => setShowCreate((v) => !v)}>
            New project
          </button>
        </form>
        {showCreate ? (
          <div style={{ marginTop: 16 }}>
            <EntityForm
              submitLabel="Create project"
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
