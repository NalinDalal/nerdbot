import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import type { Approval, Provider } from "./types";
import { maskSecrets } from "./types";
import { EmptyState, ErrorState, LoadingState, Modal, ShortId, StatusBadge, useAsync } from "./components";
import { EntityForm } from "./forms";
import { ChatView } from "./views-chat";

const TABS = [
  "Tasks",
  "Chat",
  "Teammates",
  "Providers",
  "Issues",
  "Knowledge",
  "Schedules",
  "Approvals",
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
    <div>
      <div className="muted mono" style={{ marginBottom: 4 }}>
        <a href="#/">projects</a> / {projectId}
      </div>
      <h1>
        Project <ShortId id={projectId} />
      </h1>
      <div className="tabs" role="tablist">
        {TABS.map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>
      {tab === "Tasks" && <TasksTab projectId={projectId} onOpenTask={onOpenTask} />}
      {tab === "Chat" && <ChatView projectId={projectId} />}
      {tab === "Teammates" && <TeammatesTab projectId={projectId} />}
      {tab === "Providers" && <ProvidersTab projectId={projectId} />}
      {tab === "Issues" && <IssuesTab projectId={projectId} />}
      {tab === "Knowledge" && <KnowledgeTab projectId={projectId} />}
      {tab === "Schedules" && <SchedulesTab projectId={projectId} />}
      {tab === "Approvals" && <ApprovalsTab projectId={projectId} />}
      {tab === "Notifications" && <NotificationsTab projectId={projectId} />}
      {tab === "Memory" && <MemoryTab projectId={projectId} />}
      {tab === "Backup" && <BackupTab projectId={projectId} />}
      {tab === "Metrics" && <MetricsTab projectId={projectId} />}
      {tab === "Events" && <EventsTab projectId={projectId} />}
    </div>
  );
}

function useReloadable<T>(fn: () => Promise<T>, deps: unknown[]) {
  return useAsync(fn, deps);
}

