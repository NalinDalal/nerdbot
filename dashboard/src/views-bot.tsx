import { useState } from "react";
import { ApiError, api } from "./api";
import { describeError, notifyError } from "./app";
import type { Board, BoardMember, MemoryEntry, Provider, Run, Task, Teammate } from "./types";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  StatusBadge,
  useAsync,
  usePermissionCatalogue,
  Badge,
  Field,
} from "./components";

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
      <div>
        <button onClick={() => (window.location.hash = "#/teams")}>← Back</button>
        <ErrorState
          error={
            all.error ?? tasks.error ?? runs.error ?? memory.error ?? boards.error ?? "Bot not found"
          }
          onRetry={all.reload}
        />
      </div>
    );
  }

  const allMates = (all.data as { teammates: Teammate[] }).teammates;
  const mate = allMates.find((m) => m.id === teammateId);
  if (!mate) {
    return (
      <div>
        <button onClick={() => (window.location.hash = "#/teams")}>← Back</button>
        <EmptyState title="Bot not found" hint="" />
      </div>
    );
  }

  const taskList = (tasks.data as { tasks: Task[] }).tasks;
  const runList = (runs.data as { runs: Run[] }).runs;
  const memList = (memory.data as { entries: MemoryEntry[] }).entries;
  const unclaimed = taskList.find((t) => t.status === "pending" && !t.owner_teammate_id);

  return (
    <div>
      <button onClick={() => (window.location.hash = "#/teams")}>← Back to workstation</button>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Bot: {mate.persona || "Unnamed bot"}</h1>
          <p className="subtitle mono">{mate.id}</p>
          <div className="muted" style={{ fontSize: 12 }}>
            project {mate.project_id.slice(0, 10)}…
          </div>
        </div>
        <div className="row">
          <StatusBadge status={mate.status} />
          {mate.provider_id ? (
            <span className="muted mono" style={{ marginLeft: 8 }}>
              model {mate.provider_id.slice(0, 10)}…
            </span>
          ) : (
            <span style={{ color: "#b58a00", marginLeft: 8 }}>
              no model attached
            </span>
          )}
        </div>
      </div>

      {mate.instructions ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
            Instructions
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{mate.instructions}</div>
        </div>
      ) : null}

      <BotAccess mate={mate} boards={(boards.data as { boards: Board[] }).boards} />

      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Tasks</h2>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
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
          className="row"
          style={{ gap: 8, flexWrap: "wrap", alignItems: "end" }}
        >
          <input
            value={taskDescription}
            onChange={(e) => setTaskDescription(e.target.value)}
            placeholder="Task description (e.g. review the login flow)"
            aria-label="Task description"
            style={{ flex: 1, minWidth: 200 }}
          />
          <input
            value={taskCommand}
            onChange={(e) => setTaskCommand(e.target.value)}
            placeholder="Command (optional)"
            aria-label="Task command"
            style={{ minWidth: 180 }}
          />
          <button
            className="primary"
            type="submit"
            disabled={createTaskBusy || !taskDescription.trim()}
          >
            {createTaskBusy ? "Creating…" : "Create task"}
          </button>
          <button
            type="button"
            onClick={() => setShowCreateTask(!showCreateTask)}
            style={{ padding: "7px 14px" }}
          >
            {showCreateTask ? "Cancel" : "New task"}
          </button>
        </form>
      </div>
      {unclaimed && (
        <button className="primary" onClick={() => void claim(unclaimed.id)} style={{ marginBottom: 10 }}>
          Claim "{unclaimed.description.slice(0, 30)}…"
        </button>
      )}
      {taskList.length > 0 ? (
        <div className="grid2">
          {taskList.map((t) => (
            <div className="card" key={t.id} style={{ minHeight: 170 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <a href={`#/p/${t.project_id}/t/${t.id}`}>
                    <strong>{t.description || "Untitled"}</strong>
                  </a>
                  <div className="muted mono" style={{ fontSize: 11, marginTop: 2 }}>
                    {t.id}
                  </div>
                </div>
                <div className="row">
                  <StatusBadge status={t.status} />
                </div>
              </div>
              {t.command ? (
                <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
                  {t.command}
                </div>
              ) : null}
              {t.owner_teammate_id === teammateId ? (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  owned by this bot
                </div>
              ) : null}
              {t.status === "pending" && t.owner_teammate_id === teammateId ? (
                <button
                  className="primary"
                  onClick={() => {
                    void api
                      .runTask(t.id)
                      .then(() => {
                        tasks.reload();
                        runs.reload();
                      })
                      .catch(notifyError);
                  }}
                  style={{ marginTop: 8, padding: "6px 12px", fontSize: 12 }}
                >
                  Run task
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No tasks" hint="This bot owns no tasks yet. Create one from the workstation." />
      )}

      <h2 style={{ marginTop: 24, marginBottom: 8 }}>Runs</h2>
      {runList.length > 0 ? (
        <table className="data" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Exit</th>
              <th>Secs</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runList.slice(0, 20).map((r) => (
              <tr key={r.id}>
                <td className="mono muted" style={{ maxWidth: 160 }}>
                  {r.task_id.slice(0, 12)}…
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="mono">{r.exit_code ?? "—"}</td>
                <td className="mono">{Number(r.duration_s ?? 0).toFixed(1)}</td>
                <td className="mono muted">{r.started_at.slice(0, 16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No runs" hint="Runs appear here when this bot executes a task." />
      )}

      <h2 style={{ marginTop: 24, marginBottom: 8 }}>Memory (private)</h2>
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Scoped to teammate:{" "}
        <span className="mono muted" style={{ fontSize: 12 }}>{`teammate:${mate.id}`}</span>
        {" — only this bot reads/writes it."}
      </p>
      <form onSubmit={addMemory} style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        <input
          value={memContent}
          onChange={(e) => setMemContent(e.target.value)}
          placeholder="Remember this…"
          aria-label="Memory content"
          style={{ flex: 1 }}
        />
        <input
          value={memSource}
          onChange={(e) => setMemSource(e.target.value)}
          placeholder="source"
          aria-label="Memory source"
          style={{ maxWidth: 140 }}
        />
        <button className="primary" type="submit" disabled={memBusy}>
          {memBusy ? "Saving…" : "Save"}
        </button>
      </form>
      {memList.length > 0 ? (
        <div>
          {memList.map((entry) => (
            <div className="card" key={entry.id} style={{ marginTop: 8 }}>
              <div style={{ whiteSpace: "pre-wrap" }}>{entry.content}</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                {entry.source} · confidence {entry.confidence} ·{" "}
                <span className="mono">{entry.timestamp.slice(0, 16)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No memories" hint="Save a note this bot will recall in future runs." />
      )}
    </div>
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
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Access</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          permissions the server enforces for this bot
        </span>
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Granted
        </div>
        {granted.length > 0 ? (
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {granted.map((perm) => (
              <span
                className="pill"
                key={perm}
                title={
                  catalogue.isAdmin(perm)
                    ? "admin permission — also needs the owner's exact-action approval"
                    : catalogue.byName.has(perm)
                      ? catalogue.byName.get(perm)?.summary
                      : "unknown permission — the server does not recognise it, so it grants nothing"
                }
              >
                {perm}
                {catalogue.isAdmin(perm) ? " *" : ""}
              </span>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            No permissions — every gated tool call for this bot is denied.
          </div>
        )}
        {unknownHeld.length > 0 ? (
          <div className="error-box" role="alert" style={{ marginTop: 8 }}>
            Unknown permission name(s) held by this bot: {unknownHeld.join(", ")}. The server does not
            recognise them, so they grant nothing.
          </div>
        ) : null}
        {granted.some((p) => catalogue.isAdmin(p)) ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            * admin permission: granted, but each use still needs the owner&apos;s exact-action approval.
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Not granted ({denied.length})
        </div>
        {denied.length > 0 ? (
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {denied.map((perm) => (
              <span
                className="pill"
                key={perm.name}
                style={{ opacity: 0.55 }}
                title={`${perm.summary} — denied unless granted.`}
              >
                {perm.name}
              </span>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            This bot holds every permission the server defines.
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Board membership
        </div>
        {members.loading ? (
          <LoadingState lines={1} />
        ) : memberships.length > 0 ? (
          <table className="data" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Board</th>
                <th>Role</th>
                <th>Co-members</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {memberships.map(({ board, role }) => {
                const coMembers = (members.data?.[board.id] ?? []).filter(
                  (m) => m.teammate_id !== mate.id,
                );
                return (
                  <tr key={board.id}>
                    <td>
                      <a href={`#/board/${board.id}`}>{board.name || "Unnamed board"}</a>
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {board.id.slice(0, 12)}…
                      </div>
                    </td>
                    <td>{role}</td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {coMembers.length > 0
                        ? coMembers.map((m) => m.teammate_id.slice(0, 8)).join(", ")
                        : "—"}
                    </td>
                    <td>
                      <button className="danger" onClick={() => void removeMembership(board.id)} disabled={busy}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="Not on any board"
            hint="A bot needs board membership to read a board's messages, even with the board.read permission."
          />
        )}

        {notMemberOf.length > 0 ? (
          <form
            onSubmit={addMembership}
            className="row"
            style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}
          >
            <select
              value={addBoardId}
              onChange={(e) => setAddBoardId(e.target.value)}
              aria-label="Board to join"
              style={{ maxWidth: 280 }}
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
              style={{ maxWidth: 120 }}
            >
              <option value="member">Member</option>
              <option value="lead">Lead</option>
            </select>
            <button className="primary" type="submit" disabled={busy || !addBoardId || inactive}>
              Add to board
            </button>
            {inactive ? (
              <span className="muted" style={{ fontSize: 12 }}>
                This bot is {mate.status} — only active bots can join a board.
              </span>
            ) : null}
          </form>
        ) : null}

        {error ? (
          <div className="error-box" role="alert" style={{ marginTop: 8 }}>
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
  const [step, setStep] = useState<"identity" | "model" | "permissions" | "memory" | "review">(
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
    const matesList = (all.data as { teammates: Teammate[] })?.teammates ?? [];
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

  const back = () => {
    if (step === "identity") setStep("identity");
    else if (step === "model") setStep("identity");
    else if (step === "permissions") setStep("model");
    else if (step === "memory") setStep("permissions");
    else if (step === "review") setStep("memory");
  };

  const next = () => {
    if (step === "identity") {
      if (!persona.trim()) return;
      setStep("model");
    } else if (step === "model") {
      setStep("permissions");
    } else if (step === "permissions") {
      setStep("memory");
    } else if (step === "memory") {
      setStep("review");
    }
  };

  const createBot = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = pid.trim();
    if (!p || !persona.trim()) return notifyError("Pick a project and give the bot a persona.");
    try {
      await api.createTeammate(p, {
        persona: persona.trim(),
        instructions: instructions.trim(),
        capabilities: [],
        permissions: selectedPerms,
        memory_scope: memoryScope,
        provider_id: providerId || undefined,
      });
      setShowCreate(false);
      setPid("");
      setPersona("");
      setInstructions("");
      setProviderId("");
      setSelectedPerms([]);
      setMemoryScope("project");
      setStep("identity");
      all.reload();
      projects.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  if (all.loading || projects.loading || catalogue.loading || botTasks.loading) {
    return <LoadingState lines={4} />;
  }
  if (all.error || projects.error || catalogue.error || botTasks.error) {
    return (
      <div>
        <button onClick={() => (window.location.hash = "#/")}>← Home</button>
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
      </div>
    );
  }

  const mates: Teammate[] = (all.data as { teammates: Teammate[] }).teammates;
  const projList: { id: string; repository: string }[] =
    (projects.data as { projects: { id: string; repository: string }[] }).projects;
  const provList: Provider[] = (providers.data as { providers: Provider[] } | null)?.providers ?? [];

  const projectOf = (pid2: string) =>
    projList.find((p) => p.id === pid2)?.repository || pid2.slice(0, 10);

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
      // close modal handled by parent state via giveWorkMateId empty
    } catch (err) {
      notifyError(err);
    } finally {
      setGiveWorkBusy(false);
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>AI fleet</h1>
          <p className="subtitle">
            Persistent AI teammates with identity, instructions, model/provider, permissions, memory,
            and task history. Bots own tasks and run them in isolated workspaces.
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setShowCreate(true)}>
            New bot
          </button>
          <button onClick={all.reload}>Refresh</button>
        </div>
      </div>

      {showCreate ? (
        <Modal title={`Create bot — ${stepName(step)}`} onClose={() => setShowCreate(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {step === "identity" && (
              <>
                <Field label="Project (workspace)">
                  <select
                    value={pid}
                    onChange={(e) => setPid(e.target.value)}
                    required
                    style={{ width: 340 }}
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
                    style={{ width: 340 }}
                  />
                </Field>
                <Field label="Instructions (optional)">
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="You are a careful engineering bot…"
                    rows={3}
                    style={{ width: 480 }}
                  />
                </Field>
              </>
            )}
            {step === "model" && (
              <>
                <Field label="Model provider">
                  {providers.loading ? (
                    <LoadingState lines={1} />
                  ) : providers.error ? (
                    <div className="error-box" style={{ padding: 8 }}>
                      {describeError(providers.error)}
                    </div>
                  ) : provList.length === 0 ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      No providers configured for this project. Add one in the project's Providers
                      tab, then attach it here. The bot will work without a provider until one is
                      attached.
                    </div>
                  ) : (
                    <select
                      value={providerId}
                      onChange={(e) => setProviderId(e.target.value)}
                      style={{ width: 340 }}
                    >
                      <option value="">(none — use default)</option>
                      {provList.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.name} ({pr.kind})
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Select the model connection this bot uses to think. Leave unset to use the
                    project's default provider.
                  </div>
                </Field>
              </>
            )}
            {step === "permissions" && (
              <>
                <Field label="Tools &amp; permissions">
                  <p className="muted" style={{ fontSize: 12, marginBottom: 8, maxWidth: 460 }}>
                    Choose permissions from the server's canonical catalogue. Admin actions
                    (marked with a shield) require your approval before the bot can use them.
                  </p>
                  <div
                    style={{
                      maxHeight: 260,
                      overflowY: "auto" as const,
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius)",
                      padding: 8,
                      background: "var(--surface)",
                    }}
                  >
                    {catalogue.permissions.length === 0 ? (
                      <div className="muted" style={{ fontSize: 12, padding: 6 }}>
                        No permissions available from the server.
                      </div>
                    ) : (
                      catalogue.permissions.map((perm) => {
                        const held = selectedPerms.includes(perm.name);
                        return (
                          <label
                            key={perm.name}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "4px 6px",
                              borderRadius: "var(--radius-sm)",
                              cursor: "pointer",
                              background: held ? "var(--accent-dim)" : "transparent",
                              border: held ? "1px solid var(--accent)" : "1px solid transparent",
                            }}
                            onClick={() => {
                              if (held) {
                                setSelectedPerms(selectedPerms.filter((x) => x !== perm.name));
                              } else {
                                setSelectedPerms([...selectedPerms, perm.name]);
                              }
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={held}
                              readOnly
                              style={{ width: "auto", margin: 0 }}
                            />
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 500 }}>{perm.name}</div>
                              <div className="muted" style={{ fontSize: 11 }}>
                                {perm.summary}
                              </div>
                            </div>
                            {perm.requires_approval && (
                              <span style={{ fontSize: 10, marginLeft: 6 }}>
                                <Badge variant="warn">approval-gated</Badge>
                              </span>
                            )}
                          </label>
                        );
                      })
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {selectedPerms.length} selected
                  </div>
                </Field>
              </>
            )}
            {step === "memory" && (
              <>
                <Field label="Memory scope">
                  <select
                    value={memoryScope}
                    onChange={(e) => setMemoryScope(e.target.value)}
                    style={{ width: 240 }}
                  >
                    <option value="project">Project</option>
                    <option value="private">Private (this bot only)</option>
                  </select>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Project scope shares memory with other bots and tasks in the workspace. Private
                    keeps it to this bot alone.
                  </div>
                </Field>
              </>
            )}
            {step === "review" && (
              <>
                <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                  <div className="row">
                    <span className="muted">Project</span>
                    <span>{projList.find((p) => p.id === pid)?.repository || pid}</span>
                  </div>
                  <div className="row">
                    <span className="muted">Persona / name</span>
                    <span>{persona}</span>
                  </div>
                  {instructions && (
                    <div className="row">
                      <span className="muted">Instructions</span>
                      <span>{instructions}</span>
                    </div>
                  )}
                  <div className="row">
                    <span className="muted">Model provider</span>
                    <span>
                      {provList.find((pr) => pr.id === providerId)?.name || "(none — default)"}
                    </span>
                  </div>
                  <div className="row">
                    <span className="muted">Permissions</span>
                    <span>
                      {selectedPerms.length > 0 ? selectedPerms.join(", ") : "— none —"}
                    </span>
                  </div>
                  <div className="row">
                    <span className="muted">Memory scope</span>
                    <span>{memoryScope}</span>
                  </div>
                </div>
              </>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 16 }}>
              {step !== "identity" && (
                <button onClick={back} style={{ padding: "7px 14px" }}>
                  Back
                </button>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                {step === "review" ? (
                  <button className="primary" onClick={createBot} disabled={!persona.trim()}>
                    Create bot
                  </button>
                ) : (
                  <button
                    className="primary"
                    onClick={next}
                    disabled={
                      step === "identity"
                        ? !pid.trim() || !persona.trim()
                        : step === "model"
                        ? false
                        : false
                    }
                  >
                    Continue
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowCreate(false);
                    setPid("");
                    setPersona("");
                    setInstructions("");
                    setProviderId("");
                    setSelectedPerms([]);
                    setMemoryScope("project");
                    setStep("identity");
                  }}
                  style={{ padding: "7px 14px" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      <h2 style={{ marginTop: 24 }}>Bots</h2>
      {mates.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Workspace</th>
              <th>Status</th>
              <th>Model</th>
              <th>Permissions</th>
              <th>Current task</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mates.map((mate) => (
              <tr key={mate.id}>
                <td>
                  <div>
                    <a href={`#/bot/${mate.id}`}>
                      <strong>{mate.persona || "Unnamed bot"}</strong>
                    </a>
                    <div className="muted mono">{mate.id.slice(0, 12)}…</div>
                  </div>
                </td>
                <td className="muted">{projectOf(mate.project_id)}</td>
                <td>
                  <StatusBadge status={mate.status} />
                </td>
                <td className="muted mono">
                  {mate.provider_id ? mate.provider_id.slice(0, 10) + "…" : "—"}
                </td>
                <td className="muted" style={{ fontSize: 11 }}>
                  {(mate.permissions ?? []).length > 0
                    ? (mate.permissions ?? []).join(", ")
                    : "—"}
                </td>
                <td>
                  {(() => {
                    const tasks = (botTasks.data as Record<string, Task[]> | undefined)?.[mate.id] ?? [];
                    const active = tasks.filter(
                      (t) => t.status === "pending" || t.status === "running" || t.status === "blocked",
                    );
                    const latest = tasks[0];
                    if (!latest) return <span className="muted">—</span>;
                    const busy = active.length > 0;
                    return (
                      <div>
                        <div className={`muted mono ${busy ? "text-soft" : ""}`} style={{ fontSize: 11 }}>
                          {latest.description || "Untitled task"}
                        </div>
                        <div className="row" style={{ marginTop: 2 }}>
                          <StatusBadge status={latest.status} />
                          {busy ? (
                            <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>
                              active
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })()}
                </td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className="primary"
                      onClick={() => {
                        window.location.hash = `#/bot/${mate.id}`;
                      }}
                      style={{ padding: "4px 10px", fontSize: 12 }}
                    >
                      Open
                    </button>
                    <button
                      className="button"
                      onClick={() => {
                        setGiveWorkMateId(mate.id);
                      }}
                      disabled={mate.status !== "active"}
                      style={{ padding: "4px 10px", fontSize: 12, opacity: mate.status !== "active" ? 0.5 : 1 }}
                      title={mate.status !== "active" ? "Only active bots can be given work" : "Give this bot a task"}
                    >
                      Give work
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="No bots yet"
          action={
            <button className="button primary" onClick={() => setShowCreate(true)}>
              Create your first bot
            </button>
          }
          hint="Bots are persistent AI teammates. Give one a persona, attach a model, and assign it tasks. It will run work in an isolated workspace and keep its own memory."
        />
      )}

      {giveWorkMateId ? (
        <Modal
          title={`Give work to ${mates.find((m) => m.id === giveWorkMateId)?.persona || "bot"}`}
          onClose={() => setGiveWorkMateId("")}
        >
          <form onSubmit={giveWorkSubmit} className="row" style={{ flexDirection: "column", gap: 10 }}>
            <Field label="Work to do">
              <textarea
                value={giveWorkDesc}
                onChange={(e) => setGiveWorkDesc(e.target.value)}
                placeholder="e.g. review the login flow and add tests"
                rows={3}
                style={{ width: 460 }}
              />
            </Field>
            <Field label="Command (optional)">
              <input
                value={giveWorkCmd}
                onChange={(e) => setGiveWorkCmd(e.target.value)}
                placeholder="e.g. npm test"
                style={{ width: 460 }}
              />
            </Field>
            <div className="row" style={{ gap: 8 }}>
              <button className="primary" type="submit" disabled={giveWorkBusy || !giveWorkDesc.trim()}>
                {giveWorkBusy ? "Creating…" : "Create task"}
              </button>
              <button type="button" onClick={() => setGiveWorkMateId("")} style={{ padding: "7px 14px" }}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function stepName(s: string): string {
  const names: Record<string, string> = {
    identity: "Identity &amp; role",
    model: "Model provider",
    permissions: "Tools &amp; permissions",
    memory: "Memory &amp; scope",
    review: "Review &amp; save",
  };
  return names[s] ?? s;
}
