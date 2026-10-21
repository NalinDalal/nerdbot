import { useEffect, useState } from "react";
import { api, describeError } from "./api";
import { notifyError } from "./app";
import type { Approval, Provider } from "./types";
import type { Teammate as TeammateT } from "./types";
import { maskSecrets } from "./types";
import { EmptyState, ErrorState, Field, LoadingState, Modal, ShortId, StatusBadge, useAsync, usePermissionCatalogue } from "./components";
import { EntityForm } from "./forms";
import { ConversationView } from "./views-chat";

const TABS = [
  "Tasks",
  "Chat",
  "Teammates",
  "Providers",
  "Issues",
  "Knowledge",
  "Schedules",
  "Approvals",
  "Messages",
  "Notifications",
  "Memory",
  "Backup",
  "Metrics",
  "Events",
] as const;

export function ProjectDetailView({
  projectId,
  onOpenTask,
}: {
  projectId: string;
  onOpenTask: (taskId: string) => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Tasks");
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[var(--max-width-wide)] px-6 py-6 md:px-8 md:py-8">
        <div className="mono mb-1 text-[var(--step-minus-2)] text-[var(--faint)]">
          <a href="#/" className="hover:text-[var(--text-soft)]">
            projects
          </a>{" "}
          / {projectId}
        </div>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[var(--step-2)] font-semibold tracking-tight text-[var(--text)]">
            Project <ShortId id={projectId} />
          </h1>
        </div>
        <div
          role="tablist"
          className="mb-6 flex flex-wrap gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1"
        >
          {TABS.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
              className={`rounded-md px-3 py-1.5 text-[var(--step-minus-1)] font-medium transition-colors ${
                tab === name
                  ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                  : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        {tab === "Tasks" && <TasksTab projectId={projectId} onOpenTask={onOpenTask} />}
        {tab === "Chat" && (
          <div className="h-[75vh] min-h-[480px] overflow-hidden rounded-xl border border-[var(--border)]">
            <ConversationView projectId={projectId} />
          </div>
        )}
        {tab === "Teammates" && <TeammatesTab projectId={projectId} />}
        {tab === "Providers" && <ProvidersTab projectId={projectId} />}
        {tab === "Issues" && <IssuesTab projectId={projectId} />}
        {tab === "Knowledge" && <KnowledgeTab projectId={projectId} />}
        {tab === "Schedules" && <SchedulesTab projectId={projectId} />}
        {tab === "Approvals" && <ApprovalsTab projectId={projectId} />}
        {tab === "Messages" && <MessagesTab projectId={projectId} />}
        {tab === "Notifications" && <NotificationsTab projectId={projectId} />}
        {tab === "Memory" && <MemoryTab projectId={projectId} />}
        {tab === "Backup" && <BackupTab projectId={projectId} />}
        {tab === "Metrics" && <MetricsTab projectId={projectId} />}
        {tab === "Events" && <EventsTab projectId={projectId} />}
      </div>
    </div>
  );
}

function useReloadable<T>(fn: () => Promise<T>, deps: unknown[]) {
  return useAsync(fn, deps);
}

export function MessagesTab({ projectId }: { projectId: string }) {
  const [scope, setScope] = useState("");
  const msgs = useAsync(() => api.projectMessages(projectId, scope || undefined), [projectId, scope]);
  const mates = useAsync(() => api.listTeammates(projectId), [projectId]);
  useEffect(() => {
    // Poll the response channel while the tab is open.
    const t = setInterval(msgs.reload, 5000);
    return () => clearInterval(t);
  }, [msgs.reload]);
  const nameOf = (id: string | null): string => {
    if (!id) return "—";
    return mates.data?.teammates.find((m) => m.id === id)?.persona || id.slice(0, 10);
  };
  const rows = msgs.data?.messages ?? [];
  return (
    <section>
      <div className="row" style={{ marginBottom: 12 }}>
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Filter by recipient">
          <option value="">All recipients</option>
          {(mates.data?.teammates ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              To: {m.persona}
            </option>
          ))}
        </select>
        <button onClick={msgs.reload}>Refresh</button>
      </div>
      {msgs.loading && !msgs.data ? (
        <LoadingState />
      ) : msgs.error ? (
        <ErrorState error={msgs.error} onRetry={msgs.reload} />
      ) : rows.length === 0 ? (
        <EmptyState title="No messages yet" hint="Bot-to-bot responses and board messages appear here." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>From</th>
                <th>To</th>
                <th>Board</th>
                <th>Content</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <span className="pill">{m.kind}</span>
                  </td>
                  <td>{nameOf(m.from_teammate_id)}</td>
                  <td>{m.to_teammate_id ? nameOf(m.to_teammate_id) : "everyone"}</td>
                  <td>{m.board_name || "—"}</td>
                  <td style={{ maxWidth: 420, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</td>
                  <td className="muted">{new Date(m.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TasksTab({ projectId, onOpenTask }: { projectId: string; onOpenTask: (id: string) => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<string[]>([]);
  const tasks = useAsync(() => api.projectTasks(projectId), [projectId]);
  const runs = useAsync(() => api.projectRuns(projectId), [projectId]);
  const mates = useAsync(() => api.listTeammates(projectId), [projectId]);
  const ownerName = (id: string | null): string => {
    if (!id) return "—";
    return mates.data?.teammates.find((m) => m.id === id)?.persona || id.slice(0, 10);
  };
  const reload = () => {
    tasks.reload();
    runs.reload();
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowCreate(true)}>
          New task
        </button>
        <button onClick={reload}>Refresh</button>
      </div>
      {showCreate ? (
        <Modal title="New task" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create task"
            fields={[
              { name: "description", label: "Description", required: true, type: "textarea" },
              { name: "command", label: "Command", placeholder: "echo ok" },
              { name: "owner_teammate_id", label: "Owner teammate ID (optional)" },
              { name: "issue_id", label: "Issue ID (optional)" },
            ]}
            onSubmit={async (values) => {
              const task = await api.createTask(projectId, values);
              setCreated((prev) => [task.id, ...prev]);
              setShowCreate(false);
              onOpenTask(task.id);
            }}
          />
        </Modal>
      ) : null}
      {created.length > 0 ? (
        <div className="card">
          <strong>Created this session</strong>
          {created.map((id) => (
            <div key={id}>
              <a href={`#/p/${projectId}/t/${id}`}>
                <ShortId id={id} />
              </a>
            </div>
          ))}
        </div>
      ) : null}

      <h2>Tasks</h2>
      {tasks.loading ? (
        <LoadingState />
      ) : tasks.error ? (
        <ErrorState error={tasks.error} onRetry={tasks.reload} />
      ) : tasks.data && tasks.data.tasks.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Delegated from</th>
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            {tasks.data.tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <a href={`#/p/${projectId}/t/${task.id}`} onClick={() => onOpenTask(task.id)}>
                    {task.description || "Untitled task"}
                  </a>
                </td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
                <td className="muted">{ownerName(task.owner_teammate_id)}</td>
                <td>
                  {task.parent_task_id ? (
                    <a href={`#/p/${projectId}/t/${task.parent_task_id}`}>
                      <ShortId id={task.parent_task_id} />
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono muted" style={{ maxWidth: 260, overflowWrap: "anywhere" }}>
                  {task.command || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No tasks yet" hint="Create a task above, or let a bot decompose an objective into one." />
      )}

      <h2>Runs across tasks</h2>
      {runs.loading ? (
        <LoadingState />
      ) : runs.error ? (
        <ErrorState error={runs.error} onRetry={runs.reload} />
      ) : runs.data && runs.data.runs.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Run</th>
              <th>Task</th>
              <th>Status</th>
              <th>Exit</th>
              <th>Runtime</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <ShortId id={run.id} />
                </td>
                <td>
                  <a href={`#/p/${projectId}/t/${run.task_id}`}>
                    <ShortId id={run.task_id} />
                  </a>
                </td>
                <td>
                  <StatusBadge status={run.status} />
                </td>
                <td className="mono">{run.exit_code ?? "—"}</td>
                <td className="muted">{run.runtime}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No runs yet" hint="Create a task, then run it from the task page." />
      )}
    </div>
  );
}

