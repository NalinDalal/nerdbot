import { useState } from "react";
import { ApiError, api } from "./api";
import { notifyError } from "./app";
import type { Board, BoardMember, MemoryEntry, Run, Task, Teammate } from "./types";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  StatusBadge,
  useAsync,
  usePermissionCatalogue,
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
        {unclaimed && (
          <button className="primary" onClick={() => void claim(unclaimed.id)}>
            Claim "{unclaimed.description.slice(0, 30)}…"
          </button>
        )}
      </div>
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
  const [showCreate, setShowCreate] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [createPersona, setCreatePersona] = useState("");
  const [createInstructions, setCreateInstructions] = useState("");

  const createBot = async (e: React.FormEvent) => {
    e.preventDefault();
    const pid = createProjectId.trim();
    if (!pid || !createPersona.trim()) {
      return notifyError("Pick a project and give the bot a persona.");
    }
    try {
      await api.createTeammate(pid, {
        persona: createPersona.trim(),
        instructions: createInstructions.trim(),
        capabilities: [],
        permissions: [],
        memory_scope: "project",
      });
      setShowCreate(false);
      setCreateProjectId("");
      setCreatePersona("");
      setCreateInstructions("");
      all.reload();
      projects.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  if (all.loading || projects.loading) {
    return <LoadingState lines={4} />;
  }
  if (all.error || projects.error) {
    return (
      <div>
        <button onClick={() => (window.location.hash = "#/")}>← Home</button>
        <ErrorState
          error={all.error ?? projects.error ?? "Unable to load fleet"}
          onRetry={all.reload}
        />
      </div>
    );
  }

  const mates: Teammate[] = (all.data as { teammates: Teammate[] }).teammates;
  const projList: { id: string; repository: string }[] =
    (projects.data as { projects: { id: string; repository: string }[] }).projects;

  const projectOf = (pid: string) =>
    projList.find((p) => p.id === pid)?.repository || pid.slice(0, 10);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Fleet</h1>
          <p className="subtitle">
            Every bot on this server, across all workspaces. Create a bot in a
            project, then assign it tasks from that project's Teammates tab.
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
        <Modal title="Create bot" onClose={() => setShowCreate(false)}>
          <form onSubmit={createBot} className="row" style={{ gap: 8, flexDirection: "column" }}>
            <label className="field">
              <span>Project (workspace)</span>
              <select
                value={createProjectId}
                onChange={(e) => setCreateProjectId(e.target.value)}
                required
                style={{ width: 320 }}
              >
                <option value="">(select project)</option>
                {projList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.repository || "workspace"} ({p.id.slice(0, 8)}…)
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Persona / name</span>
              <input
                value={createPersona}
                onChange={(e) => setCreatePersona(e.target.value)}
                required
                placeholder="engineer"
                style={{ width: 320 }}
              />
            </label>
            <label className="field">
              <span>Instructions (optional)</span>
              <textarea
                value={createInstructions}
                onChange={(e) => setCreateInstructions(e.target.value)}
                placeholder="You are a careful engineering bot…"
                rows={2}
                style={{ width: 460 }}
              />
            </label>
            <div className="row">
              <button className="primary" type="submit">Create bot</button>
              <button
                className=""
                onClick={() => {
                  setShowCreate(false);
                  setCreateProjectId("");
                  setCreatePersona("");
                  setCreateInstructions("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
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
              <th>Memory</th>
              <th>Permissions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mates.map((mate) => (
              <tr key={mate.id}>
                <td>
                  <a href={`#/bot/${mate.id}`}>
                    <strong>{mate.persona || "Unnamed bot"}</strong>
                  </a>
                  <div className="muted mono">{mate.id.slice(0, 12)}…</div>
                  {mate.instructions ? (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {mate.instructions.slice(0, 80)}…
                    </div>
                  ) : null}
                </td>
                <td className="muted">{projectOf(mate.project_id)}</td>
                <td>
                  <StatusBadge status={mate.status} />
                </td>
                <td className="muted mono">
                  {mate.provider_id ? mate.provider_id.slice(0, 10) + "…" : "—"}
                </td>
                <td className="muted">{mate.memory_scope}</td>
                <td className="muted" style={{ fontSize: 11 }}>
                  {(mate.permissions ?? []).length > 0
                    ? (mate.permissions ?? []).join(", ")
                    : "—"}
                </td>
                <td>
                  <button
                    className="danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Disable bot ${mate.persona || mate.id}? This stops it from owning new tasks.`
                        )
                      ) {
                        void api.disableTeammate(mate.id).then(() => all.reload());
                      }
                    }}
                  >
                    Disable
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="No bots yet"
          hint="Create a bot in a workspace above. Bots own tasks, run them in isolated workspaces, and keep private memory."
        />
      )}
    </div>
  );
}
