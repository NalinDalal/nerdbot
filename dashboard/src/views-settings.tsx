/** Settings: the machine and the workspace, not a developer manual.
 *
 *  The owner comes here to connect a model, add a workspace, or reach the
 *  container pages that no longer deserve a top-level nav item. Server
 *  internals are still available, but folded away behind Details.
 */
import { useState } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { notifyError } from "./app";
import type { Project, ProjectCounts, Provider } from "./types";
import {
  Badge,
  Button,
  CodeBlock,
  EmptyState,
  ErrorState,
  FORM_INPUT,
  FORM_SELECT,
  KeyValue,
  LoadingState,
  Modal,
  Page,
  PageHeader,
  PageSection,
  useAsync,
} from "./components";

interface WorkspaceConnections {
  project: Project;
  counts: ProjectCounts | null;
  providers: Provider[];
}

const providerIsUsable = (provider: Provider): boolean => {
  if (provider.kind !== "openai-compatible") return true;
  const config = provider.config ?? {};
  return (
    (typeof config.base_url === "string" && config.base_url.trim() !== "") ||
    typeof config.api_key === "string" ||
    typeof config.api_key_env === "string"
  );
};

export function SettingsView() {
  const health = useAsync(() => api.health(), []);
  const workspaces = useAsync<WorkspaceConnections[]>(async () => {
    const { projects, counts } = await api.listProjects();
    return Promise.all(
      projects.map(async (project) => {
        try {
          const providers = (await api.listProviders(project.id)).providers;
          return { project, counts: counts[project.id] ?? null, providers };
        } catch {
          return { project, counts: counts[project.id] ?? null, providers: [] };
        }
      }),
    );
  }, []);
  const [connectTo, setConnectTo] = useState<string | null>(null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const test = async (provider: Provider) => {
    setTesting(provider.id);
    try {
      const { models } = await api.providerModels(provider.id);
      toast.success(
        `${provider.name}: ${models.length} model${models.length === 1 ? "" : "s"} available`,
      );
    } catch (err) {
      notifyError(err);
    } finally {
      setTesting(null);
    }
  };

  const disabled = async (provider: Provider) => {
    try {
      await api.disableProvider(provider.id);
      workspaces.reload();
      toast.success(`${provider.name} disabled`);
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Models, workspaces, and the machine underneath."
        actions={
          <Button
            onClick={() => {
              health.reload();
              workspaces.reload();
            }}
          >
            Refresh
          </Button>
        }
      />

      <PageSection
        title="Models"
        description="A workspace needs one working model before its bots can think."
        actions={
          <Button
            variant="primary"
            onClick={() => setConnectTo(workspaces.data?.[0]?.project.id ?? null)}
            disabled={!workspaces.data || workspaces.data.length === 0}
          >
            Connect a model
          </Button>
        }
      >
        {workspaces.loading ? (
          <LoadingState lines={3} />
        ) : workspaces.error ? (
          <ErrorState error={workspaces.error} onRetry={workspaces.reload} />
        ) : (workspaces.data ?? []).length === 0 ? (
          <EmptyState title="No workspaces" hint="Create one below, then connect a model." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {(workspaces.data ?? []).map(({ project, providers }, index) => {
              const usable = providers.filter(providerIsUsable);
              return (
                <div
                  key={project.id}
                  className={`flex flex-wrap items-center gap-3 px-4 py-3 ${
                    index > 0 ? "border-t border-[var(--border-dim)]" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-[var(--text)]">
                      {project.repository || "Workspace"}
                    </div>
                    <div className="mt-0.5 text-[var(--step-minus-2)] text-[var(--faint)]">
                      {providers.length === 0
                        ? "No model connected"
                        : `${usable.length} of ${providers.length} usable`}
                    </div>
                  </div>
                  {providers.length === 0 ? (
                    <Badge variant="warn">No model</Badge>
                  ) : (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {providers.map((provider) => (
                        <span
                          key={provider.id}
                          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2 py-1 text-[var(--step-minus-2)] text-[var(--text-soft)]"
                        >
                          <span className="max-w-[10rem] truncate">{provider.name}</span>
                          <button
                            onClick={() => void test(provider)}
                            disabled={testing === provider.id}
                            className="text-[var(--muted)] underline underline-offset-2 hover:text-[var(--text)]"
                          >
                            {testing === provider.id ? "Testing…" : "Test"}
                          </button>
                          {provider.status !== "disabled" ? (
                            <button
                              onClick={() => void disabled(provider)}
                              className="text-[var(--muted)] hover:text-[var(--danger)]"
                              aria-label={`Disable ${provider.name}`}
                            >
                              ×
                            </button>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  )}
                  <Button onClick={() => setConnectTo(project.id)}>Add</Button>
                </div>
              );
            })}
          </div>
        )}
      </PageSection>

      <PageSection
        title="Workspaces"
        description="Each workspace keeps its own bots, tasks, files, and model connections."
        actions={
          <Button onClick={() => setCreatingWorkspace(true)}>New workspace</Button>
        }
      >
        {workspaces.loading ? (
          <LoadingState lines={2} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {(workspaces.data ?? []).map(({ project, counts }, index) => (
              <div
                key={project.id}
                className={`flex flex-wrap items-center gap-3 px-4 py-3 ${
                  index > 0 ? "border-t border-[var(--border-dim)]" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <a
                    href={`#/p/${project.id}`}
                    className="truncate font-medium text-[var(--text)] hover:underline"
                  >
                    {project.repository || "Workspace"}
                  </a>
                  <div className="mt-0.5 text-[var(--step-minus-2)] text-[var(--faint)]">
                    {counts
                      ? `${counts.bots} bot${counts.bots === 1 ? "" : "s"} · ${counts.tasks} task${
                          counts.tasks === 1 ? "" : "s"
                        } · ${counts.running} running`
                      : "No counts yet"}
                  </div>
                </div>
                <a
                  href={`#/p/${project.id}`}
                  className="text-[var(--step-minus-1)] text-[var(--muted)] hover:text-[var(--text)]"
                >
                  Open →
                </a>
              </div>
            ))}
          </div>
        )}
      </PageSection>

      <PageSection title="Advanced" description="The container pages and build internals.">
        <div className="grid gap-2 sm:grid-cols-2">
          <AdvancedLink href="#/boards" title="Boards" hint="Message channels bots can read and write." />
          <AdvancedLink href="#/teams" title="Teams" hint="Group workspaces for a shared roll-up." />
          <AdvancedLink href="#/projects" title="All workspaces" hint="The full workspace table." />
          <AdvancedLink href="#/capabilities" title="Capabilities" hint="What this build can and cannot do." />
        </div>
      </PageSection>

      <PageSection title="Server" description="The machine this workspace runs on.">
        {health.loading ? (
          <LoadingState lines={2} />
        ) : health.error ? (
          <ErrorState error={health.error} onRetry={health.reload} />
        ) : health.data ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-medium text-[var(--text)]">NerdBot server</span>
              <Badge variant={health.data.status === "ok" ? "ok" : "bad"}>
                {health.data.status}
              </Badge>
              <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
                version {health.data.version}
              </span>
            </div>
            <dl className="divide-y divide-[var(--border-dim)]">
              <KeyValue label="Database">
                <Badge variant={health.data.db === "ok" ? "ok" : "bad"}>{health.data.db}</Badge>
              </KeyValue>
              <KeyValue label="Restarts">{health.data.restarts}</KeyValue>
              <KeyValue label="Key storage">
                <Badge variant={health.data.secret_key === "absent" ? "warn" : "ok"}>
                  {health.data.secret_key === "absent" ? "not configured" : "configured"}
                </Badge>
              </KeyValue>
            </dl>
            {health.data.secret_key === "absent" ? (
              <p className="mt-2 text-[var(--step-minus-1)] text-[var(--muted)]">
                Pasted keys cannot be stored until the server has a secret key. An environment
                variable works without it.
              </p>
            ) : null}
            <details className="mt-3 border-t border-[var(--border-dim)] pt-3">
              <summary className="cursor-pointer text-[var(--step-minus-1)] text-[var(--muted)]">
                Connection and security details
              </summary>
              <div className="mt-3 space-y-3">
                <div>
                  <div className="mb-1 text-[var(--step-minus-1)] text-[var(--muted)]">API base</div>
                  <CodeBlock>{"http://127.0.0.1:8080   (the dashboard is served by the API)"}</CodeBlock>
                </div>
                <dl className="divide-y divide-[var(--border-dim)]">
                  <KeyValue label="Sign in">
                    One bearer token, kept in this browser only.
                  </KeyValue>
                  <KeyValue label="Pasted keys">
                    Encrypted at rest when the server has a secret key. The API returns only a
                    fingerprint.
                  </KeyValue>
                  <KeyValue label="Shell access">
                    Bots run commands inside their task workspace, bounded by the run and the deny
                    list.
                  </KeyValue>
                </dl>
              </div>
            </details>
          </div>
        ) : (
          <EmptyState title="Server unreachable" hint="Start it with nerdbot run, then Refresh." />
        )}
      </PageSection>

      {connectTo ? (
        <ConnectModelModal
          projects={workspaces.data ?? []}
          initialProjectId={connectTo}
          onClose={() => setConnectTo(null)}
          onSaved={() => {
            setConnectTo(null);
            workspaces.reload();
          }}
        />
      ) : null}

      {creatingWorkspace ? (
        <NewWorkspaceModal
          onClose={() => setCreatingWorkspace(false)}
          onCreated={() => {
            setCreatingWorkspace(false);
            workspaces.reload();
          }}
        />
      ) : null}
    </Page>
  );
}

function AdvancedLink({ href, title, hint }: { href: string; title: string; hint: string }) {
  return (
    <a
      href={href}
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 transition-colors hover:border-[var(--faint)]"
    >
      <div className="font-medium text-[var(--text)]">{title}</div>
      <div className="mt-0.5 text-[var(--step-minus-1)] text-[var(--muted)]">{hint}</div>
    </a>
  );
}

function ConnectModelModal({
  projects,
  initialProjectId,
  onClose,
  onSaved,
}: {
  projects: WorkspaceConnections[];
  initialProjectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [name, setName] = useState("groq");
  const [baseUrl, setBaseUrl] = useState("https://api.groq.com/openai/v1");
  const [model, setModel] = useState("openai/gpt-oss-120b");
  const [envVar, setEnvVar] = useState("CLOUD_MODEL_KEY");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId || !baseUrl.trim()) return;
    setBusy(true);
    try {
      await api.createProvider(projectId, {
        kind: "openai-compatible",
        name: name.trim() || "model",
        config: {
          base_url: baseUrl.trim(),
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(apiKey.trim()
            ? { api_key: apiKey.trim() }
            : envVar.trim()
              ? { api_key_env: envVar.trim() }
              : {}),
        },
      });
      toast.success("Model connected");
      onSaved();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect a model" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[var(--step-minus-1)] text-[var(--muted)]">Workspace</span>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className={FORM_SELECT}
            required
          >
            {projects.map(({ project }) => (
              <option key={project.id} value={project.id}>
                {project.repository || "Workspace"}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[var(--step-minus-1)] text-[var(--muted)]">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={FORM_INPUT}
              placeholder="groq"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[var(--step-minus-1)] text-[var(--muted)]">Model</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className={FORM_INPUT}
              placeholder="openai/gpt-oss-120b"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[var(--step-minus-1)] text-[var(--muted)]">Base URL</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className={FORM_INPUT}
            placeholder="https://api.groq.com/openai/v1"
            required
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
              Key environment variable
            </span>
            <input
              value={envVar}
              onChange={(event) => {
                setEnvVar(event.target.value);
                if (event.target.value) setApiKey("");
              }}
              className={FORM_INPUT}
              placeholder="CLOUD_MODEL_KEY"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
              Or paste a key
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                if (event.target.value) setEnvVar("");
              }}
              className={FORM_INPUT}
              autoComplete="off"
              placeholder="sk-…"
            />
          </label>
        </div>
        <p className="text-[var(--step-minus-2)] text-[var(--faint)]">
          An environment variable keeps the key out of the database. A pasted key is encrypted
          when the server has a secret key.
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !baseUrl.trim() || !projectId}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function NewWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createProject(name.trim());
      toast.success("Workspace created");
      onCreated();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New workspace" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[var(--step-minus-1)] text-[var(--muted)]">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={FORM_INPUT}
            placeholder="my-project"
            required
            autoFocus
          />
        </label>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create workspace"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
