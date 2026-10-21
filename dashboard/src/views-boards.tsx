import { useState } from "react";
import { ApiError, api } from "./api";
import { notifyError } from "./app";
import type { Plan } from "./types";
import { EmptyState, ErrorState, LoadingState, Modal, StatusBadge, TABLE_SHELL, TABLE_TD as TD, TABLE_TH as TH, FORM_INPUT, Button, SectionLabel, Page, PageHeader, useAsync } from "./components";
import { EntityForm } from "./forms";

export function BoardsView() {
  const list = useAsync(() => api.listBoards(), []);
  const [showCreate, setShowCreate] = useState(false);
  /* Names, so a board shows where it lives instead of a raw id. */
  const projects = useAsync(() => api.listProjects(), []);
  const teams = useAsync(() => api.listTeams(), []);
  const projectName = (id: string) =>
    (projects.data?.projects ?? []).find((p) => p.id === id)?.repository || id;
  const teamName = (id: string) =>
    (teams.data?.teams ?? []).find((t) => t.id === id)?.name || id;

  return (
    <Page>
      <PageHeader
        eyebrow="Fleet"
        title="Boards"
        description="Boards are workspace containers where bots own tasks. A CEO bot can create and delete boards, add teammate members, and exchange messages with other boards over the response channel."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              New board
            </Button>
            <Button onClick={list.reload}>Refresh</Button>
          </>
        }
      />
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
        <div className={TABLE_SHELL}>
          <table className="w-full min-w-[640px] table-fixed">
            <thead>
              <tr>
                <th className={`${TH} w-[30%]`}>Board</th>
                <th className={`${TH} w-[18%]`}>Workspace</th>
                <th className={`${TH} w-[16%]`}>Team</th>
                <th className={`${TH} w-[8rem]`}>Status</th>
                <th className={`${TH} w-[7rem]`}><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {list.data.boards.map((board) => (
                <tr
                  key={board.id}
                  className="align-top transition-colors hover:bg-[var(--surface-2)]"
                >
                  <td className={TD}>
                    <a
                      href={`#/board/${board.id}`}
                      className="font-medium text-[var(--text)] hover:underline"
                    >
                      {board.name || "Unnamed board"}
                    </a>
                    {board.description ? (
                      <div className="max-w-[46ch] truncate text-[var(--step-minus-1)] text-[var(--muted)]">
                        {board.description}
                      </div>
                    ) : null}
                    <div className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
                      {board.id}
                    </div>
                  </td>
                  <td className={TD}>{projectName(board.project_id)}</td>
                  <td className={TD}>
                    {board.team_id ? teamName(board.team_id) : (
                      <span className="text-[var(--faint)]">none</span>
                    )}
                  </td>
                  <td className={TD}>
                    <StatusBadge status={board.status} />
                  </td>
                  <td className={TD}>
                    <Button variant="ghost" onClick={() => { window.location.hash = `#/board/${board.id}`; }}>
                      Open →
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No boards yet"
          hint="Create a board to group tasks under one workspace. Bots can own tasks inside a board and message other boards."
        />
      )}
    </Page>
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
      <Page>
        <ErrorState error={detail.error ?? "Board not found"} onRetry={detail.reload} />
      </Page>
    );
  }

  const { board, members, messages, inbox } = detail.data;

  return (
    <Page>
      <PageHeader
        eyebrow="Board"
        title={board.name || "Unnamed board"}
        description={board.description}
        back={{ label: "Boards", onClick: () => (window.location.hash = "#/boards") }}
        actions={
          <>
            <Button onClick={() => setShowAddMember(true)}>Add member</Button>
            <Button onClick={() => setShowDecompose(true)}>Decompose objective</Button>
            <Button onClick={() => setShowRequestApproval(true)}>Request approval</Button>
            <Button onClick={detail.reload}>Refresh</Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[var(--step-minus-1)] text-[var(--muted)]">
        <span className="mono">Project: {board.project_id}</span>
        {board.team_id ? <span className="mono">· Team: {board.team_id}</span> : null}
      </div>

      {showAddMember ? (
        <Modal title="Add board member" onClose={() => setShowAddMember(false)}>
          <form onSubmit={(e) => { e.preventDefault(); addMember(); }} className="flex items-end gap-2">
            <input
              value={newMemberId}
              onChange={(e) => setNewMemberId(e.target.value)}
              placeholder="mate_…"
              aria-label="Teammate ID"
              className={`${FORM_INPUT} max-w-52`}
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              aria-label="Role"
              className={`${FORM_INPUT} max-w-32`}
            >
              <option value="member">Member</option>
              <option value="lead">Lead</option>
            </select>
            <Button variant="primary" type="submit">
              Add
            </Button>
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
          <form onSubmit={(e) => { e.preventDefault(); requestApproval(); }} className="flex items-end gap-2">
            <input
              value={approvalAction}
              onChange={(e) => setApprovalAction(e.target.value)}
              placeholder="board.mutate"
              aria-label="Action"
              className={`${FORM_INPUT} max-w-60`}
            />
            <Button variant="primary" type="submit">
              Request
            </Button>
          </form>
        </Modal>
      ) : null}

      {/* Members */}
      <section className="mb-8">
        <SectionLabel className="mb-2">Members</SectionLabel>
        {members.length > 0 ? (
          <div className={TABLE_SHELL}>
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>Teammate</th>
                  <th className={TH}>Role</th>
                  <th className={TH}></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="transition-colors hover:bg-[var(--surface-2)]">
                    <td className={`${TD} mono`}>{m.teammate_id.slice(0, 14)}…</td>
                    <td className={TD}>{m.role}</td>
                    <td className={TD}>
                      <Button variant="danger" onClick={() => removeMember(m.teammate_id)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No members" hint="Add teammates to this board so they can own tasks and send messages." />
        )}
      </section>

      {/* Board-to-board messages */}
      <section className="mb-8">
        <SectionLabel className="mb-2">Board-to-board messages</SectionLabel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
          }}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          <input
            value={messageContent}
            onChange={(e) => setMessageContent(e.target.value)}
            placeholder="Message…"
            aria-label="Message content"
            className={`${FORM_INPUT} min-w-52 flex-1`}
          />
          <input
            value={messageToBoard}
            onChange={(e) => setMessageToBoard(e.target.value)}
            placeholder="to board id (optional)"
            aria-label="Target board"
            className={`${FORM_INPUT} w-48`}
          />
          <select
            value={messageKind}
            onChange={(e) => setMessageKind(e.target.value)}
            aria-label="Message kind"
            className={`${FORM_INPUT} w-36`}
          >
            <option value="message">Message</option>
            <option value="handoff">Handoff</option>
            <option value="notice">Notice</option>
          </select>
          <Button variant="primary" type="submit" disabled={!messageContent.trim()}>
            Send
          </Button>
        </form>

        <h3 className="mt-5 mb-2 text-[var(--step-minus-2)] uppercase tracking-[0.14em] text-[var(--faint)]">
          Sent
        </h3>
        {messages.length > 0 ? (
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <div key={m.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <div className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
                  {m.kind} · {m.created_at.slice(0, 16)}
                </div>
                <div className="mt-1 text-[var(--step-minus-1)] text-[var(--text-soft)]">{m.content}</div>
                {m.to_board_id ? (
                  <div className="mono mt-1 text-[var(--step-minus-2)] text-[var(--faint)]">
                    To board: {m.to_board_id.slice(0, 14)}…
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No sent messages" hint="Compose a message above to send to another board." />
        )}

        <h3 className="mt-5 mb-2 text-[var(--step-minus-2)] uppercase tracking-[0.14em] text-[var(--faint)]">
          Inbox (to this board)
        </h3>
        {inbox.length > 0 ? (
          <div className="flex flex-col gap-2">
            {inbox.map((m) => (
              <div
                key={m.id}
                className="rounded-xl border border-[var(--border)] border-l-2 border-l-[var(--accent)] bg-[var(--surface)] px-4 py-3"
              >
                <div className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
                  {m.kind} · from {m.from_teammate_id ? m.from_teammate_id.slice(0, 14) : "system"} ·{" "}
                  {m.created_at.slice(0, 16)}
                </div>
                <div className="mt-1 text-[var(--step-minus-1)] text-[var(--text-soft)]">{m.content}</div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="Inbox empty" hint="Messages sent to this board appear here." />
        )}
      </section>
    </Page>
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
      <label className="mb-4 flex flex-col gap-1.5">
        <span className="text-[var(--step-minus-1)] font-medium text-[var(--text)]">Objective</span>
        <textarea
          rows={2}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Ship the login flow: implement, test, and document it"
          className={`${FORM_INPUT} resize-y`}
        />
      </label>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => void preview()} disabled={busy !== null || !objective.trim()}>
          {busy === "preview" ? "Planning…" : plan ? "Re-plan" : "Preview plan"}
        </Button>
        <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
          Preview creates nothing — you review before any task exists.
        </span>
      </div>

      {error ? (
        <div className="mb-3 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--danger)]" role="alert">
          {error}
          {needsApproval ? (
            <div className="mt-1.5">
              Owner approval is pending: approve it in the project&apos;s{" "}
              <strong>Approvals</strong> tab, then run this again.
            </div>
          ) : null}
        </div>
      ) : null}

      {plan ? (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <strong className="text-[var(--text)]">
              Reviewed plan ({plan.tasks.length} step{plan.tasks.length === 1 ? "" : "s"})
            </strong>
            <Button
              onClick={() =>
                setPlan({ ...plan, tasks: [...plan.tasks, { description: "", command: "", depends_on: [] }] })
              }
            >
              Add step
            </Button>
          </div>
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {plan.tasks.map((task, idx) => (
              <div key={idx} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
                    step {idx}
                    {task.depends_on.length > 0 ? ` · after ${task.depends_on.join(", ")}` : ""}
                  </span>
                  <Button
                    variant="danger"
                    onClick={() => setPlan({ ...plan, tasks: plan.tasks.filter((_, i) => i !== idx) })}
                  >
                    Remove
                  </Button>
                </div>
                <input
                  value={task.description}
                  onChange={(e) => editTask(idx, "description", e.target.value)}
                  placeholder="What this step does"
                  aria-label={`Step ${idx} description`}
                  className={`${FORM_INPUT} mt-1.5`}
                />
                <div className="mt-1.5 flex gap-2">
                  <input
                    className={`${FORM_INPUT} mono flex-1`}
                    value={task.command}
                    onChange={(e) => editTask(idx, "command", e.target.value)}
                    placeholder="command (empty = coordination step)"
                    aria-label={`Step ${idx} command`}
                  />
                  <input
                    className={`${FORM_INPUT} mono w-36`}
                    value={task.depends_on.join(", ")}
                    onChange={(e) => editTask(idx, "depends_on", e.target.value)}
                    placeholder="after: 0, 1"
                    aria-label={`Step ${idx} dependencies`}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={() => void materialize()}
              disabled={busy !== null || plan.tasks.length === 0}
            >
              {busy === "materialize" ? "Creating…" : "Approve & create tasks"}
            </Button>
            <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
              Creates exactly these steps — no second model call.
            </span>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
