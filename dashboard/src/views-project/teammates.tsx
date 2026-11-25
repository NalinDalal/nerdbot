import { useState } from "react";
import { api, describeError } from "../api";
import { notifyError, navigate } from "../app";
import { FacePicker } from "../bot/FacePicker";
import { DEFAULT_FACE, normalizeFace, type BotFace as FaceChoice } from "../bot/face";
import { faceStateFor } from "../bot/status";
import { Provider, Task, Teammate as TeammateT } from "../types";
import { BotFace, Button, ERROR_BOX, EmptyState, ErrorState, Field, FORM_INPUT, LoadingState, Modal, PageSection, StatusBadge, useAsync, usePermissionCatalogue } from "../components";
import { taskTitle } from "../taskTitle";

function teammateWorkSummary(teammateId: string, tasks: Task[]) {
  const mine = tasks.filter((t) => t.owner_teammate_id === teammateId);
  const active = mine.find((t) => t.status === "running") || mine.find((t) => t.status === "awaiting_approval" || t.status === "blocked") || mine.find((t) => t.status === "ready" || t.status === "pending" || t.status === "queued");
  const running = mine.filter((t) => t.status === "running").length;
  const needsAttention = mine.filter((t) => t.status === "blocked" || t.status === "awaiting_approval" || t.status === "failed").length;
  const queued = mine.filter((t) => ["ready", "pending", "queued"].includes(t.status)).length;
  const done = mine.filter((t) => t.status === "done").length;
  let state = "Available";
  if (running > 0) state = "Working now";
  else if (needsAttention > 0) state = "Needs attention";
  else if (queued > 0) state = "Queued work";
  else if (done > 0) state = "Idle";
  return { active, state, running, needsAttention, queued, done, total: mine.length };
}

