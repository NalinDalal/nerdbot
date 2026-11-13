import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { ApiError, api } from "./api";
import { notifyError } from "./app";
import { EmptyState, ErrorState, LoadingState, Modal, StatusBadge, TABLE_SHELL, TABLE_TD as TD, TABLE_TH as TH, FORM_INPUT, Button, SectionLabel, Page, PageHeader, useAsync } from "./components";
import { navigate } from "./app";
import { EntityForm } from "./forms";
import { Markdown } from "./markdown";
export function BoardsView() {
    const list = useAsync(() => api.listBoards(), []);
    const [showCreate, setShowCreate] = useState(false);
    /* Names, so a board shows where it lives instead of a raw id. */
    const projects = useAsync(() => api.listProjects(), []);
    const teams = useAsync(() => api.listTeams(), []);
    const projectName = (id) => (projects.data?.projects ?? []).find((p) => p.id === id)?.repository || id;
    const teamName = (id) => (teams.data?.teams ?? []).find((t) => t.id === id)?.name || id;
    return (_jsxs(Page, { width: "data", children: [_jsx(PageHeader, { eyebrow: "Advanced", title: "Boards", description: "Message channels that bots can read and write. Board membership is a real grant.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "New board" }), _jsx(Button, { onClick: list.reload, children: "Refresh" })] }) }), showCreate ? (_jsx(Modal, { title: "New board", onClose: () => setShowCreate(false), children: _jsx(EntityForm, { submitLabel: "Create board", fields: [
                        { name: "name", label: "Name", required: true, placeholder: "Quarterly planning" },
                        { name: "description", label: "Description", placeholder: "What this board owns" },
                        { name: "project_id", label: "Project ID", required: true, placeholder: "prj_…" },
                        { name: "team_id", label: "Team ID (optional)", placeholder: "tm_…" },
                    ], onSubmit: async (values) => {
                        await api.createBoard(values);
                        setShowCreate(false);
                        list.reload();
                    } }) })) : null, list.loading ? (_jsx(LoadingState, {})) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : list.data && list.data.boards.length > 0 ? (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full min-w-[640px] table-fixed", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: `${TH} w-[30%]`, children: "Board" }), _jsx("th", { className: `${TH} w-[18%]`, children: "Workspace" }), _jsx("th", { className: `${TH} w-[16%]`, children: "Team" }), _jsx("th", { className: `${TH} w-[8rem]`, children: "Status" }), _jsx("th", { className: `${TH} w-[7rem]`, children: _jsx("span", { className: "sr-only", children: "Open" }) })] }) }), _jsx("tbody", { children: list.data.boards.map((board) => (_jsxs("tr", { className: "align-top transition-colors hover:bg-[var(--surface-2)]", children: [_jsxs("td", { className: TD, children: [_jsx("a", { href: `/board/${board.id}`, className: "font-medium text-[var(--text)] hover:underline", children: board.name || "Unnamed board" }), board.description ? (_jsx("div", { className: "max-w-[46ch] truncate text-step--1 text-[var(--muted)]", children: board.description })) : null, _jsx("div", { className: "mono text-step--2 text-[var(--faint)]", children: board.id })] }), _jsx("td", { className: TD, children: projectName(board.project_id) }), _jsx("td", { className: TD, children: board.team_id ? teamName(board.team_id) : (_jsx("span", { className: "text-[var(--faint)]", children: "none" })) }), _jsx("td", { className: TD, children: _jsx(StatusBadge, { status: board.status }) }), _jsx("td", { className: TD, children: _jsx(Button, { variant: "ghost", onClick: () => { navigate(`/board/${board.id}`); }, children: "Open \u2192" }) })] }, board.id))) })] }) })) : (_jsx(EmptyState, { title: "No boards yet", hint: "Create a board to group tasks under one workspace. Bots can own tasks inside a board and message other boards." }))] }));
}
export function BoardDetailView({ boardId, }) {
    const detail = useAsync(() => api.getBoard(boardId), [boardId]);
    const execution = useAsync(() => api.getBoardExecution(boardId), [boardId]);
    const teammates = useAsync(() => api.listTeammates(detail.data?.board?.project_id || ""), [detail.data?.board?.project_id]);
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
        if (!id)
            return;
        try {
            await api.addBoardMember(boardId, { teammate_id: id, role: newRole });
            setNewMemberId("");
            setShowAddMember(false);
            detail.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const removeMember = async (teammateId) => {
        try {
            await api.removeBoardMember(boardId, teammateId);
            detail.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const sendMessage = async () => {
        if (!messageContent.trim())
            return;
        const body = { content: messageContent, kind: messageKind };
        if (messageToBoard.trim())
            body.to_board_id = messageToBoard.trim();
        try {
            await api.createBoardMessage(boardId, body);
            setMessageContent("");
            setMessageToBoard("");
            detail.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const requestApproval = async () => {
        try {
            await api.requestBoardApproval(boardId, { action: approvalAction });
            setShowRequestApproval(false);
            detail.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    if (detail.loading)
        return _jsx(LoadingState, { lines: 4 });
    if (detail.error || !detail.data) {
        return (_jsx(Page, { children: _jsx(ErrorState, { error: detail.error ?? "Board not found", onRetry: detail.reload }) }));
    }
    const { board, members, messages, inbox } = detail.data;
    return (_jsxs(Page, { children: [_jsx(PageHeader, { eyebrow: "Board", title: board.name || "Unnamed board", description: board.description, back: { label: "Boards", onClick: () => (window.location.hash = "/boards") }, actions: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setShowAddMember(true), children: "Add member" }), _jsx(Button, { onClick: () => setShowDecompose(true), children: "Decompose objective" }), _jsx(Button, { onClick: () => setShowRequestApproval(true), children: "Request approval" }), _jsx(Button, { onClick: detail.reload, children: "Refresh" })] }) }), _jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-2 text-step--1 text-[var(--muted)]", children: [_jsxs("span", { className: "mono", children: ["Project: ", board.project_id] }), board.team_id ? _jsxs("span", { className: "mono", children: ["\u00B7 Team: ", board.team_id] }) : null] }), showAddMember ? (_jsx(Modal, { title: "Add board member", onClose: () => setShowAddMember(false), children: _jsxs("form", { onSubmit: (e) => { e.preventDefault(); addMember(); }, className: "flex items-end gap-2", children: [_jsx("input", { value: newMemberId, onChange: (e) => setNewMemberId(e.target.value), placeholder: "mate_\u2026", "aria-label": "Teammate ID", className: `${FORM_INPUT} max-w-52` }), _jsxs("select", { value: newRole, onChange: (e) => setNewRole(e.target.value), "aria-label": "Role", className: `${FORM_INPUT} max-w-32`, children: [_jsx("option", { value: "member", children: "Member" }), _jsx("option", { value: "lead", children: "Lead" })] }), _jsx(Button, { variant: "primary", type: "submit", children: "Add" })] }) })) : null, showDecompose ? (_jsx(DecomposeModal, { boardId: boardId, onDone: () => {
                    setShowDecompose(false);
                    detail.reload();
                } })) : null, showRequestApproval ? (_jsx(Modal, { title: "Request board approval", onClose: () => setShowRequestApproval(false), children: _jsxs("form", { onSubmit: (e) => { e.preventDefault(); requestApproval(); }, className: "flex items-end gap-2", children: [_jsx("input", { value: approvalAction, onChange: (e) => setApprovalAction(e.target.value), placeholder: "board.mutate", "aria-label": "Action", className: `${FORM_INPUT} max-w-60` }), _jsx(Button, { variant: "primary", type: "submit", children: "Request" })] }) })) : null, _jsxs("section", { className: "mb-8", children: [_jsx(SectionLabel, { className: "mb-2", children: "Members" }), members.length > 0 ? (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TH, children: "Teammate" }), _jsx("th", { className: TH, children: "Role" }), _jsx("th", { className: TH })] }) }), _jsx("tbody", { children: members.map((m) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsxs("td", { className: `${TD} mono`, children: [m.teammate_id.slice(0, 14), "\u2026"] }), _jsx("td", { className: TD, children: m.role }), _jsx("td", { className: TD, children: _jsx(Button, { variant: "danger", onClick: () => removeMember(m.teammate_id), children: "Remove" }) })] }, m.id))) })] }) })) : (_jsx(EmptyState, { title: "No members", hint: "Add teammates to this board so they can own tasks and send messages." }))] }), _jsxs("section", { className: "mb-8", children: [_jsx(SectionLabel, { className: "mb-2", children: "Execution & deliverables" }), execution.loading ? (_jsx(LoadingState, { lines: 2 })) : execution.error ? (_jsx(ErrorState, { error: execution.error, onRetry: execution.reload })) : execution.data ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-3 text-step--1 text-[var(--muted)]", children: [execution.data.tasks.length, " tasks \u00B7 ", execution.data.deliverables.length, " deliverables"] }), execution.data.tasks.length === 0 ? (_jsx(EmptyState, { title: "No tasks on this board yet", hint: "Decompose an objective to create tasks." })) : (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TH, children: "Task" }), _jsx("th", { className: TH, children: "Assignee" }), _jsx("th", { className: TH, children: "Status" }), _jsx("th", { className: TH, children: "Latest run" }), _jsx("th", { className: TH, children: "Artifacts" })] }) }), _jsx("tbody", { children: execution.data.tasks.map((row) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsxs("td", { className: TD, children: [_jsx("button", { className: "text-left text-[var(--text)] hover:underline", onClick: () => navigate(`/p/${row.task.project_id}/t/${row.task.id}`), children: row.task.description || row.task.id }), _jsx("div", { className: "mono text-step--2 text-[var(--faint)]", children: row.task.id })] }), _jsx("td", { className: TD, children: (() => {
                                                            const mate = (teammates.data?.teammates || []).find((m) => m.id === row.task.owner_teammate_id);
                                                            if (!mate)
                                                                return _jsx("span", { className: "text-[var(--faint)]", children: "\u2014" });
                                                            return (_jsx("div", { className: "flex items-center gap-1.5", children: _jsx("span", { className: "text-step--1", children: mate.slug || mate.id }) }));
                                                        })() }), _jsxs("td", { className: TD, children: [_jsx(StatusBadge, { status: row.task.status }), row.task.status === "pending" ? (_jsx("div", { className: "mt-1 text-step--2 text-[var(--muted)]", children: row.task.dependencies?.length ? "Waiting for dependencies" : "Queued (executor not running)" })) : null] }), _jsx("td", { className: TD, children: row.latest_run ? (_jsxs("span", { className: "text-step--1", children: [row.latest_run.status, row.latest_run.exit_code !== null ? ` (exit ${row.latest_run.exit_code})` : ""] })) : (_jsx("span", { className: "text-[var(--faint)]", children: "\u2014" })) }), _jsx("td", { className: TD, children: row.artifacts.length === 0 ? (_jsx("span", { className: "text-[var(--faint)]", children: "\u2014" })) : (_jsx("div", { className: "flex flex-col gap-1", children: row.artifacts.map((a) => (_jsxs("span", { className: "text-step--1", children: [a.type, " \u00B7 ", a.verification_status] }, a.id))) })) })] }, row.task.id))) })] }) })), execution.data.deliverables.length > 0 ? (_jsxs("div", { className: "mt-4", children: [_jsx(SectionLabel, { className: "mb-2", children: "Deliverables" }), _jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TH, children: "Type" }), _jsx("th", { className: TH, children: "Task" }), _jsx("th", { className: TH, children: "Status" }), _jsx("th", { className: TH, children: "Summary" })] }) }), _jsx("tbody", { children: execution.data.deliverables.map((d) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: TD, children: d.type }), _jsx("td", { className: `${TD} mono text-step--2`, children: d.task_id }), _jsx("td", { className: TD, children: d.verification_status }), _jsx("td", { className: TD, children: d.summary })] }, d.artifact_id))) })] }) })] })) : null] })) : null] }), _jsxs("section", { className: "mb-8", children: [_jsx(SectionLabel, { className: "mb-2", children: "Board-to-board messages" }), _jsxs("form", { onSubmit: (e) => {
                            e.preventDefault();
                            sendMessage();
                        }, className: "flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsx("input", { value: messageContent, onChange: (e) => setMessageContent(e.target.value), placeholder: "Message\u2026", "aria-label": "Message content", className: `${FORM_INPUT} min-w-52 flex-1` }), _jsx("input", { value: messageToBoard, onChange: (e) => setMessageToBoard(e.target.value), placeholder: "to board id (optional)", "aria-label": "Target board", className: `${FORM_INPUT} w-48` }), _jsxs("select", { value: messageKind, onChange: (e) => setMessageKind(e.target.value), "aria-label": "Message kind", className: `${FORM_INPUT} w-36`, children: [_jsx("option", { value: "message", children: "Message" }), _jsx("option", { value: "handoff", children: "Handoff" }), _jsx("option", { value: "notice", children: "Notice" })] }), _jsx(Button, { variant: "primary", type: "submit", disabled: !messageContent.trim(), children: "Send" })] }), _jsx("h3", { className: "mt-5 mb-2 text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Sent" }), messages.length > 0 ? (_jsx("div", { className: "flex flex-col gap-2", children: messages.map((m) => (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3", children: [_jsxs("div", { className: "mono text-step--2 text-[var(--faint)]", children: [m.kind, " \u00B7 ", m.created_at.slice(0, 16)] }), _jsx("div", { className: "mt-1 text-step--1 text-[var(--text-soft)]", children: _jsx(Markdown, { text: m.content }) }), m.to_board_id ? (_jsxs("div", { className: "mono mt-1 text-step--2 text-[var(--faint)]", children: ["To board: ", m.to_board_id.slice(0, 14), "\u2026"] })) : null] }, m.id))) })) : (_jsx(EmptyState, { title: "No sent messages", hint: "Compose a message above to send to another board." })), _jsx("h3", { className: "mt-5 mb-2 text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Inbox (to this board)" }), inbox.length > 0 ? (_jsx("div", { className: "flex flex-col gap-2", children: inbox.map((m) => (_jsxs("div", { className: "rounded-xl border border-[var(--border)] border-l-2 border-l-[var(--accent)] bg-[var(--surface)] px-4 py-3", children: [_jsxs("div", { className: "mono text-step--2 text-[var(--faint)]", children: [m.kind, " \u00B7 from ", m.from_teammate_id ? m.from_teammate_id.slice(0, 14) : "system", " \u00B7", " ", m.created_at.slice(0, 16)] }), _jsx("div", { className: "mt-1 text-step--1 text-[var(--text-soft)]", children: _jsx(Markdown, { text: m.content }) })] }, m.id))) })) : (_jsx(EmptyState, { title: "Inbox empty", hint: "Messages sent to this board appear here." }))] })] }));
}
/**
 * Plan-review flow: `preview` asks the model for a plan with no side effects;
 * the human edits it here; posting the reviewed plan back materializes exactly
 * that plan (no second model call). Gated bot callers answer 403/409 with the
 * server's message — a pending approval is surfaced so the operator can
 * approve it under the project's Approvals tab and retry.
 */
