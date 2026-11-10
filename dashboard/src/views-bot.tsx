import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "./api";
import { describeError, navigate, notifyError } from "./app";
import { FacePicker } from "./bot/FacePicker";
import { DEFAULT_FACE, normalizeFace, SHAPE_LABELS, COLOR_LABELS, EXPRESSION_LABELS, type BotFace as FaceChoice } from "./bot/face";
import { BotAvatar } from "./bot/BotAvatar";
import { botActivity, faceStateFor } from "./bot/status";
import type { Board, BoardMember, MemoryEntry, Project, Provider, Run, Task, Teammate } from "./types";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  ShortId,
  StatusBadge,
  StatusDot,
  BotChip,
  Button,
  SectionLabel,
  Page,
  PageHeader,
  relativeTime,
  useAsync,
  usePermissionCatalogue,
  Badge,
  ERROR_BOX,
  FORM_INPUT,
  FORM_SELECT,
  Field,
  TABLE_SHELL,
  TABLE_TD,
  TABLE_TH,
} from "./components";

function TeammateMemorySection({ teammateId }: { teammateId: string }) {
  const scope = `teammate:${teammateId}`;
  const [q, setQ] = useState("");
  const [tier, setTier] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [showWrite, setShowWrite] = useState(false);
  const [edit, setEdit] = useState<MemoryEntry | null>(null);
  const [data, setData] = useState<{ entries: MemoryEntry[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listMemory(scope, {
        q: q || undefined,
        tier: tier || undefined,
        pinned: pinnedOnly || undefined,
        limit,
        offset: page * limit,
      });
      setData({ entries: res.entries || [], total: res.total ?? (res.entries || []).length });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [teammateId, q, tier, pinnedOnly, page]);
  useEffect(() => { setPage(0); }, [q, tier, pinnedOnly, teammateId]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await reload(); } catch (err) { notifyError(err); }
  };

  const entries = data?.entries ?? [];
  const total = data?.total ?? entries.length;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>Private memory</SectionLabel>
      </div>
      <p className="mb-3 max-w-[72ch] text-step--1 text-[var(--muted)]">
        Only this bot reads and writes this memory. Notes here are recalled in its future runs as untrusted context with provenance.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setShowWrite(true)}>Remember something</Button>
        <Button onClick={() => void reload()}>Refresh</Button>
        <Button variant="ghost" onClick={() => void act(() => api.pruneMemory(scope, { keep: 200 }))}>Retention prune</Button>
        <input className={`${FORM_INPUT} max-w-xs`} placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search teammate memories" />
        <select className={FORM_SELECT} value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier filter">
          <option value="">All tiers</option>
          <option value="raw">raw</option>
          <option value="typed">typed</option>
          <option value="wisdom">wisdom</option>
        </select>
        <label className="flex items-center gap-1.5 text-step--1 text-[var(--muted)]">
          <input type="checkbox" checked={pinnedOnly} onChange={(e) => setPinnedOnly(e.target.checked)} /> Pinned
        </label>
      </div>

      {showWrite ? (
        <Modal title="Add teammate memory" onClose={() => setShowWrite(false)}>
          <form className="flex flex-col gap-3" onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            try {
              await api.writeTeammateMemory(teammateId, {
                content: String(fd.get("content") || "").trim(),
                source: String(fd.get("source") || "workspace").trim(),
                confidence: Number(fd.get("confidence") || 0.8),
                tier: String(fd.get("tier") || "raw"),
                provenance: { kind: "manual", actor: "user" },
              });
              setShowWrite(false);
              await reload();
              toast.success("Memory saved");
            } catch (err) { notifyError(err); }
          }}>
            <label className="text-step--1"><div className="mb-1 font-medium">What to remember</div><textarea name="content" className={`${FORM_INPUT} min-h-24`} required /></label>
            <label className="text-step--1"><div className="mb-1 font-medium">Source/provenance</div><input name="source" className={FORM_INPUT} defaultValue="workspace" /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-step--1"><div className="mb-1 font-medium">Confidence (0–1)</div><input name="confidence" className={FORM_INPUT} defaultValue="0.8" /></label>
              <label className="text-step--1"><div className="mb-1 font-medium">Tier</div><select name="tier" className={FORM_SELECT} defaultValue="raw"><option value="raw">raw</option><option value="typed">typed</option><option value="wisdom">wisdom</option></select></label>
            </div>
            <div className="flex justify-end gap-2"><Button type="button" onClick={() => setShowWrite(false)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
          </form>
        </Modal>
      ) : null}

      {edit ? (
        <Modal title="Edit memory" onClose={() => setEdit(null)}>
          <form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); try { await api.patchMemory(edit.id, { content: String(fd.get("content") || ""), source: String(fd.get("source") || "") }); setEdit(null); await reload(); toast.success("Memory corrected"); } catch (err) { notifyError(err); } }}>
            <label className="text-step--1"><div className="mb-1 font-medium">Content</div><textarea name="content" className={`${FORM_INPUT} min-h-24`} defaultValue={edit.content} /></label>
            <label className="text-step--1"><div className="mb-1 font-medium">Source</div><input name="source" className={FORM_INPUT} defaultValue={edit.source} /></label>
            <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save correction</Button></div>
          </form>
        </Modal>
      ) : null}

      {loading ? <LoadingState lines={3} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : entries.length === 0 ? (
        <EmptyState title="No memories" hint="Search, pin important facts, correct mistakes, or delete entries. Scoped memories are untrusted context when recalled." />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 whitespace-pre-wrap text-step--1 text-[var(--text-soft)]">{entry.content}</div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {entry.pinned ? <Badge variant="info">pinned</Badge> : null}
                    {(entry as any).corrected ? <Badge variant="warn">corrected</Badge> : null}
                    <Badge variant="neutral">{entry.tier || "raw"}</Badge>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-step--2 text-[var(--faint)]">
                  <span>Source: <span className="text-[var(--muted)]">{entry.source || "unknown"}</span></span>
                  <span>Confidence: {typeof entry.confidence === "number" ? entry.confidence.toFixed(2) : entry.confidence}</span>
                  <span>Scope: <span className="mono">{entry.scope}</span></span>
                  <span className="mono">{entry.id}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button onClick={() => void act(() => api.patchMemory(entry.id, { pinned: !entry.pinned }))}>{entry.pinned ? "Unpin" : "Pin"}</Button>
                  <Button onClick={() => setEdit(entry)}>Correct</Button>
                  <Button variant="danger" onClick={() => { if (confirm("Delete this memory?")) void act(() => api.deleteMemory(entry.id)); }}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-step--2 text-[var(--muted)]">
            <span>{total} total</span>
            <div className="flex gap-2">
              <Button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
              <Button disabled={(page + 1) * limit >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function openTask(projectId: string, taskId: string): void {
  navigate(`/p/${projectId}/t/${taskId}`);
}

export function BotDetailView({
  teammateId,
}: {
  teammateId: string;
}) {
  const all = useAsync(() => api.listAllTeammates(), [teammateId]);
  const tasks = useAsync(() => api.teammateTasks(teammateId), [teammateId]);
  const runs = useAsync(() => api.teammateRuns(teammateId), [teammateId]);
  const persona = useAsync(() => api.getPersona(teammateId), [teammateId]);
  const skills = useAsync(() => api.teammateSkills(teammateId), [teammateId]);
  const allSkills = useAsync(() => api.listSkills({ limit: 100 }), [teammateId]);
  const boards = useAsync(() => api.listBoards(), [teammateId]);
  /* Resolve the model name rather than printing "model connected": the owner
     needs to know which model a bot will think with. */
  const mateProjectId = all.data?.teammates.find((m) => m.id === teammateId)?.project_id;
  const providers = useAsync(
    () =>
      mateProjectId
        ? api.listProviders(mateProjectId).then((result) => result.providers)
        : Promise.resolve([] as Provider[]),
    [mateProjectId],
  );

  const [showCreateTask, setShowCreateTask] = useState(false);
  const [taskDescription, setTaskDescription] = useState("");
  const [taskCommand, setTaskCommand] = useState("");
  const [createTaskBusy, setCreateTaskBusy] = useState(false);
  const [showFace, setShowFace] = useState(false);
  const [faceDraft, setFaceDraft] = useState<FaceChoice>(DEFAULT_FACE);
  const [faceBusy, setFaceBusy] = useState(false);
  const catalogue = usePermissionCatalogue();
  const [showEdit, setShowEdit] = useState(false);
  const [editPersona, setEditPersona] = useState("");
  const [editName, setEditName] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editProviderId, setEditProviderId] = useState("");
  const [editMemoryScope, setEditMemoryScope] = useState("project");
  const [editPerms, setEditPerms] = useState<string[]>([]);
  const [editBusy, setEditBusy] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState<"disable" | "archive" | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [section, setSection] = useState<"overview" | "configuration" | "capabilities" | "memory" | "skills" | "work" | "activity">("overview");

  const openEditor = () => {
    if (!mate) return;
    setEditPersona(mate.persona ?? "");
    setEditName(mate.name ?? "");
    setEditInstructions(mate.instructions ?? "");
    setEditProviderId(mate.provider_id ?? "");
    setEditMemoryScope(mate.memory_scope || "project");
    setEditPerms(mate.permissions ?? []);
    setShowEdit(true);
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditBusy(true);
    try {
      await api.patchTeammate(teammateId, {
        persona: editPersona.trim(),
        name: editName.trim(),
        instructions: editInstructions,
        provider_id: editProviderId || null,
        memory_scope: editMemoryScope,
        permissions: editPerms,
      });
      setShowEdit(false);
      all.reload();
      toast.success("Teammate updated.");
    } catch (err) {
      notifyError(err);
    } finally {
      setEditBusy(false);
    }
  };

  const duplicate = async () => {
    if (!mate) return;
    try {
      const copy = await api.createTeammate(mate.project_id, {
        name: mate.name ? `${mate.name} copy` : "",
        persona: `${mate.persona || "Teammate"} copy`,
        instructions: mate.instructions,
        capabilities: mate.capabilities,
        memory_scope: mate.memory_scope,
        permissions: mate.permissions,
        provider_id: mate.provider_id,
        face: mate.face,
      });
      toast.success("Teammate duplicated.");
      navigate(`/bot/${copy.id}`);
    } catch (err) {
      notifyError(err);
    }
  };

  const applyStatus = async () => {
    if (!confirmStatus || !mate) return;
    setStatusBusy(true);
    try {
      if (confirmStatus === "disable") await api.disableTeammate(teammateId);
      else await api.archiveTeammate(teammateId);
      setConfirmStatus(null);
      all.reload();
      toast.success(confirmStatus === "disable" ? "Teammate disabled." : "Teammate archived.");
    } catch (err) {
      notifyError(err);
    } finally {
      setStatusBusy(false);
    }
  };

  const claim = async (taskId: string) => {
    try {
      await api.claimTask(taskId, teammateId);
      tasks.reload();
      runs.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  if (all.loading || tasks.loading || runs.loading || boards.loading || persona.loading) {
    return <LoadingState lines={4} />;
  }
  if (all.error || tasks.error || runs.error || boards.error) {
    return (
      <Page>
        <ErrorState
          error={all.error ?? tasks.error ?? runs.error ?? boards.error ?? "Bot not found"}
          onRetry={all.reload}
        />
      </Page>
    );
  }

  const allMates = (all.data as { teammates: Teammate[] }).teammates;
  const mate = allMates.find((m) => m.id === teammateId);
  if (!mate) {
    return (
      <Page>
        <EmptyState title="Bot not found" hint="" />
      </Page>
    );
  }

  const taskList = (tasks.data as { tasks: Task[] }).tasks;
  const runList = (runs.data as { runs: Run[] }).runs;
  const unclaimed = taskList.find((t) => t.status === "pending" && !t.owner_teammate_id);
  const openCount = taskList.filter((t) => !["done", "failed", "cancelled"].includes(t.status)).length;

  /** What this bot is doing right now; the face is posed to match. */
  const activity = botActivity(mate.status, taskList, runList);
  const modelName = mate.provider_id
    ? providers.data?.find((provider) => provider.id === mate.provider_id)?.name
    : undefined;

  /** Open the face editor on the bot's current face, not on the default. */
  const openFaceEditor = () => {
    setFaceDraft(normalizeFace(mate.face));
    setShowFace(true);
  };

  const saveFace = async () => {
    setFaceBusy(true);
    try {
      await api.patchTeammate(teammateId, { face: faceDraft });
      setShowFace(false);
      all.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setFaceBusy(false);
    }
  };

  return (
    <Page>
      <div className="mb-8">
        <button
          onClick={() => {
            navigate("/bots");
          }}
          className="mb-3 inline-flex items-center gap-1 text-step--1 text-[var(--muted)] transition-colors hover:text-[var(--text)]"
        >
          <span aria-hidden>←</span> Team
        </button>
        <div className="flex flex-wrap items-start gap-4">
          <BotAvatar
            face={mate.face}
            size={64}
            animated
            follow
            state={faceStateFor(activity)}
            label={`The face of ${mate.name || mate.persona || "this bot"}`}
          />
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-step--2 uppercase tracking-[0.16em] text-[var(--faint)]">
              <a href="/bots" className="hover:text-[var(--text)]">
                Teammates
              </a>{" "}
              / Teammate
            </div>
            <h1 className="text-step-1 font-semibold tracking-tight text-[var(--text)]">
              {mate.name || mate.persona || "Unnamed teammate"}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-step--1 text-[var(--muted)]">
              <StatusDot
                status={mate.status}
                label={mate.status}
                pulse={mate.status === "running"}
              />
              <span>
                {openCount} open task{openCount === 1 ? "" : "s"}
              </span>
              <span aria-hidden>·</span>
              <span>{runList.length} runs</span>
              <span aria-hidden>·</span>
              <a href={`/p/${mate.project_id}`} className="hover:text-[var(--text)] hover:underline">
                Project
              </a>
              <span aria-hidden>·</span>
              <span>{modelName || (mate.provider_id ? "Model connected" : "No model connected")}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => setShowCreateTask(true)}>
              Give work
            </Button>
            <Button onClick={openEditor}>Edit</Button>
            <Button onClick={() => void duplicate()}>Duplicate</Button>
            <Button onClick={openFaceEditor}>Face</Button>
            {mate.status === "active" ? (
              <Button variant="danger" onClick={() => setConfirmStatus("disable")}>
                Disable
              </Button>
            ) : mate.status !== "archived" ? (
              <Button variant="danger" onClick={() => setConfirmStatus("archive")}>
                Archive
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-step--2 text-[var(--faint)]">Model</div>
          <div className="text-step--1 font-medium text-[var(--text)]">{modelName || (mate.provider_id ? "Connected" : "None")}</div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-step--2 text-[var(--faint)]">Memory</div>
          <div className="text-step--1 font-medium text-[var(--text)]">{mate.memory_scope}</div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-step--2 text-[var(--faint)]">Tasks</div>
          <div className="text-step--1 font-medium text-[var(--text)]">{taskList.length}</div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-step--2 text-[var(--faint)]">Runs</div>
          <div className="text-step--1 font-medium text-[var(--text)]">{runList.length}</div>
        </div>
      </section>

      {/* Section tabs */}
      <div
        role="tablist"
        aria-label="Agent sections"
        className="mb-6 flex flex-wrap gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1"
      >
        {(
          [
            ["overview", "Overview"],
            ["configuration", "Configuration"],
            ["capabilities", "Capabilities"],
            ["memory", "Memory"],
            ["skills", "Skills"],
            ["work", "Work"],
            ["activity", "Activity"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            onClick={() => setSection(id)}
            className={`rounded-md px-3 py-1.5 text-step--1 font-medium transition-colors ${
              section === id
                ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {(section === "overview" || section === "configuration") && mate.instructions ? (
        <details className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <summary className="cursor-pointer text-step--1 font-medium text-[var(--text-soft)]">
            Instructions
          </summary>
          <p className="mt-3 whitespace-pre-wrap text-step-0 leading-relaxed text-[var(--text-soft)]">
            {mate.instructions}
          </p>
        </details>
      ) : null}

      {(section === "overview" || section === "configuration") && (
      <details className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <summary className="cursor-pointer text-step--1 font-medium text-[var(--text-soft)]">
          Persona (soul · goals · wisdom)
        </summary>
        {persona.data ? (
          <div className="mt-3 space-y-3 text-step-0 text-[var(--text-soft)]">
            <div>
              <div className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">Soul</div>
              <p className="whitespace-pre-wrap">{persona.data.soul || "—"}</p>
            </div>
            <div>
              <div className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">Goals</div>
              <p className="whitespace-pre-wrap">{persona.data.goals || "—"}</p>
            </div>
            <div>
              <div className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">Wisdom</div>
              <p className="whitespace-pre-wrap">{persona.data.wisdom || "—"}</p>
            </div>
            <div className="text-step--2 text-[var(--faint)]">version {persona.data.version}</div>
          </div>
        ) : (
          <p className="mt-3 text-step--1 text-[var(--muted)]">No persona loaded.</p>
        )}
      </details>
      )}

      {(section === "capabilities") && (
      <details className="mb-6">
        <summary className="mb-2 cursor-pointer text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">
          Access and permissions
        </summary>
        <BotAccess mate={mate} boards={(boards.data as { boards: Board[] }).boards} />
      </details>
      )}

      {/* Tasks */}
      {(section === "work" || section === "overview") && (
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>Tasks</SectionLabel>
          {showCreateTask ? (
            <Button onClick={() => setShowCreateTask(false)} variant="ghost">
              Cancel
            </Button>
          ) : null}
        </div>
        {showCreateTask && (
          <form
            onSubmit={async (e: React.FormEvent) => {
              e.preventDefault();
              setCreateTaskBusy(true);
              try {
                await api.createTask(mate.project_id, {
                  description: taskDescription.trim(),
                  command: taskCommand.trim() || undefined,
                  owner_teammate_id: teammateId,
                });
                setTaskDescription("");
                setTaskCommand("");
                setShowCreateTask(false);
                tasks.reload();
              } catch (err) {
                notifyError(err);
              } finally {
                setCreateTaskBusy(false);
              }
            }}
            className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
          >
            <input
              value={taskDescription}
              onChange={(e) => setTaskDescription(e.target.value)}
              placeholder="What should this bot do?"
              aria-label="Task description"
              required
              autoFocus
              className={`${FORM_INPUT} min-w-52 flex-1`}
            />
            <input
              value={taskCommand}
              onChange={(e) => setTaskCommand(e.target.value)}
              placeholder="Command (optional)"
              aria-label="Task command"
              className={`${FORM_INPUT} w-48`}
            />
            <Button variant="primary" type="submit" disabled={createTaskBusy || !taskDescription.trim()}>
              {createTaskBusy ? "Creating…" : "Create task"}
            </Button>
          </form>
        )}
        {unclaimed && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-step--1 text-[var(--warn)]">
            <span className="min-w-0 flex-1 truncate">Unclaimed: {unclaimed.description}</span>
            <Button onClick={() => void claim(unclaimed.id)}>Claim &amp; assign to me</Button>
          </div>
        )}
        {taskList.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {taskList.map((t, index) => (
              <div
                key={t.id}
                className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${
                  index > 0 ? "border-t border-[var(--border-dim)]" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <button
                    className="block w-full truncate text-left font-medium text-[var(--text)] hover:underline"
                    onClick={() => openTask(t.project_id, t.id)}
                  >
                    {t.description || "Untitled"}
                  </button>
                  {t.command ? (
                    <div className="mono truncate text-step--2 text-[var(--faint)]">{t.command}</div>
                  ) : null}
                </div>
                <StatusBadge status={t.status} label={undefined} />
                {t.status === "pending" && t.owner_teammate_id === teammateId && (
                  <Button
                    variant="primary"
                    title="Run this task in the bot's isolated workspace"
                    onClick={() => {
                      void api
                        .runTask(t.id)
                        .then(() => {
                          tasks.reload();
                          runs.reload();
                        })
                        .catch(notifyError);
                    }}
                  >
                    Run
                  </Button>
                )}
                <Button variant="ghost" onClick={() => openTask(t.project_id, t.id)}>
                  Open →
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No tasks yet"
            hint="Give this teammate something to do. It will run using its connected model."
            action={
              <Button variant="primary" onClick={() => setShowCreateTask(true)}>
                Give work
              </Button>
            }
          />
        )}
      </section>
      )}

      {/* Runs */}
      {(section === "activity" || section === "overview") && (
      <section className="mb-6">
        <SectionLabel className="mb-2">Runs</SectionLabel>
        {runList.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {runList.slice(0, 20).map((r, index) => (
              <div
                key={r.id}
                className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 ${
                  index > 0 ? "border-t border-[var(--border-dim)]" : ""
                }`}
              >
                <StatusDot status={r.status} pulse={r.status === "running"} label={undefined} />
                <button
                  className="min-w-0 flex-1 truncate text-left text-step--1 text-[var(--muted)] hover:text-[var(--text)]"
                  onClick={() => openTask(mate.project_id, r.task_id)}
                  title="Open task"
                >
                  {taskList.find((t) => t.id === r.task_id)?.description?.trim() || "Task"}
                </button>
                <span className="mono text-step--2 text-[var(--faint)]">exit {r.exit_code ?? "—"}</span>
                <span className="mono text-step--2 text-[var(--faint)]">
                  {Number(r.duration_s ?? 0).toFixed(1)}s
                </span>
                <span className="mono text-step--2 text-[var(--faint)]">{relativeTime(r.started_at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No runs" hint="Runs appear here when this bot executes a task." />
        )}
      </section>
      )}

      {/* Private memory */}
      {(section === "memory" || section === "overview") && (
      <section>
        <TeammateMemorySection teammateId={teammateId} />
      </section>
      )}

      {/* Skills (Phase 3) */}
      {(section === "skills" || section === "overview") && (
      <section>
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>Skills</SectionLabel>
        </div>
        <p className="mb-3 max-w-[72ch] text-step--1 text-[var(--muted)]">
          Reusable instruction packs attached to this teammate. Skills add context/instructions when resolved; they never widen permissions (gates and tool policy still apply).
        </p>
        {skills.loading ? <LoadingState lines={2} /> : skills.error ? <ErrorState error={skills.error} onRetry={skills.reload} /> : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select
                className={`${FORM_INPUT} max-w-sm`}
                defaultValue=""
                aria-label="Attach skill"
                onChange={async (e) => {
                  const skillId = e.target.value;
                  if (!skillId) return;
                  try { await api.attachSkill(teammateId, skillId); skills.reload(); toast.success("Skill attached"); } catch (err) { notifyError(err); }
                  e.target.value = "";
                }}
              >
                <option value="">Attach a skill…</option>
                {(allSkills.data?.skills || []).filter((sk: any) => !(skills.data?.skills || []).some((a: any) => a.skill_id === sk.id)).map((sk: any) => (
                  <option key={sk.id} value={sk.id}>{sk.name} (v{sk.version})</option>
                ))}
              </select>
              <Button onClick={() => { const name = prompt("Skill name"); if (!name) return; const instructions = prompt("Instructions (what this skill teaches the teammate)"); if (!instructions) return; void api.createSkill({ name, instructions, description: "", scope: "owner" }).then(() => { allSkills.reload(); toast.success("Skill created"); }).catch(notifyError); }}>New skill</Button>
            </div>
            {(skills.data?.skills || []).length === 0 ? (
              <EmptyState title="No skills attached" hint="Create or attach a skill to give this teammate reusable instructions." />
            ) : (
              <div className="flex flex-col gap-2">
                {(skills.data?.skills || []).map((s: any) => (
                  <div key={s.skill_id || s.attachment_id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--text)]">{s.name} <span className="text-step--2 font-normal text-[var(--faint)]">v{s.version} · {s.scope}</span></div>
                        {s.description ? <div className="mt-0.5 text-step--1 text-[var(--muted)]">{s.description}</div> : null}
                        <div className="mt-1 text-step--2 text-[var(--faint)]">Active when attached and enabled. Required permissions (enforced, not granted): {(s.required_permissions || []).join(", ") || "none"}</div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="danger" onClick={() => void api.detachSkill(teammateId, s.skill_id).then(() => { skills.reload(); toast.success("Detached"); }).catch(notifyError)}>Detach</Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      )}

      {showFace ? (
        <Modal title="Change face" onClose={() => setShowFace(false)}>
          <FacePicker value={faceDraft} onChange={setFaceDraft} compact />
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button onClick={() => setShowFace(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void saveFace()} disabled={faceBusy}>
              {faceBusy ? "Saving…" : "Save face"}
            </Button>
          </div>
        </Modal>
      ) : null}

      {showEdit ? (
        <Modal title="Edit teammate" onClose={() => setShowEdit(false)}>
          <form onSubmit={saveEdit} className="flex flex-col gap-3">
            <Field label="Display name (shown in chat)">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Research Analyst"
                className={FORM_INPUT}
              />
              <p className="text-step--1 text-[var(--faint)]">
                What the conversation shows next to this bot&rsquo;s face. Its
                @mention handle follows the name when it has no slug yet.
              </p>
            </Field>
            <Field label="Persona">
              <input
                value={editPersona}
                onChange={(e) => setEditPersona(e.target.value)}
                required
                className={FORM_INPUT}
              />
            </Field>
            <Field label="Instructions">
              <textarea
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                rows={4}
                className={`${FORM_INPUT} resize-y`}
              />
            </Field>
            <Field label="Model provider">
              <select
                value={editProviderId}
                onChange={(e) => setEditProviderId(e.target.value)}
                className={FORM_INPUT}
              >
                <option value="">Project default</option>
                {(providers.data ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} ({provider.kind})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Memory scope">
              <select
                value={editMemoryScope}
                onChange={(e) => setEditMemoryScope(e.target.value)}
                className={FORM_INPUT}
              >
                <option value="project">Project (shared with the workspace)</option>
                <option value="private">Private (this teammate only)</option>
              </select>
            </Field>
            <Field label="Permissions">
              <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--border)] p-2">
                {catalogue.permissions.length === 0 ? (
                  <p className="px-2 py-2 text-step--1 text-[var(--faint)]">
                    No permission catalogue reported by the server.
                  </p>
                ) : (
                  <div className="grid gap-1 sm:grid-cols-2">
                    {catalogue.permissions.map((permission) => (
                      <label
                        key={permission.name}
                        className="flex items-start gap-2 rounded px-1.5 py-1 text-step--1 text-[var(--text-soft)] hover:bg-[var(--surface-2)]"
                        title={permission.summary}
                      >
                        <input
                          type="checkbox"
                          checked={editPerms.includes(permission.name)}
                          onChange={(e) =>
                            setEditPerms((prev) =>
                              e.target.checked
                                ? [...prev, permission.name]
                                : prev.filter((name) => name !== permission.name),
                            )
                          }
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="mono block truncate">{permission.name}</span>
                          <span className="block text-step--2 text-[var(--faint)]">
                            {permission.summary}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </Field>
            <div className="mt-1 flex justify-end gap-2">
              <Button type="button" onClick={() => setShowEdit(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={editBusy || !editPersona.trim()}>
                {editBusy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {confirmStatus ? (
        <Modal
          title={confirmStatus === "disable" ? "Disable teammate?" : "Archive teammate?"}
          onClose={() => setConfirmStatus(null)}
        >
          <p className="text-step--1 text-[var(--text-soft)]">
            {confirmStatus === "disable"
              ? `${mate.name || mate.persona || "This teammate"} will stop receiving new work. Existing tasks and memory are kept.`
              : `${mate.name || mate.persona || "This teammate"} will be archived and hidden from active work. Existing tasks and memory are kept.`}
          </p>
          <p className="mt-2 text-step--1 text-[var(--muted)]">
            This build has no re-enable action, so confirm only if you mean it.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setConfirmStatus(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void applyStatus()} disabled={statusBusy}>
              {statusBusy ? "Working…" : confirmStatus === "disable" ? "Disable" : "Archive"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </Page>
  );
}

/**
 * Access grants for one bot: the permissions it holds, the ones it does not,
 * and the boards it belongs to.
 *
 * Board membership is a real server-enforced grant, not a UI-only label: the
 * owner adds and removes it through the same API the agent tools are gated by,
 * so a bot that is not a member cannot read the board even with `board.read`.
 */
function BotAccess({ mate, boards }: { mate: Teammate; boards: Board[] }) {
  const catalogue = usePermissionCatalogue();
  const projectBoards = boards.filter((b) => b.project_id === mate.project_id);
  const boardIds = projectBoards.map((b) => b.id).join(",");
  const members = useAsync(async () => {
    const entries = await Promise.all(
      projectBoards.map(async (b) => {
        const res = await api.listBoardMembers(b.id);
        return [b.id, res.members] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<string, BoardMember[]>;
  }, [boardIds]);

  const [addBoardId, setAddBoardId] = useState("");
  const [addRole, setAddRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const held = mate.permissions ?? [];
  const policyKeys = Object.keys(mate.tool_policy ?? {});
  const granted = held.concat(policyKeys.filter((k) => !held.includes(k)));
  const denied = catalogue.permissions.filter((p) => !granted.includes(p.name));
  const unknownHeld = granted.filter((g) => !catalogue.byName.has(g));

  const memberships = projectBoards
    .map((b) => ({
      board: b,
      role: (members.data?.[b.id] ?? []).find((m) => m.teammate_id === mate.id)?.role ?? "",
    }))
    .filter((m) => m.role !== "");

  const fail = (err: unknown) => {
    if (err instanceof ApiError) {
      setError(
        err.status === 403
          ? `Access denied: ${err.detail}`
          : `Rejected by the server: ${err.detail}`,
      );
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
    notifyError(err);
  };

  const addMembership = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addBoardId) return;
    setBusy(true);
    setError(null);
    try {
      await api.addBoardMember(addBoardId, { teammate_id: mate.id, role: addRole });
      setAddBoardId("");
      members.reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const removeMembership = async (boardId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.removeBoardMember(boardId, mate.id);
      members.reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const notMemberOf = projectBoards.filter((b) => !memberships.some((m) => m.board.id === b.id));
  const inactive = mate.status !== "active";

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Access</SectionLabel>
        <span className="text-step--1 text-[var(--muted)]">
          permissions the server enforces for this bot
        </span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
          Granted ({granted.length})
        </div>
        {granted.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {granted.map((perm) => (
              <span
                key={perm}
                tabIndex={0}
                title={
                  catalogue.isAdmin(perm)
                    ? "admin permission. Also needs the owner's exact-action approval"
                    : catalogue.byName.has(perm)
                      ? catalogue.byName.get(perm)?.summary
                      : "unknown permission. The server does not recognise it, so it grants nothing"
                }
                className={`inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-step--2 font-medium text-[var(--text-soft)] ${
                  catalogue.isAdmin(perm) ? "border-[var(--warn)] text-[var(--warn)]" : ""
                }`}
              >
                {perm}
                {catalogue.isAdmin(perm) ? " *" : ""}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-step--1 text-[var(--muted)]">
            No permissions. Every gated tool call for this bot is denied.
          </p>
        )}
        {unknownHeld.length > 0 ? (
          <div className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]" role="alert">
            Unknown permission name(s) held by this bot: {unknownHeld.join(", ")}. The server does not
            recognise them, so they grant nothing.
          </div>
        ) : null}
        {granted.some((p) => catalogue.isAdmin(p)) ? (
          <p className="mt-1.5 text-step--2 text-[var(--faint)]">
            * admin permission: granted, but each use still needs the owner&apos;s exact-action approval.
          </p>
        ) : null}
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">
          Not granted ({denied.length})
        </div>
        {denied.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {denied.map((perm) => (
              <span
                key={perm.name}
                tabIndex={0}
                title={`${perm.summary}. Denied unless granted.`}
                className="inline-flex items-center rounded-full border border-[var(--border-dim)] bg-[var(--surface-2)] px-2.5 py-0.5 text-step--2 font-medium text-[var(--muted)] opacity-60"
              >
                {perm.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-step--1 text-[var(--muted)]">
            This bot holds every permission the server defines.
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-[var(--border-dim)] pt-3">
        <div className="mb-2 text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">
          Board membership
        </div>
        {members.loading ? (
          <LoadingState lines={1} />
        ) : memberships.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {memberships.map(({ board, role }) => {
              const coMembers = (members.data?.[board.id] ?? []).filter(
                (m) => m.teammate_id !== mate.id,
              );
              return (
                <div
                  key={board.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1"
                >
                  <div className="min-w-0">
                    <a className="font-medium text-[var(--text)] hover:underline" href={`/board/${board.id}`}>
                      {board.name || "Unnamed board"}
                    </a>
                    <span className="mono ml-2 text-[var(--faint)]">{role}</span>
                    <div className="mono text-step--2 text-[var(--faint)]">
                      {coMembers.length > 0
                        ? `${coMembers.length} co-member${coMembers.length === 1 ? "" : "s"}`
                        : "alone on this board"}
                    </div>
                  </div>
                  <Button variant="danger" onClick={() => void removeMembership(board.id)} disabled={busy}>
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-step--1 text-[var(--muted)]">
            Not on any board. A bot needs board membership to read a board&apos;s messages, even with
            the board.read permission.
          </p>
        )}

        {notMemberOf.length > 0 && (
          <form onSubmit={addMembership} className="mt-2.5 flex flex-wrap items-center gap-2">
            <select
              value={addBoardId}
              onChange={(e) => setAddBoardId(e.target.value)}
              aria-label="Board to join"
              className="max-w-64 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-step--1 outline-none focus:border-[var(--border-focus)]"
            >
              <option value="">(select board)</option>
              {notMemberOf.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name || "Unnamed board"}
                </option>
              ))}
            </select>
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
              aria-label="Board role"
              className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-step--1 outline-none focus:border-[var(--border-focus)]"
            >
              <option value="member">Member</option>
              <option value="lead">Lead</option>
            </select>
            <Button variant="primary" type="submit" disabled={busy || !addBoardId || inactive}>
              Add to board
            </Button>
            {inactive ? (
              <span className="text-step--1 text-[var(--muted)]">
                This bot is {mate.status}. Only active bots can join a board.
              </span>
            ) : null}
          </form>
        )}

        {error ? (
          <div className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const ROLE_TEMPLATES = [
  { id: "researcher", label: "Research Analyst", persona: "researcher", instructions: "Find public evidence, sources and leads. Output structured records with links. Never invent facts." },
  { id: "engineer", label: "Software Engineer", persona: "engineer", instructions: "Implement, test and review code. Show real command output. Ask before destructive steps." },
  { id: "strategist", label: "Product Strategist", persona: "strategist", instructions: "Synthesize research into positioning and recommendations. Cite evidence. Draft only." },
  { id: "pm", label: "Project Manager", persona: "project-manager", instructions: "Break objectives into tasks, assign, track progress, report status." },
  { id: "data", label: "Data Analyst", persona: "data-analyst", instructions: "Analyze data, produce charts and summaries with evidence." },
  { id: "marketing", label: "Marketing Specialist", persona: "marketing", instructions: "Draft positioning, copy and campaigns. Draft only; publishing needs approval." },
];

/**
 * Global fleet directory: every bot across all projects, with creation.
 * This is the CEO's cockpit: see every bot, its project, status, current task,
 * and create new bots that any project can use.
 */
export function BotsView() {
  const all = useAsync(() => api.listAllTeammates(), []);
  const projects = useAsync(() => api.listProjects(), []);
  const catalogue = usePermissionCatalogue();
  const [step, setStep] = useState<
    "identity" | "face" | "model" | "permissions" | "memory" | "review"
  >(
    "identity",
  );
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled" | "archived">(
    "all",
  );

  // creation draft
  const [pid, setPid] = useState("");
  const [mateName, setMateName] = useState("");
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");
  const [providerId, setProviderId] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
  const [memoryScope, setMemoryScope] = useState("project");
  const [face, setFace] = useState<FaceChoice>(DEFAULT_FACE);

  // give-work draft (delegate a task to a specific bot from the fleet directory)
  const [giveWorkMateId, setGiveWorkMateId] = useState("");
  const [giveWorkDesc, setGiveWorkDesc] = useState("");
  const [giveWorkCmd, setGiveWorkCmd] = useState("");
  const [giveWorkBusy, setGiveWorkBusy] = useState(false);

  const providers = useAsync(
    () => (pid ? api.listProviders(pid) : Promise.resolve({ providers: [] })),
    [pid],
  );

  /** Live execution status per bot so the fleet directory doubles as a
   *  workload monitor. One query per bot is fine at personal-fleet scale. */
  const botTasks = useAsync(async () => {
    const matesList = (all.data as { teammates: Teammate[] } | null)?.teammates ?? [];
    const byBot = await Promise.all(
      matesList.map(async (m) => {
        try {
          const data = await api.teammateTasks(m.id);
          return [m.id, (data as { tasks: Task[] }).tasks] as const;
        } catch {
          return [m.id, [] as Task[]];
        }
      }),
    );
    return Object.fromEntries(byBot) as Record<string, Task[]>;
  }, [all.data]);

  /** Provider names, so the fleet shows which model a bot thinks with
   *  instead of a truncated provider id. */
  const providerNames = useAsync(async () => {
    const projectsList = (projects.data as { projects: Project[] } | null)?.projects ?? [];
    const byProject = await Promise.all(
      projectsList.map(async (p) => {
        try {
          const data = await api.listProviders(p.id);
          return data.providers.map((prov) => [prov.id, prov] as const);
        } catch {
          return [] as Array<readonly [string, Provider]>;
        }
      }),
    );
    const all2 = byProject.flat();
    return Object.fromEntries(all2) as Record<string, Provider>;
  }, [projects.data]);

  const back = () => {
    if (step === "identity") setStep("identity");
    else if (step === "face") setStep("identity");
    else if (step === "model") setStep("face");
    else if (step === "permissions") setStep("model");
    else if (step === "memory") setStep("permissions");
    else if (step === "review") setStep("memory");
  };

  const next = () => {
    if (step === "identity") {
      if (!persona.trim()) return;
      setStep("face");
    } else if (step === "face") {
      setStep("model");
    } else if (step === "model") {
      setStep("permissions");
    } else if (step === "permissions") {
      setStep("memory");
    } else if (step === "memory") {
      setStep("review");
    }
  };

  const createBot = async () => {
    const p = pid.trim();
    if (!p || !persona.trim()) {
      notifyError("Pick a project and give the teammate a persona.");
      return;
    }
    try {
      await api.createTeammate(p, {
        name: mateName.trim(),
        persona: persona.trim(),
        instructions: instructions.trim(),
        capabilities: [],
        permissions: selectedPerms,
        memory_scope: memoryScope,
        provider_id: providerId || undefined,
        face,
      });
      setShowCreate(false);
      setPid("");
      setMateName("");
      setPersona("");
      setInstructions("");
      setProviderId("");
      setSelectedPerms([]);
      setMemoryScope("project");
      setFace(DEFAULT_FACE);
      setStep("identity");
      all.reload();
      projects.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const loading = all.loading || projects.loading || catalogue.loading || botTasks.loading;
  if (loading) return <LoadingState lines={4} />;
  if (all.error || projects.error || catalogue.error || botTasks.error) {
    return (
      <Page>
        <ErrorState
          error={
            all.error ??
            projects.error ??
            catalogue.error ??
            botTasks.error ??
            "Unable to load fleet"
          }
          onRetry={all.reload}
        />
      </Page>
    );
  }

  const mates: Teammate[] = (all.data as { teammates: Teammate[] }).teammates;
  const projList: { id: string; repository: string }[] =
    (projects.data as { projects: { id: string; repository: string }[] }).projects;
  const provList: Provider[] = (providers.data as { providers: Provider[] } | null)?.providers ?? [];

  const projectOf = (botPid: string) =>
    projList.find((p) => p.id === botPid)?.repository || botPid;

  const giveWorkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!giveWorkMateId || !giveWorkDesc.trim()) return;
    const mate = mates.find((m) => m.id === giveWorkMateId);
    if (!mate) return;
    setGiveWorkBusy(true);
    try {
      await api.createTask(mate.project_id, {
        description: giveWorkDesc.trim(),
        command: giveWorkCmd.trim() || undefined,
        owner_teammate_id: giveWorkMateId,
      });
      setGiveWorkMateId("");
      setGiveWorkDesc("");
      setGiveWorkCmd("");
      all.reload();
      botTasks.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setGiveWorkBusy(false);
    }
  };

  const busyBots = mates.filter((mate) => {
    const tasks = (botTasks.data as Record<string, Task[]> | undefined)?.[mate.id] ?? [];
    return tasks.some((t) => t.status === "running");
  }).length;

  const needle = query.trim().toLowerCase();
  const filteredMates = mates.filter((mate) => {
    if (statusFilter !== "all" && mate.status !== statusFilter) return false;
    if (!needle) return true;
    return [mate.name, mate.persona, mate.instructions, projectOf(mate.project_id)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  /* Everything the two layouts (cards on a phone, table on a desktop) need,
     computed once so they cannot disagree about a teammate's state. */
  const rows = filteredMates.map((mate) => {
    const tasks = (botTasks.data as Record<string, Task[]> | undefined)?.[mate.id] ?? [];
    const active = tasks.filter(
      (t) =>
        t.status === "pending" ||
        t.status === "running" ||
        t.status === "blocked" ||
        t.status === "awaiting_approval",
    );
    const latest = tasks[0];
    const liveStatus = botActivity(mate.status, tasks);
    const provider = mate.provider_id
      ? (providerNames.data as Record<string, Provider> | undefined)?.[mate.provider_id]
      : undefined;
    return {
      mate,
      tasks,
      active,
      latest,
      busy: active.length > 0,
      liveStatus,
      provider,
      blocked: latest?.status === "blocked" ? latest : null,
    };
  });

  const steps = ["identity", "face", "model", "permissions", "memory", "review"] as const;
  const stepIndex = steps.indexOf(step);

  return (
    <Page>
      <PageHeader
        eyebrow="Your team"
        title="Teammates"
        description="The AI teammates working in your workspaces. Each one has a role, model, permissions, and memory."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              New teammate
            </Button>
            <Button onClick={all.reload}>Refresh</Button>
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        <Badge variant={mates.length > 0 ? "info" : "neutral"}>{mates.length} teammate{mates.length === 1 ? "" : "s"}</Badge>
        <Badge variant={busyBots > 0 ? "ok" : "neutral"}>{busyBots} working now</Badge>
      </div>

      {showCreate ? (
        <Modal title={`Create teammate: ${stepName(step)}`} onClose={() => setShowCreate(false)}>
          <div className="mb-3 flex items-center gap-1.5">
            {steps.map((s, i) => (
              <div
                key={s}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i <= stepIndex ? "bg-[var(--accent)]" : "bg-[var(--surface-3)]"
                }`}
              />
            ))}
          </div>
          <div className="flex flex-col gap-3">
            {step === "identity" && (
              <>
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
                    <option value="">(none — start blank)</option>
                    {ROLE_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-step--1 text-[var(--faint)]">
                    Prefills the persona and instructions. You can edit everything after.
                  </p>
                </Field>
                <Field label="Project (workspace)">
                  <select
                    value={pid}
                    onChange={(e) => setPid(e.target.value)}
                    required
                    className={FORM_INPUT}
                  >
                    <option value="">(select project)</option>
                    {projList.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.repository || "workspace"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Display name (shown in chat)">
                  <input
                    value={mateName}
                    onChange={(e) => setMateName(e.target.value)}
                    placeholder="Research Analyst"
                    className={FORM_INPUT}
                  />
                  <p className="text-step--1 text-[var(--faint)]">
                    The name chat shows next to the face, and the base of its
                    @mention handle. Leave blank to fall back to the persona.
                  </p>
                </Field>
                <Field label="Persona">
                  <input
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                    required
                    placeholder="engineer"
                    className={FORM_INPUT}
                  />
                </Field>
                <Field label="Instructions (optional)">
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="You are a careful engineering bot…"
                    rows={3}
                    className={`${FORM_INPUT} resize-y`}
                  />
                </Field>
              </>
            )}
            {step === "face" && (
              <>
                <p className="max-w-[46ch] text-step--1 text-[var(--muted)]">
                  The face is the bot&apos;s own: it shows up wherever the bot does, so a fleet
                  is scannable by face alone. It is yours to choose, and you can change it
                  later.
                </p>
                <FacePicker value={face} onChange={setFace} compact />
              </>
            )}
            {step === "model" && (
              <Field label="Model provider">
                {providers.loading ? (
                  <LoadingState lines={1} />
                ) : providers.error ? (
                  <div className={ERROR_BOX}>{describeError(providers.error)}</div>
                ) : provList.length === 0 ? (
                  <p className="text-step--1 text-[var(--muted)]">
                    No providers configured for this project. Add one in the project&apos;s Providers
                    tab, then attach it here. The bot will work without a provider until one is
                    attached.
                  </p>
                ) : (
                  <select
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                    className={FORM_INPUT}
                  >
                    <option value="">(none, use default)</option>
                    {provList.map((pr) => (
                      <option key={pr.id} value={pr.id}>
                        {pr.name} ({pr.kind})
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-step--1 text-[var(--faint)]">
                  Select the model connection this bot uses to think. Leave unset to use the
                  project&apos;s default provider.
                </p>
              </Field>
            )}
            {step === "permissions" && (
              <Field label="Tools &amp; permissions">
                <p className="mb-2 max-w-[46ch] text-step--1 text-[var(--muted)]">
                  Choose permissions from the server&apos;s canonical catalogue. Admin actions
                  (marked with a shield) require your approval before the bot can use them.
                </p>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
                  {catalogue.permissions.length === 0 ? (
                    <p className="p-1.5 text-step--1 text-[var(--muted)]">
                      No permissions available from the server.
                    </p>
                  ) : (
                    catalogue.permissions.map((perm) => {
                      const held = selectedPerms.includes(perm.name);
                      return (
                        <label
                          key={perm.name}
                          className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${
                            held
                              ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                              : "border-transparent hover:bg-[var(--surface-2)]"
                          }`}
                          onClick={() => {
                            if (held) {
                              setSelectedPerms(selectedPerms.filter((x) => x !== perm.name));
                            } else {
                              setSelectedPerms([...selectedPerms, perm.name]);
                            }
                          }}
                        >
                          <input type="checkbox" checked={held} readOnly className="h-3.5 w-3.5" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-[var(--text)]">{perm.name}</div>
                            <div className="text-step--2 text-[var(--muted)]">{perm.summary}</div>
                          </div>
                          {perm.requires_approval && <Badge variant="warn">approval-gated</Badge>}
                        </label>
                      );
                    })
                  )}
                </div>
                <p className="mt-1.5 text-step--1 text-[var(--faint)]">
                  {selectedPerms.length} selected
                </p>
              </Field>
            )}
            {step === "memory" && (
              <Field label="Memory scope">
                <select
                  value={memoryScope}
                  onChange={(e) => setMemoryScope(e.target.value)}
                  className={`${FORM_INPUT} max-w-60`}
                >
                  <option value="project">Project</option>
                  <option value="private">Private (this bot only)</option>
                </select>
                <p className="text-step--1 text-[var(--faint)]">
                  Project scope shares memory with other bots and tasks in the workspace. Private
                  keeps it to this bot alone.
                </p>
              </Field>
            )}
            {step === "review" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <BotAvatar face={face} size={64} label="The face this bot will wear" />
                  <p className="text-step--1 text-[var(--muted)]">
                    This is the face the teammate will wear. You can change it at any time.
                  </p>
                </div>
                <dl className="flex flex-col gap-1.5 text-step--1">
                  {[
                    ["Project", projList.find((p) => p.id === pid)?.repository || <ShortId id={pid} />],
                    ["Persona / name", persona],
                    ["Instructions", instructions || "Not set"],
                    ["Face", `${SHAPE_LABELS[face.shape]} · ${COLOR_LABELS[face.color]} · ${EXPRESSION_LABELS[face.expression]}`],
                    ["Model provider", provList.find((pr) => pr.id === providerId)?.name || "(none, default)"],
                    ["Permissions", selectedPerms.length > 0 ? selectedPerms.join(", ") : "None"],
                    ["Memory scope", memoryScope],
                  ].map(([key, value]) => (
                <div
                  key={key as string}
                      className="flex items-baseline justify-between gap-4 border-b border-[var(--border-dim)] pb-1.5 last:border-0"
                    >
                      <dt className="shrink-0 text-[var(--faint)]">{key}</dt>
                      <dd className="truncate text-right text-[var(--text-soft)]">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <div className="mt-2 flex items-center justify-between gap-3">
              <Button onClick={back} disabled={step === "identity"}>
                Back
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => {
                    setShowCreate(false);
                    setPid("");
                    setPersona("");
                    setInstructions("");
                    setProviderId("");
                    setSelectedPerms([]);
                    setMemoryScope("project");
                    setFace(DEFAULT_FACE);
                    setStep("identity");
                  }}
                >
                  Cancel
                </Button>
                {step === "review" ? (
                  <Button variant="primary" onClick={() => void createBot()} disabled={!persona.trim()}>
                    Create teammate
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={next}
                    disabled={step === "identity" ? (!pid.trim() || !persona.trim()) : false}
                  >
                    Continue
                  </Button>
                )}
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {mates.length > 0 ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a teammate"
              aria-label="Search teammates"
              className={`${FORM_INPUT} min-w-52 flex-1 sm:max-w-xs`}
            />
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as "all" | "active" | "disabled" | "archived")
              }
              aria-label="Filter teammates by status"
              className={`${FORM_INPUT} w-auto`}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
              <option value="archived">Archived</option>
            </select>
            <span className="text-step--1 text-[var(--faint)]">
              {filteredMates.length} of {mates.length}
            </span>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              title="No teammates match"
              hint="Try a different name or status."
              action={<Button onClick={() => { setQuery(""); setStatusFilter("all"); }}>Clear filters</Button>}
            />
          ) : null}

          {/* Phones get cards: a 720px table is a horizontal scroll, not a
              directory. The same facts appear in the table on md+. */}
          <div className="grid gap-2 md:hidden">
            {rows.map(({ mate, tasks, latest, liveStatus, provider, blocked }) => (
              <div
                key={mate.id}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <BotChip
                    href={`/bot/${mate.id}`}
                    persona={mate.name || mate.persona || "Unnamed teammate"}
                    id={mate.id}
                    status={liveStatus}
                    face={mate.face}
                  />
                  <StatusDot
                    status={liveStatus}
                    label={liveStatus === "running" ? "working" : liveStatus}
                    pulse={liveStatus === "running"}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-step--2 text-[var(--faint)]">
                  <span>{projectOf(mate.project_id)}</span>
                  <span aria-hidden>·</span>
                  <span>
                    {provider?.name ?? "no model"} · {tasks.length} task
                    {tasks.length === 1 ? "" : "s"}
                  </span>
                </div>
                {latest ? (
                  <button
                    className="mt-2 flex w-full items-start justify-between gap-2 rounded-lg bg-[var(--surface-2)] px-2.5 py-2 text-left"
                    onClick={() => openTask(latest.project_id, latest.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-step--1 text-[var(--text)]">
                        {latest.description || "Untitled task"}
                      </span>
                      {blocked?.blocked_reason ? (
                        <span className="mt-0.5 block truncate text-step--2 text-[var(--warn)]">
                          {blocked.blocked_reason}
                        </span>
                      ) : null}
                    </span>
                    <StatusBadge status={latest.status} />
                  </button>
                ) : (
                  <p className="mt-2 text-step--1 text-[var(--faint)]">No work assigned</p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    variant="primary"
                    onClick={() => setGiveWorkMateId(mate.id)}
                    disabled={mate.status !== "active"}
                  >
                    Give work
                  </Button>
                  <Button onClick={() => { navigate(`/bot/${mate.id}`); }}>
                    Open
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className={`${TABLE_SHELL} hidden md:block`}>
            <table className="w-full table-fixed">
              <thead>
                <tr>
                  <th className={`${TABLE_TH} w-[27%]`}>Teammate</th>
                  <th className={`${TABLE_TH} w-[5.5rem]`}>State</th>
                  <th className={`${TABLE_TH} w-[10rem]`}>Model</th>
                  <th className={TABLE_TH}>Work</th>
                  <th className={`${TABLE_TH} w-[8rem]`}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ mate, tasks, active, latest, busy, liveStatus, provider, blocked }) => (
                  <tr
                    key={mate.id}
                    className="align-top transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <td className={TABLE_TD}>
                      <BotChip href={`/bot/${mate.id}`} persona={mate.name || mate.persona || "Unnamed teammate"} id={mate.id} status={liveStatus} face={mate.face} />
                      <div
                        className="mt-0.5 truncate text-step--2 text-[var(--faint)]"
                        title={`${projectOf(mate.project_id)} · ${tasks.length} tasks`}
                      >
                        {projectOf(mate.project_id)} · {tasks.length} task{tasks.length === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className={`${TABLE_TD} whitespace-nowrap`}>
                      <StatusDot
                        status={liveStatus}
                        label={
                          liveStatus === "running"
                            ? "working"
                            : liveStatus === "awaiting_approval"
                              ? "needs you"
                              : liveStatus
                        }
                        pulse={liveStatus === "running"}
                      />
                    </td>
                    <td className={`${TABLE_TD} whitespace-nowrap`}>
                      {provider ? (
                        <span
                          className="block truncate text-step--1 text-[var(--text-soft)]"
                          title={provider.name}
                        >
                          {provider.name}
                        </span>
                      ) : (
                        <span className="text-step--1 text-[var(--warn)]">
                          no model
                        </span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      {latest ? (
                        <>
                          <div className="flex min-w-0 items-center gap-2">
                            <button
                              className="min-w-0 flex-1 truncate text-left text-step--1 text-[var(--text)] hover:underline"
                              title={latest.description}
                              onClick={() => openTask(latest.project_id, latest.id)}
                            >
                              {latest.description || "Untitled task"}
                            </button>
                            <StatusBadge status={latest.status} />
                            {busy && active.length > 1 ? (
                              <span className="shrink-0 text-step--2 text-[var(--faint)]">
                                +{active.length - 1}
                              </span>
                            ) : null}
                          </div>
                          {blocked?.blocked_reason ? (
                            <div className="mt-1 truncate text-step--2 text-[var(--warn)]" title={blocked.blocked_reason}>
                              {blocked.blocked_reason}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-step--1 text-[var(--faint)]">
                          no work assigned
                        </span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} whitespace-nowrap`}>
                      <div className="flex items-center gap-1.5">
                        <Button
                          onClick={() => {
                            setGiveWorkMateId(mate.id);
                          }}
                          disabled={mate.status !== "active"}
                          title={mate.status !== "active" ? "Only active teammates can be given work" : "Give this teammate a task"}
                        >
                          Give work
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <EmptyState
          title="No teammates yet"
          action={
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              Create your first teammate
            </Button>
          }
          hint="Create a teammate with a role and model, then chat with them or assign work from a task."
        />
      )}

      {giveWorkMateId ? (
        <Modal
          title={`Give work to ${mates.find((m) => m.id === giveWorkMateId)?.persona || "bot"}`}
          onClose={() => setGiveWorkMateId("")}
        >
          <form onSubmit={giveWorkSubmit} className="flex flex-col gap-2">
            <Field label="Work to do">
              <textarea
                value={giveWorkDesc}
                onChange={(e) => setGiveWorkDesc(e.target.value)}
                placeholder="e.g. review the login flow and add tests"
                rows={3}
                required
                className={`${FORM_INPUT} resize-y`}
              />
            </Field>
            <Field label="Command (optional)">
              <input
                value={giveWorkCmd}
                onChange={(e) => setGiveWorkCmd(e.target.value)}
                placeholder="e.g. npm test"
                className={FORM_INPUT}
              />
            </Field>
            <div className="mt-1 flex justify-end gap-2">
              <Button type="button" onClick={() => setGiveWorkMateId("")}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={giveWorkBusy || !giveWorkDesc.trim()}>
                {giveWorkBusy ? "Creating…" : "Create task"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </Page>
  );
}

function stepName(s: string): string {
  const names: Record<string, string> = {
    identity: "Identity & role",
    face: "Face",
    model: "Model provider",
    permissions: "Tools & permissions",
    memory: "Memory & scope",
    review: "Review & save",
  };
  return names[s] ?? s;
}
