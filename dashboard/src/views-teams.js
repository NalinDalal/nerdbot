import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import { EmptyState, ErrorState, LoadingState, Modal, Button, SectionLabel, BotChip, StatusBadge, Page, PageHeader, useAsync, taskStatusLabel, taskTally, TABLE_SHELL, TABLE_TD, TABLE_TH, } from "./components";
import { navigate } from "./app";
import { EntityForm } from "./forms";
function openBot(id) {
    navigate(`/bot/${id}`);
}
function TeamStatusPill({ status }) {
    const archived = status === "archived";
    return (_jsx("span", { className: `inline-flex items-center rounded-full px-2 py-0.5 text-step--2 ${archived
            ? "bg-[var(--surface-3)] text-[var(--muted)]"
            : "bg-[var(--success-bg,rgba(16,185,129,0.12))] text-[var(--success,#059669)]"}`, children: archived ? "Archived" : "Active" }));
}
export function TeamsView() {
    const [mode, setMode] = useState("active");
    const list = useAsync(() => api.listTeams(mode), [mode]);
    const [showCreate, setShowCreate] = useState(false);
    const createTeam = async (values) => {
        try {
            await api.createTeam(values);
            setShowCreate(false);
            list.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    return (_jsxs(Page, { width: "data", children: [_jsx(PageHeader, { eyebrow: "Advanced", title: "Teams", description: "Group workspaces for a shared roll-up. Membership grants no permissions.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { variant: mode === "active" ? "default" : "ghost", onClick: () => setMode("active"), children: "Active" }), _jsx(Button, { variant: mode === "archived" ? "default" : "ghost", onClick: () => setMode("archived"), children: "Archived" }), _jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "New team" }), _jsx(Button, { onClick: list.reload, children: "Refresh" })] }) }), showCreate ? (_jsx(Modal, { title: "New team", onClose: () => setShowCreate(false), children: _jsx(EntityForm, { submitLabel: "Create team", fields: [
                        { name: "name", label: "Name", required: true, placeholder: "platform" },
                        { name: "description", label: "Description", placeholder: "What this team owns" },
                    ], onSubmit: createTeam }) })) : null, list.loading ? (_jsx(LoadingState, {})) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : list.data && list.data.teams.length > 0 ? (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full min-w-[640px] table-fixed", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: `${TABLE_TH} w-[42%]`, children: "Team" }), _jsx("th", { className: `${TABLE_TH} w-[7rem]`, children: "Status" }), _jsx("th", { className: `${TABLE_TH} w-[7rem]`, children: "Bots" }), _jsx("th", { className: `${TABLE_TH} w-[8rem]`, children: "Workspaces" }), _jsx("th", { className: `${TABLE_TH} w-[6rem]`, children: _jsx("span", { className: "sr-only", children: "Open" }) })] }) }), _jsx("tbody", { children: list.data.teams.map((team) => {
                                const count = (list.data?.counts ?? {})[team.id];
                                return (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsxs("td", { className: TABLE_TD, children: [_jsx("button", { onClick: () => navigate(`/team/${team.id}`), className: "text-left font-medium text-[var(--text)] hover:underline", children: team.name || "Unnamed team" }), team.description ? (_jsx("div", { className: "text-step--1 text-[var(--muted)]", children: team.description })) : null] }), _jsx("td", { className: TABLE_TD, children: _jsx(TeamStatusPill, { status: team.status }) }), _jsx("td", { className: TABLE_TD, children: count?.bots ?? 0 }), _jsx("td", { className: TABLE_TD, children: count?.workspaces ?? 0 }), _jsx("td", { className: TABLE_TD, children: _jsx(Button, { variant: "ghost", onClick: () => navigate(`/team/${team.id}`), children: "Open \u2192" }) })] }, team.id));
                            }) })] }) })) : (_jsx(EmptyState, { title: mode === "archived" ? "No archived teams" : "No active teams", hint: mode === "archived"
                    ? "Archived teams will appear here. You can restore or delete them from the team page."
                    : "Create a team to group bots and workspaces around a purpose, then assign bots to tasks and hand work off between them.", action: mode === "active" ? (_jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "Create your first team" })) : undefined }))] }));
}
function teamRollup(members) {
    const entry = {
        running: 0, queued: 0, blocked: 0, done: 0, failed: 0, awaiting: 0, handoffs: [],
    };
    const ownerByTaskId = new Map();
    for (const member of members) {
        for (const task of member.tasks) {
            ownerByTaskId.set(task.id, { id: member.id, persona: member.persona, face: member.face });
        }
    }
    const tally = taskTally(members.flatMap((member) => member.tasks));
    entry.running = tally.running;
    entry.queued = tally.queued;
    entry.blocked = tally.blocked;
    entry.awaiting = tally.awaiting;
    entry.done = tally.done;
    entry.failed = tally.failed;
    for (const member of members) {
        for (const task of member.tasks) {
            if (task.parent_task_id) {
                const parent = ownerByTaskId.get(task.parent_task_id);
                if (parent && parent.id !== member.id) {
                    entry.handoffs.push({
                        fromId: parent.id, fromPersona: parent.persona, fromFace: parent.face,
                        toId: member.id, toPersona: member.persona, toFace: member.face, child: task,
                    });
                }
            }
        }
    }
    return entry;
}
function OpenTaskLink({ projectId, taskId, children }) {
    return (_jsx("button", { className: "text-[var(--accent)] hover:underline", onClick: () => navigate(`/p/${projectId}/t/${taskId}`), children: children }));
}
export function TeamDetailView({ teamId, }) {
    const detail = useAsync(() => api.getTeam(teamId), [teamId]);
    const allBots = useAsync(() => api.listAllTeammates(), []);
    const [attachProjectId, setAttachProjectId] = useState("");
    const [showEdit, setShowEdit] = useState(false);
    const memberTasks = useAsync(async () => {
        if (!detail.data)
            return [];
        const mats = detail.data.teammates ?? [];
        const pairs = await Promise.all(mats.map(async (bot) => ({
            id: bot.id,
            persona: bot.persona || "Unnamed bot",
            face: bot.face ?? null,
            tasks: (await api.teammateTasks(bot.id).then((r) => r.tasks).catch(() => [])),
        })));
        return pairs;
    }, [detail.data]);
    const attachProject = async () => {
        const id = attachProjectId.trim();
        if (!id)
            return;
        try {
            await api.addTeamProject(teamId, id);
            setAttachProjectId("");
            detail.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    if (detail.loading)
        return _jsx(LoadingState, { lines: 3 });
    if (detail.error || !detail.data) {
        return (_jsx(Page, { children: _jsx(ErrorState, { error: detail.error ?? "Team not found", onRetry: detail.reload }) }));
    }
    const { team, projects, teammates = [], members } = detail.data;
    const archived = team.status === "archived";
    const memberBotIds = new Set(teammates.map((t) => t.id));
    const addable = (allBots.data?.teammates ?? []).filter((b) => !memberBotIds.has(b.id));
    const rollup = memberTasks.data ? teamRollup(memberTasks.data) : null;
    const onSaveEdit = async (values) => {
        try {
            await api.updateTeam(teamId, { name: values.name ?? "", description: values.description ?? "" });
            setShowEdit(false);
            detail.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    return (_jsxs(Page, { children: [_jsx(PageHeader, { eyebrow: "Team", title: team.name || "Unnamed team", description: team.description, back: { label: "Teams", onClick: () => { navigate("/teams"); } }, actions: _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(TeamStatusPill, { status: team.status }), _jsx(Button, { onClick: () => setShowEdit(true), disabled: false, children: "Edit" }), archived ? (_jsx(Button, { onClick: async () => {
                                try {
                                    await api.restoreTeam(teamId);
                                    detail.reload();
                                }
                                catch (e) {
                                    notifyError(e);
                                }
                            }, children: "Restore" })) : (_jsx(Button, { onClick: async () => {
                                if (window.confirm(`Archive team "${team.name || team.id}"? It will be hidden from active team lists and cannot receive new members while archived.`)) {
                                    try {
                                        await api.archiveTeam(teamId);
                                        detail.reload();
                                    }
                                    catch (e) {
                                        notifyError(e);
                                    }
                                }
                            }, children: "Archive" })), _jsx(Button, { variant: "danger", onClick: async () => {
                                if (window.confirm(`Delete team "${team.name || team.id}"? This removes the team grouping and its membership associations, but does not delete bots, workspaces, boards, tasks, runs, or history.`)) {
                                    try {
                                        await api.deleteTeam(teamId);
                                        navigate("/teams");
                                    }
                                    catch (e) {
                                        notifyError(e);
                                    }
                                }
                            }, children: "Delete" }), _jsx(Button, { onClick: detail.reload, children: "Refresh" })] }) }), showEdit ? (_jsx(Modal, { title: "Edit team", onClose: () => setShowEdit(false), children: _jsx(EntityForm, { submitLabel: "Save changes", fields: [
                        { name: "name", label: "Name", required: true, placeholder: team.name || "platform" },
                        { name: "description", label: "Description", placeholder: team.description || "What this team owns" },
                    ], onSubmit: onSaveEdit }) })) : null, archived ? (_jsx("div", { className: "mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-step--1 text-[var(--muted)]", children: "This team is archived. Membership and history are preserved, but new workspace/bot members cannot be added until it is restored." })) : null, _jsxs("section", { className: "mb-8", children: [_jsx(SectionLabel, { className: "mb-2", children: "Execution rollup" }), _jsx("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4", children: rollup ? (_jsxs("div", { className: "flex flex-col gap-4", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2 text-step--1", children: [_jsx(StatusBadge, { status: "running", label: `${rollup.running} running` }), _jsx(StatusBadge, { status: "pending", label: `${rollup.queued} queued` }), rollup.awaiting > 0 && (_jsx(StatusBadge, { status: "awaiting_approval", label: `${rollup.awaiting} awaiting approval` })), rollup.blocked > 0 && _jsx(StatusBadge, { status: "blocked", label: `${rollup.blocked} blocked` }), _jsx(StatusBadge, { status: "done", label: `${rollup.done} completed` }), rollup.failed > 0 && _jsx(StatusBadge, { status: "failed", label: `${rollup.failed} failed` })] }), rollup.handoffs.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Agent-to-agent handoffs" }), _jsx("div", { className: "mt-1.5 flex flex-col gap-1.5", children: rollup.handoffs.map(({ fromPersona, fromFace, toPersona, toFace, child }) => (_jsxs("div", { className: "flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1", children: [_jsx(BotChip, { persona: fromPersona, id: fromPersona, status: "done", face: fromFace }), _jsx("span", { className: "text-[var(--faint)]", "aria-hidden": true, children: "\u2192" }), _jsx(BotChip, { persona: toPersona, id: toPersona, status: child.status, face: toFace }), _jsx("span", { className: "text-[var(--muted)]", children: "delegated:" }), _jsx("span", { className: "truncate text-[var(--text-soft)]", children: child.description }), _jsxs("span", { className: "ml-auto flex items-center gap-2", children: [_jsx(StatusBadge, { status: child.status, label: taskStatusLabel(child.status) }), _jsx(OpenTaskLink, { projectId: child.project_id, taskId: child.id, children: "open \u2192" })] })] }, `${child.id}`))) })] })), rollup.running === 0 && rollup.queued === 0 && rollup.blocked === 0 && rollup.handoffs.length === 0 && (_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "Nothing in flight for this team right now." }))] })) : (_jsx(LoadingState, { lines: 2 })) })] }), _jsxs("section", { className: "mb-8", children: [_jsx(SectionLabel, { className: "mb-2", children: "Bots in this team" }), _jsx("p", { className: "mb-3 max-w-[72ch] text-step--1 text-[var(--muted)]", children: "These bots share the team\u2019s workspaces and hand tasks off to one another. Membership grants no permissions. Each bot acts within its own configured tool permissions." }), teammates.length > 0 ? (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: teammates.map((bot, index) => (_jsxs("div", { className: `flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx(BotChip, { persona: bot.persona || "Unnamed bot", id: bot.id, status: bot.status, face: bot.face }), _jsx("div", { className: "mt-1 truncate text-step--2 text-[var(--faint)]", title: bot.instructions || "", children: bot.instructions?.slice(0, 110) || "No instructions" })] }), _jsx("div", { className: "mono max-w-[220px] truncate text-step--2 text-[var(--faint)]", title: bot.permissions.join(", "), children: bot.permissions.length > 0 ? `${bot.permissions.length} perms` : "no perms" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Button, { variant: "ghost", onClick: () => openBot(bot.id), children: "Open" }), _jsx(Button, { variant: "danger", onClick: () => {
                                                if (window.confirm(`Remove bot ${bot.persona || bot.id} from this team? This does not delete the bot or its workspace memberships.`)) {
                                                    void api.removeTeamTeammate(teamId, bot.id).then(() => detail.reload()).catch(notifyError);
                                                }
                                            }, children: "Remove" })] })] }, bot.id))) })) : (_jsx(EmptyState, { title: "No bots in this team", hint: "Add bots to group them into a fleet around a purpose or workflow." })), _jsxs("div", { className: "mt-3 flex items-center gap-3", children: [_jsxs("select", { value: "", disabled: archived, onChange: (e) => {
                                    const id = e.target.value;
                                    if (!id)
                                        return;
                                    void api.addTeamTeammate(teamId, id).then(() => { detail.reload(); allBots.reload(); }).catch(notifyError);
                                }, "aria-label": "Bot to add", className: "max-w-xs rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] disabled:opacity-50", children: [_jsx("option", { value: "", children: archived ? "Restore team to add bots" : "Add a bot…" }), !archived && addable.map((bot) => (_jsxs("option", { value: bot.id, children: [bot.persona || bot.id, " (", bot.id.slice(0, 8), ")"] }, bot.id)))] }), archived ? _jsx("span", { className: "text-step--1 text-[var(--faint)]", children: "Archived teams cannot receive new members." }) : null] })] }), _jsxs("section", { className: "mb-8", children: [_jsx(SectionLabel, { className: "mb-2", children: "Workspaces in this team" }), projects.length > 0 ? (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: projects.map((project, index) => (_jsxs("div", { className: `flex items-center justify-between gap-3 px-4 py-3 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsxs("div", { className: "min-w-0", children: [_jsx("button", { className: "mono truncate font-medium text-[var(--text)] hover:underline", onClick: () => navigate(`/p/${project.id}`), children: project.repository || "workspace" }), _jsx("div", { className: "mono text-step--2 text-[var(--faint)]", children: project.id })] }), _jsx(Button, { variant: "danger", onClick: () => {
                                        if (window.confirm(`Detach workspace ${project.repository || project.id} from this team? This does not delete the workspace.`)) {
                                            void api.removeTeamProject(teamId, project.id).then(() => detail.reload()).catch(notifyError);
                                        }
                                    }, children: "Detach" })] }, project.id))) })) : (_jsx(EmptyState, { title: "No workspaces", hint: "Attach a workspace to this team so its bots and tasks belong to the team." })), _jsxs("form", { onSubmit: (e) => { e.preventDefault(); attachProject(); }, className: "mt-3 flex items-center gap-2", children: [_jsx("input", { value: attachProjectId, onChange: (e) => setAttachProjectId(e.target.value), placeholder: "prj_\u2026", "aria-label": "Project ID to attach", disabled: archived, className: "w-64 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-50" }), _jsx(Button, { type: "submit", variant: "default", disabled: archived, children: "Attach workspace" })] }), archived ? _jsx("p", { className: "mt-2 text-step--2 text-[var(--faint)]", children: "Archived teams cannot receive new workspace associations." }) : null] }), members.length > 0 ? (_jsxs("section", { children: [_jsx(SectionLabel, { className: "mb-2", children: "Membership rows" }), _jsx("div", { className: "mono rounded-xl border border-dashed border-[var(--border-dim)] px-4 py-3 text-step--2 text-[var(--faint)]", children: members.map((m) => (_jsx("div", { className: "py-0.5", children: m.teammate_id ? `bot ${m.teammate_id}` : `workspace ${m.project_id}` }, m.id))) })] })) : null] }));
}
