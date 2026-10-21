import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import type { Project } from "./types";
import { EmptyState, ErrorState, LoadingState, Modal, Button, Page, PageHeader, Badge, useAsync, TABLE_SHELL, TABLE_TD, TABLE_TH } from "./components";
import { EntityForm } from "./forms";

export function ProjectsView({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useAsync(() => api.listProjects(), []);
  const [projectId, setProjectId] = useState("");
  const [showCreate, setShowCreate] = useState("");

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    const id = projectId.trim();
    if (id) onOpen(id);
  };

  const create = async (values: Record<string, string>) => {
    const project = await api.createProject(values.repository || "repo");
    setShowCreate("");
    onOpen(project.id);
  };

  const projects = list.data?.projects ?? [];
  const counts = list.data?.counts ?? {};

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Workspaces"
        description="Every workspace on this server. A workspace holds its bots, tasks, boards, memory and approvals. Open one to work inside it."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate("create")}>
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
      ) : projects.length > 0 ? (
        <div className={TABLE_SHELL}>
          <table className="w-full min-w-[720px] table-fixed">
            <thead>
              <tr>
                <th className={`${TABLE_TH} w-[24%]`}>Workspace</th>
                <th className={`${TABLE_TH} w-[5rem]`}>Bots</th>
                <th className={`${TABLE_TH} w-[6rem]`}>Tasks</th>
                <th className={`${TABLE_TH} w-[5rem]`}>Boards</th>
                <th className={`${TABLE_TH} w-[10rem]`}>Needs you</th>
                <th className={`${TABLE_TH} w-[10rem]`}>Id</th>
                <th className={`${TABLE_TH} w-[7rem]`}><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const count = counts[project.id];
                const needsYou = (count?.approvals ?? 0) + (count?.blocked ?? 0);
                return (
                  <tr
                    key={project.id}
                    className="transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <td className={TABLE_TD}>
                      <button
                        onClick={() => onOpen(project.id)}
                        className="text-left font-medium text-[var(--text)] hover:underline"
                      >
                        {project.repository || "Untitled workspace"}
                      </button>
                      <div className="truncate text-[var(--step-minus-2)] text-[var(--faint)]">
                        owner {project.owner}
                      </div>
                    </td>
                    <td className={TABLE_TD}>{count?.bots ?? 0}</td>
                    <td className={TABLE_TD}>
                      {count?.tasks ?? 0}
                      {count?.running ? (
                        <span className="ml-1.5 text-[var(--step-minus-2)] text-[var(--info)]">
                          {count.running} running
                        </span>
                      ) : null}
                    </td>
                    <td className={TABLE_TD}>{count?.boards ?? 0}</td>
                    <td className={TABLE_TD}>
                      {needsYou > 0 ? (
                        <span className="text-[var(--warn)]">
                          {count?.approvals ? `${count.approvals} approval` : ""}
                          {count?.approvals && count?.blocked ? " and " : ""}
                          {count?.blocked ? `${count?.blocked} blocked` : ""}
                        </span>
                      ) : (
                        <span className="text-[var(--faint)]">nothing</span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      <span className="mono block truncate text-[var(--step-minus-2)] text-[var(--faint)]">
                        {project.id}
                      </span>
                    </td>
                    <td className={`${TABLE_TD} whitespace-nowrap`}>
                      <Button variant="ghost" onClick={() => onOpen(project.id)}>
                        Open →
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No workspaces yet"
          hint="Create one to start: a workspace owns its bots, tasks, boards, memory and approvals."
          action={
            <Button variant="primary" onClick={() => setShowCreate("create")}>
              Create your first workspace
            </Button>
          }
        />
      )}

      {/* Opening a workspace by its id stays available for scripts and for
          ids copied from elsewhere, without sitting in the page's way. */}
      <form
        onSubmit={open}
        className="mt-8 flex flex-wrap items-center gap-2 border-t border-[var(--border-dim)] pt-4"
      >
        <label
          htmlFor="open-by-id"
          className="text-[var(--step-minus-1)] text-[var(--muted)]"
        >
          Open by id
        </label>
        <input
          id="open-by-id"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="prj_…"
          className="mono w-56 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
        />
        <Button type="submit" disabled={!projectId.trim()}>
          Open
        </Button>
      </form>

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
