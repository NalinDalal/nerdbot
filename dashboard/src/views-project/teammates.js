import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api, describeError } from "../api";
import { notifyError, navigate } from "../app";
import { FacePicker } from "../bot/FacePicker";
import { DEFAULT_FACE, normalizeFace } from "../bot/face";
import { faceStateFor } from "../bot/status";
import { BotFace, Button, ERROR_BOX, EmptyState, ErrorState, Field, FORM_INPUT, LoadingState, Modal, PageSection, StatusBadge, useAsync, usePermissionCatalogue } from "../components";
import { taskTitle } from "../taskTitle";
function teammateWorkSummary(teammateId, tasks) {
    const mine = tasks.filter((t) => t.owner_teammate_id === teammateId);
    const active = mine.find((t) => t.status === "running") || mine.find((t) => t.status === "awaiting_approval" || t.status === "blocked") || mine.find((t) => t.status === "ready" || t.status === "pending" || t.status === "queued");
    const running = mine.filter((t) => t.status === "running").length;
    const needsAttention = mine.filter((t) => t.status === "blocked" || t.status === "awaiting_approval" || t.status === "failed").length;
    const queued = mine.filter((t) => ["ready", "pending", "queued"].includes(t.status)).length;
    const done = mine.filter((t) => t.status === "done").length;
    let state = "Available";
    if (running > 0)
        state = "Working now";
    else if (needsAttention > 0)
        state = "Needs attention";
    else if (queued > 0)
        state = "Queued work";
    else if (done > 0)
        state = "Idle";
    return { active, state, running, needsAttention, queued, done, total: mine.length };
}
export function TeammatesTab({ projectId }) {
    const list = useAsync(() => api.listTeammates(projectId), [projectId]);
    const providers = useAsync(() => api.listProviders(projectId), [projectId]);
    const tasks = useAsync(() => api.projectTasks(projectId).catch(() => ({ tasks: [] })), [projectId]);
    const [showCreate, setShowCreate] = useState(false);
    const taskList = tasks.data?.tasks ?? [];
    return (_jsx("div", { className: "flex flex-col gap-6", children: _jsxs(PageSection, { title: "AI teammates", description: "Collaborators in this workspace, what they\u2019re responsible for, and how to work with them.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => { list.reload(); providers.reload(); tasks.reload(); }, children: "Refresh" }), _jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "Add teammate" })] }), children: [showCreate ? (_jsx(Modal, { title: "Add AI teammate", onClose: () => setShowCreate(false), children: _jsx(BotForm, { projectId: projectId, providers: providers.data?.providers ?? [], onDone: () => {
                            setShowCreate(false);
                            list.reload();
                        } }) })) : null, list.loading ? (_jsx(LoadingState, {})) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : list.data && list.data.teammates.length > 0 ? (_jsx("div", { className: "flex flex-col gap-3", children: list.data.teammates.map((mate) => (_jsx(BotCard, { mate: mate, providers: providers.data?.providers ?? [], tasks: taskList, onChanged: () => {
                            list.reload();
                            providers.reload();
                            tasks.reload();
                        } }, mate.id))) })) : (_jsx(EmptyState, { title: "No teammates yet", hint: "Add an AI teammate to collaborate on work in this workspace.", action: _jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "Add teammate" }) }))] }) }));
}
function BotCard({ mate, providers, tasks, onChanged, }) {
    const [showAttach, setShowAttach] = useState(false);
    const [showPerms, setShowPerms] = useState(false);
    const [showFace, setShowFace] = useState(false);
    const [showModelSettings, setShowModelSettings] = useState(false);
    const [showConfig, setShowConfig] = useState(false);
    const [faceDraft, setFaceDraft] = useState(DEFAULT_FACE);
    const act = async (fn) => {
        try {
            await fn();
            onChanged();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const attached = providers.find((p) => p.id === mate.provider_id);
    const work = teammateWorkSummary(mate.id, tasks);
    return (_jsxs("div", { className: "rounded-lg bg-[var(--surface)] px-4 py-4", children: [_jsxs("div", { className: "flex flex-wrap items-start justify-between gap-3", children: [_jsxs("div", { className: "flex min-w-0 items-start gap-3", children: [_jsx(BotFace, { face: mate.face, size: 36, state: faceStateFor(mate.status), animated: true }), _jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("span", { className: "truncate text-step-0 font-medium text-[var(--text)]", children: mate.persona || mate.name || "Teammate" }), _jsx("span", { className: "text-step--2 text-[var(--muted)]", children: work.state }), _jsx(StatusBadge, { status: mate.status })] }), _jsx("div", { className: "mt-1 text-step--1 text-[var(--muted)] line-clamp-2", children: mate.instructions || "No role or instructions set yet." }), _jsx("div", { className: "mt-2 text-step--2 text-[var(--text-soft)]", children: work.active ? (_jsxs(_Fragment, { children: ["Current: ", _jsx("span", { className: "text-[var(--text)]", children: taskTitle(work.active.description) }), " ", _jsxs("span", { className: "text-[var(--muted)]", children: ["\u00B7 ", work.active.status.replace("_", " ")] })] })) : work.total > 0 ? (_jsxs(_Fragment, { children: [work.done, " completed \u00B7 ", work.total, " assigned in this workspace"] })) : (_jsx(_Fragment, { children: "No work assigned in this workspace yet" })) }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--faint)]", children: attached ? `Model: ${attached.name || attached.id}${mate.model ? ` (override ${mate.model})` : ""}` : mate.provider_id ? `Model: ${mate.provider_id} (connection not found)` : "No model connected" })] })] }), _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Button, { onClick: () => navigate(`/bot/${mate.id}`), children: "Open" }), _jsx(Button, { variant: "primary", onClick: () => navigate(`/p/${mate.project_id}?tab=Chat`), children: "Chat" }), _jsx(Button, { onClick: () => setShowConfig((v) => !v), children: showConfig ? "Hide settings" : "Configure" })] })] }), showConfig ? (_jsxs("div", { className: "mt-4 border-t border-[var(--border-dim)] pt-3", children: [_jsxs("div", { className: "mb-3 flex flex-wrap items-center gap-2 text-step--2 text-[var(--muted)]", children: [_jsxs("span", { children: ["memory: ", mate.memory_scope] }), _jsx("span", { children: "\u00B7" }), _jsxs("span", { children: [(mate.permissions ?? []).length, " permission", (mate.permissions ?? []).length === 1 ? "" : "s"] }), attached ? _jsxs(_Fragment, { children: [_jsx("span", { children: "\u00B7" }), _jsx("span", { children: String(attached.config.model ?? "model not set") })] }) : null] }), _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Button, { onClick: () => setShowAttach(true), children: attached ? "Switch model" : "Attach model" }), _jsx(Button, { onClick: () => setShowModelSettings(true), children: "Model settings" }), _jsx(Button, { onClick: () => setShowPerms(true), children: "Permissions" }), _jsx(Button, { onClick: () => { setFaceDraft(normalizeFace(mate.face)); setShowFace(true); }, children: "Face" }), _jsx(Button, { onClick: () => void act(() => api.disableTeammate(mate.id)), children: "Disable" }), _jsx(Button, { onClick: () => void act(() => api.archiveTeammate(mate.id)), children: "Archive" })] }), _jsx("div", { className: "mt-2 text-step--2 text-[var(--faint)]", children: "Advanced configuration and access controls remain available here and in the full agent view." })] })) : null, showAttach ? (_jsx(Modal, { title: `Model for ${mate.persona || mate.id}`, onClose: () => setShowAttach(false), children: providers.length === 0 ? (_jsxs("div", { className: "rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-step--1", children: ["This project has no model connections yet. Create one under the", " ", _jsx("strong", { children: "Providers" }), " tab first."] })) : (_jsx("div", { children: providers.map((p) => (_jsxs("div", { className: "flex items-center justify-between gap-3 py-1.5", children: [_jsxs("span", { children: [_jsx("strong", { children: p.name || p.id }), " ", _jsx("span", { className: "mono text-[var(--muted)]", children: String(p.config.model ?? "") }), mate.provider_id === p.id ? " (current)" : null] }), _jsx(Button, { onClick: () => void act(() => api.patchTeammate(mate.id, {
                                    provider_id: mate.provider_id === p.id ? null : p.id,
                                })), children: mate.provider_id === p.id ? "Detach" : "Attach" })] }, p.id))) })) })) : null, showModelSettings ? (_jsx(Modal, { title: `Model settings for ${mate.persona || mate.id}`, onClose: () => setShowModelSettings(false), children: _jsx(ModelSettingsForm, { mate: mate, providers: providers, onSaved: () => {
                        setShowModelSettings(false);
                        onChanged();
                    } }) })) : null, showFace ? (_jsxs(Modal, { title: `Face of ${mate.persona || mate.id}`, onClose: () => setShowFace(false), children: [_jsx(FacePicker, { value: faceDraft, onChange: setFaceDraft, compact: true }), _jsxs("div", { className: "mt-4 flex items-center justify-end gap-2", children: [_jsx(Button, { onClick: () => setShowFace(false), children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => {
                                    setShowFace(false);
                                    void act(() => api.patchTeammate(mate.id, { face: faceDraft }));
                                }, children: "Save face" })] })] })) : null, showPerms ? (_jsx(Modal, { title: `Permissions for ${mate.persona || mate.id}`, onClose: () => setShowPerms(false), children: _jsx(PermissionsForm, { mate: mate, onSaved: () => {
                        setShowPerms(false);
                        onChanged();
                    } }) })) : null] }));
}
function PermissionsForm({ mate, onSaved }) {
    const [permissions, setPermissions] = useState(mate.permissions ?? []);
    const [memoryScope, setMemoryScope] = useState(mate.memory_scope || "teammate");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const catalogue = usePermissionCatalogue();
    const toggle = (perm) => setPermissions((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]));
    const adminPerms = catalogue.permissions.filter((p) => p.kind === "admin");
    const agentPerms = catalogue.permissions.filter((p) => p.kind !== "admin");
    // A permission the bot holds but the server does not know is dead weight:
    // it grants nothing. Surface it instead of silently dropping it.
    const unknownHeld = permissions.filter((p) => !catalogue.byName.has(p));
    return (_jsxs("form", { onSubmit: async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
                await api.patchTeammate(mate.id, { permissions, memory_scope: memoryScope });
                onSaved();
            }
            catch (err) {
                setError(describeError(err));
            }
            finally {
                setBusy(false);
            }
        }, children: [_jsx(Field, { label: "Memory scope: where this bot may read and write memory", children: _jsxs("select", { value: memoryScope, onChange: (e) => setMemoryScope(e.target.value), children: [_jsx("option", { value: "teammate", children: "teammate: only its own memory" }), _jsx("option", { value: "project", children: "project: shared workspace memory" })] }) }), catalogue.loading ? (_jsx("div", { className: "text-[var(--muted)]", style: { margin: "8px 0" }, children: "Loading the permission catalogue\u2026" })) : catalogue.error ? (_jsxs("div", { className: ERROR_BOX, role: "alert", children: ["Could not load the permission catalogue: ", describeError(catalogue.error)] })) : null, _jsx("div", { className: "text-[var(--muted)]", style: { margin: "8px 0 4px" }, children: "Admin permissions are deny-by-default and need a human's exact-action approval even when granted." }), _jsxs("fieldset", { style: { border: "1px solid var(--line)", borderRadius: 6, padding: 8, marginBottom: 8 }, children: [_jsx("legend", { className: "mono text-[var(--muted)]", style: { fontSize: 12 }, children: "admin (approval-gated)" }), adminPerms.map((perm) => (_jsxs("label", { style: { display: "block" }, title: perm.summary, children: [_jsx("input", { type: "checkbox", checked: permissions.includes(perm.name), onChange: () => toggle(perm.name) }), " ", perm.name, _jsxs("span", { className: "text-[var(--muted)]", style: { fontSize: 11 }, children: [" ", "\u2014 ", perm.summary] })] }, perm.name)))] }), _jsxs("fieldset", { style: { border: "1px solid var(--line)", borderRadius: 6, padding: 8, marginBottom: 8 }, children: [_jsx("legend", { className: "mono text-[var(--muted)]", style: { fontSize: 12 }, children: "agent" }), agentPerms.map((perm) => (_jsxs("label", { style: { display: "block" }, title: perm.summary, children: [_jsx("input", { type: "checkbox", checked: permissions.includes(perm.name), onChange: () => toggle(perm.name) }), " ", perm.name, _jsxs("span", { className: "text-[var(--muted)]", style: { fontSize: 11 }, children: [" ", "\u2014 ", perm.summary] })] }, perm.name)))] }), unknownHeld.length > 0 ? (_jsxs("div", { className: ERROR_BOX, role: "alert", children: ["This bot holds permission names the server does not know: ", unknownHeld.join(", "), ". They grant nothing and will be rejected on save \u2014 remove them below.", _jsx("div", { className: "flex items-center gap-3", style: { gap: 6, marginTop: 6 }, children: unknownHeld.map((p) => (_jsxs(Button, { type: "button", variant: "danger", onClick: () => toggle(p), children: ["remove ", p] }, p))) })] })) : null, _jsxs("div", { className: "mono text-[var(--muted)]", style: { fontSize: 12 }, children: ["selected: ", permissions.length ? permissions.join(", ") : "none"] }), error ? (_jsx("div", { className: ERROR_BOX, role: "alert", children: error })) : null, _jsx("div", { className: "flex items-center gap-3", style: { marginTop: 8 }, children: _jsx(Button, { variant: "primary", type: "submit", disabled: busy || catalogue.loading || unknownHeld.length > 0, children: busy ? "Saving…" : "Save permissions" }) })] }));
}
function ModelSettingsForm({ mate, providers, onSaved, }) {
    const [model, setModel] = useState(mate.model || "");
    const [temperature, setTemperature] = useState(mate.temperature === null || mate.temperature === undefined ? "" : String(mate.temperature));
    const [maxTokens, setMaxTokens] = useState(mate.max_tokens === null || mate.max_tokens === undefined ? "" : String(mate.max_tokens));
    const [contextLimit, setContextLimit] = useState(mate.context_limit === null || mate.context_limit === undefined ? "" : String(mate.context_limit));
    const [fallbackProviderId, setFallbackProviderId] = useState(mate.fallback_provider_id || "");
    const [fallbackModel, setFallbackModel] = useState(mate.fallback_model || "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    return (_jsxs("form", { onSubmit: async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
                await api.patchTeammate(mate.id, {
                    model: model.trim(),
                    temperature: temperature.trim() === "" ? null : Number(temperature),
                    max_tokens: maxTokens.trim() === "" ? null : Number(maxTokens),
                    context_limit: contextLimit.trim() === "" ? null : Number(contextLimit),
                    fallback_provider_id: fallbackProviderId || null,
                    fallback_model: fallbackModel.trim(),
                });
                onSaved();
            }
            catch (err) {
                setError(describeError(err));
            }
            finally {
                setBusy(false);
            }
        }, children: [_jsx(Field, { label: "Model override (leave empty to use the connection's model)", children: _jsx("input", { value: model, onChange: (e) => setModel(e.target.value), placeholder: "openai/gpt-oss-120b" }) }), _jsx(Field, { label: "Temperature", children: _jsx("input", { type: "number", step: "0.1", value: temperature, onChange: (e) => setTemperature(e.target.value) }) }), _jsx(Field, { label: "Max tokens", children: _jsx("input", { type: "number", value: maxTokens, onChange: (e) => setMaxTokens(e.target.value) }) }), _jsx(Field, { label: "Context limit", children: _jsx("input", { type: "number", value: contextLimit, onChange: (e) => setContextLimit(e.target.value) }) }), _jsx(Field, { label: "Fallback connection", children: _jsxs("select", { value: fallbackProviderId, onChange: (e) => setFallbackProviderId(e.target.value), children: [_jsx("option", { value: "", children: "(none)" }), providers.map((p) => (_jsx("option", { value: p.id, children: p.name || p.id }, p.id)))] }) }), _jsx(Field, { label: "Fallback model", children: _jsx("input", { value: fallbackModel, onChange: (e) => setFallbackModel(e.target.value) }) }), error ? (_jsx("div", { className: "text-[var(--danger)]", style: { marginBottom: 8 }, children: error })) : null, _jsx("div", { className: "flex items-center gap-3", style: { marginTop: 8 }, children: _jsx(Button, { variant: "primary", type: "submit", disabled: busy, children: busy ? "Saving…" : "Save model settings" }) })] }));
}
function BotForm({ projectId, providers, onDone, }) {
    const [persona, setPersona] = useState("");
    const [instructions, setInstructions] = useState("");
    const [capabilities, setCapabilities] = useState("");
    const ROLE_TEMPLATES = [
        { id: "researcher", label: "Research Analyst", persona: "researcher", instructions: "Find public evidence, sources and leads. Output structured records with links. Never invent facts." },
        { id: "engineer", label: "Software Engineer", persona: "engineer", instructions: "Implement, test and review code. Show real command output. Ask before destructive steps." },
        { id: "strategist", label: "Product Strategist", persona: "strategist", instructions: "Synthesize research into positioning and recommendations. Cite evidence. Draft only." },
    ];
    const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
    const [face, setFace] = useState(DEFAULT_FACE);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    return (_jsxs("form", { onSubmit: async (e) => {
            e.preventDefault();
            setError(null);
            setBusy(true);
            try {
                const created = await api.createTeammate(projectId, {
                    persona,
                    instructions,
                    capabilities: capabilities
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    face,
                });
                if (providerId) {
                    await api.patchTeammate(created.id, { provider_id: providerId });
                }
                onDone();
            }
            catch (err) {
                setError(describeError(err));
            }
            finally {
                setBusy(false);
            }
        }, children: [_jsx(Field, { label: "Role template (optional)", children: _jsxs("select", { value: "", onChange: (e) => {
                        const t = ROLE_TEMPLATES.find((x) => x.id === e.target.value);
                        if (!t)
                            return;
                        setPersona(t.persona);
                        setInstructions(t.instructions);
                    }, className: FORM_INPUT, children: [_jsx("option", { value: "", children: "(none \u2014 start blank)" }), ROLE_TEMPLATES.map((t) => (_jsx("option", { value: t.id, children: t.label }, t.id)))] }) }), _jsx(Field, { label: "Name (its job)", children: _jsx("input", { required: true, value: persona, onChange: (e) => setPersona(e.target.value), placeholder: "coder" }) }), _jsx(Field, { label: "Instructions: how it should behave", children: _jsx("textarea", { rows: 3, value: instructions, onChange: (e) => setInstructions(e.target.value), placeholder: "Be terse. Show real command output. Ask before destructive steps." }) }), _jsx(Field, { label: "Capabilities (comma separated)", children: _jsx("input", { value: capabilities, onChange: (e) => setCapabilities(e.target.value), placeholder: "code, review" }) }), _jsx(Field, { label: "Face: the bot's own, changeable later", children: _jsx(FacePicker, { value: face, onChange: setFace, compact: true }) }), _jsx(Field, { label: "Model connection (change or detach later)", children: providers.length === 0 ? (_jsx("div", { className: "text-[var(--muted)]", children: "No connections in this project yet. Attach one after creating the bot." })) : (_jsxs("select", { value: providerId, onChange: (e) => setProviderId(e.target.value), children: [_jsx("option", { value: "", children: "(attach later)" }), providers.map((p) => (_jsxs("option", { value: p.id, children: [p.name || p.id, " \u2014 ", String(p.config.model ?? "")] }, p.id)))] })) }), error ? (_jsx("div", { className: ERROR_BOX, role: "alert", children: error })) : null, _jsx("div", { className: "flex items-center gap-3", style: { marginTop: 8 }, children: _jsx(Button, { variant: "primary", type: "submit", disabled: busy, children: busy ? "Creating…" : "Create bot" }) })] }));
}
