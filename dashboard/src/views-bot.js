import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "./api";
import { describeError, navigate, notifyError } from "./app";
import { FacePicker } from "./bot/FacePicker";
import { DEFAULT_FACE, normalizeFace, SHAPE_LABELS, COLOR_LABELS, EXPRESSION_LABELS } from "./bot/face";
import { BotAvatar } from "./bot/BotAvatar";
import { botActivity, faceStateFor } from "./bot/status";
import { EmptyState, ErrorState, LoadingState, Modal, ShortId, StatusBadge, StatusDot, BotChip, Button, SectionLabel, Page, PageHeader, relativeTime, useAsync, usePermissionCatalogue, Badge, ERROR_BOX, FORM_INPUT, FORM_SELECT, Field, TABLE_SHELL, TABLE_TD, TABLE_TH, } from "./components";
function TeammateMemorySection({ teammateId }) {
    const scope = `teammate:${teammateId}`;
    const [q, setQ] = useState("");
    const [tier, setTier] = useState("");
    const [pinnedOnly, setPinnedOnly] = useState(false);
    const [page, setPage] = useState(0);
    const [showWrite, setShowWrite] = useState(false);
    const [edit, setEdit] = useState(null);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
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
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => { void reload(); }, [teammateId, q, tier, pinnedOnly, page]);
    useEffect(() => { setPage(0); }, [q, tier, pinnedOnly, teammateId]);
    const act = async (fn) => {
        try {
            await fn();
            await reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const entries = data?.entries ?? [];
    const total = data?.total ?? entries.length;
    return (_jsxs("div", { children: [_jsx("div", { className: "mb-2 flex items-center justify-between", children: _jsx(SectionLabel, { children: "Private memory" }) }), _jsx("p", { className: "mb-3 max-w-[72ch] text-step--1 text-[var(--muted)]", children: "Only this bot reads and writes this memory. Notes here are recalled in its future runs as untrusted context with provenance." }), _jsxs("div", { className: "mb-3 flex flex-wrap items-center gap-2", children: [_jsx(Button, { variant: "primary", onClick: () => setShowWrite(true), children: "Remember something" }), _jsx(Button, { onClick: () => void reload(), children: "Refresh" }), _jsx(Button, { variant: "ghost", onClick: () => void act(() => api.pruneMemory(scope, { keep: 200 })), children: "Retention prune" }), _jsx("input", { className: `${FORM_INPUT} max-w-xs`, placeholder: "Search memories", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search teammate memories" }), _jsxs("select", { className: FORM_SELECT, value: tier, onChange: (e) => setTier(e.target.value), "aria-label": "Tier filter", children: [_jsx("option", { value: "", children: "All tiers" }), _jsx("option", { value: "raw", children: "raw" }), _jsx("option", { value: "typed", children: "typed" }), _jsx("option", { value: "wisdom", children: "wisdom" })] }), _jsxs("label", { className: "flex items-center gap-1.5 text-step--1 text-[var(--muted)]", children: [_jsx("input", { type: "checkbox", checked: pinnedOnly, onChange: (e) => setPinnedOnly(e.target.checked) }), " Pinned"] })] }), showWrite ? (_jsx(Modal, { title: "Add teammate memory", onClose: () => setShowWrite(false), children: _jsxs("form", { className: "flex flex-col gap-3", onSubmit: async (e) => {
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
                        }
                        catch (err) {
                            notifyError(err);
                        }
                    }, children: [_jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "What to remember" }), _jsx("textarea", { name: "content", className: `${FORM_INPUT} min-h-24`, required: true })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Source/provenance" }), _jsx("input", { name: "source", className: FORM_INPUT, defaultValue: "workspace" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Confidence (0\u20131)" }), _jsx("input", { name: "confidence", className: FORM_INPUT, defaultValue: "0.8" })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Tier" }), _jsxs("select", { name: "tier", className: FORM_SELECT, defaultValue: "raw", children: [_jsx("option", { value: "raw", children: "raw" }), _jsx("option", { value: "typed", children: "typed" }), _jsx("option", { value: "wisdom", children: "wisdom" })] })] })] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx(Button, { type: "button", onClick: () => setShowWrite(false), children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", children: "Save" })] })] }) })) : null, edit ? (_jsx(Modal, { title: "Edit memory", onClose: () => setEdit(null), children: _jsxs("form", { className: "flex flex-col gap-3", onSubmit: async (e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); try {
                        await api.patchMemory(edit.id, { content: String(fd.get("content") || ""), source: String(fd.get("source") || "") });
                        setEdit(null);
                        await reload();
                        toast.success("Memory corrected");
                    }
                    catch (err) {
                        notifyError(err);
                    } }, children: [_jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Content" }), _jsx("textarea", { name: "content", className: `${FORM_INPUT} min-h-24`, defaultValue: edit.content })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Source" }), _jsx("input", { name: "source", className: FORM_INPUT, defaultValue: edit.source })] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx(Button, { type: "button", onClick: () => setEdit(null), children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", children: "Save correction" })] })] }) })) : null, loading ? _jsx(LoadingState, { lines: 3 }) : error ? _jsx(ErrorState, { error: error, onRetry: () => void reload() }) : entries.length === 0 ? (_jsx(EmptyState, { title: "No memories", hint: "Search, pin important facts, correct mistakes, or delete entries. Scoped memories are untrusted context when recalled." })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "flex flex-col gap-2", children: entries.map((entry) => (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsxs("div", { className: "flex flex-wrap items-start justify-between gap-2", children: [_jsx("div", { className: "min-w-0 flex-1 whitespace-pre-wrap text-step--1 text-[var(--text-soft)]", children: entry.content }), _jsxs("div", { className: "flex shrink-0 flex-wrap gap-1.5", children: [entry.pinned ? _jsx(Badge, { variant: "info", children: "pinned" }) : null, entry.corrected ? _jsx(Badge, { variant: "warn", children: "corrected" }) : null, _jsx(Badge, { variant: "neutral", children: entry.tier || "raw" })] })] }), _jsxs("div", { className: "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-step--2 text-[var(--faint)]", children: [_jsxs("span", { children: ["Source: ", _jsx("span", { className: "text-[var(--muted)]", children: entry.source || "unknown" })] }), _jsxs("span", { children: ["Confidence: ", typeof entry.confidence === "number" ? entry.confidence.toFixed(2) : entry.confidence] }), _jsxs("span", { children: ["Scope: ", _jsx("span", { className: "mono", children: entry.scope })] }), _jsx("span", { className: "mono", children: entry.id })] }), _jsxs("div", { className: "mt-2 flex flex-wrap gap-2", children: [_jsx(Button, { onClick: () => void act(() => api.patchMemory(entry.id, { pinned: !entry.pinned })), children: entry.pinned ? "Unpin" : "Pin" }), _jsx(Button, { onClick: () => setEdit(entry), children: "Correct" }), _jsx(Button, { variant: "danger", onClick: () => { if (confirm("Delete this memory?"))
                                                void act(() => api.deleteMemory(entry.id)); }, children: "Delete" })] })] }, entry.id))) }), _jsxs("div", { className: "mt-3 flex items-center justify-between text-step--2 text-[var(--muted)]", children: [_jsxs("span", { children: [total, " total"] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { disabled: page === 0, onClick: () => setPage((p) => Math.max(0, p - 1)), children: "Prev" }), _jsx(Button, { disabled: (page + 1) * limit >= total, onClick: () => setPage((p) => p + 1), children: "Next" })] })] })] }))] }));
}
function openTask(projectId, taskId) {
    navigate(`/p/${projectId}/t/${taskId}`);
}
export function BotDetailView({ teammateId, }) {
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
    const providers = useAsync(() => mateProjectId
        ? api.listProviders(mateProjectId).then((result) => result.providers)
        : Promise.resolve([]), [mateProjectId]);
    const [showCreateTask, setShowCreateTask] = useState(false);
    const [taskDescription, setTaskDescription] = useState("");
    const [taskCommand, setTaskCommand] = useState("");
    const [createTaskBusy, setCreateTaskBusy] = useState(false);
    const [showFace, setShowFace] = useState(false);
    const [faceDraft, setFaceDraft] = useState(DEFAULT_FACE);
    const [faceBusy, setFaceBusy] = useState(false);
    const catalogue = usePermissionCatalogue();
    const [showEdit, setShowEdit] = useState(false);
    const [editPersona, setEditPersona] = useState("");
    const [editName, setEditName] = useState("");
    const [editInstructions, setEditInstructions] = useState("");
    const [editProviderId, setEditProviderId] = useState("");
    const [editMemoryScope, setEditMemoryScope] = useState("project");
    const [editPerms, setEditPerms] = useState([]);
    const [editBusy, setEditBusy] = useState(false);
    const [confirmStatus, setConfirmStatus] = useState(null);
    const [statusBusy, setStatusBusy] = useState(false);
    const [section, setSection] = useState("overview");
    const openEditor = () => {
        if (!mate)
            return;
        setEditPersona(mate.persona ?? "");
        setEditName(mate.name ?? "");
        setEditInstructions(mate.instructions ?? "");
        setEditProviderId(mate.provider_id ?? "");
        setEditMemoryScope(mate.memory_scope || "project");
        setEditPerms(mate.permissions ?? []);
        setShowEdit(true);
    };
    const saveEdit = async (e) => {
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
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setEditBusy(false);
        }
    };
    const duplicate = async () => {
        if (!mate)
            return;
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
        }
        catch (err) {
            notifyError(err);
        }
    };
    const applyStatus = async () => {
        if (!confirmStatus || !mate)
            return;
        setStatusBusy(true);
        try {
            if (confirmStatus === "disable")
                await api.disableTeammate(teammateId);
            else
                await api.archiveTeammate(teammateId);
            setConfirmStatus(null);
            all.reload();
            toast.success(confirmStatus === "disable" ? "Teammate disabled." : "Teammate archived.");
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setStatusBusy(false);
        }
    };
    const claim = async (taskId) => {
        try {
            await api.claimTask(taskId, teammateId);
            tasks.reload();
            runs.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    if (all.loading || tasks.loading || runs.loading || boards.loading || persona.loading) {
        return _jsx(LoadingState, { lines: 4 });
    }
    if (all.error || tasks.error || runs.error || boards.error) {
        return (_jsx(Page, { children: _jsx(ErrorState, { error: all.error ?? tasks.error ?? runs.error ?? boards.error ?? "Bot not found", onRetry: all.reload }) }));
    }
    const allMates = all.data.teammates;
    const mate = allMates.find((m) => m.id === teammateId);
    if (!mate) {
        return (_jsx(Page, { children: _jsx(EmptyState, { title: "Bot not found", hint: "" }) }));
    }
    const taskList = tasks.data.tasks;
    const runList = runs.data.runs;
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
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setFaceBusy(false);
        }
    };
    return (_jsxs(Page, { children: [_jsxs("div", { className: "mb-8", children: [_jsxs("button", { onClick: () => {
                            navigate("/bots");
                        }, className: "mb-3 inline-flex items-center gap-1 text-step--1 text-[var(--muted)] transition-colors hover:text-[var(--text)]", children: [_jsx("span", { "aria-hidden": true, children: "\u2190" }), " Team"] }), _jsxs("div", { className: "flex flex-wrap items-start gap-4", children: [_jsx(BotAvatar, { face: mate.face, size: 64, animated: true, follow: true, state: faceStateFor(activity), label: `The face of ${mate.name || mate.persona || "this bot"}` }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "mb-1 text-step--2 uppercase tracking-[0.16em] text-[var(--faint)]", children: [_jsx("a", { href: "/bots", className: "hover:text-[var(--text)]", children: "Teammates" }), " ", "/ Teammate"] }), _jsx("h1", { className: "text-step-1 font-semibold tracking-tight text-[var(--text)]", children: mate.name || mate.persona || "Unnamed teammate" }), _jsxs("div", { className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-step--1 text-[var(--muted)]", children: [_jsx(StatusDot, { status: mate.status, label: mate.status, pulse: mate.status === "running" }), _jsxs("span", { children: [openCount, " open task", openCount === 1 ? "" : "s"] }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsxs("span", { children: [runList.length, " runs"] }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsx("a", { href: `/p/${mate.project_id}`, className: "hover:text-[var(--text)] hover:underline", children: "Project" }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsx("span", { children: modelName || (mate.provider_id ? "Model connected" : "No model connected") })] })] }), _jsxs("div", { className: "flex shrink-0 flex-wrap items-center gap-2", children: [_jsx(Button, { variant: "primary", onClick: () => setShowCreateTask(true), children: "Give work" }), _jsx(Button, { onClick: openEditor, children: "Edit" }), _jsx(Button, { onClick: () => void duplicate(), children: "Duplicate" }), _jsx(Button, { onClick: openFaceEditor, children: "Face" }), mate.status === "active" ? (_jsx(Button, { variant: "danger", onClick: () => setConfirmStatus("disable"), children: "Disable" })) : mate.status !== "archived" ? (_jsx(Button, { variant: "danger", onClick: () => setConfirmStatus("archive"), children: "Archive" })) : null] })] })] }), _jsxs("section", { className: "mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4", children: [_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsx("div", { className: "text-step--2 text-[var(--faint)]", children: "Model" }), _jsx("div", { className: "text-step--1 font-medium text-[var(--text)]", children: modelName || (mate.provider_id ? "Connected" : "None") })] }), _jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsx("div", { className: "text-step--2 text-[var(--faint)]", children: "Memory" }), _jsx("div", { className: "text-step--1 font-medium text-[var(--text)]", children: mate.memory_scope })] }), _jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsx("div", { className: "text-step--2 text-[var(--faint)]", children: "Tasks" }), _jsx("div", { className: "text-step--1 font-medium text-[var(--text)]", children: taskList.length })] }), _jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsx("div", { className: "text-step--2 text-[var(--faint)]", children: "Runs" }), _jsx("div", { className: "text-step--1 font-medium text-[var(--text)]", children: runList.length })] })] }), _jsx("div", { role: "tablist", "aria-label": "Agent sections", className: "mb-6 flex flex-wrap gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1", children: [
                    ["overview", "Overview"],
                    ["configuration", "Configuration"],
                    ["capabilities", "Capabilities"],
                    ["memory", "Memory"],
                    ["skills", "Skills"],
                    ["work", "Work"],
                    ["activity", "Activity"],
                ].map(([id, label]) => (_jsx("button", { type: "button", role: "tab", "aria-selected": section === id, onClick: () => setSection(id), className: `rounded-md px-3 py-1.5 text-step--1 font-medium transition-colors ${section === id
                        ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                        : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"}`, children: label }, id))) }), (section === "overview" || section === "configuration") && mate.instructions ? (_jsxs("details", { className: "mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3", children: [_jsx("summary", { className: "cursor-pointer text-step--1 font-medium text-[var(--text-soft)]", children: "Instructions" }), _jsx("p", { className: "mt-3 whitespace-pre-wrap text-step-0 leading-relaxed text-[var(--text-soft)]", children: mate.instructions })] })) : null, (section === "overview" || section === "configuration") && (_jsxs("details", { className: "mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3", children: [_jsx("summary", { className: "cursor-pointer text-step--1 font-medium text-[var(--text-soft)]", children: "Persona (soul \u00B7 goals \u00B7 wisdom)" }), persona.data ? (_jsxs("div", { className: "mt-3 space-y-3 text-step-0 text-[var(--text-soft)]", children: [_jsxs("div", { children: [_jsx("div", { className: "text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Soul" }), _jsx("p", { className: "whitespace-pre-wrap", children: persona.data.soul || "—" })] }), _jsxs("div", { children: [_jsx("div", { className: "text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Goals" }), _jsx("p", { className: "whitespace-pre-wrap", children: persona.data.goals || "—" })] }), _jsxs("div", { children: [_jsx("div", { className: "text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Wisdom" }), _jsx("p", { className: "whitespace-pre-wrap", children: persona.data.wisdom || "—" })] }), _jsxs("div", { className: "text-step--2 text-[var(--faint)]", children: ["version ", persona.data.version] })] })) : (_jsx("p", { className: "mt-3 text-step--1 text-[var(--muted)]", children: "No persona loaded." }))] })), (section === "capabilities") && (_jsxs("details", { className: "mb-6", children: [_jsx("summary", { className: "mb-2 cursor-pointer text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Access and permissions" }), _jsx(BotAccess, { mate: mate, boards: boards.data.boards })] })), (section === "work" || section === "overview") && (_jsxs("section", { className: "mb-6", children: [_jsxs("div", { className: "mb-2 flex items-center justify-between", children: [_jsx(SectionLabel, { children: "Tasks" }), showCreateTask ? (_jsx(Button, { onClick: () => setShowCreateTask(false), variant: "ghost", children: "Cancel" })) : null] }), showCreateTask && (_jsxs("form", { onSubmit: async (e) => {
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
                            }
                            catch (err) {
                                notifyError(err);
                            }
                            finally {
                                setCreateTaskBusy(false);
                            }
                        }, className: "mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsx("input", { value: taskDescription, onChange: (e) => setTaskDescription(e.target.value), placeholder: "What should this bot do?", "aria-label": "Task description", required: true, autoFocus: true, className: `${FORM_INPUT} min-w-52 flex-1` }), _jsx("input", { value: taskCommand, onChange: (e) => setTaskCommand(e.target.value), placeholder: "Command (optional)", "aria-label": "Task command", className: `${FORM_INPUT} w-48` }), _jsx(Button, { variant: "primary", type: "submit", disabled: createTaskBusy || !taskDescription.trim(), children: createTaskBusy ? "Creating…" : "Create task" })] })), unclaimed && (_jsxs("div", { className: "mb-3 flex items-center gap-3 rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-step--1 text-[var(--warn)]", children: [_jsxs("span", { className: "min-w-0 flex-1 truncate", children: ["Unclaimed: ", unclaimed.description] }), _jsx(Button, { onClick: () => void claim(unclaimed.id), children: "Claim & assign to me" })] })), taskList.length > 0 ? (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: taskList.map((t, index) => (_jsxs("div", { className: `flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("button", { className: "block w-full truncate text-left font-medium text-[var(--text)] hover:underline", onClick: () => openTask(t.project_id, t.id), children: t.description || "Untitled" }), t.command ? (_jsx("div", { className: "mono truncate text-step--2 text-[var(--faint)]", children: t.command })) : null] }), _jsx(StatusBadge, { status: t.status, label: undefined }), t.status === "pending" && t.owner_teammate_id === teammateId && (_jsx(Button, { variant: "primary", title: "Run this task in the bot's isolated workspace", onClick: () => {
                                        void api
                                            .runTask(t.id)
                                            .then(() => {
                                            tasks.reload();
                                            runs.reload();
                                        })
                                            .catch(notifyError);
                                    }, children: "Run" })), _jsx(Button, { variant: "ghost", onClick: () => openTask(t.project_id, t.id), children: "Open \u2192" })] }, t.id))) })) : (_jsx(EmptyState, { title: "No tasks yet", hint: "Give this teammate something to do. It will run using its connected model.", action: _jsx(Button, { variant: "primary", onClick: () => setShowCreateTask(true), children: "Give work" }) }))] })), (section === "activity" || section === "overview") && (_jsxs("section", { className: "mb-6", children: [_jsx(SectionLabel, { className: "mb-2", children: "Runs" }), runList.length > 0 ? (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: runList.slice(0, 20).map((r, index) => (_jsxs("div", { className: `flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsx(StatusDot, { status: r.status, pulse: r.status === "running", label: undefined }), _jsx("button", { className: "min-w-0 flex-1 truncate text-left text-step--1 text-[var(--muted)] hover:text-[var(--text)]", onClick: () => openTask(mate.project_id, r.task_id), title: "Open task", children: taskList.find((t) => t.id === r.task_id)?.description?.trim() || "Task" }), _jsxs("span", { className: "mono text-step--2 text-[var(--faint)]", children: ["exit ", r.exit_code ?? "—"] }), _jsxs("span", { className: "mono text-step--2 text-[var(--faint)]", children: [Number(r.duration_s ?? 0).toFixed(1), "s"] }), _jsx("span", { className: "mono text-step--2 text-[var(--faint)]", children: relativeTime(r.started_at) })] }, r.id))) })) : (_jsx(EmptyState, { title: "No runs", hint: "Runs appear here when this bot executes a task." }))] })), (section === "memory" || section === "overview") && (_jsx("section", { children: _jsx(TeammateMemorySection, { teammateId: teammateId }) })), (section === "skills" || section === "overview") && (_jsxs("section", { children: [_jsx("div", { className: "mb-2 flex items-center justify-between", children: _jsx(SectionLabel, { children: "Skills" }) }), _jsx("p", { className: "mb-3 max-w-[72ch] text-step--1 text-[var(--muted)]", children: "Reusable instruction packs attached to this teammate. Skills add context/instructions when resolved; they never widen permissions (gates and tool policy still apply)." }), skills.loading ? _jsx(LoadingState, { lines: 2 }) : skills.error ? _jsx(ErrorState, { error: skills.error, onRetry: skills.reload }) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-3 flex flex-wrap items-center gap-2", children: [_jsxs("select", { className: `${FORM_INPUT} max-w-sm`, defaultValue: "", "aria-label": "Attach skill", onChange: async (e) => {
                                            const skillId = e.target.value;
                                            if (!skillId)
                                                return;
                                            try {
                                                await api.attachSkill(teammateId, skillId);
                                                skills.reload();
                                                toast.success("Skill attached");
                                            }
                                            catch (err) {
                                                notifyError(err);
                                            }
                                            e.target.value = "";
                                        }, children: [_jsx("option", { value: "", children: "Attach a skill\u2026" }), (allSkills.data?.skills || []).filter((sk) => !(skills.data?.skills || []).some((a) => a.skill_id === sk.id)).map((sk) => (_jsxs("option", { value: sk.id, children: [sk.name, " (v", sk.version, ")"] }, sk.id)))] }), _jsx(Button, { onClick: () => { const name = prompt("Skill name"); if (!name)
                                            return; const instructions = prompt("Instructions (what this skill teaches the teammate)"); if (!instructions)
                                            return; void api.createSkill({ name, instructions, description: "", scope: "owner" }).then(() => { allSkills.reload(); toast.success("Skill created"); }).catch(notifyError); }, children: "New skill" })] }), (skills.data?.skills || []).length === 0 ? (_jsx(EmptyState, { title: "No skills attached", hint: "Create or attach a skill to give this teammate reusable instructions." })) : (_jsx("div", { className: "flex flex-col gap-2", children: (skills.data?.skills || []).map((s) => (_jsx("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3", children: _jsxs("div", { className: "flex flex-wrap items-start justify-between gap-2", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "font-medium text-[var(--text)]", children: [s.name, " ", _jsxs("span", { className: "text-step--2 font-normal text-[var(--faint)]", children: ["v", s.version, " \u00B7 ", s.scope] })] }), s.description ? _jsx("div", { className: "mt-0.5 text-step--1 text-[var(--muted)]", children: s.description }) : null, _jsxs("div", { className: "mt-1 text-step--2 text-[var(--faint)]", children: ["Active when attached and enabled. Required permissions (enforced, not granted): ", (s.required_permissions || []).join(", ") || "none"] })] }), _jsx("div", { className: "flex gap-2", children: _jsx(Button, { variant: "danger", onClick: () => void api.detachSkill(teammateId, s.skill_id).then(() => { skills.reload(); toast.success("Detached"); }).catch(notifyError), children: "Detach" }) })] }) }, s.skill_id || s.attachment_id))) }))] }))] })), showFace ? (_jsxs(Modal, { title: "Change face", onClose: () => setShowFace(false), children: [_jsx(FacePicker, { value: faceDraft, onChange: setFaceDraft, compact: true }), _jsxs("div", { className: "mt-5 flex items-center justify-end gap-2", children: [_jsx(Button, { onClick: () => setShowFace(false), children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => void saveFace(), disabled: faceBusy, children: faceBusy ? "Saving…" : "Save face" })] })] })) : null, showEdit ? (_jsx(Modal, { title: "Edit teammate", onClose: () => setShowEdit(false), children: _jsxs("form", { onSubmit: saveEdit, className: "flex flex-col gap-3", children: [_jsxs(Field, { label: "Display name (shown in chat)", children: [_jsx("input", { value: editName, onChange: (e) => setEditName(e.target.value), placeholder: "Research Analyst", className: FORM_INPUT }), _jsx("p", { className: "text-step--1 text-[var(--faint)]", children: "What the conversation shows next to this bot\u2019s face. Its @mention handle follows the name when it has no slug yet." })] }), _jsx(Field, { label: "Persona", children: _jsx("input", { value: editPersona, onChange: (e) => setEditPersona(e.target.value), required: true, className: FORM_INPUT }) }), _jsx(Field, { label: "Instructions", children: _jsx("textarea", { value: editInstructions, onChange: (e) => setEditInstructions(e.target.value), rows: 4, className: `${FORM_INPUT} resize-y` }) }), _jsx(Field, { label: "Model provider", children: _jsxs("select", { value: editProviderId, onChange: (e) => setEditProviderId(e.target.value), className: FORM_INPUT, children: [_jsx("option", { value: "", children: "Project default" }), (providers.data ?? []).map((provider) => (_jsxs("option", { value: provider.id, children: [provider.name, " (", provider.kind, ")"] }, provider.id)))] }) }), _jsx(Field, { label: "Memory scope", children: _jsxs("select", { value: editMemoryScope, onChange: (e) => setEditMemoryScope(e.target.value), className: FORM_INPUT, children: [_jsx("option", { value: "project", children: "Project (shared with the workspace)" }), _jsx("option", { value: "private", children: "Private (this teammate only)" })] }) }), _jsx(Field, { label: "Permissions", children: _jsx("div", { className: "max-h-56 overflow-y-auto rounded-md border border-[var(--border)] p-2", children: catalogue.permissions.length === 0 ? (_jsx("p", { className: "px-2 py-2 text-step--1 text-[var(--faint)]", children: "No permission catalogue reported by the server." })) : (_jsx("div", { className: "grid gap-1 sm:grid-cols-2", children: catalogue.permissions.map((permission) => (_jsxs("label", { className: "flex items-start gap-2 rounded px-1.5 py-1 text-step--1 text-[var(--text-soft)] hover:bg-[var(--surface-2)]", title: permission.summary, children: [_jsx("input", { type: "checkbox", checked: editPerms.includes(permission.name), onChange: (e) => setEditPerms((prev) => e.target.checked
                                                    ? [...prev, permission.name]
                                                    : prev.filter((name) => name !== permission.name)), className: "mt-0.5" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "mono block truncate", children: permission.name }), _jsx("span", { className: "block text-step--2 text-[var(--faint)]", children: permission.summary })] })] }, permission.name))) })) }) }), _jsxs("div", { className: "mt-1 flex justify-end gap-2", children: [_jsx(Button, { type: "button", onClick: () => setShowEdit(false), children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", disabled: editBusy || !editPersona.trim(), children: editBusy ? "Saving…" : "Save changes" })] })] }) })) : null, confirmStatus ? (_jsxs(Modal, { title: confirmStatus === "disable" ? "Disable teammate?" : "Archive teammate?", onClose: () => setConfirmStatus(null), children: [_jsx("p", { className: "text-step--1 text-[var(--text-soft)]", children: confirmStatus === "disable"
                            ? `${mate.name || mate.persona || "This teammate"} will stop receiving new work. Existing tasks and memory are kept.`
                            : `${mate.name || mate.persona || "This teammate"} will be archived and hidden from active work. Existing tasks and memory are kept.` }), _jsx("p", { className: "mt-2 text-step--1 text-[var(--muted)]", children: "This build has no re-enable action, so confirm only if you mean it." }), _jsxs("div", { className: "mt-4 flex justify-end gap-2", children: [_jsx(Button, { onClick: () => setConfirmStatus(null), children: "Cancel" }), _jsx(Button, { variant: "danger", onClick: () => void applyStatus(), disabled: statusBusy, children: statusBusy ? "Working…" : confirmStatus === "disable" ? "Disable" : "Archive" })] })] })) : null] }));
}
/**
 * Access grants for one bot: the permissions it holds, the ones it does not,
 * and the boards it belongs to.
 *
 * Board membership is a real server-enforced grant, not a UI-only label: the
 * owner adds and removes it through the same API the agent tools are gated by,
 * so a bot that is not a member cannot read the board even with `board.read`.
 */
function BotAccess({ mate, boards }) {
    const catalogue = usePermissionCatalogue();
    const projectBoards = boards.filter((b) => b.project_id === mate.project_id);
    const boardIds = projectBoards.map((b) => b.id).join(",");
    const members = useAsync(async () => {
        const entries = await Promise.all(projectBoards.map(async (b) => {
            const res = await api.listBoardMembers(b.id);
            return [b.id, res.members];
        }));
        return Object.fromEntries(entries);
    }, [boardIds]);
    const [addBoardId, setAddBoardId] = useState("");
    const [addRole, setAddRole] = useState("member");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
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
    const fail = (err) => {
        if (err instanceof ApiError) {
            setError(err.status === 403
                ? `Access denied: ${err.detail}`
                : `Rejected by the server: ${err.detail}`);
        }
        else {
            setError(err instanceof Error ? err.message : String(err));
        }
        notifyError(err);
    };
    const addMembership = async (e) => {
        e.preventDefault();
        if (!addBoardId)
            return;
        setBusy(true);
        setError(null);
        try {
            await api.addBoardMember(addBoardId, { teammate_id: mate.id, role: addRole });
            setAddBoardId("");
            members.reload();
        }
        catch (err) {
            fail(err);
        }
        finally {
            setBusy(false);
        }
    };
    const removeMembership = async (boardId) => {
        setBusy(true);
        setError(null);
        try {
            await api.removeBoardMember(boardId, mate.id);
            members.reload();
        }
        catch (err) {
            fail(err);
        }
        finally {
            setBusy(false);
        }
    };
    const notMemberOf = projectBoards.filter((b) => !memberships.some((m) => m.board.id === b.id));
    const inactive = mate.status !== "active";
    return (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4", children: [_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2", children: [_jsx(SectionLabel, { children: "Access" }), _jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "permissions the server enforces for this bot" })] }), _jsxs("div", { className: "mt-3", children: [_jsxs("div", { className: "mb-1.5 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]", children: ["Granted (", granted.length, ")"] }), granted.length > 0 ? (_jsx("div", { className: "flex flex-wrap gap-1.5", children: granted.map((perm) => (_jsxs("span", { tabIndex: 0, title: catalogue.isAdmin(perm)
                                ? "admin permission. Also needs the owner's exact-action approval"
                                : catalogue.byName.has(perm)
                                    ? catalogue.byName.get(perm)?.summary
                                    : "unknown permission. The server does not recognise it, so it grants nothing", className: `inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-step--2 font-medium text-[var(--text-soft)] ${catalogue.isAdmin(perm) ? "border-[var(--warn)] text-[var(--warn)]" : ""}`, children: [perm, catalogue.isAdmin(perm) ? " *" : ""] }, perm))) })) : (_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "No permissions. Every gated tool call for this bot is denied." })), unknownHeld.length > 0 ? (_jsxs("div", { className: "mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]", role: "alert", children: ["Unknown permission name(s) held by this bot: ", unknownHeld.join(", "), ". The server does not recognise them, so they grant nothing."] })) : null, granted.some((p) => catalogue.isAdmin(p)) ? (_jsx("p", { className: "mt-1.5 text-step--2 text-[var(--faint)]", children: "* admin permission: granted, but each use still needs the owner's exact-action approval." })) : null] }), _jsxs("div", { className: "mt-3", children: [_jsxs("div", { className: "mb-1.5 text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: ["Not granted (", denied.length, ")"] }), denied.length > 0 ? (_jsx("div", { className: "flex flex-wrap gap-1.5", children: denied.map((perm) => (_jsx("span", { tabIndex: 0, title: `${perm.summary}. Denied unless granted.`, className: "inline-flex items-center rounded-full border border-[var(--border-dim)] bg-[var(--surface-2)] px-2.5 py-0.5 text-step--2 font-medium text-[var(--muted)] opacity-60", children: perm.name }, perm.name))) })) : (_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "This bot holds every permission the server defines." }))] }), _jsxs("div", { className: "mt-4 border-t border-[var(--border-dim)] pt-3", children: [_jsx("div", { className: "mb-2 text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]", children: "Board membership" }), members.loading ? (_jsx(LoadingState, { lines: 1 })) : memberships.length > 0 ? (_jsx("div", { className: "flex flex-col gap-1.5", children: memberships.map(({ board, role }) => {
                            const coMembers = (members.data?.[board.id] ?? []).filter((m) => m.teammate_id !== mate.id);
                            return (_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("a", { className: "font-medium text-[var(--text)] hover:underline", href: `/board/${board.id}`, children: board.name || "Unnamed board" }), _jsx("span", { className: "mono ml-2 text-[var(--faint)]", children: role }), _jsx("div", { className: "mono text-step--2 text-[var(--faint)]", children: coMembers.length > 0
                                                    ? `${coMembers.length} co-member${coMembers.length === 1 ? "" : "s"}`
                                                    : "alone on this board" })] }), _jsx(Button, { variant: "danger", onClick: () => void removeMembership(board.id), disabled: busy, children: "Remove" })] }, board.id));
                        }) })) : (_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "Not on any board. A bot needs board membership to read a board's messages, even with the board.read permission." })), notMemberOf.length > 0 && (_jsxs("form", { onSubmit: addMembership, className: "mt-2.5 flex flex-wrap items-center gap-2", children: [_jsxs("select", { value: addBoardId, onChange: (e) => setAddBoardId(e.target.value), "aria-label": "Board to join", className: "max-w-64 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-step--1 outline-none focus:border-[var(--border-focus)]", children: [_jsx("option", { value: "", children: "(select board)" }), notMemberOf.map((b) => (_jsx("option", { value: b.id, children: b.name || "Unnamed board" }, b.id)))] }), _jsxs("select", { value: addRole, onChange: (e) => setAddRole(e.target.value), "aria-label": "Board role", className: "rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-step--1 outline-none focus:border-[var(--border-focus)]", children: [_jsx("option", { value: "member", children: "Member" }), _jsx("option", { value: "lead", children: "Lead" })] }), _jsx(Button, { variant: "primary", type: "submit", disabled: busy || !addBoardId || inactive, children: "Add to board" }), inactive ? (_jsxs("span", { className: "text-step--1 text-[var(--muted)]", children: ["This bot is ", mate.status, ". Only active bots can join a board."] })) : null] })), error ? (_jsx("div", { className: "mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]", role: "alert", children: error })) : null] })] }));
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
    const [step, setStep] = useState("identity");
    const [showCreate, setShowCreate] = useState(false);
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    // creation draft
    const [pid, setPid] = useState("");
    const [mateName, setMateName] = useState("");
    const [persona, setPersona] = useState("");
    const [instructions, setInstructions] = useState("");
    const [providerId, setProviderId] = useState("");
    const [selectedPerms, setSelectedPerms] = useState([]);
    const [memoryScope, setMemoryScope] = useState("project");
    const [face, setFace] = useState(DEFAULT_FACE);
    // give-work draft (delegate a task to a specific bot from the fleet directory)
    const [giveWorkMateId, setGiveWorkMateId] = useState("");
    const [giveWorkDesc, setGiveWorkDesc] = useState("");
    const [giveWorkCmd, setGiveWorkCmd] = useState("");
    const [giveWorkBusy, setGiveWorkBusy] = useState(false);
    const providers = useAsync(() => (pid ? api.listProviders(pid) : Promise.resolve({ providers: [] })), [pid]);
    /** Live execution status per bot so the fleet directory doubles as a
     *  workload monitor. One query per bot is fine at personal-fleet scale. */
    const botTasks = useAsync(async () => {
        const matesList = all.data?.teammates ?? [];
        const byBot = await Promise.all(matesList.map(async (m) => {
            try {
                const data = await api.teammateTasks(m.id);
                return [m.id, data.tasks];
            }
            catch {
                return [m.id, []];
            }
        }));
        return Object.fromEntries(byBot);
    }, [all.data]);
    /** Provider names, so the fleet shows which model a bot thinks with
     *  instead of a truncated provider id. */
    const providerNames = useAsync(async () => {
        const projectsList = projects.data?.projects ?? [];
        const byProject = await Promise.all(projectsList.map(async (p) => {
            try {
                const data = await api.listProviders(p.id);
                return data.providers.map((prov) => [prov.id, prov]);
            }
            catch {
                return [];
            }
        }));
        const all2 = byProject.flat();
        return Object.fromEntries(all2);
    }, [projects.data]);
    const back = () => {
        if (step === "identity")
            setStep("identity");
        else if (step === "face")
            setStep("identity");
        else if (step === "model")
            setStep("face");
        else if (step === "permissions")
            setStep("model");
        else if (step === "memory")
            setStep("permissions");
        else if (step === "review")
            setStep("memory");
    };
    const next = () => {
        if (step === "identity") {
            if (!persona.trim())
                return;
            setStep("face");
        }
        else if (step === "face") {
            setStep("model");
        }
        else if (step === "model") {
            setStep("permissions");
        }
        else if (step === "permissions") {
            setStep("memory");
        }
        else if (step === "memory") {
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
        }
        catch (err) {
            notifyError(err);
        }
    };
    const loading = all.loading || projects.loading || catalogue.loading || botTasks.loading;
    if (loading)
        return _jsx(LoadingState, { lines: 4 });
    if (all.error || projects.error || catalogue.error || botTasks.error) {
        return (_jsx(Page, { children: _jsx(ErrorState, { error: all.error ??
                    projects.error ??
                    catalogue.error ??
                    botTasks.error ??
                    "Unable to load fleet", onRetry: all.reload }) }));
    }
    const mates = all.data.teammates;
    const projList = projects.data.projects;
    const provList = providers.data?.providers ?? [];
    const projectOf = (botPid) => projList.find((p) => p.id === botPid)?.repository || botPid;
    const giveWorkSubmit = async (e) => {
        e.preventDefault();
        if (!giveWorkMateId || !giveWorkDesc.trim())
            return;
        const mate = mates.find((m) => m.id === giveWorkMateId);
        if (!mate)
            return;
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
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setGiveWorkBusy(false);
        }
    };
    const busyBots = mates.filter((mate) => {
        const tasks = botTasks.data?.[mate.id] ?? [];
        return tasks.some((t) => t.status === "running");
    }).length;
    const needle = query.trim().toLowerCase();
    const filteredMates = mates.filter((mate) => {
        if (statusFilter !== "all" && mate.status !== statusFilter)
            return false;
        if (!needle)
            return true;
        return [mate.name, mate.persona, mate.instructions, projectOf(mate.project_id)]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle));
    });
    /* Everything the two layouts (cards on a phone, table on a desktop) need,
       computed once so they cannot disagree about a teammate's state. */
    const rows = filteredMates.map((mate) => {
        const tasks = botTasks.data?.[mate.id] ?? [];
        const active = tasks.filter((t) => t.status === "pending" ||
            t.status === "running" ||
            t.status === "blocked" ||
            t.status === "awaiting_approval");
        const latest = tasks[0];
        const liveStatus = botActivity(mate.status, tasks);
        const provider = mate.provider_id
            ? providerNames.data?.[mate.provider_id]
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
    const steps = ["identity", "face", "model", "permissions", "memory", "review"];
    const stepIndex = steps.indexOf(step);
    return (_jsxs(Page, { children: [_jsx(PageHeader, { eyebrow: "Your team", title: "Teammates", description: "The AI teammates working in your workspaces. Each one has a role, model, permissions, and memory.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "New teammate" }), _jsx(Button, { onClick: all.reload, children: "Refresh" })] }) }), _jsxs("div", { className: "mb-5 flex flex-wrap items-center gap-1.5", children: [_jsxs(Badge, { variant: mates.length > 0 ? "info" : "neutral", children: [mates.length, " teammate", mates.length === 1 ? "" : "s"] }), _jsxs(Badge, { variant: busyBots > 0 ? "ok" : "neutral", children: [busyBots, " working now"] })] }), showCreate ? (_jsxs(Modal, { title: `Create teammate: ${stepName(step)}`, onClose: () => setShowCreate(false), children: [_jsx("div", { className: "mb-3 flex items-center gap-1.5", children: steps.map((s, i) => (_jsx("div", { className: `h-1 flex-1 rounded-full transition-colors ${i <= stepIndex ? "bg-[var(--accent)]" : "bg-[var(--surface-3)]"}` }, s))) }), _jsxs("div", { className: "flex flex-col gap-3", children: [step === "identity" && (_jsxs(_Fragment, { children: [_jsxs(Field, { label: "Role template (optional)", children: [_jsxs("select", { value: "", onChange: (e) => {
                                                    const t = ROLE_TEMPLATES.find((x) => x.id === e.target.value);
                                                    if (!t)
                                                        return;
                                                    setPersona(t.persona);
                                                    setInstructions(t.instructions);
                                                }, className: FORM_INPUT, children: [_jsx("option", { value: "", children: "(none \u2014 start blank)" }), ROLE_TEMPLATES.map((t) => (_jsx("option", { value: t.id, children: t.label }, t.id)))] }), _jsx("p", { className: "text-step--1 text-[var(--faint)]", children: "Prefills the persona and instructions. You can edit everything after." })] }), _jsx(Field, { label: "Project (workspace)", children: _jsxs("select", { value: pid, onChange: (e) => setPid(e.target.value), required: true, className: FORM_INPUT, children: [_jsx("option", { value: "", children: "(select project)" }), projList.map((p) => (_jsx("option", { value: p.id, children: p.repository || "workspace" }, p.id)))] }) }), _jsxs(Field, { label: "Display name (shown in chat)", children: [_jsx("input", { value: mateName, onChange: (e) => setMateName(e.target.value), placeholder: "Research Analyst", className: FORM_INPUT }), _jsx("p", { className: "text-step--1 text-[var(--faint)]", children: "The name chat shows next to the face, and the base of its @mention handle. Leave blank to fall back to the persona." })] }), _jsx(Field, { label: "Persona", children: _jsx("input", { value: persona, onChange: (e) => setPersona(e.target.value), required: true, placeholder: "engineer", className: FORM_INPUT }) }), _jsx(Field, { label: "Instructions (optional)", children: _jsx("textarea", { value: instructions, onChange: (e) => setInstructions(e.target.value), placeholder: "You are a careful engineering bot\u2026", rows: 3, className: `${FORM_INPUT} resize-y` }) })] })), step === "face" && (_jsxs(_Fragment, { children: [_jsx("p", { className: "max-w-[46ch] text-step--1 text-[var(--muted)]", children: "The face is the bot's own: it shows up wherever the bot does, so a fleet is scannable by face alone. It is yours to choose, and you can change it later." }), _jsx(FacePicker, { value: face, onChange: setFace, compact: true })] })), step === "model" && (_jsxs(Field, { label: "Model provider", children: [providers.loading ? (_jsx(LoadingState, { lines: 1 })) : providers.error ? (_jsx("div", { className: ERROR_BOX, children: describeError(providers.error) })) : provList.length === 0 ? (_jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "No providers configured for this project. Add one in the project's Providers tab, then attach it here. The bot will work without a provider until one is attached." })) : (_jsxs("select", { value: providerId, onChange: (e) => setProviderId(e.target.value), className: FORM_INPUT, children: [_jsx("option", { value: "", children: "(none, use default)" }), provList.map((pr) => (_jsxs("option", { value: pr.id, children: [pr.name, " (", pr.kind, ")"] }, pr.id)))] })), _jsx("p", { className: "text-step--1 text-[var(--faint)]", children: "Select the model connection this bot uses to think. Leave unset to use the project's default provider." })] })), step === "permissions" && (_jsxs(Field, { label: "Tools & permissions", children: [_jsx("p", { className: "mb-2 max-w-[46ch] text-step--1 text-[var(--muted)]", children: "Choose permissions from the server's canonical catalogue. Admin actions (marked with a shield) require your approval before the bot can use them." }), _jsx("div", { className: "max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2", children: catalogue.permissions.length === 0 ? (_jsx("p", { className: "p-1.5 text-step--1 text-[var(--muted)]", children: "No permissions available from the server." })) : (catalogue.permissions.map((perm) => {
                                            const held = selectedPerms.includes(perm.name);
                                            return (_jsxs("label", { className: `flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${held
                                                    ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                                                    : "border-transparent hover:bg-[var(--surface-2)]"}`, onClick: () => {
                                                    if (held) {
                                                        setSelectedPerms(selectedPerms.filter((x) => x !== perm.name));
                                                    }
                                                    else {
                                                        setSelectedPerms([...selectedPerms, perm.name]);
                                                    }
                                                }, children: [_jsx("input", { type: "checkbox", checked: held, readOnly: true, className: "h-3.5 w-3.5" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "font-medium text-[var(--text)]", children: perm.name }), _jsx("div", { className: "text-step--2 text-[var(--muted)]", children: perm.summary })] }), perm.requires_approval && _jsx(Badge, { variant: "warn", children: "approval-gated" })] }, perm.name));
                                        })) }), _jsxs("p", { className: "mt-1.5 text-step--1 text-[var(--faint)]", children: [selectedPerms.length, " selected"] })] })), step === "memory" && (_jsxs(Field, { label: "Memory scope", children: [_jsxs("select", { value: memoryScope, onChange: (e) => setMemoryScope(e.target.value), className: `${FORM_INPUT} max-w-60`, children: [_jsx("option", { value: "project", children: "Project" }), _jsx("option", { value: "private", children: "Private (this bot only)" })] }), _jsx("p", { className: "text-step--1 text-[var(--faint)]", children: "Project scope shares memory with other bots and tasks in the workspace. Private keeps it to this bot alone." })] })), step === "review" && (_jsxs("div", { className: "flex flex-col gap-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(BotAvatar, { face: face, size: 64, label: "The face this bot will wear" }), _jsx("p", { className: "text-step--1 text-[var(--muted)]", children: "This is the face the teammate will wear. You can change it at any time." })] }), _jsx("dl", { className: "flex flex-col gap-1.5 text-step--1", children: [
                                            ["Project", projList.find((p) => p.id === pid)?.repository || _jsx(ShortId, { id: pid })],
                                            ["Persona / name", persona],
                                            ["Instructions", instructions || "Not set"],
                                            ["Face", `${SHAPE_LABELS[face.shape]} · ${COLOR_LABELS[face.color]} · ${EXPRESSION_LABELS[face.expression]}`],
                                            ["Model provider", provList.find((pr) => pr.id === providerId)?.name || "(none, default)"],
                                            ["Permissions", selectedPerms.length > 0 ? selectedPerms.join(", ") : "None"],
                                            ["Memory scope", memoryScope],
                                        ].map(([key, value]) => (_jsxs("div", { className: "flex items-baseline justify-between gap-4 border-b border-[var(--border-dim)] pb-1.5 last:border-0", children: [_jsx("dt", { className: "shrink-0 text-[var(--faint)]", children: key }), _jsx("dd", { className: "truncate text-right text-[var(--text-soft)]", children: value })] }, key))) })] })), _jsxs("div", { className: "mt-2 flex items-center justify-between gap-3", children: [_jsx(Button, { onClick: back, disabled: step === "identity", children: "Back" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Button, { onClick: () => {
                                                    setShowCreate(false);
                                                    setPid("");
                                                    setPersona("");
                                                    setInstructions("");
                                                    setProviderId("");
                                                    setSelectedPerms([]);
                                                    setMemoryScope("project");
                                                    setFace(DEFAULT_FACE);
                                                    setStep("identity");
                                                }, children: "Cancel" }), step === "review" ? (_jsx(Button, { variant: "primary", onClick: () => void createBot(), disabled: !persona.trim(), children: "Create teammate" })) : (_jsx(Button, { variant: "primary", onClick: next, disabled: step === "identity" ? (!pid.trim() || !persona.trim()) : false, children: "Continue" }))] })] })] })] })) : null, mates.length > 0 ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-2", children: [_jsx("input", { value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Find a teammate", "aria-label": "Search teammates", className: `${FORM_INPUT} min-w-52 flex-1 sm:max-w-xs` }), _jsxs("select", { value: statusFilter, onChange: (e) => setStatusFilter(e.target.value), "aria-label": "Filter teammates by status", className: `${FORM_INPUT} w-auto`, children: [_jsx("option", { value: "all", children: "All statuses" }), _jsx("option", { value: "active", children: "Active" }), _jsx("option", { value: "disabled", children: "Disabled" }), _jsx("option", { value: "archived", children: "Archived" })] }), _jsxs("span", { className: "text-step--1 text-[var(--faint)]", children: [filteredMates.length, " of ", mates.length] })] }), rows.length === 0 ? (_jsx(EmptyState, { title: "No teammates match", hint: "Try a different name or status.", action: _jsx(Button, { onClick: () => { setQuery(""); setStatusFilter("all"); }, children: "Clear filters" }) })) : null, _jsx("div", { className: "grid gap-2 md:hidden", children: rows.map(({ mate, tasks, latest, liveStatus, provider, blocked }) => (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsx(BotChip, { href: `/bot/${mate.id}`, persona: mate.name || mate.persona || "Unnamed teammate", id: mate.id, status: liveStatus, face: mate.face, animated: true }), _jsx(StatusDot, { status: liveStatus, label: liveStatus === "running" ? "working" : liveStatus, pulse: liveStatus === "running" })] }), _jsxs("div", { className: "mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-step--2 text-[var(--faint)]", children: [_jsx("span", { children: projectOf(mate.project_id) }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsxs("span", { children: [provider?.name ?? "no model", " \u00B7 ", tasks.length, " task", tasks.length === 1 ? "" : "s"] })] }), latest ? (_jsxs("button", { className: "mt-2 flex w-full items-start justify-between gap-2 rounded-lg bg-[var(--surface-2)] px-2.5 py-2 text-left", onClick: () => openTask(latest.project_id, latest.id), children: [_jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block truncate text-step--1 text-[var(--text)]", children: latest.description || "Untitled task" }), blocked?.blocked_reason ? (_jsx("span", { className: "mt-0.5 block truncate text-step--2 text-[var(--warn)]", children: blocked.blocked_reason })) : null] }), _jsx(StatusBadge, { status: latest.status })] })) : (_jsx("p", { className: "mt-2 text-step--1 text-[var(--faint)]", children: "No work assigned" })), _jsxs("div", { className: "mt-3 flex items-center gap-2", children: [_jsx(Button, { variant: "primary", onClick: () => setGiveWorkMateId(mate.id), disabled: mate.status !== "active", children: "Give work" }), _jsx(Button, { onClick: () => { navigate(`/bot/${mate.id}`); }, children: "Open" })] })] }, mate.id))) }), _jsx("div", { className: `${TABLE_SHELL} hidden md:block`, children: _jsxs("table", { className: "w-full table-fixed", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: `${TABLE_TH} w-[27%]`, children: "Teammate" }), _jsx("th", { className: `${TABLE_TH} w-[5.5rem]`, children: "State" }), _jsx("th", { className: `${TABLE_TH} w-[10rem]`, children: "Model" }), _jsx("th", { className: TABLE_TH, children: "Work" }), _jsx("th", { className: `${TABLE_TH} w-[8rem]`, children: _jsx("span", { className: "sr-only", children: "Actions" }) })] }) }), _jsx("tbody", { children: rows.map(({ mate, tasks, active, latest, busy, liveStatus, provider, blocked }) => (_jsxs("tr", { className: "align-top transition-colors hover:bg-[var(--surface-2)]", children: [_jsxs("td", { className: TABLE_TD, children: [_jsx(BotChip, { href: `/bot/${mate.id}`, persona: mate.name || mate.persona || "Unnamed teammate", id: mate.id, status: liveStatus, face: mate.face, animated: true }), _jsxs("div", { className: "mt-0.5 truncate text-step--2 text-[var(--faint)]", title: `${projectOf(mate.project_id)} · ${tasks.length} tasks`, children: [projectOf(mate.project_id), " \u00B7 ", tasks.length, " task", tasks.length === 1 ? "" : "s"] })] }), _jsx("td", { className: `${TABLE_TD} whitespace-nowrap`, children: _jsx(StatusDot, { status: liveStatus, label: liveStatus === "running"
                                                        ? "working"
                                                        : liveStatus === "awaiting_approval"
                                                            ? "needs you"
                                                            : liveStatus, pulse: liveStatus === "running" }) }), _jsx("td", { className: `${TABLE_TD} whitespace-nowrap`, children: provider ? (_jsx("span", { className: "block truncate text-step--1 text-[var(--text-soft)]", title: provider.name, children: provider.name })) : (_jsx("span", { className: "text-step--1 text-[var(--warn)]", children: "no model" })) }), _jsx("td", { className: TABLE_TD, children: latest ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex min-w-0 items-center gap-2", children: [_jsx("button", { className: "min-w-0 flex-1 truncate text-left text-step--1 text-[var(--text)] hover:underline", title: latest.description, onClick: () => openTask(latest.project_id, latest.id), children: latest.description || "Untitled task" }), _jsx(StatusBadge, { status: latest.status }), busy && active.length > 1 ? (_jsxs("span", { className: "shrink-0 text-step--2 text-[var(--faint)]", children: ["+", active.length - 1] })) : null] }), blocked?.blocked_reason ? (_jsx("div", { className: "mt-1 truncate text-step--2 text-[var(--warn)]", title: blocked.blocked_reason, children: blocked.blocked_reason })) : null] })) : (_jsx("span", { className: "text-step--1 text-[var(--faint)]", children: "no work assigned" })) }), _jsx("td", { className: `${TABLE_TD} whitespace-nowrap`, children: _jsx("div", { className: "flex items-center gap-1.5", children: _jsx(Button, { onClick: () => {
                                                            setGiveWorkMateId(mate.id);
                                                        }, disabled: mate.status !== "active", title: mate.status !== "active" ? "Only active teammates can be given work" : "Give this teammate a task", children: "Give work" }) }) })] }, mate.id))) })] }) })] })) : (_jsx(EmptyState, { title: "No teammates yet", action: _jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "Create your first teammate" }), hint: "Create a teammate with a role and model, then chat with them or assign work from a task." })), giveWorkMateId ? (_jsx(Modal, { title: `Give work to ${mates.find((m) => m.id === giveWorkMateId)?.persona || "bot"}`, onClose: () => setGiveWorkMateId(""), children: _jsxs("form", { onSubmit: giveWorkSubmit, className: "flex flex-col gap-2", children: [_jsx(Field, { label: "Work to do", children: _jsx("textarea", { value: giveWorkDesc, onChange: (e) => setGiveWorkDesc(e.target.value), placeholder: "e.g. review the login flow and add tests", rows: 3, required: true, className: `${FORM_INPUT} resize-y` }) }), _jsx(Field, { label: "Command (optional)", children: _jsx("input", { value: giveWorkCmd, onChange: (e) => setGiveWorkCmd(e.target.value), placeholder: "e.g. npm test", className: FORM_INPUT }) }), _jsxs("div", { className: "mt-1 flex justify-end gap-2", children: [_jsx(Button, { type: "button", onClick: () => setGiveWorkMateId(""), children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", disabled: giveWorkBusy || !giveWorkDesc.trim(), children: giveWorkBusy ? "Creating…" : "Create task" })] })] }) })) : null] }));
}
function stepName(s) {
    const names = {
        identity: "Identity & role",
        face: "Face",
        model: "Model provider",
        permissions: "Tools & permissions",
        memory: "Memory & scope",
        review: "Review & save",
    };
    return names[s] ?? s;
}