function TasksTab({ projectId, onOpenTask }: { projectId: string; onOpenTask: (id: string) => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<string[]>([]);
  const list = useAsync(() => api.projectRuns(projectId), [projectId]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowCreate(true)}>
          New task
        </button>
        <button onClick={list.reload}>Refresh</button>
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
      <h2>Runs across tasks</h2>
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.runs.length > 0 ? (
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
            {list.data.runs.map((run) => (
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
  const [showCreate, setShowCreate] = useState(false);

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
        <button className="primary" onClick={() => setShowCreate(true)}>
          New teammate
        </button>
        <button onClick={list.reload}>Refresh</button>
      </div>
      {showCreate ? (
        <Modal title="New teammate" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create teammate"
            fields={[
              { name: "persona", label: "Persona", required: true, placeholder: "coder" },
              { name: "instructions", label: "Instructions", type: "textarea" },
              { name: "capabilities", label: "Capabilities (comma separated)", placeholder: "code, review" },
            ]}
            onSubmit={async (values) => {
              await api.createTeammate(projectId, {
                ...values,
                capabilities: values.capabilities.split(",").map((s) => s.trim()).filter(Boolean),
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
      ) : list.data && list.data.teammates.length > 0 ? (
        list.data.teammates.map((mate) => (
          <div className="card" key={mate.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{mate.persona || "Unnamed"}</strong>{" "}
                <span className="muted mono">{mate.id}</span> <StatusBadge status={mate.status} />
              </div>
              <div className="row">
                <button onClick={() => act(() => api.disableTeammate(mate.id))}>Disable</button>
                <button onClick={() => act(() => api.archiveTeammate(mate.id))}>Archive</button>
              </div>
            </div>
            <div className="muted">{mate.instructions || "No instructions"}</div>
          </div>
        ))
      ) : (
        <EmptyState title="No teammates" hint="Create one to own tasks." />
      )}
    </div>
  );
}

function ProvidersTab({ projectId }: { projectId: string }) {
  const list = useReloadable(() => api.listProviders(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowCreate(true)}>
          New provider
        </button>
        <button onClick={list.reload}>Refresh</button>
      </div>
      {showCreate ? (
        <Modal title="New provider" onClose={() => setShowCreate(false)}>
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
        <EmptyState title="No providers" hint="Local and mock need no credentials." />
      )}
    </div>
  );
}

function ProviderCard({ provider, onChanged }: { provider: Provider; onChanged: () => void }) {
  const masked = maskSecrets(provider.config);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{provider.name}</strong> <span className="muted mono">{provider.kind}</span>{" "}
          <StatusBadge status={provider.status} />
        </div>
        <button
          onClick={async () => {
            try {
              await api.disableProvider(provider.id);
              onChanged();
            } catch (err) {
              notifyError(err);
            }
          }}
        >
          Disable
        </button>
      </div>
      <div className="mono muted" style={{ marginTop: 8 }}>
        {provider.id}
      </div>
      <pre className="log">{JSON.stringify(masked, null, 2)}</pre>
    </div>
  );
}

export function ProviderForm({ projectId, onDone }: { projectId?: string; onDone?: () => void }) {
  return (
    <EntityForm
      submitLabel="Create provider"
      fields={[
        ...(projectId ? [] : [{ name: "project_id", label: "Project ID", required: true }]),
        { name: "kind", label: "Kind", type: "select", options: ["local", "mock", "openai-compatible"] },
        { name: "name", label: "Name", placeholder: "default" },
        { name: "base_url", label: "Base URL (openai-compatible only)", placeholder: "https://api.example.com/v1" },
        { name: "model", label: "Model (openai-compatible only)" },
        { name: "api_key", label: "API key (password, never echoed back)", type: "password" },
        { name: "api_key_env", label: "Or env var name holding the key", hint: "Prefer this over pasting a key. Never use NERDBOT_* names." },
      ]}
      onSubmit={async (values) => {
        const target = projectId ?? values.project_id;
        const config: Record<string, string> = {};
        for (const key of ["base_url", "model", "api_key", "api_key_env"]) {
          if (values[key]) config[key] = values[key];
        }
        await api.createProvider(target, { kind: values.kind || "local", name: values.name, config });
        onDone?.();
      }}
    />
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
  const inbox = useAsync(async () => {
    const runList = (await api.projectRuns(projectId)).runs;
    const collected: { approval: Approval; taskId: string }[] = [];
    for (const run of runList) {
      const list = await api.listRunApprovals(run.id);
      for (const approval of list.approvals) {
        collected.push({ approval, taskId: run.task_id });
      }
    }
    return collected;
  }, [projectId]);

  const decide = async (id: string, decision: "approved" | "denied") => {
    try {
      await api.decideApproval(id, decision);
      inbox.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const rows = inbox.data ?? [];
  const pending = rows.filter((row) => row.approval.decision === "pending");

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
      {inbox.loading ? (
        <LoadingState />
      ) : inbox.error ? (
        <ErrorState error={inbox.error} onRetry={inbox.reload} />
      ) : pending.length > 0 ? (
        pending.map(({ approval, taskId }) => (
          <div className="card" key={approval.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{approval.action || "approval"}</strong>{" "}
                <span className="muted mono">{approval.id}</span>{" "}
                {taskId ? (
                  <a href={`#/p/${projectId}/t/${taskId}`}>
                    <ShortId id={taskId} />
                  </a>
                ) : null}
              </div>
              <div className="row">
                <button className="primary" onClick={() => void decide(approval.id, "approved")}>
                  Approve
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
      {rows.some((row) => row.approval.decision !== "pending") ? (
        <>
          <h2>Decided</h2>
          <table className="data">
            <thead>
              <tr>
                <th>ID</th>
                <th>Action</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((row) => row.approval.decision !== "pending")
                .map(({ approval }) => (
                  <tr key={approval.id}>
                    <td>
                      <ShortId id={approval.id} />
                    </td>
                    <td>{approval.action}</td>
                    <td>
                      <StatusBadge status={approval.decision} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
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
