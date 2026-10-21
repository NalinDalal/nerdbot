import { useState } from "react";
import { api, describeError } from "../api";
import { notifyError } from "../app";
import { Provider, maskSecrets } from "../types";
import { Button, CARD_SHELL, CHIP_SHELL, ERROR_BOX, EmptyState, ErrorState, Field, LoadingState, Modal, StatusBadge, useAsync } from "../components";
export function ProvidersTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.listProviders(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  const health = useAsync(() => api.health(), [projectId]);

  return (
    <div>
      {health.data && health.data.secret_key === "absent" ? (
        <div className={ERROR_BOX} style={{ marginBottom: 12 }}>
          No <code>NERDBOT_SECRET_KEY</code> on this server: pasting an API key will be
          refused (we never store keys in the clear). Start the server with a Fernet key to
          enable BYOK — the <code>api_key_env</code> path keeps working meanwhile.
        </div>
      ) : null}
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          New model connection
        </Button>
        <Button onClick={list.reload}>Refresh</Button>
      </div>
      {showCreate ? (
        <Modal title="New model connection" onClose={() => setShowCreate(false)}>
          <ProviderForm
            projectId={projectId}
            onDone={() => {
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
      ) : list.data && list.data.providers.length > 0 ? (
        list.data.providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} onChanged={list.reload} />
        ))
      ) : (
        <EmptyState
          title="No model connections"
          hint="Bots need a brain: connect one openai-compatible provider (Groq, OpenRouter, OpenAI, Kimi…) above. Keys are stored Fernet-encrypted, or referenced via an env var name."
        />
      )}
    </div>
  );
}

const BASE_URL_PRESETS: Array<{ label: string; url: string }> = [
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "Kimi (Moonshot)", url: "https://api.moonshot.cn/v1" },
];

function providerModelName(config: Record<string, unknown>): string {
  return typeof config.model === "string" ? config.model : "";
}

function ProviderCard({ provider, onChanged }: { provider: Provider; onChanged: () => void }) {
  const [showModels, setShowModels] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const disabled = provider.status !== "active";

  return (
    <div className={CARD_SHELL} style={disabled ? { opacity: 0.6 } : undefined}>
      <div className="flex items-center gap-3" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{provider.name || provider.id}</strong> <span className="mono text-[var(--muted)]">{provider.kind}</span>{" "}
          <StatusBadge status={provider.status} />
          {providerModelName(provider.config) ? (
            <span className={CHIP_SHELL}>{providerModelName(provider.config)}</span>
          ) : (
            <span className={`${CHIP_SHELL} text-[var(--muted)]`}>no model set</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => setShowModels(true)}>Models</Button>
          <Button onClick={() => setShowEdit(true)}>Edit</Button>
          <Button
            onClick={async () => {
              try {
                await api.patchProvider(provider.id, {
                  status: disabled ? "active" : "disabled",
                });
                onChanged();
              } catch (err) {
                notifyError(err);
              }
            }}
          >
            {disabled ? "Enable" : "Disable"}
          </Button>
        </div>
      </div>
      <div className="mono text-[var(--muted)]" style={{ marginTop: 8 }}>
        {provider.id} · {String(provider.config.base_url ?? "")}
        {typeof provider.config.api_key === "string" && provider.config.api_key ? (
          <> · key <code>{String(maskSecrets(provider.config).api_key)}</code></>
        ) : typeof provider.config.api_key_env === "string" && provider.config.api_key_env ? (
          <> · key env <code>{provider.config.api_key_env}</code></>
        ) : null}
      </div>
      {showModels ? (
        <Modal title={`Models · ${provider.name || provider.id}`} onClose={() => setShowModels(false)}>
          <ModelCatalogPicker provider={provider} onDone={() => setShowModels(false)} />
        </Modal>
      ) : null}
      {showEdit ? (
        <Modal title="Edit connection" onClose={() => setShowEdit(false)}>
          <EditProviderForm provider={provider} onDone={() => { setShowEdit(false); onChanged(); }} />
        </Modal>
      ) : null}
    </div>
  );
}

function ModelCatalogPicker({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const list = useAsync(() => api.providerModels(provider.id), [provider.id]);
  const [applying, setApplying] = useState<string | null>(null);
  const current = providerModelName(provider.config);

  return (
    <div>
      {list.loading ? <LoadingState lines={4} /> : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {list.data?.models.map((model) => (
            <div className="flex items-center gap-3" key={model} style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span className="mono" style={model === current ? { fontWeight: 700 } : undefined}>
                {model === current ? `${model} (current)` : model}
              </span>
              <Button
                disabled={model === current || applying !== null}
                onClick={async () => {
                  setApplying(model);
                  try {
                    await api.patchProvider(provider.id, { config: { model } });
                    onDone();
                  } catch (err) {
                    notifyError(err);
                  } finally {
                    setApplying(null);
                  }
                }}
              >
                {applying === model ? "Setting…" : "Use"}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="text-[var(--muted)]" style={{ marginTop: 8 }}>
        Fetched live from the provider's <code>/models</code>; picking one rewrites this connection's model.
      </div>
    </div>
  );
}

function EditProviderForm({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(typeof provider.config.base_url === "string" ? provider.config.base_url : "");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setBusy(true);
        const body: Record<string, unknown> = { name, config: { base_url: baseUrl } };
        if (apiKey) body.config = { ...(body.config as Record<string, unknown>), api_key: apiKey };
        try {
          await api.patchProvider(provider.id, body);
          onDone();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Base URL">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="API key — leave empty to keep the current one" error={error ?? undefined}>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      </Field>
      <div className="flex items-center gap-3" style={{ marginTop: 8 }}>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function ProviderForm({ projectId, onDone }: { projectId?: string; onDone?: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(BASE_URL_PRESETS[0].url);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyPreset = (label: string) => {
    const preset = BASE_URL_PRESETS.find((p) => p.label === label);
    if (preset) {
      setPresetLabel(label);
      setBaseUrl(preset.url);
    }
  };
  const [presetLabel, setPresetLabel] = useState(BASE_URL_PRESETS[0].label);

  return (
    <form
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setBusy(true);
        const target = projectId;
        if (!target) {
          setError("Project ID required");
          setBusy(false);
          return;
        }
        const config: Record<string, string> = {};
        if (baseUrl) config.base_url = baseUrl;
        if (model) config.model = model;
        if (apiKey) config.api_key = apiKey;
        if (apiKeyEnv) config.api_key_env = apiKeyEnv;
        try {
          await api.createProvider(target, { kind: "openai-compatible", name, config });
          onDone?.();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {projectId ? null : <input type="hidden" />}
      <Field label="Preset">
        <select value={presetLabel} onChange={(e) => applyPreset(e.target.value)}>
          {BASE_URL_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom (edit base URL)</option>
        </select>
      </Field>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="groq" />
      </Field>
      <Field label="Base URL">
        <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="Model (you can pick from the catalog after connecting)">
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-oss-120b" />
      </Field>
      <Field label="API key — stored Fernet-encrypted (server needs NERDBOT_SECRET_KEY)">
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Or env var name holding the key" >
        <input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="CLOUD_MODEL_KEY" />
        <div className="text-[var(--muted)]" style={{ fontSize: 12, marginTop: 4 }}>
          Alternative to pasting a key. Never a NERDBOT_* name.
        </div>
      </Field>
      {error ? (
        <div className={ERROR_BOX} role="alert">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-3" style={{ marginTop: 8 }}>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </form>
  );
}
