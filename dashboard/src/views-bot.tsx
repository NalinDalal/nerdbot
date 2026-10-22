import { useState } from "react";
import { ApiError, api } from "./api";
import { describeError, notifyError } from "./app";
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
  Field,
  TABLE_SHELL,
  TABLE_TD,
  TABLE_TH,
} from "./components";

function openBot(id: string): void {
  window.location.hash = `#/bot/${id}`;
}

function openTask(projectId: string, taskId: string): void {
  window.location.hash = `#/p/${projectId}/t/${taskId}`;
}

export function BotDetailView({
  teammateId,
}: {
  teammateId: string;
}) {
  const all = useAsync(() => api.listAllTeammates(), [teammateId]);
  const tasks = useAsync(() => api.teammateTasks(teammateId), [teammateId]);
  const runs = useAsync(() => api.teammateRuns(teammateId), [teammateId]);
  const memory = useAsync(() => api.teammateMemory(teammateId), [teammateId]);
  const boards = useAsync(() => api.listBoards(), [teammateId]);

  const [memContent, setMemContent] = useState("");
  const [memSource, setMemSource] = useState("");
  const [memBusy, setMemBusy] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [taskDescription, setTaskDescription] = useState("");
  const [taskCommand, setTaskCommand] = useState("");
  const [createTaskBusy, setCreateTaskBusy] = useState(false);
  const [showFace, setShowFace] = useState(false);
  const [faceDraft, setFaceDraft] = useState<FaceChoice>(DEFAULT_FACE);
  const [faceBusy, setFaceBusy] = useState(false);

  const addMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memContent.trim()) return;
    setMemBusy(true);
    try {
      await api.writeTeammateMemory(teammateId, {
        content: memContent.trim(),
        source: memSource.trim() || "workspace",
        confidence: 0.5,
      });
      setMemContent("");
      setMemSource("");
      memory.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setMemBusy(false);
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

  if (all.loading || tasks.loading || runs.loading || memory.loading || boards.loading) {
    return <LoadingState lines={4} />;
  }
  if (all.error || tasks.error || runs.error || memory.error || boards.error) {
    return (
      <Page>
        <ErrorState
          error={
            all.error ?? tasks.error ?? runs.error ?? memory.error ?? boards.error ?? "Bot not found"
          }
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
  const memList = (memory.data as { entries: MemoryEntry[] }).entries;
  const unclaimed = taskList.find((t) => t.status === "pending" && !t.owner_teammate_id);
  const openCount = taskList.filter((t) => !["done", "failed", "cancelled"].includes(t.status)).length;

  /** What this bot is doing right now; the face is posed to match. */
  const activity = botActivity(mate.status, taskList, runList);

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
      <PageHeader
        eyebrow="Bot"
        title={mate.persona || "Unnamed bot"}
        description={mate.instructions ? undefined : "No instructions — give this bot a role via edit."}
        back={{ label: "Fleet", onClick: () => { window.location.hash = "#/bots"; } }}
        actions={
          <>
            <StatusDot status={mate.status} label={mate.status} pulse={mate.status === "running"} />
            {mate.provider_id ? (
              <span className="mono text-[var(--step-minus-1)] text-[var(--muted)]">
                model {mate.provider_id.slice(0, 10)}…
              </span>
            ) : (
              <Badge variant="warn">no model attached</Badge>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[var(--step-minus-1)] text-[var(--muted)]">
        <span className="mono">{mate.id}</span>
        <span className="text-[var(--faint)]">·</span>
        <span>workspace {mate.project_id.slice(0, 10)}…</span>
        <span className="text-[var(--faint)]">·</span>
        <span>
          {openCount} open task{openCount === 1 ? "" : "s"} · {runList.length} runs
        </span>
      </div>

      <section className="mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <BotAvatar
          face={mate.face}
          size={96}
          animated
          follow
          state={faceStateFor(activity)}
          label={`The face of ${mate.persona || "this bot"}`}
        />
        <div className="min-w-0 flex-1">
          <SectionLabel className="mb-1">Face</SectionLabel>
          <p className="mb-3 max-w-[52ch] text-[var(--step-minus-1)] text-[var(--muted)]">
            The face this bot wears wherever it appears. It is yours to change.
          </p>
          <Button onClick={openFaceEditor}>Change face</Button>
        </div>
      </section>

      {mate.instructions ? (
        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <SectionLabel className="mb-2">Instructions</SectionLabel>
          <p className="whitespace-pre-wrap text-[var(--step-0)] leading-relaxed text-[var(--text-soft)]">
            {mate.instructions}
          </p>
        </section>
      ) : null}

      <section className="mb-6">
        <BotAccess mate={mate} boards={(boards.data as { boards: Board[] }).boards} />
      </section>

      {/* Tasks */}
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>Tasks</SectionLabel>
          <Button onClick={() => setShowCreateTask((v) => !v)} variant="ghost">
            {showCreateTask ? "Cancel" : "New task"}
          </Button>
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
              placeholder="Task description (e.g. review the login flow)"
              aria-label="Task description"
              required
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
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--warn)]">
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
                    className="truncate text-left font-medium text-[var(--text)] hover:underline"
                    onClick={() => openTask(t.project_id, t.id)}
                  >
                    {t.description || "Untitled"}
                  </button>
                  {t.command ? (
                    <div className="mono truncate text-[var(--step-minus-2)] text-[var(--faint)]">{t.command}</div>
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
          <EmptyState title="No tasks" hint="This bot owns no tasks yet. Create one above." />
        )}
      </section>

      {/* Runs */}
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
                  className="mono min-w-0 flex-1 truncate text-left text-[var(--step-minus-1)] text-[var(--muted)] hover:text-[var(--text)]"
                  onClick={() => openTask(mate.project_id, r.task_id)}
                  title="Open task"
                >
                  {r.task_id.slice(0, 12)}…
                </button>
                <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">exit {r.exit_code ?? "—"}</span>
                <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
                  {Number(r.duration_s ?? 0).toFixed(1)}s
                </span>
                <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">{relativeTime(r.started_at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No runs" hint="Runs appear here when this bot executes a task." />
        )}
      </section>

      {/* Private memory */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>Private memory</SectionLabel>
          <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
            scoped to teammate:{mate.id}
          </span>
        </div>
        <p className="mb-3 max-w-[72ch] text-[var(--step-minus-1)] text-[var(--muted)]">
          Only this bot reads and writes this memory. Notes here are recalled in its future runs.
        </p>
        <form onSubmit={addMemory} className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={memContent}
            onChange={(e) => setMemContent(e.target.value)}
            placeholder="Remember this…"
            aria-label="Memory content"
            className={`${FORM_INPUT} min-w-52 flex-1`}
          />
          <input
            value={memSource}
            onChange={(e) => setMemSource(e.target.value)}
            placeholder="source"
            aria-label="Memory source"
            className={`${FORM_INPUT} w-36`}
          />
          <Button variant="primary" type="submit" disabled={memBusy || !memContent.trim()}>
            {memBusy ? "Saving…" : "Save"}
          </Button>
        </form>
        {memList.length > 0 ? (
          <div className="flex flex-col gap-2">
            {memList.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <p className="whitespace-pre-wrap text-[var(--step-minus-1)] text-[var(--text-soft)]">{entry.content}</p>
                <p className="mt-1 text-[var(--step-minus-2)] text-[var(--faint)]">
                  {entry.source} · confidence {entry.confidence} · {relativeTime(entry.timestamp)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No memories" hint="Save a note this bot will recall in future runs." />
        )}
      </section>

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
        <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
          permissions the server enforces for this bot
        </span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-[var(--step-minus-2)] font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
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
                    ? "admin permission — also needs the owner's exact-action approval"
                    : catalogue.byName.has(perm)
                      ? catalogue.byName.get(perm)?.summary
                      : "unknown permission — the server does not recognise it, so it grants nothing"
                }
                className={`inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-[var(--step-minus-2)] font-medium text-[var(--text-soft)] ${
                  catalogue.isAdmin(perm) ? "border-[var(--warn)] text-[var(--warn)]" : ""
                }`}
              >
                {perm}
                {catalogue.isAdmin(perm) ? " *" : ""}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[var(--step-minus-1)] text-[var(--muted)]">
            No permissions — every gated tool call for this bot is denied.
          </p>
        )}
        {unknownHeld.length > 0 ? (
          <div className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--danger)]" role="alert">
            Unknown permission name(s) held by this bot: {unknownHeld.join(", ")}. The server does not
            recognise them, so they grant nothing.
          </div>
        ) : null}
        {granted.some((p) => catalogue.isAdmin(p)) ? (
          <p className="mt-1.5 text-[var(--step-minus-2)] text-[var(--faint)]">
            * admin permission: granted, but each use still needs the owner&apos;s exact-action approval.
          </p>
        ) : null}
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-[var(--step-minus-2)] uppercase tracking-[0.14em] text-[var(--faint)]">
          Not granted ({denied.length})
        </div>
        {denied.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {denied.map((perm) => (
              <span
                key={perm.name}
                tabIndex={0}
                title={`${perm.summary} — denied unless granted.`}
                className="inline-flex items-center rounded-full border border-[var(--border-dim)] bg-[var(--surface-2)] px-2.5 py-0.5 text-[var(--step-minus-2)] font-medium text-[var(--muted)] opacity-60"
              >
                {perm.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[var(--step-minus-1)] text-[var(--muted)]">
            This bot holds every permission the server defines.
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-[var(--border-dim)] pt-3">
        <div className="mb-2 text-[var(--step-minus-2)] uppercase tracking-[0.14em] text-[var(--faint)]">
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
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)]"
                >
                  <div className="min-w-0">
                    <a className="font-medium text-[var(--text)] hover:underline" href={`#/board/${board.id}`}>
                      {board.name || "Unnamed board"}
                    </a>
                    <span className="mono ml-2 text-[var(--faint)]">{role}</span>
                    <div className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
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
          <p className="text-[var(--step-minus-1)] text-[var(--muted)]">
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
              className="max-w-64 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)]"
            >
              <option value="">(select board)</option>
              {notMemberOf.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name || "Unnamed board"} ({b.id.slice(0, 8)}…)
                </option>
              ))}
            </select>
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
              aria-label="Board role"
              className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)]"
            >
              <option value="member">Member</option>
              <option value="lead">Lead</option>
            </select>
            <Button variant="primary" type="submit" disabled={busy || !addBoardId || inactive}>
              Add to board
            </Button>
            {inactive ? (
              <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
                This bot is {mate.status} — only active bots can join a board.
              </span>
            ) : null}
          </form>
        )}

        {error ? (
          <div className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--danger)]" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

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

  // creation draft
  const [pid, setPid] = useState("");
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
      notifyError("Pick a project and give the bot a persona.");
      return;
    }
    try {
      await api.createTeammate(p, {
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
    projList.find((p) => p.id === botPid)?.repository || botPid.slice(0, 10);

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

  const steps = ["identity", "face", "model", "permissions", "memory", "review"] as const;
  const stepIndex = steps.indexOf(step);

  return (
    <Page>
      <PageHeader
        eyebrow="Fleet"
        title="AI fleet"
        description="Persistent AI teammates with identity, instructions, model/provider, permissions, memory, and task history. Bots own tasks and run them in isolated workspaces."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              New bot
            </Button>
            <Button onClick={all.reload}>Refresh</Button>
          </>
        }
      />

      <div className="mb-5 flex flex-wrap gap-1.5">
        <Badge variant={mates.length > 0 ? "info" : "neutral"}>{mates.length} bots</Badge>
        <Badge variant={busyBots > 0 ? "ok" : "neutral"}>{busyBots} running</Badge>
      </div>

      {showCreate ? (
        <Modal title={`Create bot — ${stepName(step)}`} onClose={() => setShowCreate(false)}>
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
                        {p.repository || "workspace"} ({p.id.slice(0, 8)}…)
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Persona / name">
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
                <p className="max-w-[46ch] text-[var(--step-minus-1)] text-[var(--muted)]">
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
                  <p className="text-[var(--step-minus-1)] text-[var(--muted)]">
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
                    <option value="">(none — use default)</option>
                    {provList.map((pr) => (
                      <option key={pr.id} value={pr.id}>
                        {pr.name} ({pr.kind})
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-[var(--step-minus-1)] text-[var(--faint)]">
                  Select the model connection this bot uses to think. Leave unset to use the
                  project&apos;s default provider.
                </p>
              </Field>
            )}
            {step === "permissions" && (
              <Field label="Tools &amp; permissions">
                <p className="mb-2 max-w-[46ch] text-[var(--step-minus-1)] text-[var(--muted)]">
                  Choose permissions from the server&apos;s canonical catalogue. Admin actions
                  (marked with a shield) require your approval before the bot can use them.
                </p>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
                  {catalogue.permissions.length === 0 ? (
                    <p className="p-1.5 text-[var(--step-minus-1)] text-[var(--muted)]">
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
                            <div className="text-[var(--step-minus-2)] text-[var(--muted)]">{perm.summary}</div>
                          </div>
                          {perm.requires_approval && <Badge variant="warn">approval-gated</Badge>}
                        </label>
                      );
                    })
                  )}
                </div>
                <p className="mt-1.5 text-[var(--step-minus-1)] text-[var(--faint)]">
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
                <p className="text-[var(--step-minus-1)] text-[var(--faint)]">
                  Project scope shares memory with other bots and tasks in the workspace. Private
                  keeps it to this bot alone.
                </p>
              </Field>
            )}
            {step === "review" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <BotAvatar face={face} size={64} label="The face this bot will wear" />
                  <p className="text-[var(--step-minus-1)] text-[var(--muted)]">
                    This is the face the bot will wear. You can change it at any time.
                  </p>
                </div>
                <dl className="flex flex-col gap-1.5 text-[var(--step-minus-1)]">
                  {[
                    ["Project", projList.find((p) => p.id === pid)?.repository || pid],
                    ["Persona / name", persona],
                    ["Instructions", instructions || "—"],
                    ["Face", `${SHAPE_LABELS[face.shape]} · ${COLOR_LABELS[face.color]} · ${EXPRESSION_LABELS[face.expression]}`],
                    ["Model provider", provList.find((pr) => pr.id === providerId)?.name || "(none — default)"],
                    ["Permissions", selectedPerms.length > 0 ? selectedPerms.join(", ") : "— none —"],
                    ["Memory scope", memoryScope],
                  ].map(([key, value]) => (
                    <div
                      key={key}
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
                    Create bot
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
        <div className={TABLE_SHELL}>
          <table className="w-full min-w-[720px] table-fixed">
            <thead>
              <tr>
                <th className={`${TABLE_TH} w-[22%]`}>Agent</th>
                <th className={`${TABLE_TH} w-[6rem]`}>State</th>
                <th className={`${TABLE_TH} w-[8rem]`}>Model</th>
                <th className={TABLE_TH}>Work</th>
                <th className={`${TABLE_TH} w-[12rem]`}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {mates.map((mate) => {
                const tasks = (botTasks.data as Record<string, Task[]> | undefined)?.[mate.id] ?? [];
                const active = tasks.filter(
                  (t) =>
                    t.status === "pending" ||
                    t.status === "running" ||
                    t.status === "blocked" ||
                    t.status === "awaiting_approval",
                );
                const latest = tasks[0];
                const busy = active.length > 0;
                // What the bot is doing, not whether it is enabled: an
                // unanswered approval outranks work in flight, so a blocked
                // bot no longer looks busy.
                const liveStatus = botActivity(mate.status, tasks);
                const provider = mate.provider_id
                  ? (providerNames.data as Record<string, Provider> | undefined)?.[mate.provider_id]
                  : undefined;
                const blocked = latest?.status === "blocked" ? latest : null;
                return (
                  <tr
                    key={mate.id}
                    className="align-top transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <td className={TABLE_TD}>
                      <BotChip href={`#/bot/${mate.id}`} persona={mate.persona || "Unnamed bot"} id={mate.id} status={liveStatus} face={mate.face} />
                      <div className="mt-0.5 truncate pl-8 text-[var(--step-minus-2)] text-[var(--faint)]">
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
                          className="block truncate text-[var(--step-minus-1)] text-[var(--text-soft)]"
                          title={provider.name}
                        >
                          {provider.name}
                        </span>
                      ) : (
                        <span className="text-[var(--step-minus-1)] text-[var(--warn)]">
                          no model
                        </span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      {latest ? (
                        <>
                          <button
                            className="block w-full truncate text-left text-[var(--step-minus-1)] text-[var(--text)] hover:underline"
                            title={latest.description}
                            onClick={() => openTask(latest.project_id, latest.id)}
                          >
                            {latest.description || "Untitled task"}
                          </button>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <StatusBadge status={latest.status} />
                            {busy ? (
                              <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
                                +{active.length - 1} more
                              </span>
                            ) : null}
                          </div>
                          {blocked?.blocked_reason ? (
                            <div className="mt-1 truncate text-[var(--step-minus-2)] text-[var(--warn)]" title={blocked.blocked_reason}>
                              {blocked.blocked_reason}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[var(--step-minus-1)] text-[var(--faint)]">
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
                          title={mate.status !== "active" ? "Only active bots can be given work" : "Give this bot a task"}
                        >
                          Give work
                        </Button>
                        <Button variant="ghost" onClick={() => openBot(mate.id)}>
                          Open →
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No bots yet"
          action={
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              Create your first bot
            </Button>
          }
          hint="Bots are persistent AI teammates. Give one a persona, attach a model, and assign it tasks. It will run work in an isolated workspace and keep its own memory."
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
