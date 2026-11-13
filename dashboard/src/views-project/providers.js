import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { api, describeError } from "../api";
import { notifyError } from "../app";
import { maskSecrets } from "../types";
import { Button, CARD_SHELL, CHIP_SHELL, ERROR_BOX, EmptyState, ErrorState, Field, LoadingState, Modal, StatusBadge, useAsync } from "../components";
export function ProvidersTab({ projectId }) {
    const list = useAsync(() => api.listProviders(projectId), [projectId]);
    const [showCreate, setShowCreate] = useState(false);
    const health = useAsync(() => api.health(), [projectId]);
    return (_jsxs("div", { children: [health.data && health.data.secret_key === "absent" ? (_jsxs("div", { className: ERROR_BOX, style: { marginBottom: 12 }, children: ["No ", _jsx("code", { children: "NERDBOT_SECRET_KEY" }), " on this server: pasting an API key will be refused (we never store keys in the clear). Start the server with a Fernet key to enable BYOK. The ", _jsx("code", { children: "api_key_env" }), " path keeps working meanwhile."] })) : null, _jsxs("div", { className: "flex items-center gap-3", style: { marginBottom: 12 }, children: [_jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "New model connection" }), _jsx(Button, { onClick: list.reload, children: "Refresh" })] }), showCreate ? (_jsx(Modal, { title: "New model connection", onClose: () => setShowCreate(false), children: _jsx(ProviderForm, { projectId: projectId, onDone: () => {
                        setShowCreate(false);
                        list.reload();
                    } }) })) : null, list.loading ? (_jsx(LoadingState, {})) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : list.data && list.data.providers.length > 0 ? (list.data.providers.map((provider) => (_jsx(ProviderCard, { provider: provider, onChanged: list.reload }, provider.id)))) : (_jsx(EmptyState, { title: "No model connected", hint: "Bots need a brain. Connect one openai-compatible provider (Groq, OpenRouter, OpenAI, Kimi\u2026) to start chatting and running tasks.", action: _jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "Connect a model" }) }))] }));
}
const BASE_URL_PRESETS = [
    { label: "Groq", url: "https://api.groq.com/openai/v1" },
    { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
    { label: "OpenAI", url: "https://api.openai.com/v1" },
    { label: "Kimi (Moonshot)", url: "https://api.moonshot.cn/v1" },
    { label: "Ollama (local)", url: "http://localhost:11434", kind: "ollama" },
];
function providerModelName(config) {
    return typeof config.model === "string" ? config.model : "";
}
function ProviderCard({ provider, onChanged }) {
    const [showModels, setShowModels] = useState(false);
    const [showEdit, setShowEdit] = useState(false);
    const [health, setHealth] = useState(null);
    const [checkingHealth, setCheckingHealth] = useState(false);
    const disabled = provider.status !== "active";
    const checkHealth = async () => {
        setCheckingHealth(true);
        try {
            const result = await api.providerHealth(provider.id);
            setHealth({ healthy: result.healthy, error: result.error, latency_ms: result.latency_ms });
        }
        catch (err) {
            setHealth({ healthy: false, error: describeError(err), latency_ms: 0 });
        }
        finally {
            setCheckingHealth(false);
        }
    };
    return (_jsxs("div", { className: CARD_SHELL, style: disabled ? { opacity: 0.6 } : undefined, children: [_jsxs("div", { className: "flex items-center gap-3", style: { justifyContent: "space-between" }, children: [_jsxs("div", { children: [_jsx("strong", { children: provider.name || provider.id }), " ", _jsx("span", { className: "mono text-[var(--muted)]", children: provider.kind }), " ", _jsx(StatusBadge, { status: provider.status }), providerModelName(provider.config) ? (_jsx("span", { className: CHIP_SHELL, children: providerModelName(provider.config) })) : (_jsx("span", { className: `${CHIP_SHELL} text-[var(--muted)]`, children: "no model set" })), health ? (_jsx("span", { className: CHIP_SHELL, style: { color: health.healthy ? "var(--ok, #16a34a)" : "var(--danger, #dc2626)" }, children: health.healthy ? `healthy ${health.latency_ms}ms` : `unhealthy: ${health.error ?? "unknown"}` })) : null] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Button, { onClick: () => void checkHealth(), disabled: checkingHealth, children: checkingHealth ? "Checking…" : "Health" }), _jsx(Button, { onClick: () => setShowModels(true), children: "Models" }), _jsx(Button, { onClick: () => setShowEdit(true), children: "Edit" }), _jsx(Button, { onClick: async () => {
                                    try {
                                        await api.patchProvider(provider.id, {
                                            status: disabled ? "active" : "disabled",
                                        });
                                        onChanged();
                                    }
                                    catch (err) {
                                        notifyError(err);
                                    }
                                }, children: disabled ? "Enable" : "Disable" })] })] }), _jsxs("div", { className: "mono text-[var(--muted)]", style: { marginTop: 8 }, children: [provider.id, " \u00B7 ", String(provider.config.base_url ?? ""), provider.capabilities && provider.capabilities.length > 0 ? (_jsxs(_Fragment, { children: [" \u00B7 capabilities ", provider.capabilities.join(", ")] })) : null, typeof provider.config.api_key === "string" && provider.config.api_key ? (_jsxs(_Fragment, { children: [" \u00B7 key ", _jsx("code", { children: String(maskSecrets(provider.config).api_key) })] })) : typeof provider.config.api_key_env === "string" && provider.config.api_key_env ? (_jsxs(_Fragment, { children: [" \u00B7 key env ", _jsx("code", { children: provider.config.api_key_env })] })) : null] }), showModels ? (_jsx(Modal, { title: `Models · ${provider.name || provider.id}`, onClose: () => setShowModels(false), children: _jsx(ModelCatalogPicker, { provider: provider, onDone: () => setShowModels(false) }) })) : null, showEdit ? (_jsx(Modal, { title: "Edit connection", onClose: () => setShowEdit(false), children: _jsx(EditProviderForm, { provider: provider, onDone: () => { setShowEdit(false); onChanged(); } }) })) : null] }));
}
function ModelCatalogPicker({ provider, onDone }) {
    const list = useAsync(() => api.providerModels(provider.id), [provider.id]);
    const [applying, setApplying] = useState(null);
    const current = providerModelName(provider.config);
    return (_jsxs("div", { children: [list.loading ? _jsx(LoadingState, { lines: 4 }) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : (_jsx("div", { style: { maxHeight: 320, overflowY: "auto" }, children: list.data?.models.map((model) => (_jsxs("div", { className: "flex items-center gap-3", style: { justifyContent: "space-between", padding: "4px 0" }, children: [_jsx("span", { className: "mono", style: model === current ? { fontWeight: 700 } : undefined, children: model === current ? `${model} (current)` : model }), _jsx(Button, { disabled: model === current || applying !== null, onClick: async () => {
                                setApplying(model);
                                try {
                                    await api.patchProvider(provider.id, { config: { model } });
                                    onDone();
                                }
                                catch (err) {
                                    notifyError(err);
                                }
                                finally {
                                    setApplying(null);
                                }
                            }, children: applying === model ? "Setting…" : "Use" })] }, model))) })), _jsxs("div", { className: "text-[var(--muted)]", style: { marginTop: 8 }, children: ["Fetched live from the provider's ", _jsx("code", { children: "/models" }), "; picking one rewrites this connection's model."] })] }));
}
function EditProviderForm({ provider, onDone }) {
    const [name, setName] = useState(provider.name);
    const [baseUrl, setBaseUrl] = useState(typeof provider.config.base_url === "string" ? provider.config.base_url : "");
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    return (_jsxs("form", { onSubmit: async (e) => {
            e.preventDefault();
            setError(null);
            setBusy(true);
            const body = { name, config: { base_url: baseUrl } };
            if (apiKey)
                body.config = { ...body.config, api_key: apiKey };
            try {
                await api.patchProvider(provider.id, body);
                onDone();
            }
            catch (err) {
                setError(describeError(err));
            }
            finally {
                setBusy(false);
            }
        }, children: [_jsx(Field, { label: "Name", children: _jsx("input", { value: name, onChange: (e) => setName(e.target.value) }) }), _jsx(Field, { label: "Base URL", children: _jsx("input", { value: baseUrl, onChange: (e) => setBaseUrl(e.target.value) }) }), _jsx(Field, { label: "API key \u2014 leave empty to keep the current one", error: error ?? undefined, children: _jsx("input", { type: "password", value: apiKey, onChange: (e) => setApiKey(e.target.value), autoComplete: "off" }) }), _jsx("div", { className: "flex items-center gap-3", style: { marginTop: 8 }, children: _jsx(Button, { variant: "primary", type: "submit", disabled: busy, children: busy ? "Saving…" : "Save" }) })] }));
}
function ProviderForm({ projectId, onDone }) {
    const [kind, setKind] = useState("openai-compatible");
    const [name, setName] = useState("");
    const [baseUrl, setBaseUrl] = useState(BASE_URL_PRESETS[0].url);
    const [model, setModel] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [apiKeyEnv, setApiKeyEnv] = useState("");
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const applyPreset = (label) => {
        const preset = BASE_URL_PRESETS.find((p) => p.label === label);
        if (preset) {
            setPresetLabel(label);
            setBaseUrl(preset.url);
            if (preset.kind)
                setKind(preset.kind);
        }
    };
    const [presetLabel, setPresetLabel] = useState(BASE_URL_PRESETS[0].label);
    return (_jsxs("form", { onSubmit: async (e) => {
            e.preventDefault();
            setError(null);
            setBusy(true);
            const target = projectId;
            if (!target) {
                setError("Project ID required");
                setBusy(false);
                return;
            }
            const config = {};
            if (baseUrl)
                config.base_url = baseUrl;
            if (model)
                config.model = model;
            if (apiKey)
                config.api_key = apiKey;
            if (apiKeyEnv)
                config.api_key_env = apiKeyEnv;
            try {
                await api.createProvider(target, { kind, name, config });
                onDone?.();
            }
            catch (err) {
                setError(describeError(err));
            }
            finally {
                setBusy(false);
            }
        }, children: [projectId ? null : _jsx("input", { type: "hidden" }), _jsx(Field, { label: "Kind", children: _jsxs("select", { value: kind, onChange: (e) => setKind(e.target.value), children: [_jsx("option", { value: "openai-compatible", children: "openai-compatible" }), _jsx("option", { value: "ollama", children: "ollama" }), _jsx("option", { value: "mock", children: "mock" }), _jsx("option", { value: "local", children: "local" })] }) }), _jsx(Field, { label: "Preset", children: _jsxs("select", { value: presetLabel, onChange: (e) => applyPreset(e.target.value), children: [BASE_URL_PRESETS.map((p) => (_jsx("option", { value: p.label, children: p.label }, p.label))), _jsx("option", { value: "custom", children: "Custom (edit base URL)" })] }) }), _jsx(Field, { label: "Name", children: _jsx("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "groq" }) }), _jsx(Field, { label: "Base URL", children: _jsx("input", { className: "mono", value: baseUrl, onChange: (e) => setBaseUrl(e.target.value) }) }), _jsx(Field, { label: "Model (you can pick from the catalog after connecting)", children: _jsx("input", { value: model, onChange: (e) => setModel(e.target.value), placeholder: "openai/gpt-oss-120b" }) }), _jsx(Field, { label: "API key: stored Fernet-encrypted (server needs NERDBOT_SECRET_KEY)", children: _jsx("input", { type: "password", value: apiKey, onChange: (e) => setApiKey(e.target.value), autoComplete: "off" }) }), _jsxs(Field, { label: "Or env var name holding the key", children: [_jsx("input", { value: apiKeyEnv, onChange: (e) => setApiKeyEnv(e.target.value), placeholder: "CLOUD_MODEL_KEY" }), _jsx("div", { className: "text-[var(--muted)]", style: { fontSize: 12, marginTop: 4 }, children: "Alternative to pasting a key. Never a NERDBOT_* name." })] }), error ? (_jsx("div", { className: ERROR_BOX, role: "alert", children: error })) : null, _jsx("div", { className: "flex items-center gap-3", style: { marginTop: 8 }, children: _jsx(Button, { variant: "primary", type: "submit", disabled: busy, children: busy ? "Connecting…" : "Connect" }) })] }));
}