function TeammatesTab({ projectId }: { projectId: string }) {
  const list = useReloadable(() => api.listTeammates(projectId), [projectId]);
  const providers = useReloadable(() => api.listProviders(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowCreate(true)}>
          New bot
        </button>
        <button onClick={list.reload}>Refresh</button>
      </div>
      {showCreate ? (
        <Modal title="New bot" onClose={() => setShowCreate(false)}>
          <BotForm
            projectId={projectId}
            providers={providers.data?.providers ?? []}
            onDone={() => {
              setShowCreate(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.teammates.length > 0 ? (
        list.data.teammates.map((mate) => (
          <BotCard
            key={mate.id}
            mate={mate}
            providers={providers.data?.providers ?? []}
            onChanged={() => {
              list.reload();
              providers.reload();
            }}
          />
        ))
      ) : (
        <EmptyState
          title="No bots yet"
          hint="Create a bot with a persona and instructions, then attach a model connection so it can think. Bots own and run tasks."
        />
      )}
    </div>
  );
}

function BotCard({
  mate,
  providers,
  onChanged,
}: {
  mate: TeammateT;
  providers: Provider[];
  onChanged: () => void;
}) {
  const [showAttach, setShowAttach] = useState(false);
  const [showPerms, setShowPerms] = useState(false);
  const catalogue = usePermissionCatalogue();
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (err) {
      notifyError(err);
    }
  };
  const attached = providers.find((p) => p.id === mate.provider_id);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{mate.persona || "Unnamed bot"}</strong>{" "}
          <span className="muted mono">{mate.id}</span> <StatusBadge status={mate.status} />
        </div>
        <div className="row">
          <button onClick={() => setShowAttach(true)}>
            {attached ? "Switch model" : "Attach model"}
          </button>
          <button onClick={() => setShowPerms(true)}>Permissions</button>
          <button onClick={() => void act(() => api.disableTeammate(mate.id))}>Disable</button>
          <button onClick={() => void act(() => api.archiveTeammate(mate.id))}>Archive</button>
        </div>
      </div>
      <div className="muted">{mate.instructions || "No instructions yet."}</div>
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span className="muted mono" style={{ fontSize: 12 }}>
          memory: {mate.memory_scope}
        </span>
        {(mate.permissions ?? []).length === 0 ? (
          <span className="pill" title="No permissions: every gated tool call is denied.">
            no permissions
          </span>
        ) : (
          mate.permissions.map((perm) => (
            <span
              className="pill"
              key={perm}
              title={
                catalogue.isAdmin(perm)
                  ? "admin (approval-gated)"
                  : catalogue.byName.has(perm)
                    ? "agent permission"
                    : "unknown permission — grants nothing"
              }
            >
              {perm}
            </span>
          ))
        )}
        {Object.keys(mate.tool_policy ?? {}).length > 0
          ? Object.entries(mate.tool_policy).map(([tool, mode]) => (
              <span className="pill" key={tool} title={`tool_policy.${tool}`}>
                {tool}: {String(mode)}
              </span>
            ))
          : null}
      </div>
      <div className="mono muted" style={{ marginTop: 8 }}>
        brain:{" "}
        {attached ? (
          <>
            {attached.name} · {String(attached.config.model ?? "model not set")}
          </>
        ) : mate.provider_id ? (
          <>{mate.provider_id} (connection not found)</>
        ) : (
          <span style={{ color: "#b58a00" }}>none — the bot cannot think until one is attached</span>
        )}
      </div>
      {showAttach ? (
        <Modal title={`Model for ${mate.persona || mate.id}`} onClose={() => setShowAttach(false)}>
          {providers.length === 0 ? (
            <div className="error-box">
              This project has no model connections yet — create one under the{" "}
              <strong>Providers</strong> tab first.
            </div>
          ) : (
            <div>
              {providers.map((p) => (
                <div
                  key={p.id}
                  className="row"
                  style={{ justifyContent: "space-between", padding: "6px 0" }}
                >
                  <span>
                    <strong>{p.name || p.id}</strong>{" "}
                    <span className="mono muted">{String(p.config.model ?? "")}</span>
                    {mate.provider_id === p.id ? " (current)" : null}
                  </span>
                  <button
                    onClick={() =>
                      void act(() => api.patchTeammate(mate.id, {
                        // current connection → explicit detach (null);
                        // another connection → attach it
                        provider_id: mate.provider_id === p.id ? null : p.id,
                      }))
                    }
                  >
                    {mate.provider_id === p.id ? "Detach" : "Attach"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
      {showPerms ? (
        <Modal title={`Permissions for ${mate.persona || mate.id}`} onClose={() => setShowPerms(false)}>
          <PermissionsForm
            mate={mate}
            onSaved={() => {
              setShowPerms(false);
              onChanged();
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function PermissionsForm({ mate, onSaved }: { mate: TeammateT; onSaved: () => void }) {
  const [permissions, setPermissions] = useState<string[]>(mate.permissions ?? []);
  const [memoryScope, setMemoryScope] = useState(mate.memory_scope || "teammate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalogue = usePermissionCatalogue();
  const toggle = (perm: string) =>
    setPermissions((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]));

  const adminPerms = catalogue.permissions.filter((p) => p.kind === "admin");
  const agentPerms = catalogue.permissions.filter((p) => p.kind !== "admin");
  // A permission the bot holds but the server does not know is dead weight:
  // it grants nothing. Surface it instead of silently dropping it.
  const unknownHeld = permissions.filter((p) => !catalogue.byName.has(p));

  return (
    <form
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.patchTeammate(mate.id, { permissions, memory_scope: memoryScope });
          onSaved();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Memory scope — where this bot may read and write memory">
        <select value={memoryScope} onChange={(e) => setMemoryScope(e.target.value)}>
          <option value="teammate">teammate — only its own memory</option>
          <option value="project">project — shared workspace memory</option>
        </select>
      </Field>
      {catalogue.loading ? (
        <div className="muted" style={{ margin: "8px 0" }}>
          Loading the permission catalogue…
        </div>
      ) : catalogue.error ? (
        <div className="error-box" role="alert">
          Could not load the permission catalogue: {describeError(catalogue.error)}
        </div>
      ) : null}
      <div className="muted" style={{ margin: "8px 0 4px" }}>
        Admin permissions are deny-by-default and need a human&apos;s exact-action approval even when granted.
      </div>
      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
        <legend className="muted mono" style={{ fontSize: 12 }}>
          admin (approval-gated)
        </legend>
        {adminPerms.map((perm) => (
          <label key={perm.name} style={{ display: "block" }} title={perm.summary}>
            <input type="checkbox" checked={permissions.includes(perm.name)} onChange={() => toggle(perm.name)} />{" "}
            {perm.name}
            <span className="muted" style={{ fontSize: 11 }}>
              {" "}
              — {perm.summary}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
        <legend className="muted mono" style={{ fontSize: 12 }}>
          agent
        </legend>
        {agentPerms.map((perm) => (
          <label key={perm.name} style={{ display: "block" }} title={perm.summary}>
            <input type="checkbox" checked={permissions.includes(perm.name)} onChange={() => toggle(perm.name)} />{" "}
            {perm.name}
            <span className="muted" style={{ fontSize: 11 }}>
              {" "}
              — {perm.summary}
            </span>
          </label>
        ))}
      </fieldset>
      {unknownHeld.length > 0 ? (
        <div className="error-box" role="alert">
          This bot holds permission names the server does not know: {unknownHeld.join(", ")}. They grant
          nothing and will be rejected on save — remove them below.
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {unknownHeld.map((p) => (
              <button key={p} type="button" className="danger" onClick={() => toggle(p)}>
                remove {p}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="muted mono" style={{ fontSize: 12 }}>
        selected: {permissions.length ? permissions.join(", ") : "none"}
      </div>
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" type="submit" disabled={busy || catalogue.loading || unknownHeld.length > 0}>
          {busy ? "Saving…" : "Save permissions"}
        </button>
      </div>
    </form>
  );
}

function BotForm({
  projectId,
  providers,
  onDone,
}: {
  projectId: string;
  providers: Provider[];
  onDone: () => void;
}) {
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
          const created = await api.createTeammate(projectId, {
            persona,
            instructions,
            capabilities: capabilities
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          if (providerId) {
            await api.patchTeammate(created.id, { provider_id: providerId });
          }
          onDone();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name (its job)">
        <input
          required
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder="coder"
        />
      </Field>
      <Field label="Instructions — how it should behave">
        <textarea
          rows={3}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Be terse. Show real command output. Ask before destructive steps."
        />
      </Field>
      <Field label="Capabilities (comma separated)">
        <input
          value={capabilities}
          onChange={(e) => setCapabilities(e.target.value)}
          placeholder="code, review"
        />
      </Field>
      <Field label="Model connection (change or detach later)">
        {providers.length === 0 ? (
          <div className="muted">No connections in this project yet — attach one after creating the bot.</div>
        ) : (
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">(attach later)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id} — {String(p.config.model ?? "")}
              </option>
            ))}
          </select>
        )}
      </Field>
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create bot"}
        </button>
      </div>
    </form>
  );
}

function ProvidersTab({ projectId }: { projectId: string }) {
  const list = useReloadable(() => api.listProviders(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  const health = useAsync(() => api.health(), [projectId]);

  return (
    <div>
      {health.data && health.data.secret_key === "absent" ? (
        <div className="error-box" style={{ marginBottom: 12 }}>
          No <code>NERDBOT_SECRET_KEY</code> on this server: pasting an API key will be
          refused (we never store keys in the clear). Start the server with a Fernet key to
          enable BYOK — the <code>api_key_env</code> path keeps working meanwhile.
        </div>
      ) : null}
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowCreate(true)}>
          New model connection
        </button>
        <button onClick={list.reload}>Refresh</button>
      </div>
      {showCreate ? (
        <Modal title="New model connection" onClose={() => setShowCreate(false)}>
          <ProviderForm
            projectId={projectId}
            onDone={() => {
              setShowCreate(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.providers.length > 0 ? (
        list.data.providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} onChanged={list.reload} />
        ))
      ) : (
        <EmptyState
          title="No model connections"
          hint="Bots need a brain: connect one openai-compatible provider (Groq, OpenRouter, OpenAI, Kimi…) above. Keys are stored Fernet-encrypted, or referenced via an env var name."
        />
      )}
    </div>
  );
}

const BASE_URL_PRESETS: Array<{ label: string; url: string }> = [
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "Kimi (Moonshot)", url: "https://api.moonshot.cn/v1" },
];

function providerModelName(config: Record<string, unknown>): string {
  return typeof config.model === "string" ? config.model : "";
}

function ProviderCard({ provider, onChanged }: { provider: Provider; onChanged: () => void }) {
  const [showModels, setShowModels] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const disabled = provider.status !== "active";

  return (
    <div className="card" style={disabled ? { opacity: 0.6 } : undefined}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{provider.name || provider.id}</strong> <span className="muted mono">{provider.kind}</span>{" "}
          <StatusBadge status={provider.status} />
          {providerModelName(provider.config) ? (
            <span className="chip">{providerModelName(provider.config)}</span>
          ) : (
            <span className="chip muted">no model set</span>
          )}
        </div>
        <div className="row">
          <button onClick={() => setShowModels(true)}>Models</button>
          <button onClick={() => setShowEdit(true)}>Edit</button>
          <button
            onClick={async () => {
              try {
                await api.patchProvider(provider.id, {
                  status: disabled ? "active" : "disabled",
                });
                onChanged();
              } catch (err) {
                notifyError(err);
              }
            }}
          >
            {disabled ? "Enable" : "Disable"}
          </button>
        </div>
      </div>
      <div className="mono muted" style={{ marginTop: 8 }}>
        {provider.id} · {String(provider.config.base_url ?? "")}
        {typeof provider.config.api_key === "string" && provider.config.api_key ? (
          <> · key <code>{String(maskSecrets(provider.config).api_key)}</code></>
        ) : typeof provider.config.api_key_env === "string" && provider.config.api_key_env ? (
          <> · key env <code>{provider.config.api_key_env}</code></>
        ) : null}
      </div>
      {showModels ? (
        <Modal title={`Models · ${provider.name || provider.id}`} onClose={() => setShowModels(false)}>
          <ModelCatalogPicker provider={provider} onDone={() => setShowModels(false)} />
        </Modal>
      ) : null}
      {showEdit ? (
        <Modal title="Edit connection" onClose={() => setShowEdit(false)}>
          <EditProviderForm provider={provider} onDone={() => { setShowEdit(false); onChanged(); }} />
        </Modal>
      ) : null}
    </div>
  );
}

function ModelCatalogPicker({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const list = useAsync(() => api.providerModels(provider.id), [provider.id]);
  const [applying, setApplying] = useState<string | null>(null);
  const current = providerModelName(provider.config);

  return (
    <div>
      {list.loading ? <LoadingState lines={4} /> : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {list.data?.models.map((model) => (
            <div className="row" key={model} style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span className="mono" style={model === current ? { fontWeight: 700 } : undefined}>
                {model === current ? `${model} (current)` : model}
              </span>
              <button
                disabled={model === current || applying !== null}
                onClick={async () => {
                  setApplying(model);
                  try {
                    await api.patchProvider(provider.id, { config: { model } });
                    onDone();
                  } catch (err) {
                    notifyError(err);
                  } finally {
                    setApplying(null);
                  }
                }}
              >
                {applying === model ? "Setting…" : "Use"}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="muted" style={{ marginTop: 8 }}>
        Fetched live from the provider's <code>/models</code>; picking one rewrites this connection's model.
      </div>
    </div>
  );
}

function EditProviderForm({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(typeof provider.config.base_url === "string" ? provider.config.base_url : "");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setBusy(true);
        const body: Record<string, unknown> = { name, config: { base_url: baseUrl } };
        if (apiKey) body.config = { ...(body.config as Record<string, unknown>), api_key: apiKey };
        try {
          await api.patchProvider(provider.id, body);
          onDone();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Base URL">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="API key — leave empty to keep the current one" error={error ?? undefined}>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      </Field>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export function ProviderForm({ projectId, onDone }: { projectId?: string; onDone?: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(BASE_URL_PRESETS[0].url);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyPreset = (label: string) => {
    const preset = BASE_URL_PRESETS.find((p) => p.label === label);
    if (preset) {
      setPresetLabel(label);
      setBaseUrl(preset.url);
    }
  };
  const [presetLabel, setPresetLabel] = useState(BASE_URL_PRESETS[0].label);

  return (
    <form
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setBusy(true);
        const target = projectId;
        if (!target) {
          setError("Project ID required");
          setBusy(false);
          return;
        }
        const config: Record<string, string> = {};
        if (baseUrl) config.base_url = baseUrl;
        if (model) config.model = model;
        if (apiKey) config.api_key = apiKey;
        if (apiKeyEnv) config.api_key_env = apiKeyEnv;
        try {
          await api.createProvider(target, { kind: "openai-compatible", name, config });
          onDone?.();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {projectId ? null : <input type="hidden" />}
      <Field label="Preset">
        <select value={presetLabel} onChange={(e) => applyPreset(e.target.value)}>
          {BASE_URL_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom (edit base URL)</option>
        </select>
      </Field>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="groq" />
      </Field>
      <Field label="Base URL">
        <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="Model (you can pick from the catalog after connecting)">
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-oss-120b" />
      </Field>
      <Field label="API key — stored Fernet-encrypted (server needs NERDBOT_SECRET_KEY)">
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Or env var name holding the key" >
        <input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="CLOUD_MODEL_KEY" />
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Alternative to pasting a key. Never a NERDBOT_* name.
        </div>
      </Field>
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}

function IssuesTab({ projectId }: { projectId: string }) {
  const list = useReloadable(() => api.listIssues(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  const [showGithub, setShowGithub] = useState(false);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowCreate(true)}>
          New issue
        </button>
        <button onClick={() => setShowGithub(true)}>Fetch from GitHub</button>
        <button onClick={list.reload}>Refresh</button>
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
          <div className="card" key={issue.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{issue.title}</strong>
              <StatusBadge status={issue.status} />
            </div>
            <div className="muted mono">{issue.id} · {issue.source}{issue.external_id ? ` · ${issue.external_id}` : ""}</div>
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
      <div className="row">
        <input value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="owner/repo" aria-label="Repository" />
        <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="7" aria-label="Issue number" style={{ maxWidth: 100 }} />
        <button className="primary" onClick={fetchPreview} disabled={busy}>
          {busy ? "Fetching…" : "Preview"}
        </button>
      </div>
      {error ? <div className="error-box" style={{ marginTop: 12 }}>{error}</div> : null}
      {preview ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12 }}>Untrusted preview — confirm before ingesting.</div>
          <strong>{String(preview.title ?? "")}</strong>
          <div className="muted">{String(preview.body ?? "").slice(0, 400)}</div>
          <div style={{ marginTop: 12 }}>
            <button className="primary" onClick={ingest}>
              Confirm and ingest
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KnowledgeTab({ projectId }: { projectId: string }) {
  const list = useReloadable(() => api.listKnowledge(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowCreate(true)}>
          Ingest knowledge
        </button>
        <button onClick={list.reload}>Refresh</button>
      </div>
      {showCreate ? (
        <Modal title="Ingest knowledge" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Ingest"
            fields={[
              { name: "title", label: "Title", required: true },
              { name: "content", label: "Content", required: true, type: "textarea" },
              { name: "source", label: "Source (provenance)", required: true, placeholder: "ops-wiki" },
            ]}
            onSubmit={async (values) => {
              await api.ingestKnowledge(projectId, values);
              setShowCreate(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.sources.length > 0 ? (
        list.data.sources.map((source) => (
          <div className="card" key={source.id}>
            <strong>{source.title}</strong> <span className="muted">· {source.source}</span>
            <div className="muted mono">{source.id}</div>
          </div>
        ))
      ) : (
        <EmptyState title="No knowledge sources" hint="Ingest runbooks and notes with provenance." />
      )}
    </div>
  );
}

function SchedulesTab({ projectId }: { projectId: string }) {
  const list = useReloadable(() => api.listSchedules(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);

  const fire = async (id: string) => {
    try {
      await api.fireSchedule(id);
      list.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowCreate(true)}>
          New schedule
        </button>
        <button onClick={list.reload}>Refresh</button>
      </div>
      {showCreate ? (
        <Modal title="New schedule" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create schedule"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "cron", label: "Cron (5 fields)", required: true, placeholder: "0 9 * * *" },
              { name: "description", label: "Task description", required: true },
              { name: "command", label: "Task command", required: true },
            ]}
            onSubmit={async (values) => {
              await api.createSchedule(projectId, {
                name: values.name,
                cron: values.cron,
                task_template: { description: values.description, command: values.command },
              });
              setShowCreate(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.schedules.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Cron</th>
              <th>Next run</th>
              <th>Fired</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data.schedules.map((schedule) => (
              <tr key={schedule.id}>
                <td>{schedule.name}</td>
                <td className="mono">{schedule.cron}</td>
                <td className="muted mono">{schedule.next_run_at ?? "—"}</td>
                <td>{schedule.fire_count}×</td>
                <td>
                  <button onClick={() => fire(schedule.id)}>Fire now</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No schedules" hint="Schedules fire tasks on a cron." />
      )}
    </div>
  );
}

function ApprovalsTab({ projectId }: { projectId: string }) {
  // Merge project-wide approvals with per-run ones: legacy rows may have an
  // empty project_id, so the project query alone can miss them.
  const inbox = useAsync(async () => {
    const byId = new Map<string, Approval>();
    const projectRows = (await api.projectApprovals(projectId)).approvals;
    for (const approval of projectRows) byId.set(approval.id, approval);
    const runList = (await api.projectRuns(projectId)).runs;
    for (const run of runList) {
      const list = await api.listRunApprovals(run.id);
      for (const approval of list.approvals) {
        if (!byId.has(approval.id)) byId.set(approval.id, approval);
      }
    }
    return [...byId.values()];
  }, [projectId]);

  // Poll while anything awaits a decision so bot requests show up unprompted.
  useEffect(() => {
    const pendingCount = (inbox.data ?? []).filter((a) => a.decision === "pending").length;
    if (!pendingCount) return;
    const t = setInterval(inbox.reload, 8000);
    return () => clearInterval(t);
  }, [inbox.data, inbox.reload]);

  const decide = async (
    id: string,
    decision: "approved" | "approved_forever" | "denied",
  ) => {
    try {
      await api.decideApproval(id, decision);
      inbox.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const rows = inbox.data ?? [];
  const pending = rows.filter((approval) => approval.decision === "pending");
  const decided = rows.filter((approval) => approval.decision !== "pending");

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button
          onClick={async () => {
            try {
              await api.purgeApprovals(projectId);
              inbox.reload();
            } catch (err) {
              notifyError(err);
            }
          }}
        >
          Purge expired
        </button>
        <button onClick={inbox.reload}>Refresh</button>
      </div>
      {inbox.loading && !inbox.data ? (
        <LoadingState />
      ) : inbox.error ? (
        <ErrorState error={inbox.error} onRetry={inbox.reload} />
      ) : pending.length > 0 ? (
        pending.map((approval) => (
          <div className="card" key={approval.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{approval.action || "approval"}</strong>{" "}
                <span className="muted mono">{approval.id}</span>{" "}
                <span className="pill">{approval.requester}</span>{" "}
                {approval.task_id ? (
                  <a href={`#/p/${projectId}/t/${approval.task_id}`}>
                    task <ShortId id={approval.task_id} />
                  </a>
                ) : null}
                <div className="muted mono" style={{ fontSize: 12 }}>
                  digest: {approval.digest || "—"}
                </div>
              </div>
              <div className="row">
                <button className="primary" onClick={() => void decide(approval.id, "approved")}>
                  Approve
                </button>
                <button
                  className="primary"
                  onClick={() => void decide(approval.id, "approved_forever")}
                >
                  Approve Forever
                </button>
                <button className="danger" onClick={() => void decide(approval.id, "denied")}>
                  Deny
                </button>
              </div>
            </div>
          </div>
        ))
      ) : (
        <EmptyState title="Inbox empty" hint="No pending approvals. Decided ones stay queryable per run." />
      )}
      {decided.length > 0 ? (
        <>
          <h2>Decided</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Action</th>
                  <th>Requester</th>
                  <th>Decision</th>
                  <th>Executed</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((approval) => (
                  <tr key={approval.id}>
                    <td>
                      <ShortId id={approval.id} />
                    </td>
                    <td>{approval.action}</td>
                    <td>{approval.requester}</td>
                    <td>
                      <StatusBadge status={approval.decision} />
                    </td>
                    <td className="muted">
                      {approval.executed_at ? new Date(approval.executed_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

function NotificationsTab({ projectId }: { projectId: string }) {
  const list = useReloadable(() => api.listNotifications(projectId), [projectId]);
  const [showSend, setShowSend] = useState(false);
  const [showTarget, setShowTarget] = useState(false);
  const targets = useReloadable(() => api.listWebhookTargets(projectId), [projectId]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      list.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowSend(true)}>
          Send notification
        </button>
        <button onClick={() => setShowTarget(true)}>Add webhook target</button>
        <button onClick={() => act(() => api.sweepWebhooks())}>Sweep due webhooks</button>
        <button onClick={list.reload}>Refresh</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
        Deliveries run only when swept here or by OS cron (nerdbot deliveries-sweep).
        There is no background delivery recovery in NerdBot.
      </p>
      {showSend ? (
        <Modal title="Send notification" onClose={() => setShowSend(false)}>
          <EntityForm
            submitLabel="Send"
            fields={[
              { name: "channel", label: "Channel", type: "select", options: ["outbox", "webhook-out"] },
              { name: "kind", label: "Kind", required: true, placeholder: "deploy.done" },
              { name: "payload", label: "Payload (JSON object)", placeholder: '{"ref": "main"}' },
              { name: "target_url", label: "Target URL override (webhook-out only)" },
            ]}
            onSubmit={async (values) => {
              let payload: Record<string, unknown> = {};
              try {
                payload = values.payload ? (JSON.parse(values.payload) as Record<string, unknown>) : {};
              } catch {
                throw new Error("Payload is not valid JSON");
              }
              await api.sendNotification(projectId, { ...values, payload });
              setShowSend(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {showTarget ? (
        <Modal title="Add webhook target" onClose={() => setShowTarget(false)}>
          <EntityForm
            submitLabel="Add target"
            fields={[{ name: "url", label: "HTTPS URL (public hosts only)", required: true }]}
            onSubmit={async (values) => {
              await api.addWebhookTarget(projectId, values.url);
              setShowTarget(false);
              targets.reload();
            }}
          />
        </Modal>
      ) : null}
      {targets.data && targets.data.targets.length > 0 ? (
        <div className="card">
          <strong>Targets</strong>
          {targets.data.targets.map((target) => (
            <div className="row mono muted" key={String(target.id)} style={{ justifyContent: "space-between" }}>
              <span>{String(target.url)}</span>
              <button
                onClick={() =>
                  act(async () => {
                    await api.deleteWebhookTarget(String(target.id));
                    targets.reload();
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.notifications.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>ID</th>
              <th>Channel</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Next attempt</th>
              <th>Last error</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data.notifications.map((note) => (
              <tr key={note.id}>
                <td>
                  <ShortId id={note.id} />
                </td>
                <td className="muted">{note.channel}</td>
                <td>{note.kind}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <StatusBadge status={note.status} />
                    {note.locked ? <span className="badge">locked</span> : null}
                  </div>
                </td>
                <td className="mono">{note.attempts}</td>
                <td className="mono muted">{note.next_attempt_at ?? ""}</td>
                <td
                  className="mono muted"
                  style={{ maxWidth: 320, overflowWrap: "anywhere" }}
                  title={note.last_error || undefined}
                >
                  {note.last_error}
                </td>
                <td>
                  <div className="row">
                    <button onClick={() => act(() => api.deliverNotification(note.id))}>Deliver</button>
                    <button onClick={() => act(() => api.unlockNotification(note.id))}>Unlock</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No notifications" hint="Send one to record or deliver it." />
      )}
    </div>
  );
}

function MemoryTab({ projectId }: { projectId: string }) {
  const list = useReloadable(() => api.projectMemory(projectId), [projectId]);
  const [showWrite, setShowWrite] = useState(false);
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowWrite(true)}>
          Write memory
        </button>
        <button onClick={list.reload}>Refresh</button>
      </div>
      {showWrite ? (
        <Modal title="Write memory" onClose={() => setShowWrite(false)}>
          <EntityForm
            submitLabel="Store"
            fields={[
              { name: "content", label: "Content", required: true, type: "textarea" },
              { name: "source", label: "Source (provenance)", required: true },
              { name: "confidence", label: "Confidence (0–1)", placeholder: "0.8" },
            ]}
            onSubmit={async (values) => {
              await api.writeProjectMemory(projectId, {
                ...values,
                confidence: Number(values.confidence || 0.5),
              });
              setShowWrite(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.entries.length > 0 ? (
        list.data.entries.map((entry) => (
          <div className="card" key={entry.id}>
            <div>{entry.content}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {entry.source} · confidence {entry.confidence} ·{" "}
              <span className="mono">{entry.id}</span>
            </div>
          </div>
        ))
      ) : (
        <EmptyState title="No memories" hint="Project-scoped memories with provenance live here." />
      )}
    </div>
  );
}

function BackupTab({ projectId }: { projectId: string }) {
  const [manifest, setManifest] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setError(null);
    try {
      const data = await api.exportBackup(projectId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `nerdbot-backup-${projectId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notifyError(err);
    }
  };

  const runValidate = async () => {
    setError(null);
    setResult(null);
    try {
      const parsed: unknown = JSON.parse(manifest || "{}");
      setResult((await api.validateBackup(projectId, parsed)) as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notifyError(err);
    }
  };

  const runImport = async (dryRun: boolean) => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(manifest || "{}");
      setResult((await api.importBackup(projectId, parsed, dryRun)) as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => void download()}>
          Export backup
        </button>
      </div>
      <h2>Validate / import</h2>
      <p className="muted">Paste a manifest, validate it, dry-run first, then apply.</p>
      {error ? <div className="error-box">{error}</div> : null}
      <label className="field">
        <span>Manifest JSON</span>
        <textarea rows={6} value={manifest} onChange={(e) => setManifest(e.target.value)} placeholder='{"version": 1, …}' />
      </label>
      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={() => void runValidate()}>Validate</button>
        <button onClick={() => void runImport(true)} disabled={busy}>
          Dry run
        </button>
        <button className="danger" onClick={() => void runImport(false)} disabled={busy}>
          Apply import
        </button>
      </div>
      {result ? <pre className="log">{JSON.stringify(result, null, 2)}</pre> : null}
    </div>
  );
}

function MetricsTab({ projectId }: { projectId: string }) {
  const metrics = useAsync(() => api.projectMetrics(projectId), [projectId]);
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={metrics.reload}>Refresh</button>
      </div>
      {metrics.loading ? (
        <LoadingState />
      ) : metrics.error ? (
        <ErrorState error={metrics.error} onRetry={metrics.reload} />
      ) : metrics.data ? (
        <pre className="log">{JSON.stringify(metrics.data, null, 2)}</pre>
      ) : (
        <EmptyState title="No metrics" />
      )}
    </div>
  );
}

function EventsTab({ projectId }: { projectId: string }) {
  const [entity, setEntity] = useState("");
  const events = useAsync(() => api.projectEvents(projectId, entity || undefined), [projectId, entity]);
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entity filter" style={{ maxWidth: 220 }}>
          <option value="">All entities</option>
          <option value="task">task</option>
          <option value="run">run</option>
          <option value="approval">approval</option>
          <option value="teammate">teammate</option>
          <option value="notification">notification</option>
        </select>
        <button onClick={events.reload}>Refresh</button>
      </div>
      {events.loading ? (
        <LoadingState />
      ) : events.error ? (
        <ErrorState error={events.error} onRetry={events.reload} />
      ) : events.data && events.data.events.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Entity</th>
              <th>Event</th>
            </tr>
          </thead>
          <tbody>
            {events.data.events.slice(-100).reverse().map((event) => (
              <tr key={event.id}>
                <td className="mono muted">{event.timestamp}</td>
                <td className="muted">{event.entity}</td>
                <td className="mono">{event.event_type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No events" hint="State changes are recorded here." />
      )}
    </div>
  );
}
