import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import type { Project } from "./types";
import { EmptyState, ErrorState, LoadingState, Modal, Button, Page, PageHeader, Badge, useAsync, TABLE_SHELL, TABLE_TD, TABLE_TH } from "./components";
import { EntityForm } from "./forms";

export function ProjectsView({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useAsync(() => api.listProjects(), []);
  const [showCreate, setShowCreate] = useState("");
  const [query, setQuery] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);

  const create = async (values: Record<string, string>) => {
    const project = await api.createProject(values.repository || "repo");
    setShowCreate("");
    onOpen(project.id);
  };

  const allProjects = list.data?.projects ?? [];
  const counts = list.data?.counts ?? {};
  const needle = query.trim().toLowerCase();
  const filteredByQuery = needle
    ? allProjects.filter((p) =>
        (p.repository || "").toLowerCase().includes(needle),
      )
    : allProjects;
  const projects = showEmpty
    ? filteredByQuery
    : filteredByQuery.filter((p) => {
        const c = counts[p.id];
        if (!c) return true;
        return (c.bots || 0) + (c.tasks || 0) + (c.objectives || 0) + (c.approvals || 0) + (c.blocked || 0) > 0;
      });

  return (
    <Page>
      <PageHeader
        eyebrow="Workspaces"
        title="Workspaces"
        description="Where your teammates, conversations, tasks, files, and model connections live."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate("create")}>
              New workspace
            </Button>
            <Button onClick={list.reload}>Refresh</Button>
          </>
        }
      />

      <div className="mb-3 flex items-center gap-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workspaces"
          aria-label="Search workspaces"
          className="h-9 w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-step--1 outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
        />
        <label className="flex items-center gap-1.5 text-step--2 text-[var(--faint)]">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} className="h-3 w-3" />
          Show empty
        </label>
      </div>
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          hint="Create a workspace to organize teammates, tasks, and files."
          action={<Button variant="primary" onClick={() => setShowCreate("create")}>New workspace</Button>}
        />
      ) : (
        <div className={TABLE_SHELL}>
          <table className="w-full min-w-[720px] table-fixed">
            <thead>
              <tr>
                <th className={`${TABLE_TH} w-[24%]`}>Project</th>
                <th className={`${TABLE_TH} w-[5rem]`}>Bots</th>
                <th className={`${TABLE_TH} w-[6rem]`}>Tasks</th>
                <th className={`${TABLE_TH} w-[6rem]`}>Objectives</th>
                <th className={`${TABLE_TH} w-[10rem]`}>Needs you</th>
                <th className={`${TABLE_TH} w-[7rem]`}><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const count = counts[project.id];
                const needsYou = (count?.approvals ?? 0) + (count?.blocked ?? 0);
                return (
                  <tr key={project.id} className="transition-colors hover:bg-[var(--surface-2)]">
                    <td className={TABLE_TD}>
                      <button className="text-left text-[var(--text)] hover:underline" onClick={() => onOpen(project.id)}>
                        {project.repository || "Untitled project"}
                        {project.repository === "Home" ? <span className="ml-2 text-step--2 text-[var(--faint)]">(default)</span> : null}
                      </button>
                    </td>
                    <td className={TABLE_TD}>{count?.bots ?? 0}</td>
                    <td className={TABLE_TD}>{count?.tasks ?? 0}</td>
                    <td className={TABLE_TD}>{count?.objectives ?? 0}</td>
                    <td className={TABLE_TD}>
                      {needsYou ? (
                        <span className="text-step--1 text-[var(--warn)]">
                          {count?.approvals ? `${count.approvals} approval` : ""}
                          {count?.approvals && count?.blocked ? " and " : ""}
                          {count?.blocked ? `${count?.blocked} blocked` : ""}
                        </span>
                      ) : (
                        <span className="text-[var(--faint)]">nothing</span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} whitespace-nowrap`}>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={() => onOpen(project.id)}>Open →</Button>
                        {project.repository !== "Home" ? (
                          <Button variant="ghost" onClick={async () => {
                            if (!confirm(`Delete project ${project.repository || project.id}?`)) return;
                            try { await api.deleteProject(project.id); list.reload(); } catch (err) { notifyError(err); }
                          }}>Delete</Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate ? (
        <Modal title="New workspace" onClose={() => setShowCreate("")}>
          <EntityForm
            submitLabel="Create workspace"
            fields={[
              { name: "repository", label: "Name", required: true, placeholder: "demo-repo" },
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
          <span className="mono text-step--1 text-[var(--muted)]">version {health.data.version}</span>
          <span className="mono text-step--1 text-[var(--muted)]">db {health.data.db}</span>
          <span className="mono text-step--1 text-[var(--muted)]">restarts {health.data.restarts}</span>
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
              <span className="mono w-56 shrink-0 text-step--1 text-[var(--text)]">{cap.id}</span>
              <Badge variant={cap.status === "ready" ? "ok" : cap.status === "stub" ? "warn" : "neutral"}>
                {cap.status}
              </Badge>
              <span className="text-step--1 text-[var(--muted)]">{cap.description}</span>
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
