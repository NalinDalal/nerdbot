import { useState } from "react";
import { api, describeError } from "../api";
import { notifyError, navigate } from "../app";
import { FacePicker } from "../bot/FacePicker";
import { DEFAULT_FACE, normalizeFace, type BotFace as FaceChoice, faceStateFor } from "../bot/face";
import { Provider, Task, Teammate as TeammateT } from "../types";
import { BotFace, Button, ERROR_BOX, EmptyState, ErrorState, Field, FORM_INPUT, LoadingState, Modal, PageSection, StatusBadge, useAsync, usePermissionCatalogue } from "../components";
import { taskTitle } from "../taskTitle";

function teammateWorkSummary(teammateId: string, tasks: Task[]) {
  const mine = tasks.filter((t) => t.owner_teammate_id === teammateId);
  const running = mine.filter((t) => t.status === "running").length;
  const needsAttention = mine.filter((t) => t.status === "blocked" || t.status === "awaiting_approval" || t.status === "failed").length;
  const queued = mine.filter((t) => ["ready", "pending", "queued"].includes(t.status)).length;
  const done = mine.filter((t) => t.status === "done").length;
  const total = mine.length;

  let state = "Available";
  if (running > 0) state = "Working now";
  else if (needsAttention > 0) state = "Needs attention";
  else if (queued > 0) state = "Queued work";
  else if (done > 0 && running === 0) state = "Idle";
  else if (total === 0) state = "No work assigned";

  return { running, needsAttention, queued, done, state, total };
}