function DecomposeModal({ boardId, onDone }) {
    const [objective, setObjective] = useState("");
    const [plan, setPlan] = useState(null);
    const [error, setError] = useState(null);
    const [needsApproval, setNeedsApproval] = useState(false);
    const [busy, setBusy] = useState(null);
    const fail = (err) => {
        if (err instanceof ApiError) {
            setError(err.detail);
            setNeedsApproval(err.approval !== undefined);
        }
        else {
            setError(err instanceof Error ? err.message : String(err));
        }
        notifyError(err);
    };
    const preview = async () => {
        if (!objective.trim() || busy)
            return;
        setBusy("preview");
        setError(null);
        setNeedsApproval(false);
        try {
            const result = await api.decomposeBoard(boardId, { objective, preview: true });
            setPlan(result.plan);
        }
        catch (err) {
            fail(err);
        }
        finally {
            setBusy(null);
        }
    };
    const materialize = async () => {
        if (!plan || busy)
            return;
        setBusy("materialize");
        setError(null);
        setNeedsApproval(false);
        try {
            await api.decomposeBoard(boardId, { objective, plan, create_board: true });
            onDone();
        }
        catch (err) {
            fail(err);
        }
        finally {
            setBusy(null);
        }
    };
    const editTask = (idx, field, value) => {
        setPlan((prev) => {
            if (!prev)
                return prev;
            return {
                ...prev,
                tasks: prev.tasks.map((task, i) => {
                    if (i !== idx)
                        return task;
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
    return (_jsxs(Modal, { title: "Decompose objective: review the plan first", onClose: onDone, children: [_jsxs("label", { className: "mb-4 flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 font-medium text-[var(--text)]", children: "Objective" }), _jsx("textarea", { rows: 2, value: objective, onChange: (e) => setObjective(e.target.value), placeholder: "Ship the login flow: implement, test, and document it", className: `${FORM_INPUT} resize-y` })] }), _jsxs("div", { className: "mb-3 flex flex-wrap items-center gap-3", children: [_jsx(Button, { variant: "primary", onClick: () => void preview(), disabled: busy !== null || !objective.trim(), children: busy === "preview" ? "Planning…" : plan ? "Re-plan" : "Preview plan" }), _jsx("span", { className: "text-step--2 text-[var(--faint)]", children: "Preview creates nothing. You review before any task exists." })] }), error ? (_jsxs("div", { className: "mb-3 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]", role: "alert", children: [error, needsApproval ? (_jsxs("div", { className: "mt-1.5", children: ["Owner approval is pending: approve it in the project's", " ", _jsx("strong", { children: "Approvals" }), " tab, then run this again."] })) : null] })) : null, plan ? (_jsxs("div", { children: [_jsxs("div", { className: "mb-2 flex items-center justify-between", children: [_jsxs("strong", { className: "text-[var(--text)]", children: ["Reviewed plan (", plan.tasks.length, " step", plan.tasks.length === 1 ? "" : "s", ")"] }), _jsx(Button, { onClick: () => setPlan({ ...plan, tasks: [...plan.tasks, { description: "", command: "", depends_on: [] }] }), children: "Add step" })] }), _jsx("div", { className: "flex max-h-80 flex-col gap-2 overflow-y-auto", children: plan.tasks.map((task, idx) => (_jsxs("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsxs("span", { className: "mono text-step--2 text-[var(--faint)]", children: ["step ", idx, task.depends_on.length > 0 ? ` · after ${task.depends_on.join(", ")}` : ""] }), _jsx(Button, { variant: "danger", onClick: () => setPlan({ ...plan, tasks: plan.tasks.filter((_, i) => i !== idx) }), children: "Remove" })] }), _jsx("input", { value: task.description, onChange: (e) => editTask(idx, "description", e.target.value), placeholder: "What this step does", "aria-label": `Step ${idx} description`, className: `${FORM_INPUT} mt-1.5` }), _jsxs("div", { className: "mt-1.5 flex gap-2", children: [_jsx("input", { className: `${FORM_INPUT} mono flex-1`, value: task.command, onChange: (e) => editTask(idx, "command", e.target.value), placeholder: "command (empty = coordination step)", "aria-label": `Step ${idx} command` }), _jsx("input", { className: `${FORM_INPUT} mono w-36`, value: task.depends_on.join(", "), onChange: (e) => editTask(idx, "depends_on", e.target.value), placeholder: "after: 0, 1", "aria-label": `Step ${idx} dependencies` })] })] }, idx))) }), _jsxs("div", { className: "mt-3 flex flex-wrap items-center gap-3", children: [_jsx(Button, { variant: "primary", onClick: () => void materialize(), disabled: busy !== null || plan.tasks.length === 0, children: busy === "materialize" ? "Creating…" : "Approve & create tasks" }), _jsx("span", { className: "text-step--2 text-[var(--faint)]", children: "Creates exactly these steps. No second model call." })] })] })) : null] }));
}
