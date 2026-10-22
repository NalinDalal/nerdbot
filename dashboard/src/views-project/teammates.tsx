import { useState } from "react";
import { api, describeError } from "../api";
import { notifyError } from "../app";
import { FacePicker } from "../bot/FacePicker";
import { DEFAULT_FACE, normalizeFace, type BotFace as FaceChoice } from "../bot/face";
import { faceStateFor } from "../bot/status";
import { Provider, Teammate as TeammateT } from "../types";
import { BotFace, Button, CARD_SHELL, ERROR_BOX, EmptyState, ErrorState, Field, LoadingState, Modal, PILL_SHELL, StatusBadge, useAsync, usePermissionCatalogue } from "../components";
export function TeammatesTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.listTeammates(projectId), [projectId]);
  const providers = useAsync(() => api.listProviders(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          New bot
        </Button>
        <Button onClick={list.reload}>Refresh</Button>
      </div>
      {showCreate ? (
        <Modal title="New bot" onClose={() => setShowCreate(false)}>
          <BotForm
            projectId={projectId}
            providers={providers.data?.providers ?? []}
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
      ) : list.data && list.data.teammates.length > 0 ? (
        list.data.teammates.map((mate) => (
          <BotCard
            key={mate.id}
            mate={mate}
            providers={providers.data?.providers ?? []}
            onChanged={() => {
              list.reload();
              providers.reload();
            }}
          />
        ))
      ) : (
        <EmptyState
          title="No bots yet"
          hint="Create a bot with a persona and instructions, then attach a model connection so it can think. Bots own and run tasks."
        />
      )}
    </div>
  );
}

