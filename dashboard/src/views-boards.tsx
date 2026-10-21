import { useState } from "react";
import { ApiError, api } from "./api";
import { notifyError } from "./app";
import type { Plan } from "./types";
import { EmptyState, ErrorState, LoadingState, Modal, ShortId, StatusBadge, useAsync } from "./components";
import { EntityForm } from "./forms";

export function BoardsView() {
  const list = useAsync(() => api.listBoards(), []);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Boards</h1>
          <p className="subtitle">
            Boards are workspace containers where bots own tasks. A CEO bot can create and delete
            boards, add teammate members, and exchange messages with other boards over the response
            channel.
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setShowCreate(true)}>New board</button>
          <button onClick={list.reload}>Refresh</button>
        </div>
      </div>
      {showCreate ? (
        <Modal title="New board" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create board"
            fields={[
              { name: "name", label: "Name", required: true, placeholder: "Quarterly planning" },
              { name: "description", label: "Description", placeholder: "What this board owns" },
              { name: "project_id", label: "Project ID", required: true, placeholder: "prj_…" },
              { name: "team_id", label: "Team ID (optional)", placeholder: "tm_…" },
            ]}
            onSubmit={async (values) => {
              await api.createBoard(values);
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
      ) : list.data && list.data.boards.length > 0 ? (
        <div>
          {list.data.boards.map((board) => (
            <div className="card" key={board.id} style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <a href={`#/board/${board.id}`}>
                    <strong>{board.name || "Unnamed board"}</strong>
                  </a>
                  <div className="muted mono" style={{ marginTop: 4 }}>
                    <ShortId id={board.id} />
                  </div>
                  <span className="badge" style={{ marginTop: 4 }}>
                    <StatusBadge status={board.status} />
                  </span>
                  {board.description ? (
                    <div className="muted" style={{ marginTop: 4 }}>{board.description}</div>
                  ) : null}
                </div>
                <div className="row">
                  <button onClick={list.reload}>Refresh</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No boards yet"
          hint="Create a board to group tasks under one workspace. Bots can own tasks inside a board and message other boards."
        />
      )}
    </div>
  );
}

export function BoardDetailView({
  boardId,
}: {
  boardId: string;
}) {
  const detail = useAsync(() => api.getBoard(boardId), [boardId]);
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberId, setNewMemberId] = useState("");
  const [newRole, setNewRole] = useState("member");
  const [messageContent, setMessageContent] = useState("");
  const [messageToBoard, setMessageToBoard] = useState("");
  const [messageKind, setMessageKind] = useState("message");
  const [showRequestApproval, setShowRequestApproval] = useState(false);
  const [approvalAction, setApprovalAction] = useState("board.mutate");
  const [showDecompose, setShowDecompose] = useState(false);

  const addMember = async () => {
    const id = newMemberId.trim();
    if (!id) return;
    try {
      await api.addBoardMember(boardId, { teammate_id: id, role: newRole });
      setNewMemberId("");
      setShowAddMember(false);
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const removeMember = async (teammateId: string) => {
    try {
      await api.removeBoardMember(boardId, teammateId);
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const sendMessage = async () => {
    if (!messageContent.trim()) return;
    const body: Record<string, unknown> = { content: messageContent, kind: messageKind };
    if (messageToBoard.trim()) body.to_board_id = messageToBoard.trim();
    try {
      await api.createBoardMessage(boardId, body);
      setMessageContent("");
      setMessageToBoard("");
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const requestApproval = async () => {
    try {
      await api.requestBoardApproval(boardId, { action: approvalAction });
      setShowRequestApproval(false);
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };



  if (detail.loading) return <LoadingState lines={4} />;
  if (detail.error || !detail.data) {
    return (
      <div>
        <button onClick={() => (window.location.hash = "#/boards")}>← Back to boards</button>
        <ErrorState error={detail.error ?? "Board not found"} onRetry={detail.reload} />
      </div>
    );
  }

  const { board, members, messages, inbox } = detail.data;

  return (
    <div>
      <button onClick={() => (window.location.hash = "#/boards")}>← Back to boards</button>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Board: {board.name || "Unnamed board"}</h1>
          <p className="subtitle mono">{board.id}</p>
          {board.description ? <p className="subtitle">{board.description}</p> : null}
          <div className="muted" style={{ marginTop: 8 }}>
            Project: <span className="mono">{board.project_id}</span>
            {board.team_id ? (
              <>
                {" · Team: "}
                <span className="mono">{board.team_id}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="row">
          <button onClick={() => setShowAddMember(true)}>Add member</button>
          <button onClick={() => setShowDecompose(true)}>Decompose objective</button>
          <button onClick={() => setShowRequestApproval(true)}>Request approval</button>
          <button onClick={detail.reload}>Refresh</button>
        </div>
      </div>

      {showAddMember ? (
        <Modal title="Add board member" onClose={() => setShowAddMember(false)}>
          <form onSubmit={(e) => { e.preventDefault(); addMember(); }} className="row" style={{ gap: 8 }}>
            <input
              value={newMemberId}
              onChange={(e) => setNewMemberId(e.target.value)}
              placeholder="mate_…"
              aria-label="Teammate ID"
              style={{ maxWidth: 200 }}
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              style={{ maxWidth: 120 }}
            >
              <option value="member">Member</option>
              <option value="lead">Lead</option>
            </select>
            <button className="primary" type="submit">Add</button>
          </form>
        </Modal>
      ) : null}

      {showDecompose ? (
        <DecomposeModal
          boardId={boardId}
          onDone={() => {
            setShowDecompose(false);
            detail.reload();
          }}
        />
      ) : null}

      {showRequestApproval ? (
        <Modal title="Request board approval" onClose={() => setShowRequestApproval(false)}>
          <form onSubmit={(e) => { e.preventDefault(); requestApproval(); }} className="row" style={{ gap: 8 }}>
            <input
              value={approvalAction}
              onChange={(e) => setApprovalAction(e.target.value)}
              placeholder="board.mutate"
              aria-label="Action"
              style={{ maxWidth: 220 }}
            />
            <button className="primary" type="submit">Request</button>
          </form>
        </Modal>
      ) : null}

      <h2 style={{ marginTop: 24 }}>Members</h2>
      {members.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Teammate</th>
              <th>Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="mono">{m.teammate_id.slice(0, 14)}…</span>
                </td>
                <td>{m.role}</td>
                <td>
                  <button className="danger" onClick={() => removeMember(m.teammate_id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No members" hint="Add teammates to this board so they can own tasks and send messages." />
      )}

      <h2 style={{ marginTop: 32 }}>Board-to-board messages</h2>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input
          value={messageContent}
          onChange={(e) => setMessageContent(e.target.value)}
          placeholder="Message…"
          aria-label="Message content"
          style={{ flex: 1 }}
        />
        <input
          value={messageToBoard}
          onChange={(e) => setMessageToBoard(e.target.value)}
          placeholder="to board id (optional)"
          aria-label="Target board"
          style={{ maxWidth: 180 }}
        />
        <select value={messageKind} onChange={(e) => setMessageKind(e.target.value)} style={{ maxWidth: 120 }}>
          <option value="message">Message</option>
          <option value="handoff">Handoff</option>
          <option value="notice">Notice</option>
        </select>
        <button className="primary" onClick={sendMessage}>
          Send
        </button>
      </div>

      <h3>Sent</h3>
      {messages.length > 0 ? (
        <div className="row" style={{ flexDirection: "column", gap: 8 }}>
          {messages.map((m) => (
            <div className="card" key={m.id} style={{ padding: 10, marginBottom: 6 }}>
              <div className="muted mono" style={{ fontSize: 11 }}>
                {m.kind} · {m.created_at.slice(0, 16)}
              </div>
              <div>{m.content}</div>
              {m.to_board_id ? (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  To board: <span className="mono">{m.to_board_id.slice(0, 14)}…</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No sent messages" hint="Compose a message above to send to another board." />
      )}

      <h3 style={{ marginTop: 24 }}>Inbox (to this board)</h3>
      {inbox.length > 0 ? (
        <div className="row" style={{ flexDirection: "column", gap: 8 }}>
          {inbox.map((m) => (
            <div className="card" key={m.id} style={{ padding: 10, marginBottom: 6, borderLeft: "3px solid var(--accent)" }}>
              <div className="muted mono" style={{ fontSize: 11 }}>
                {m.kind} · from {m.from_teammate_id ? m.from_teammate_id.slice(0, 14) : "system"}·{" "}
                {m.created_at.slice(0, 16)}
              </div>
              <div>{m.content}</div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="Inbox empty" hint="Messages sent to this board appear here." />
      )}
    </div>
  );
}

/**
 * Plan-review flow: `preview` asks the model for a plan with no side effects;
 * the human edits it here; posting the reviewed plan back materializes exactly
 * that plan (no second model call). Gated bot callers answer 403/409 with the
 * server's message — a pending approval is surfaced so the operator can
 * approve it under the project's Approvals tab and retry.
 */
function DecomposeModal({ boardId, onDone }: { boardId: string; onDone: () => void }) {
  const [objective, setObjective] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [busy, setBusy] = useState<"preview" | "materialize" | null>(null);

  const fail = (err: unknown) => {
    if (err instanceof ApiError) {
      setError(err.detail);
      setNeedsApproval(err.approval !== undefined);
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
    notifyError(err);
  };

  const preview = async () => {
    if (!objective.trim() || busy) return;
    setBusy("preview");
    setError(null);
    setNeedsApproval(false);
    try {
      const result = await api.decomposeBoard(boardId, { objective, preview: true });
      setPlan(result.plan);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const materialize = async () => {
    if (!plan || busy) return;
    setBusy("materialize");
    setError(null);
    setNeedsApproval(false);
    try {
      await api.decomposeBoard(boardId, { objective, plan, create_board: true });
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const editTask = (idx: number, field: "description" | "command" | "depends_on", value: string) => {
    setPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tasks: prev.tasks.map((task, i) => {
          if (i !== idx) return task;
          if (field === "depends_on") {
            const depends_on = value
              .split(",")
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isInteger(n) && n >= 0 && n < idx);
            return { ...task, depends_on };
          }
          return { ...task, [field]: value };
        }),
      };
    });
  };

  return (
    <Modal title="Decompose objective — review the plan first" onClose={onDone}>
      <label className="field">
        <span>Objective</span>
        <textarea
          rows={2}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Ship the login flow: implement, test, and document it"
        />
      </label>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => void preview()} disabled={busy !== null || !objective.trim()}>
          {busy === "preview" ? "Planning…" : plan ? "Re-plan" : "Preview plan"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Preview creates nothing — you review before any task exists.
        </span>
      </div>

      {error ? (
        <div className="error-box" role="alert">
          {error}
          {needsApproval ? (
            <div style={{ marginTop: 6 }}>
              Owner approval is pending: approve it in the project&apos;s{" "}
              <strong>Approvals</strong> tab, then run this again.
            </div>
          ) : null}
        </div>
      ) : null}

      {plan ? (
        <div>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <strong>Reviewed plan ({plan.tasks.length} step{plan.tasks.length === 1 ? "" : "s"})</strong>
            <button
              onClick={() =>
                setPlan({ ...plan, tasks: [...plan.tasks, { description: "", command: "", depends_on: [] }] })
              }
            >
              Add step
            </button>
          </div>
          {plan.tasks.map((task, idx) => (
            <div className="card" key={idx} style={{ padding: 10, marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted mono" style={{ fontSize: 12 }}>
                  step {idx}
                  {task.depends_on.length > 0 ? ` · after ${task.depends_on.join(", ")}` : ""}
                </span>
                <button
                  className="danger"
                  onClick={() => setPlan({ ...plan, tasks: plan.tasks.filter((_, i) => i !== idx) })}
                >
                  Remove
                </button>
              </div>
              <input
                value={task.description}
                onChange={(e) => editTask(idx, "description", e.target.value)}
                placeholder="What this step does"
                aria-label={`Step ${idx} description`}
                style={{ width: "100%", marginTop: 6 }}
              />
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <input
                  className="mono"
                  value={task.command}
                  onChange={(e) => editTask(idx, "command", e.target.value)}
                  placeholder="command (empty = coordination step)"
                  aria-label={`Step ${idx} command`}
                />
                <input
                  className="mono"
                  value={task.depends_on.join(", ")}
                  onChange={(e) => editTask(idx, "depends_on", e.target.value)}
                  placeholder="after: 0, 1"
                  aria-label={`Step ${idx} dependencies`}
                  style={{ maxWidth: 140 }}
                />
              </div>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="primary"
              onClick={() => void materialize()}
              disabled={busy !== null || plan.tasks.length === 0}
            >
              {busy === "materialize" ? "Creating…" : "Approve & create tasks"}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Creates exactly these steps — no second model call.
            </span>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