// role template hints for the creation form
const ROLE_TEMPLATES_WITH_HINTS = [
  {
    id: "researcher",
    label: "Research Analyst",
    persona: "researcher",
    instructions: "Find public evidence, sources and leads. Output structured records with links. Never invent facts.",
    hint: "Best for: market research, competitive intel, lead generation, document summarization",
  },
  {
    id: "engineer",
    label: "Software Engineer",
    persona: "engineer",
    instructions: "Implement, test and review code. Show real command output. Ask before destructive steps.",
    hint: "Best for: code generation, bug fixes, feature implementation, infrastructure tasks",
  },
  {
    id: "strategist",
    label: "Product Strategist",
    persona: "strategist",
    instructions: "Synthesize research into positioning and recommendations. Cite evidence. Draft only.",
    hint: "Best for: market positioning, go-to-market strategy, product briefs, opportunity analysis",
  },
  {
    id: "creator",
    label: "Content Creator",
    persona: "creator",
    instructions: "Write engaging content for marketing, blogs, and social media. Adapt tone for audience. Cite sources.",
    hint: "Best for: blog posts, social media content, marketing copy, email newsletters",
  },
  {
    id: "analyst",
    label: "Data Analyst",
    persona: "analyst",
    instructions: "Analyze data, generate charts and insights, write SQL queries. Show output clearly.",
    hint: "Best for: data analysis, report generation, trend identification, KPI tracking",
  },
];

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
        description="Collaborators in this workspace, what they're responsible for, and how to work with them."
        actions={
          <>
            <Button onClick={() => { list.reload(); providers.reload(); tasks.reload(); }}>Refresh</Button>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              {list.data?.teammates.length === 0 ? "Add teammate" : "Add another"}
            </Button>
          </>
        }
      >
        {showCreate ? (
          <Modal title="Add AI teammate" onClose={() => setShowCreate(false)}>
            <BotForm
              projectId={projectId}
              providers={providers.data?.providers ?? []}
              roleTemplates={ROLE_TEMPLATES_WITH_HINTS}
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
          <div className="flex flex-col gap-4">
            {/* Summary stats at top */}
            <div className="grid grid-cols-2 md-grid-cols-4 gap-3 text-step--1">
              <div className="p-3 rounded-lg bg-[var(--surface)]">
                <div className="text-[var(--muted)] text-xs">Total teammates</div>
                <div className="text-step-0 font-medium">{list.data.teammates.length}</div>
              </div>
              <div className="p-3 rounded-lg bg-[var(--surface)]">
                <div className="text-[var(--muted)] text-xs">Active</div>
                <div className="text-step-0 font-medium" style={{ color: "var(--accent)" }}>
                  {list.data.teammates.filter((m) => m.status === "active").length}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[var(--surface)]">
                <div className="text-[var(--muted)] text-xs">Needs attention</div>
                <div className="text-step-0 font-medium" style={{ color: "var(--warn)" }}>
                  {list.data.teammates.filter((m) => m.status === "blocked" || m.status === "awaiting_approval").length}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[var(--surface)]">
                <div className="text-[var(--muted)] text-xs">Idle</div>
                <div className="text-step-0 font-medium">{list.data.teammates.filter((m) => m.status === "idle").length}</div>
              </div>
            </div>

            {/* Teammate cards */}
            {list.data.teammates.map((mate) => (
              <BotCardEnhanced
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

function BotCardEnhanced({
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
  const work = teammateWorkSummary(mate.id, tasks);
  const attached = providers.find((p) => p.id === mate.provider_id);
  const face = normalizeFace(mate.face);

  // Quick status badge colors
  const statusColor = work.state === "Working now" ? "var(--accent)" :
    work.state === "Needs attention" ? "var(--warn)" :
    work.state === "Idle" ? "var(--muted)" : "var(--muted)";

  return (
    <div className="rounded-lg bg-[var(--surface)] p-4 flex flex-col min-h-[140px] hover:bg-[var(--surface-hover)] transition-colors">
      <div className="flex flex-col gap-2 flex-1">
        {/* Header: face + name + status */}
        <div className="flex items-start gap-3">
          <BotFace
            face={face}
            size={32}
            state={faceStateFor(mate.status)}
            animated
            className="flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div className="flex flex-col gap-1">
              <h4 className="text-step-0 font-medium text-[var(--text)]">
                {mate.persona || mate.name || "Teammate"}
              </h4>
              <p className="text-step--1 text-[var(--muted)] line-clamp-2">
                {mate.instructions || "No role or instructions set yet."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={mate.status} size="sm" />
              <span className="text-step--1" style={{ color: statusColor }}>
                {work.state}
              </span>
            </div>
          </div>
        </div>

        {/* Work summary */}
        <div className="mt-3 flex items-center gap-4 text-step--1 text-[var(--muted)]">
          <span className="flex items-center gap-1">
            <StatusBadge status={mate.status} size="sm" />
            {work.total} assigned, {work.done} done
          </span>
          {work.running > 0 && (
            <span className="ml-2 text-xs" style={{ color: "var(--accent)" }}>
              {work.running} running
            </span>
          )}
        </div>

        {/* Model + quick actions */}
        <div className="mt-3 pt-3 border-t border-[var(--border-dim)]">
          <div className="flex items-center gap-2 text-step--2">
            {attached ? (
              <div>
                <strong>{attached.name || attached.id}</strong>
                <span className="mono text-[var(--muted)]"> {String(attached.config.model ?? "")}</span>
                {mate.provider_id === attached.id ? " (current)" : ""}
              </div>
            ) : (
              <span className="text-[var(--muted)] text-xs">
                No model connected — attach under Providers tab
              </span>
            )}
          </div>

          <div className="mt-2 flex gap-2">
            <Button onClick={() => navigate(`/bot/${mate.id}`)} className="flex-1">
              Open details
            </Button>
            <Button
              variant="link"
              onClick={() => navigate(`/p/${mate.project_id}?tab=Chat`}
            )
            >
              Chat
            </Button>
            {mate.provider_id ? (
              <Button
                variant="link"
                onClick={() => setShowConfig((v) => !v)}
              >
                {showConfig ? "Hide" : "Configure"}
              </Button>
            ) : (
              <Button
                variant="link"
                onClick={() => setShowConfig((v) => !v)}
              >
                Configure
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BotForm({
  projectId,
  providers,
  roleTemplates,
  onDone,
}: {
  projectId: string;
  providers: Provider[];
  roleTemplates: typeof ROLE_TEMPLATES_WITH_HINTS;
  onDone: () => void;
}) {
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");
  const [name, setName] = useState("");
  const [face, setFace] = useState<FaceChoice>(DEFAULT_FACE);
  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Auto-populate from role template selection
  const [selectedTemplate, setSelectedTemplate] = useState<typeof roleTemplates[0] | null>(null);

  const handleTemplateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const t = roleTemplates.find((x) => x.id === e.target.value);
    if (!t) return;
    setPersona(t.persona);
    setInstructions(t.instructions);
    setName(t.label);
    setSelectedTemplate(t);
  };

  return (
    <Modal title="Add AI teammate" onClose={() => setShowCreate(false)} size="lg">
      <form
        onSubmit={async (e: React.FormEvent) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            // Use name as primary identifier if provided, otherwise persona
            const effectiveName = name.trim() || persona.trim() || "Teammate";
            const created = await api.createTeammate(projectId, {
              persona,
              instructions,
              name: effectiveName,
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
            value={selectedTemplate?.id ?? ""}
            onChange={handleTemplateChange}
            className={FORM_INPUT}
          >
            <option value="">(start blank or select a template)</option>
            {roleTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}{t.hint && (
                  <span className="ml-2 text-[var(--muted)] text-xs" title={t.hint}>
                    • {t.hint}
                  </span>
                )}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Name (its job, what teammates call this bot)">
          <input
            required
            value={name || persona}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. researcher, growth-bot, analyst"
            disabled={!!selectedTemplate}
          />
        </Field>

        <Field label="Instructions: how it should behave">
          <textarea
            rows={4}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. Find public evidence, sources and leads. Output structured records with links. Never invent facts."
          />
        </Field>

        <Field label="Face: the bot's own, changeable later">
          <FacePicker value={face} onChange={setFace} compact />
        </Field>

        <Field label="Model connection (change or detach later)">
          {providers.length === 0 ? (
            <div className="text-[var(--muted)]">
              No connections in this project yet. Create one under the <strong>Providers</strong> tab first.
            </div>
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
    </Modal>
  );
}