function BotCard({
  mate,
  providers,
  onChanged,
}: {
  mate: TeammateT;
  providers: Provider[];
  onChanged: () => void;
}) {
  const [showAttach, setShowAttach] = useState(false);
  const [showPerms, setShowPerms] = useState(false);
  const [showFace, setShowFace] = useState(false);
  const [faceDraft, setFaceDraft] = useState<FaceChoice>(DEFAULT_FACE);
  const catalogue = usePermissionCatalogue();
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (err) {
      notifyError(err);
    }
  };
  const attached = providers.find((p) => p.id === mate.provider_id);

  return (
    <div className={CARD_SHELL}>
      <div className="flex items-center gap-3" style={{ justifyContent: "space-between" }}>
        <div className="flex items-center gap-2.5">
          <BotFace face={mate.face} size={32} state={faceStateFor(mate.status)} />
          <div>
            <strong>{mate.persona || "Unnamed bot"}</strong>{" "}
            <span className="mono text-[var(--muted)]">{mate.id}</span> <StatusBadge status={mate.status} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => setShowAttach(true)}>
            {attached ? "Switch model" : "Attach model"}
          </Button>
          <Button onClick={() => setShowPerms(true)}>Permissions</Button>
          <Button
            onClick={() => {
              setFaceDraft(normalizeFace(mate.face));
              setShowFace(true);
            }}
          >
            Face
          </Button>
          <Button onClick={() => void act(() => api.disableTeammate(mate.id))}>Disable</Button>
          <Button onClick={() => void act(() => api.archiveTeammate(mate.id))}>Archive</Button>
        </div>
      </div>
      <div className="text-[var(--muted)]">{mate.instructions || "No instructions yet."}</div>
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span className="mono text-[var(--muted)]" style={{ fontSize: 12 }}>
          memory: {mate.memory_scope}
        </span>
        {(mate.permissions ?? []).length === 0 ? (
          <span className={PILL_SHELL} title="No permissions: every gated tool call is denied.">
            no permissions
          </span>
        ) : (
          mate.permissions.map((perm) => (
            <span
              className={PILL_SHELL}
              key={perm}
              title={
                catalogue.isAdmin(perm)
                  ? "admin (approval-gated)"
                  : catalogue.byName.has(perm)
                    ? "agent permission"
                    : "unknown permission — grants nothing"
              }
            >
              {perm}
            </span>
          ))
        )}
        {Object.keys(mate.tool_policy ?? {}).length > 0
          ? Object.entries(mate.tool_policy).map(([tool, mode]) => (
              <span className={PILL_SHELL} key={tool} title={`tool_policy.${tool}`}>
                {tool}: {String(mode)}
              </span>
            ))
          : null}
      </div>
      <div className="mono text-[var(--muted)]" style={{ marginTop: 8 }}>
        brain:{" "}
        {attached ? (
          <>
            {attached.name} · {String(attached.config.model ?? "model not set")}
          </>
        ) : mate.provider_id ? (
          <>{mate.provider_id} (connection not found)</>
        ) : (
          <span style={{ color: "#b58a00" }}>none — the bot cannot think until one is attached</span>
        )}
      </div>
      {showAttach ? (
        <Modal title={`Model for ${mate.persona || mate.id}`} onClose={() => setShowAttach(false)}>
          {providers.length === 0 ? (
            <div className={ERROR_BOX}>
              This project has no model connections yet — create one under the{" "}
              <strong>Providers</strong> tab first.
            </div>
          ) : (
            <div>
              {providers.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3"
                  style={{ justifyContent: "space-between", padding: "6px 0" }}
                >
                  <span>
                    <strong>{p.name || p.id}</strong>{" "}
                    <span className="mono text-[var(--muted)]">{String(p.config.model ?? "")}</span>
                    {mate.provider_id === p.id ? " (current)" : null}
                  </span>
                  <Button
                    onClick={() =>
                      void act(() => api.patchTeammate(mate.id, {
                        // current connection → explicit detach (null);
                        // another connection → attach it
                        provider_id: mate.provider_id === p.id ? null : p.id,
                      }))
                    }
                  >
                    {mate.provider_id === p.id ? "Detach" : "Attach"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
      {showFace ? (
        <Modal title={`Face of ${mate.persona || mate.id}`} onClose={() => setShowFace(false)}>
          <FacePicker value={faceDraft} onChange={setFaceDraft} compact />
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button onClick={() => setShowFace(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setShowFace(false);
                void act(() => api.patchTeammate(mate.id, { face: faceDraft }));
              }}
            >
              Save face
            </Button>
          </div>
        </Modal>
      ) : null}
      {showPerms ? (
        <Modal title={`Permissions for ${mate.persona || mate.id}`} onClose={() => setShowPerms(false)}>
          <PermissionsForm
            mate={mate}
            onSaved={() => {
              setShowPerms(false);
              onChanged();
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function PermissionsForm({ mate, onSaved }: { mate: TeammateT; onSaved: () => void }) {
  const [permissions, setPermissions] = useState<string[]>(mate.permissions ?? []);
  const [memoryScope, setMemoryScope] = useState(mate.memory_scope || "teammate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalogue = usePermissionCatalogue();
  const toggle = (perm: string) =>
    setPermissions((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]));

  const adminPerms = catalogue.permissions.filter((p) => p.kind === "admin");
  const agentPerms = catalogue.permissions.filter((p) => p.kind !== "admin");
  // A permission the bot holds but the server does not know is dead weight:
  // it grants nothing. Surface it instead of silently dropping it.
  const unknownHeld = permissions.filter((p) => !catalogue.byName.has(p));

  return (
    <form
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.patchTeammate(mate.id, { permissions, memory_scope: memoryScope });
          onSaved();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Memory scope — where this bot may read and write memory">
        <select value={memoryScope} onChange={(e) => setMemoryScope(e.target.value)}>
          <option value="teammate">teammate — only its own memory</option>
          <option value="project">project — shared workspace memory</option>
        </select>
      </Field>
      {catalogue.loading ? (
        <div className="text-[var(--muted)]" style={{ margin: "8px 0" }}>
          Loading the permission catalogue…
        </div>
      ) : catalogue.error ? (
        <div className={ERROR_BOX} role="alert">
          Could not load the permission catalogue: {describeError(catalogue.error)}
        </div>
      ) : null}
      <div className="text-[var(--muted)]" style={{ margin: "8px 0 4px" }}>
        Admin permissions are deny-by-default and need a human&apos;s exact-action approval even when granted.
      </div>
      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
        <legend className="mono text-[var(--muted)]" style={{ fontSize: 12 }}>
          admin (approval-gated)
        </legend>
        {adminPerms.map((perm) => (
          <label key={perm.name} style={{ display: "block" }} title={perm.summary}>
            <input type="checkbox" checked={permissions.includes(perm.name)} onChange={() => toggle(perm.name)} />{" "}
            {perm.name}
            <span className="text-[var(--muted)]" style={{ fontSize: 11 }}>
              {" "}
              — {perm.summary}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
        <legend className="mono text-[var(--muted)]" style={{ fontSize: 12 }}>
          agent
        </legend>
        {agentPerms.map((perm) => (
          <label key={perm.name} style={{ display: "block" }} title={perm.summary}>
            <input type="checkbox" checked={permissions.includes(perm.name)} onChange={() => toggle(perm.name)} />{" "}
            {perm.name}
            <span className="text-[var(--muted)]" style={{ fontSize: 11 }}>
              {" "}
              — {perm.summary}
            </span>
          </label>
        ))}
      </fieldset>
      {unknownHeld.length > 0 ? (
        <div className={ERROR_BOX} role="alert">
          This bot holds permission names the server does not know: {unknownHeld.join(", ")}. They grant
          nothing and will be rejected on save — remove them below.
          <div className="flex items-center gap-3" style={{ gap: 6, marginTop: 6 }}>
            {unknownHeld.map((p) => (
              <Button key={p} type="button" variant="danger" onClick={() => toggle(p)}>
                remove {p}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mono text-[var(--muted)]" style={{ fontSize: 12 }}>
        selected: {permissions.length ? permissions.join(", ") : "none"}
      </div>
      {error ? (
        <div className={ERROR_BOX} role="alert">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-3" style={{ marginTop: 8 }}>
        <Button variant="primary" type="submit" disabled={busy || catalogue.loading || unknownHeld.length > 0}>
          {busy ? "Saving…" : "Save permissions"}
        </Button>
      </div>
    </form>
  );
}

function BotForm({
  projectId,
  providers,
  onDone,
}: {
  projectId: string;
  providers: Provider[];
  onDone: () => void;
}) {
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? "");
  const [face, setFace] = useState<FaceChoice>(DEFAULT_FACE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (e: React.FormEvent) => {
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
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name (its job)">
        <input
          required
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder="coder"
        />
      </Field>
      <Field label="Instructions — how it should behave">
        <textarea
          rows={3}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Be terse. Show real command output. Ask before destructive steps."
        />
      </Field>
      <Field label="Capabilities (comma separated)">
        <input
          value={capabilities}
          onChange={(e) => setCapabilities(e.target.value)}
          placeholder="code, review"
        />
      </Field>
      <Field label="Face — the bot's own, changeable later">
        <FacePicker value={face} onChange={setFace} compact />
      </Field>
      <Field label="Model connection (change or detach later)">
        {providers.length === 0 ? (
          <div className="text-[var(--muted)]">No connections in this project yet — attach one after creating the bot.</div>
        ) : (
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">(attach later)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id} — {String(p.config.model ?? "")}
              </option>
            ))}
          </select>
        )}
      </Field>
      {error ? (
        <div className={ERROR_BOX} role="alert">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-3" style={{ marginTop: 8 }}>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create bot"}
        </Button>
      </div>
    </form>
  );
}