export function TeammatesTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.listTeammates(projectId), [projectId]);
  const providers = useAsync(() => api.listProviders(projectId), [projectId]);
  const tasks = useAsync(() => api.projectTasks(projectId).catch(() => ({ tasks: [] as Task[] })), [projectId]);
  const [showCreate, setShowCreate] = useState(false);

  const taskList = tasks.data?.tasks ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageSection
        title="AI teammates"
        description="Collaborators in this workspace, what they’re responsible for, and how to work with them."
        actions={
          <>
            <Button onClick={() => { list.reload(); providers.reload(); tasks.reload(); }}>Refresh</Button>
            <Button variant="primary" onClick={() => setShowCreate(true)}>Add teammate</Button>
          </>
        }
      >
        {showCreate ? (
          <Modal title="Add AI teammate" onClose={() => setShowCreate(false)}>
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
          <div className="flex flex-col gap-3">
            {list.data.teammates.map((mate) => (
              <BotCard
                key={mate.id}
                mate={mate}
                providers={providers.data?.providers ?? []}
                tasks={taskList}
                onChanged={() => {
                  list.reload();
                  providers.reload();
                  tasks.reload();
                }}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No teammates yet"
            hint="Add an AI teammate to collaborate on work in this workspace."
            action={<Button variant="primary" onClick={() => setShowCreate(true)}>Add teammate</Button>}
          />
        )}
      </PageSection>
    </div>
  );
}

function BotCard({
  mate,
  providers,
  tasks,
  onChanged,
}: {
  mate: TeammateT;
  providers: Provider[];
  tasks: Task[];
  onChanged: () => void;
}) {
  const [showAttach, setShowAttach] = useState(false);
  const [showPerms, setShowPerms] = useState(false);
  const [showFace, setShowFace] = useState(false);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [faceDraft, setFaceDraft] = useState<FaceChoice>(DEFAULT_FACE);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (err) {
      notifyError(err);
    }
  };
  const attached = providers.find((p) => p.id === mate.provider_id);
  const work = teammateWorkSummary(mate.id, tasks);

  return (
    <div className="rounded-lg bg-[var(--surface)] px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <BotFace face={mate.face} size={36} state={faceStateFor(mate.status)} animated />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-step-0 font-medium text-[var(--text)]">{mate.persona || mate.name || "Teammate"}</span>
              <span className="text-step--2 text-[var(--muted)]">{work.state}</span>
              <StatusBadge status={mate.status} />
            </div>
            <div className="mt-1 text-step--1 text-[var(--muted)] line-clamp-2">
              {mate.instructions || "No role or instructions set yet."}
            </div>
            <div className="mt-2 text-step--2 text-[var(--text-soft)]">
              {work.active ? (
                <>Current: <span className="text-[var(--text)]">{taskTitle(work.active.description)}</span> <span className="text-[var(--muted)]">· {work.active.status.replace("_", " ")}</span></>
              ) : work.total > 0 ? (
                <>{work.done} completed · {work.total} assigned in this workspace</>
              ) : (
                <>No work assigned in this workspace yet</>
              )}
            </div>
            <div className="mt-1 text-step--2 text-[var(--faint)]">
              {attached ? `Model: ${attached.name || attached.id}${mate.model ? ` (override ${mate.model})` : ""}` : mate.provider_id ? `Model: ${mate.provider_id} (connection not found)` : "No model connected"}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => navigate(`/bot/${mate.id}`)}>Open</Button>
          <Button variant="primary" onClick={() => navigate(`/p/${mate.project_id}?tab=Chat`)}>Chat</Button>
          <Button onClick={() => setShowConfig((v) => !v)}>{showConfig ? "Hide settings" : "Configure"}</Button>
        </div>
      </div>

      {showConfig ? (
        <div className="mt-4 border-t border-[var(--border-dim)] pt-3">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-step--2 text-[var(--muted)]">
            <span>memory: {mate.memory_scope}</span>
            <span>·</span>
            <span>{(mate.permissions ?? []).length} permission{(mate.permissions ?? []).length === 1 ? "" : "s"}</span>
            {attached ? <><span>·</span><span>{String(attached.config.model ?? "model not set")}</span></> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setShowAttach(true)}>{attached ? "Switch model" : "Attach model"}</Button>
            <Button onClick={() => setShowModelSettings(true)}>Model settings</Button>
            <Button onClick={() => setShowPerms(true)}>Permissions</Button>
            <Button onClick={() => { setFaceDraft(normalizeFace(mate.face)); setShowFace(true); }}>Face</Button>
            <Button onClick={() => void act(() => api.disableTeammate(mate.id))}>Disable</Button>
            <Button onClick={() => void act(() => api.archiveTeammate(mate.id))}>Archive</Button>
          </div>
          <div className="mt-2 text-step--2 text-[var(--faint)]">
            Advanced configuration and access controls remain available here and in the full agent view.
          </div>
        </div>
      ) : null}

      {showAttach ? (
        <Modal title={`Model for ${mate.persona || mate.id}`} onClose={() => setShowAttach(false)}>
          {providers.length === 0 ? (
            <div className="rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-step--1">
              This project has no model connections yet. Create one under the{" "}
              <strong>Providers</strong> tab first.
            </div>
          ) : (
            <div>
              {providers.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span>
                    <strong>{p.name || p.id}</strong>{" "}
                    <span className="mono text-[var(--muted)]">{String(p.config.model ?? "")}</span>
                    {mate.provider_id === p.id ? " (current)" : null}
                  </span>
                  <Button
                    onClick={() =>
                      void act(() => api.patchTeammate(mate.id, {
                        provider_id: mate.provider_id === p.id ? null : p.id,
                      }))
                    }
                  >
                    {mate.provider_id === p.id ? "Detach" : "Attach"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
      {showModelSettings ? (
        <Modal title={`Model settings for ${mate.persona || mate.id}`} onClose={() => setShowModelSettings(false)}>
          <ModelSettingsForm
            mate={mate}
            providers={providers}
            onSaved={() => {
              setShowModelSettings(false);
              onChanged();
            }}
          />
        </Modal>
      ) : null}
      {showFace ? (
        <Modal title={`Face of ${mate.persona || mate.id}`} onClose={() => setShowFace(false)}>
          <FacePicker value={faceDraft} onChange={setFaceDraft} compact />
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button onClick={() => setShowFace(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setShowFace(false);
                void act(() => api.patchTeammate(mate.id, { face: faceDraft }));
              }}
            >
              Save face
            </Button>
          </div>
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
      <Field label="Memory scope: where this bot may read and write memory">
        <select value={memoryScope} onChange={(e) => setMemoryScope(e.target.value)}>
          <option value="teammate">teammate: only its own memory</option>
          <option value="project">project: shared workspace memory</option>
        </select>
      </Field>
      {catalogue.loading ? (
        <div className="text-[var(--muted)]" style={{ margin: "8px 0" }}>
          Loading the permission catalogue…
        </div>
      ) : catalogue.error ? (
        <div className={ERROR_BOX} role="alert">
          Could not load the permission catalogue: {describeError(catalogue.error)}
        </div>
      ) : null}
      <div className="text-[var(--muted)]" style={{ margin: "8px 0 4px" }}>
        Admin permissions are deny-by-default and need a human&apos;s exact-action approval even when granted.
      </div>
      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
        <legend className="mono text-[var(--muted)]" style={{ fontSize: 12 }}>
          admin (approval-gated)
        </legend>
        {adminPerms.map((perm) => (
          <label key={perm.name} style={{ display: "block" }} title={perm.summary}>
            <input type="checkbox" checked={permissions.includes(perm.name)} onChange={() => toggle(perm.name)} />{" "}
            {perm.name}
            <span className="text-[var(--muted)]" style={{ fontSize: 11 }}>
              {" "}
               {perm.summary}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
        <legend className="mono text-[var(--muted)]" style={{ fontSize: 12 }}>
          agent
        </legend>
        {agentPerms.map((perm) => (
          <label key={perm.name} style={{ display: "block" }} title={perm.summary}>
            <input type="checkbox" checked={permissions.includes(perm.name)} onChange={() => toggle(perm.name)} />{" "}
            {perm.name}
            <span className="text-[var(--muted)]" style={{ fontSize: 11 }}>
              {" "}
               {perm.summary}
            </span>
          </label>
        ))}
      </fieldset>
      {unknownHeld.length > 0 ? (
        <div className={ERROR_BOX} role="alert">
          This bot holds permission names the server does not know: {unknownHeld.join(", ")}. They grant
          nothing and will be rejected on save remove them below.
          <div className="flex items-center gap-3" style={{ gap: 6, marginTop: 6 }}>
            {unknownHeld.map((p) => (
              <Button key={p} type="button" variant="danger" onClick={() => toggle(p)}>
                remove {p}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mono text-[var(--muted)]" style={{ fontSize: 12 }}>
        selected: {permissions.length ? permissions.join(", ") : "none"}
      </div>
      {error ? (
        <div className={ERROR_BOX} role="alert">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-3" style={{ marginTop: 8 }}>
        <Button variant="primary" type="submit" disabled={busy || catalogue.loading || unknownHeld.length > 0}>
          {busy ? "Saving…" : "Save permissions"}
        </Button>
      </div>
    </form>
  );
}

function ModelSettingsForm({
  mate,
  providers,
  onSaved,
}: {
  mate: TeammateT;
  providers: Provider[];
  onSaved: () => void;
}) {
  const [model, setModel] = useState(mate.model || "");
  const [temperature, setTemperature] = useState(
    mate.temperature === null || mate.temperature === undefined ? "" : String(mate.temperature),
  );
  const [maxTokens, setMaxTokens] = useState(
    mate.max_tokens === null || mate.max_tokens === undefined ? "" : String(mate.max_tokens),
  );
  const [contextLimit, setContextLimit] = useState(
    mate.context_limit === null || mate.context_limit === undefined ? "" : String(mate.context_limit),
  );
  const [fallbackProviderId, setFallbackProviderId] = useState(mate.fallback_provider_id || "");
  const [fallbackModel, setFallbackModel] = useState(mate.fallback_model || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.patchTeammate(mate.id, {
            model: model.trim(),
            temperature: temperature.trim() === "" ? null : Number(temperature),
            max_tokens: maxTokens.trim() === "" ? null : Number(maxTokens),
            context_limit: contextLimit.trim() === "" ? null : Number(contextLimit),
            fallback_provider_id: fallbackProviderId || null,
            fallback_model: fallbackModel.trim(),
          });
          onSaved();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Model override (leave empty to use the connection's model)">
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-oss-120b" />
      </Field>
      <Field label="Temperature">
        <input type="number" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} />
      </Field>
      <Field label="Max tokens">
        <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
      </Field>
      <Field label="Context limit">
        <input type="number" value={contextLimit} onChange={(e) => setContextLimit(e.target.value)} />
      </Field>
      <Field label="Fallback connection">
        <select value={fallbackProviderId} onChange={(e) => setFallbackProviderId(e.target.value)}>
          <option value="">(none)</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.id}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Fallback model">
        <input value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} />
      </Field>
      {error ? (
        <div className="text-[var(--danger)]" style={{ marginBottom: 8 }}>
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-3" style={{ marginTop: 8 }}>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save model settings"}
        </Button>
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
  const ROLE_TEMPLATES = [
    { id: "researcher", label: "Research Analyst", persona: "researcher", instructions: "Find public evidence, sources and leads. Output structured records with links. Never invent facts." },
    { id: "engineer", label: "Software Engineer", persona: "engineer", instructions: "Implement, test and review code. Show real command output. Ask before destructive steps." },
    { id: "strategist", label: "Product Strategist", persona: "strategist", instructions: "Synthesize research into positioning and recommendations. Cite evidence. Draft only." },
  ];
  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? "");
  const [face, setFace] = useState<FaceChoice>(DEFAULT_FACE);
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
            face,
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
      <Field label="Role template (optional)">
        <select
          value=""
          onChange={(e) => {
            const t = ROLE_TEMPLATES.find((x) => x.id === e.target.value);
            if (!t) return;
            setPersona(t.persona);
            setInstructions(t.instructions);
          }}
          className={FORM_INPUT}
        >
          <option value="">(none start blank)</option>
          {ROLE_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name (its job)">
        <input
          required
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder="coder"
        />
      </Field>
      <Field label="Instructions: how it should behave">
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
      <Field label="Face: the bot's own, changeable later">
        <FacePicker value={face} onChange={setFace} compact />
      </Field>
      <Field label="Model connection (change or detach later)">
        {providers.length === 0 ? (
          <div className="text-[var(--muted)]">No connections in this project yet. Attach one after creating the bot.</div>
        ) : (
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">(attach later)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id} {String(p.config.model ?? "")}
              </option>
            ))}
          </select>
        )}
      </Field>
      {error ? (
        <div className={ERROR_BOX} role="alert">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-3" style={{ marginTop: 8 }}>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create bot"}
        </Button>
      </div>
    </form>
  );
}
