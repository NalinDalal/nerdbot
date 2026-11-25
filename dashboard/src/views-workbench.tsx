/** Project workspace — Odysseus-style: bind a folder, confine agent tools, inspect lightly.
 *
 *  This is intentionally not a VS Code clone. The workspace is the execution
 *  context for agents and tasks: pick a folder, vet it, attach it, and let
 *  runs operate inside it. File/diff/command remain available as lightweight
 *  capabilities, not an IDE chrome.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { notifyError } from "./app";
import {
  Button,
  EmptyState,
  ErrorState,
  FORM_INPUT,
  LoadingState,
  Modal,
  Page,
  PageHeader,
  StatusBadge,
  useAsync,
} from "./components";
import type { Project, WorkspaceBrowseResult, WorkspaceMeta } from "./types";

const PROJECT_KEY = "nerdbot.workbench.project";

function readStoredProject(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function storeProject(id: string | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    /* ignore */
  }
}

function WorkspacePickerModal({
  initialPath,
  onClose,
  onSelect,
}: {
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath || "");
  const [browsePath, setBrowsePath] = useState(initialPath || "");
  const [data, setData] = useState<WorkspaceBrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.browseWorkspace(p);
      setData(res);
      setPath(res.path);
      setBrowsePath(res.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath || "");
  }, [initialPath, load]);

  return (
    <Modal title="Choose workspace folder" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-step--1 text-[var(--muted)]">
          Pick a folder on the server. Agent file tools are confined to the selected workspace;
          commands run with it as the working directory.
        </p>
        <div className="flex gap-2">
          <input
            className={`${FORM_INPUT} min-w-0 flex-1 font-mono text-step--2`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/folder"
            aria-label="Workspace path"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void load(path);
              }
            }}
          />
          <Button onClick={() => void load(path)}>Go</Button>
        </div>

        {loading ? <LoadingState lines={4} /> : error ? <ErrorState error={error} onRetry={() => void load(browsePath)} /> : data ? (
          <>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-step--2 text-[var(--text-soft)] break-all">
              {data.path}
            </div>
            <div className="max-h-72 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {data.parent ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-step--1 hover:bg-[var(--surface-2)]"
                  onClick={() => void load(data.parent!)}
                >
                  <span className="text-[var(--faint)]">↑</span> ..
                </button>
              ) : null}
              {data.dirs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-step--1 hover:bg-[var(--surface-2)]"
                  onClick={() => void load(d.path)}
                >
                  <span className="text-[var(--faint)]">▸</span>
                  <span className="truncate">{d.name}</span>
                </button>
              ))}
              {data.dirs.length === 0 ? (
                <div className="px-3 py-4 text-step--1 text-[var(--muted)]">No subfolders</div>
              ) : null}
              {data.truncated ? (
                <div className="px-3 py-2 text-step--2 text-[var(--faint)]">Too many folders to list. Type a path to jump in.</div>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="text-step--2 text-[var(--muted)]">
                {data.selectable ? "This folder can be used as a workspace." : "This folder cannot be bound as a workspace."}
              </div>
              <div className="flex gap-2">
                <Button onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={!data.selectable}
                  onClick={() => onSelect(data.path)}
                >
                  Use this folder
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

export function WorkbenchView({ projectId: routeProjectId }: { projectId?: string }) {
  const projects = useAsync(() => api.listProjects().then((r) => r.projects || []), []);
  const [projectId, setProjectId] = useState<string | null>(routeProjectId || readStoredProject());
  const [showPicker, setShowPicker] = useState(false);
  const [attachPath, setAttachPath] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (routeProjectId) {
      setProjectId(routeProjectId);
      storeProject(routeProjectId);
    }
  }, [routeProjectId]);

  useEffect(() => {
    if (projectId || !projects.data?.length) return;
    const first = projects.data[0].id;
    setProjectId(first);
    storeProject(first);
  }, [projectId, projects.data]);

  const project = projects.data?.find((p) => p.id === projectId) ?? null;
  const workspace = useAsync<WorkspaceMeta | null>(
    () => (projectId ? api.projectWorkspace(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const audit = useAsync<any[]>(
    () => (projectId ? api.workspaceAudit(projectId, 30).then((r) => r.items || []) : Promise.resolve([])),
    [projectId],
  );
  useEffect(() => {
    if (!projectId) return;
    const t = window.setInterval(() => { void audit.reload(); }, 4000);
    return () => window.clearInterval(t);
  }, [projectId]);

  const selectProject = (id: string) => {
    setProjectId(id);
    storeProject(id);
  };

  const attach = async (path: string) => {
    if (!projectId || !path.trim()) return;
    setBusy(true);
    try {
      const vet = await api.vetWorkspace(path.trim());
      if (!vet.ok || !vet.path) {
        toast.error("That path can't be used as a workspace. Pick a normal directory.");
        return;
      }
      await api.attachProjectWorkspace(projectId, vet.path, false);
      toast.success("Workspace attached");
      setShowPicker(false);
      setAttachPath("");
      await workspace.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  const useDefault = async () => {
    setBusy(true);
    try {
      const def = await api.defaultWorkspace();
      if (!def.ok || !def.path) {
        toast.error("No default workspace configured on the server (NERDBOT_WORKSPACE_DEFAULT).");
        return;
      }
      await attach(def.path);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  const meta = workspace.data;

  return (
    <Page>
      <PageHeader
        title="Workspace"
        description="Bind a project to a folder. Agent tools run inside that workspace; this view keeps it simple instead of acting like an IDE."
        actions={
          projectId ? (
            <div className="flex gap-2">
              <Button onClick={() => void useDefault()} disabled={busy}>Use default</Button>
              <Button variant="primary" onClick={() => setShowPicker(true)} disabled={busy}>Choose folder</Button>
            </div>
          ) : null
        }
      />

      {projects.loading ? <LoadingState lines={4} /> : projects.error ? <ErrorState error={projects.error} onRetry={() => void projects.reload()} /> : !projects.data?.length ? (
        <EmptyState title="No projects" hint="Create a project first, then bind it to a workspace folder." />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-step--1 text-[var(--muted)]" htmlFor="workspace-project">Project</label>
            <select
              id="workspace-project"
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1"
              value={projectId || ""}
              onChange={(e) => selectProject(e.target.value)}
            >
              {projects.data.map((p: Project) => <option key={p.id} value={p.id}>{p.repository || p.id}</option>)}
            </select>
            {project ? <span className="text-step--2 text-[var(--faint)] font-mono">{project.id}</span> : null}
          </div>

          {workspace.loading ? <LoadingState lines={5} /> : workspace.error ? <ErrorState error={workspace.error} onRetry={() => void workspace.reload()} /> : meta ? (
            <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
              <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">Active workspace</div>
                    <div className="mt-1 font-mono text-step--1 text-[var(--text)] break-all">{meta.root}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {meta.attached ? <StatusBadge status="active" /> : <StatusBadge status="idle" />}
                    {meta.git ? <StatusBadge status="active" /> : <StatusBadge status="warning" />}
                    {meta.busy ? <StatusBadge status="running" /> : null}
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-step--1 sm:grid-cols-4">
                  <div><dt className="text-[var(--faint)]">Mode</dt><dd>{meta.attached ? "Attached folder" : "Managed workspace"}</dd></div>
                  <div><dt className="text-[var(--faint)]">Git</dt><dd>{meta.git ? (meta.branch || "repo") : "not a repo"}</dd></div>
                  <div><dt className="text-[var(--faint)]">Changes</dt><dd>{meta.dirty ? `${meta.changes?.length || 0} pending` : "clean"}</dd></div>
                  <div><dt className="text-[var(--faint)]">Files</dt><dd>{meta.file_count}{meta.truncated ? "+" : ""}</dd></div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={() => setShowPicker(true)} disabled={busy}>Change folder</Button>
                  <Button onClick={() => void workspace.reload()} disabled={busy}>Refresh</Button>
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">Odysseus-style binding</div>
                <p className="mt-2 text-step--1 text-[var(--muted)]">
                  This workspace is the folder agent tools operate in. Pick a normal project directory; sensitive locations and filesystem roots are refused. For container deployments, configure <code className="font-mono text-step--2">NERDBOT_WORKSPACE_DEFAULT</code> or mount paths appropriately.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <input
                    className={`${FORM_INPUT} font-mono text-step--2`}
                    value={attachPath}
                    onChange={(e) => setAttachPath(e.target.value)}
                    placeholder="/absolute/path/to/workspace"
                    aria-label="Attach workspace path"
                  />
                  <div className="flex gap-2">
                    <Button variant="primary" disabled={busy || !attachPath.trim()} onClick={() => void attach(attachPath)}>Attach path</Button>
                    <Button disabled={busy} onClick={() => setShowPicker(true)}>Browse</Button>
                  </div>
                </div>
              </section>
            </div>
          ) : null}

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">Activity</div>
            <p className="mt-1 text-step--2 text-[var(--muted)]">Live workspace gateway activity (polling every few seconds).</p>
            <div className="mt-3 flex flex-col gap-2">
              {(audit.data || []).length === 0 ? <div className="text-step--2 text-[var(--faint)]">No workspace activity yet.</div> : (audit.data || []).slice(0, 20).map((row: any) => (
                <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-dim)] px-3 py-2 text-step--2">
                  <div className="min-w-0">
                    <span className="font-medium text-[var(--text-soft)]">{row.actor_kind}:{String(row.actor_id || "").slice(0, 8)}</span>{" "}
                    <span className="text-[var(--muted)]">{row.action}</span>{" "}
                    <span className="mono text-[var(--faint)]">{row.path || ""}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={row.denied ? "text-[var(--warn)]" : row.ok ? "text-[var(--ok)]" : "text-[var(--danger)]"}>{row.denied ? "denied" : row.ok ? "ok" : "failed"}</span>
                    {row.action === "write" || row.action === "delete" || row.action === "rename" ? (
                      <Button onClick={async () => {
                        try {
                          let snapshot_ref = "";
                          try { const a = JSON.parse(row.args_summary || "{}"); snapshot_ref = a?.snapshot?.ref || a?.snapshot?.commit || ""; } catch {}
                          await api.revertWorkspaceFile(projectId!, { path: row.path, snapshot_ref, force: false });
                          toast.success("Reverted");
                          await Promise.all([workspace.reload(), audit.reload()]);
                        } catch (err) { notifyError(err); }
                      }}>Revert</Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {showPicker ? (
        <WorkspacePickerModal
          initialPath={meta?.root}
          onClose={() => setShowPicker(false)}
          onSelect={(p) => void attach(p)}
        />
      ) : null}
    </Page>
  );
}
