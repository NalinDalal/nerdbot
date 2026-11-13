import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** Settings: the machine and the workspace, not a developer manual.
 *
 *  The owner comes here to connect a model, add a workspace, or reach the
 *  container pages that no longer deserve a top-level nav item. Server
 *  internals are still available, but folded away behind Details.
 */
import { useState } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { notifyError } from "./app";
import { providerIsUsable } from "./readiness";
import { Badge, Button, CodeBlock, EmptyState, ErrorState, FORM_INPUT, FORM_SELECT, KeyValue, LoadingState, Modal, Page, PageHeader, PageSection, useAsync, } from "./components";
export function SettingsView() {
    const health = useAsync(() => api.health(), []);
    const workspaces = useAsync(async () => {
        const { projects, counts } = await api.listProjects();
        return Promise.all(projects.map(async (project) => {
            try {
                const providers = (await api.listProviders(project.id)).providers;
                return { project, counts: counts[project.id] ?? null, providers };
            }
            catch {
                return { project, counts: counts[project.id] ?? null, providers: [] };
            }
        }));
    }, []);
    const [connectTo, setConnectTo] = useState(null);
    const [creatingWorkspace, setCreatingWorkspace] = useState(false);
    const [testing, setTesting] = useState(null);
    const [section, setSection] = useState("providers");
    const test = async (provider) => {
        setTesting(provider.id);
        try {
            const { models } = await api.providerModels(provider.id);
            toast.success(`${provider.name}: ${models.length} model${models.length === 1 ? "" : "s"} available`);
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setTesting(null);
        }
    };
    const disabled = async (provider) => {
        try {
            await api.disableProvider(provider.id);
            workspaces.reload();
            toast.success(`${provider.name} disabled`);
        }
        catch (err) {
            notifyError(err);
        }
    };
    const sections = [
        { id: "general", label: "General" },
        { id: "providers", label: "Providers & models" },
        { id: "credentials", label: "Credentials" },
        { id: "permissions", label: "Permissions" },
        { id: "integrations", label: "Integrations" },
        { id: "autonomy", label: "Autonomy" },
        { id: "advanced", label: "Advanced" },
    ];
    return (_jsxs(Page, { width: "fill", children: [_jsx(PageHeader, { title: "Settings", description: "Configure how Nerdbot operates.", actions: _jsx(Button, { onClick: () => {
                        health.reload();
                        workspaces.reload();
                    }, children: "Refresh" }) }), _jsxs("div", { className: "flex flex-col gap-4 md:flex-row", children: [_jsx("nav", { "aria-label": "Settings sections", className: "flex shrink-0 flex-row gap-1 overflow-x-auto md:w-48 md:flex-col md:overflow-visible", children: sections.map((s) => (_jsx("button", { type: "button", onClick: () => setSection(s.id), className: `rounded-md px-3 py-2 text-left text-step--1 transition-colors ${section === s.id
                                ? "bg-[var(--surface-3)] text-[var(--text)]"
                                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"}`, children: s.label }, s.id))) }), _jsxs("div", { className: "min-w-0 flex-1", children: [section === "general" ? (_jsx(PageSection, { title: "General", description: "Server health and system status.", children: health.loading ? (_jsx(LoadingState, { lines: 2 })) : health.error ? (_jsx(ErrorState, { error: health.error, onRetry: health.reload })) : health.data ? (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3", children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-center gap-2", children: [_jsx("span", { className: "font-medium text-[var(--text)]", children: "NerdBot server" }), _jsx(Badge, { variant: health.data.status === "ok" ? "ok" : "bad", children: health.data.status }), _jsxs("span", { className: "text-step--2 text-[var(--faint)]", children: ["version ", health.data.version] })] }), _jsxs("dl", { className: "divide-y divide-[var(--border-dim)]", children: [_jsx(KeyValue, { label: "Database", children: _jsx(Badge, { variant: health.data.db === "ok" ? "ok" : "bad", children: health.data.db }) }), _jsx(KeyValue, { label: "Restarts", children: health.data.restarts }), _jsx(KeyValue, { label: "Key storage", children: _jsx(Badge, { variant: health.data.secret_key === "absent" ? "warn" : "ok", children: health.data.secret_key === "absent" ? "not configured" : "configured" }) })] })] })) : (_jsx(EmptyState, { title: "Server unreachable", hint: "Start it with nerdbot run, then Refresh." })) })) : null, section === "providers" ? (_jsx(PageSection, { title: "Projects & models", description: "Each project keeps its own teammates, tasks, files, and model connection.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setCreatingWorkspace(true), children: "New project" }), _jsx(Button, { variant: "primary", onClick: () => setConnectTo(workspaces.data?.[0]?.project.id ?? null), disabled: !workspaces.data || workspaces.data.length === 0, children: "Connect a model" })] }), children: workspaces.loading ? (_jsx(LoadingState, { lines: 3 })) : workspaces.error ? (_jsx(ErrorState, { error: workspaces.error, onRetry: workspaces.reload })) : (workspaces.data ?? []).length === 0 ? (_jsx(EmptyState, { title: "No projects", hint: "Create one below, then connect a model." })) : (_jsx("div", { className: "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]", children: (workspaces.data ?? []).map(({ project, counts, providers }, index) => {
                                        const usable = providers.filter(providerIsUsable);
                                        return (_jsxs("div", { className: `flex flex-wrap items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("a", { href: `/p/${project.id}`, className: "block truncate font-medium text-[var(--text)] hover:underline", children: project.repository || "Project" }), _jsxs("div", { className: "mt-0.5 text-step--2 text-[var(--faint)]", children: [providers.length === 0
                                                                    ? "No model connected"
                                                                    : `${usable.length} of ${providers.length} usable`, counts
                                                                    ? ` · ${counts.bots} teammate${counts.bots === 1 ? "" : "s"} · ${counts.tasks} task${counts.tasks === 1 ? "" : "s"} · ${counts.running} running`
                                                                    : ""] })] }), providers.length === 0 ? (_jsx(Badge, { variant: "warn", children: "No model" })) : (_jsx("div", { className: "flex min-w-0 flex-wrap items-center gap-2", children: providers.map((provider) => (_jsxs("span", { className: "inline-flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2 py-1 text-step--2 text-[var(--text-soft)]", children: [_jsx("span", { className: "max-w-[10rem] truncate", children: provider.name }), _jsx("button", { onClick: () => void test(provider), disabled: testing === provider.id, className: "text-[var(--muted)] underline underline-offset-2 hover:text-[var(--text)]", children: testing === provider.id ? "Testing…" : "Test" }), provider.status !== "disabled" ? (_jsx("button", { onClick: () => void disabled(provider), className: "text-[var(--muted)] hover:text-[var(--danger)]", "aria-label": `Disable ${provider.name}`, children: "\u00D7" })) : null] }, provider.id))) })), _jsx(Button, { onClick: () => setConnectTo(project.id), children: "Add model" }), _jsx("a", { href: `/p/${project.id}`, className: "text-step--1 text-[var(--muted)] hover:text-[var(--text)]", children: "Open \u2192" })] }, project.id));
                                    }) })) })) : null, section === "integrations" || section === "advanced" ? (_jsx(PageSection, { title: "Integrations & advanced", description: "Cross-project surfaces and build internals.", children: _jsxs("div", { className: "grid gap-2 sm:grid-cols-2", children: [_jsx(AdvancedLink, { href: "/boards", title: "Boards", hint: "Message channels teammates can read and write." }), _jsx(AdvancedLink, { href: "/teams", title: "Teams", hint: "Group projects for a shared roll-up." }), _jsx(AdvancedLink, { href: "/projects", title: "All projects", hint: "The full project table." }), _jsx(AdvancedLink, { href: "/capabilities", title: "Capabilities", hint: "What this build can and cannot do." })] }) })) : null, section === "general" || section === "credentials" || section === "permissions" || section === "autonomy" || section === "advanced" ? (_jsx(PageSection, { title: "Server", description: "The machine this workspace runs on.", children: health.loading ? (_jsx(LoadingState, { lines: 2 })) : health.error ? (_jsx(ErrorState, { error: health.error, onRetry: health.reload })) : health.data ? (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3", children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-center gap-2", children: [_jsx("span", { className: "font-medium text-[var(--text)]", children: "NerdBot server" }), _jsx(Badge, { variant: health.data.status === "ok" ? "ok" : "bad", children: health.data.status }), _jsxs("span", { className: "text-step--2 text-[var(--faint)]", children: ["version ", health.data.version] })] }), _jsxs("dl", { className: "divide-y divide-[var(--border-dim)]", children: [_jsx(KeyValue, { label: "Database", children: _jsx(Badge, { variant: health.data.db === "ok" ? "ok" : "bad", children: health.data.db }) }), _jsx(KeyValue, { label: "Restarts", children: health.data.restarts }), _jsx(KeyValue, { label: "Key storage", children: _jsx(Badge, { variant: health.data.secret_key === "absent" ? "warn" : "ok", children: health.data.secret_key === "absent" ? "not configured" : "configured" }) })] }), health.data.secret_key === "absent" ? (_jsx("p", { className: "mt-2 text-step--1 text-[var(--muted)]", children: "Pasted keys cannot be stored until the server has a secret key. An environment variable works without it." })) : null, _jsxs("details", { className: "mt-3 border-t border-[var(--border-dim)] pt-3", children: [_jsx("summary", { className: "cursor-pointer text-step--1 text-[var(--muted)]", children: "Connection and security details" }), _jsxs("div", { className: "mt-3 space-y-3", children: [_jsxs("div", { children: [_jsx("div", { className: "mb-1 text-step--1 text-[var(--muted)]", children: "API base" }), _jsx(CodeBlock, { children: "http://127.0.0.1:8080   (the dashboard is served by the API)" })] }), _jsxs("dl", { className: "divide-y divide-[var(--border-dim)]", children: [_jsx(KeyValue, { label: "Sign in", children: "One bearer token, kept in this browser only." }), _jsx(KeyValue, { label: "Pasted keys", children: "Encrypted at rest when the server has a secret key. The API returns only a fingerprint." }), _jsx(KeyValue, { label: "Shell access", children: "Bots run commands inside their task workspace, bounded by the run and the deny list." })] })] })] })] })) : (_jsx(EmptyState, { title: "Server unreachable", hint: "Start it with nerdbot run, then Refresh." })) })) : null, connectTo ? (_jsx(ConnectModelModal, { projects: workspaces.data ?? [], initialProjectId: connectTo, onClose: () => setConnectTo(null), onSaved: () => {
                                    setConnectTo(null);
                                    workspaces.reload();
                                } })) : null, creatingWorkspace ? (_jsx(NewWorkspaceModal, { onClose: () => setCreatingWorkspace(false), onCreated: () => {
                                    setCreatingWorkspace(false);
                                    workspaces.reload();
                                } })) : null] })] })] }));
}
function AdvancedLink({ href, title, hint }) {
    return (_jsxs("a", { href: href, className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 transition-colors hover:border-[var(--faint)]", children: [_jsx("div", { className: "font-medium text-[var(--text)]", children: title }), _jsx("div", { className: "mt-0.5 text-step--1 text-[var(--muted)]", children: hint })] }));
}
function ConnectModelModal({ projects, initialProjectId, onClose, onSaved, }) {
    const [projectId, setProjectId] = useState(initialProjectId);
    const [name, setName] = useState("groq");
    const [baseUrl, setBaseUrl] = useState("https://api.groq.com/openai/v1");
    const [model, setModel] = useState("openai/gpt-oss-120b");
    const [envVar, setEnvVar] = useState("CLOUD_MODEL_KEY");
    const [apiKey, setApiKey] = useState("");
    const [busy, setBusy] = useState(false);
    const submit = async (event) => {
        event.preventDefault();
        if (!projectId || !baseUrl.trim())
            return;
        setBusy(true);
        try {
            await api.createProvider(projectId, {
                kind: "openai-compatible",
                name: name.trim() || "model",
                config: {
                    base_url: baseUrl.trim(),
                    ...(model.trim() ? { model: model.trim() } : {}),
                    ...(apiKey.trim()
                        ? { api_key: apiKey.trim() }
                        : envVar.trim()
                            ? { api_key_env: envVar.trim() }
                            : {}),
                },
            });
            toast.success("Model connected");
            onSaved();
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx(Modal, { title: "Connect a model", onClose: onClose, children: _jsxs("form", { onSubmit: submit, className: "flex flex-col gap-4", children: [_jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Workspace" }), _jsx("select", { value: projectId, onChange: (event) => setProjectId(event.target.value), className: FORM_SELECT, required: true, children: projects.map(({ project }) => (_jsx("option", { value: project.id, children: project.repository || "Workspace" }, project.id))) })] }), _jsxs("div", { className: "grid gap-3 sm:grid-cols-2", children: [_jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Name" }), _jsx("input", { value: name, onChange: (event) => setName(event.target.value), className: FORM_INPUT, placeholder: "groq" })] }), _jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Model" }), _jsx("input", { value: model, onChange: (event) => setModel(event.target.value), className: FORM_INPUT, placeholder: "openai/gpt-oss-120b" })] })] }), _jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Base URL" }), _jsx("input", { value: baseUrl, onChange: (event) => setBaseUrl(event.target.value), className: FORM_INPUT, placeholder: "https://api.groq.com/openai/v1", required: true })] }), _jsxs("div", { className: "grid gap-3 sm:grid-cols-2", children: [_jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Key environment variable" }), _jsx("input", { value: envVar, onChange: (event) => {
                                        setEnvVar(event.target.value);
                                        if (event.target.value)
                                            setApiKey("");
                                    }, className: FORM_INPUT, placeholder: "CLOUD_MODEL_KEY" })] }), _jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Or paste a key" }), _jsx("input", { type: "password", value: apiKey, onChange: (event) => {
                                        setApiKey(event.target.value);
                                        if (event.target.value)
                                            setEnvVar("");
                                    }, className: FORM_INPUT, autoComplete: "off", placeholder: "sk-\u2026" })] })] }), _jsx("p", { className: "text-step--2 text-[var(--faint)]", children: "An environment variable keeps the key out of the database. A pasted key is encrypted when the server has a secret key." }), _jsxs("div", { className: "flex items-center justify-end gap-2", children: [_jsx(Button, { type: "button", onClick: onClose, children: "Cancel" }), _jsx(Button, { type: "submit", variant: "primary", disabled: busy || !baseUrl.trim() || !projectId, children: busy ? "Connecting…" : "Connect" })] })] }) }));
}
function NewWorkspaceModal({ onClose, onCreated, }) {
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const submit = async (event) => {
        event.preventDefault();
        if (!name.trim())
            return;
        setBusy(true);
        try {
            await api.createProject(name.trim());
            toast.success("Workspace created");
            onCreated();
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx(Modal, { title: "New project", onClose: onClose, children: _jsxs("form", { onSubmit: submit, className: "flex flex-col gap-4", children: [_jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { className: "text-step--1 text-[var(--muted)]", children: "Name" }), _jsx("input", { value: name, onChange: (event) => setName(event.target.value), className: FORM_INPUT, placeholder: "my-project", required: true, autoFocus: true })] }), _jsxs("div", { className: "flex items-center justify-end gap-2", children: [_jsx(Button, { type: "button", onClick: onClose, children: "Cancel" }), _jsx(Button, { type: "submit", variant: "primary", disabled: busy || !name.trim(), children: busy ? "Creating…" : "Create project" })] })] }) }));
}
