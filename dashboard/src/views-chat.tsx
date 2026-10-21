import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { notifyError, describeError } from "./app";
import type { ChatMessage, ChatThread, Teammate } from "./types";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  useAsync,
  Field,
  StatusBadge,
} from "./components";

export function ConversationView({
  projectId,
  initialThreadId,
  onSetActiveThread,
}: {
  projectId?: string;
  initialThreadId?: string | null;
  onSetActiveThread?: (id: string | null) => void;
}) {
  const home = useAsync(() => api.getHome(), []);
  const resolvedProjectId = projectId ?? (home.data?.id ?? "");
  const threads = useAsync(
    () => (resolvedProjectId ? api.listThreads(resolvedProjectId) : Promise.resolve({ threads: [] })),
    [resolvedProjectId],
  );
  const providers = useAsync(
    () => (resolvedProjectId ? api.listProviders(resolvedProjectId) : Promise.resolve({ providers: [] })),
    [resolvedProjectId],
  );
  const [activeId, setActiveId] = useState<string | null>(initialThreadId ?? null);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (activeId) onSetActiveThread?.(activeId);
  }, [activeId, onSetActiveThread]);

  if (!resolvedProjectId) {
    return <LoadingState lines={2} />;
  }

  const isHome = !projectId;
  const filtered = (threads.data?.threads ?? []).filter(
    (t) => !search || t.title.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="conversation">
      <div className="conversation-header">
        <div>
          <h1>{isHome ? "Home" : "Project conversation"}</h1>
          <p className="subtitle">
            {isHome
              ? "Your default personal conversation. Projects are optional."
              : "Scoped to this project's workspace — files, tasks, and teammates stay with it."}
          </p>
        </div>
        <div className="header-actions">
          <button className="primary" onClick={() => setShowNew(true)} disabled={!home.data}>
            New chat
          </button>
        </div>
      </div>
      <div className="conversation-body">
        <aside className="conversation-sidebar">
          <div className="field" style={{ marginBottom: 10 }}>
            <input
              className="search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
            />
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Recent conversations
          </div>
          <div className="recent-list">
            {threads.loading ? (
              <LoadingState lines={3} />
            ) : threads.error ? (
              <div className="error-box" style={{ padding: 8, fontSize: 12 }}>
                {describeError(threads.error)}
              </div>
            ) : filtered.length === 0 ? (
              <div className="muted" style={{ fontSize: 12, padding: 8 }}>No conversations yet</div>
            ) : null}
            {filtered.map((thread: ChatThread) => (
              <div
                key={thread.id}
                className={`thread-item${activeId === thread.id ? " active" : ""}`}
                onClick={() => {
                  setActiveId(thread.id);
                  onSetActiveThread?.(thread.id);
                }}
                title={thread.title || "Untitled"}
              >
                <div className="thread-title">{thread.title || "Untitled"}</div>
                <div className="thread-meta mono muted">
                  {thread.id.slice(0, 12)}…
                </div>
              </div>
            ))}
          </div>
        </aside>
        <section className="conversation-main">
          {activeId ? (
            <ThreadPane
              threadId={activeId}
              projectId={resolvedProjectId}
              providers={providers.data?.providers ?? []}
              onReload={() => threads.reload()}
            />
          ) : (
            <EmptyState
              title="Select a conversation"
              hint="Pick a recent chat or start a new one."
              action={
                <button className="primary" onClick={() => setShowNew(true)}>
                  New chat
                </button>
              }
            />
          )}
        </section>
      </div>
      {showNew ? (
        <NewThreadModal
          projectId={resolvedProjectId}
          providers={providers.data?.providers ?? []}
          onClose={() => setShowNew(false)}
          onCreated={(thread) => {
            setShowNew(false);
            threads.reload();
            setActiveId(thread.id);
          }}
        />
      ) : null}
    </div>
  );
}

function NewThreadModal({
  projectId,
  providers,
  onClose,
  onCreated,
}: {
  projectId: string;
  providers: { id: string; name: string; kind: string }[];
  onClose: () => void;
  onCreated: (thread: ChatThread) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const thread = await api.createThread(projectId, { title: title.trim() });
      onCreated(thread);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New chat" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create(); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Evening check-in"
            autoFocus
          />
        </Field>
        <Field label="Model provider">
          <select value="__default__" disabled style={{ width: 320 }}>
            <option value="__default__">Default model</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.kind})
              </option>
            ))}
          </select>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            The default provider is used for this thread. Change it later in the thread header.
          </div>
        </Field>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Start chat"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ThreadPane({
  threadId,
  projectId,
  providers,
  onReload,
}: {
  threadId: string;
  projectId: string;
  providers: { id: string; name: string; kind: string }[];
  onReload: () => void;
}) {
  const view = useAsync(() => api.threadView(threadId, 50), [threadId]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [useStream, setUseStream] = useState(true);
  const [retryFrom, setRetryFrom] = useState<string | null>(null);
  const [execView, setExecView] = useState<{ kind: "task"; taskId: string } | null>(null);
  const [contextPanel, setContextPanel] = useState<{ kind: "files" | "bots" } | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; content: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const providerId = view.data?.thread.provider_id ?? "__default__";

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setStreaming("");
    setRetryFrom(null);
    try {
      let fullContent = content;
      if (attachedFiles.length > 0) {
        const fileText = attachedFiles.map((f) => `\n\n[Attachment: ${f.name}]\n${f.content}`).join("");
        fullContent = content + fileText;
        setAttachedFiles([]);
      }
      if (useStream) {
        await api.sendChatStream(threadId, fullContent, (chunk) => {
          setStreaming((prev) => prev + chunk);
        });
      } else {
        await api.sendChat(threadId, fullContent);
      }
      setDraft("");
      await onReload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
      setStreaming("");
    }
  };

  const stop = () => {
    setBusy(false);
    setStreaming("");
    toast.info("Stopped streaming");
  };

  const retry = async () => {
    if (!view.data) return;
    const target = retryFrom ?? view.data.messages[view.data.messages.length - 1]?.id;
    if (!target) return;
    setBusy(true);
    setStreaming("");
    try {
      const content = view.data.messages.find((m) => m.id === target)?.content ?? "";
      if (useStream) {
        await api.sendChatStream(threadId, content, (chunk) => {
          setStreaming((prev) => prev + chunk);
        });
      } else {
        await api.sendChat(threadId, content);
      }
      setRetryFrom(null);
      await onReload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
      setStreaming("");
    }
  };

  const switchProvider = async (id: string) => {
    try {
      await api.updateThread(threadId, { provider_id: id === "__default__" ? null : id });
      onReload();
      view.reload();
    } catch (err) {
      notifyError(err);
      view.reload();
    }
  };

  const summarize = async () => {
    setBusy(true);
    try {
      await api.summarizeThread(threadId);
      toast.success("Summary saved");
      view.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  const createTaskFromChat = async () => {
    if (!view.data) return;
    const last = view.data.messages[view.data.messages.length - 1];
    if (!last) return;
    const description = `From chat: ${last.content.slice(0, 120)}`;
    try {
      const task = await api.createTask(projectId, {
        description,
        owner_teammate_id: null,
      });
      toast.success("Task created");
      setExecView({ kind: "task", taskId: task.id });
      await onReload();
    } catch (err) {
      notifyError(err);
    }
  };

  const openContext = (type: { kind: "files" | "bots" }) => {
    setContextPanel(type);
  };

  const closeContext = () => setContextPanel(null);

  const closeExec = () => setExecView(null);

  const handleAttachFile = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      promises.push(
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            setAttachedFiles((prev) => [...prev, { name: file.name, content: String(reader.result ?? "") }]);
            resolve();
          };
          reader.onerror = () => resolve();
          reader.readAsText(file);
        }),
      );
    }
    Promise.all(promises).then(() => {
      e.target.value = "";
    });
  };

  const handleBotSelect = (teammateId: string) => {
    setContextPanel(null);
    window.location.hash = `#/bot/${teammateId}`;
  };

  return (
    <div className="thread-pane">
      <div className="thread-header">
        <div>
          <strong className="thread-title">{view.data?.thread.title || "Untitled"}</strong>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
            {view.data?.thread.id.slice(0, 14)}…
            {view.data?.thread.provider_id ? ` · ${view.data.thread.provider_id.slice(0, 10)}…` : ""}
          </div>
        </div>
        <div className="thread-controls">
          <select
            value={providerId}
            onChange={(e) => void switchProvider(e.target.value)}
            aria-label="Model provider"
            style={{ fontSize: 12, padding: "4px 8px" }}
          >
            <option value="__default__">Default model</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.kind})
              </option>
            ))}
          </select>
          <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", marginLeft: 10 }}>
            <input
              type="checkbox"
              checked={useStream}
              onChange={(e) => setUseStream(e.target.checked)}
              style={{ width: "auto" }}
            />
            Stream
          </label>
          <button onClick={view.reload} style={{ fontSize: 12, padding: "4px 10px", marginLeft: 6 }}>
            Refresh
          </button>
          <button onClick={summarize} disabled={busy} style={{ fontSize: 12, padding: "4px 10px", marginLeft: 6 }}>
            Summarize
          </button>
          <button
            onClick={() => openContext({ kind: "files" })}
            title="Project files"
            style={{ fontSize: 12, padding: "4px 10px", marginLeft: 6 }}
          >
            Files
          </button>
          <button
            onClick={() => openContext({ kind: "bots" })}
            title="Teammates / bots"
            style={{ fontSize: 12, padding: "4px 10px", marginLeft: 6 }}
          >
            Bots
          </button>
        </div>
      </div>

      {view.data?.thread.summary ? (
        <div className="summary-card">
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Summary (recalled by other threads)</div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{view.data.thread.summary}</div>
        </div>
      ) : null}

      {execView && (
        <ExecutionView
          state={execView}
          onClose={closeExec}
        />
      )}

      <div className="message-list">
        {view.loading ? (
          <LoadingState lines={4} />
        ) : view.error ? (
          <ErrorState error={view.error} onRetry={view.reload} />
        ) : view.data ? (
          <>
            {view.data.messages.length === 0 && !streaming ? (
              <EmptyState title="Empty conversation" hint="Say hello to begin." />
            ) : null}
            {view.data.messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {streaming ? (
              <Message
                key="streaming"
                message={{
                  id: "streaming",
                  thread_id: threadId,
                  role: "assistant",
                  content: streaming,
                  created_at: "",
                }}
                streaming
              />
            ) : null}
          </>
        ) : null}
      </div>

      <form onSubmit={send} className="composer-form">
        <div className="composer">
          <div className="composer-input-wrap">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Talk to NerdBot…"
              aria-label="Chat message"
              disabled={busy}
              spellCheck
              autoComplete="off"
            />
            {attachedFiles.length > 0 && (
              <div className="attached-list">
                {attachedFiles.map((f, i) => (
                  <div key={i} className="attached-item">
                    <span className="mono muted" style={{ fontSize: 11 }}>{f.name}</span>
                    <button
                      onClick={() => setAttachedFiles(attachedFiles.filter((_, j) => j !== i))}
                      className="danger"
                      style={{ padding: "2px 6px", fontSize: 11, marginLeft: 4 }}
                    >
                      remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer-left-actions">
              <button
                type="button"
                onClick={() => openContext({ kind: "files" })}
                title="Attach project files"
                style={{ padding: "6px 10px", fontSize: 12, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: "6px", cursor: "pointer" }}
              >
                Files
              </button>
              <button
                type="button"
                onClick={handleAttachFile}
                title="Attach local file"
                style={{ padding: "6px 10px", fontSize: 12, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: "6px", cursor: "pointer", marginLeft: 6 }}
              >
                Attach
              </button>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: "none" }}
                onChange={handleFileSelect}
                multiple
              />
            </div>
          </div>
          <div className="composer-actions">
            {busy ? (
              <button className="danger" onClick={stop} title="Stop streaming">
                Stop
              </button>
            ) : (
              <>
                {retryFrom ? (
                  <button className="" onClick={retry} title="Retry last message">
                    Retry
                  </button>
                ) : null}
                <button
                  className="primary"
                  type="submit"
                  disabled={!draft.trim() || busy}
                >
                  Send
                </button>
              </>
            )}
            <button
              className=""
              onClick={createTaskFromChat}
              title="Create a task from this conversation"
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              Task
            </button>
          </div>
        </div>
      </form>

      {contextPanel && (
        <ContextPanel
          type={contextPanel.kind}
          projectId={projectId}
          onClose={closeContext}
          onSelectBot={handleBotSelect}
        />
      )}
    </div>
  );
}

function Message({
  message,
  streaming = false,
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  return (
    <div className={`message ${isUser ? "message-user" : "message-assistant"}${streaming ? " streaming" : ""}`}>
      <div className="message-meta">
        <span className="mono muted" style={{ fontSize: 11 }}>{message.role}</span>
        {streaming ? <span className="mono muted" style={{ fontSize: 11, marginLeft: 6 }}>streaming…</span> : null}
      </div>
      <div className="message-content" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {message.content}
      </div>
    </div>
  );
}

function ExecutionView({
  state,
  onClose,
}: {
  state: { kind: "task"; taskId: string };
  onClose: () => void;
}) {
  const view = useAsync(() => api.taskView(state.taskId), [state.taskId]);
  const [poll, setPoll] = useState(0);

  useEffect(() => {
    if (!view.data || (view.data.task.status !== "done" && view.data.task.status !== "failed" && view.data.task.status !== "blocked")) {
      const t = setTimeout(() => setPoll((n) => n + 1), 3000);
      return () => clearTimeout(t);
    }
  }, [view.data, poll]);

  const task = view.data?.task;
  const runs = view.data?.runs ?? [];
  const artifacts = view.data?.artifacts ?? [];
  const latestRun = runs[runs.length - 1];

  return (
    <div className="execution-view">
      <div className="execution-header">
        <span className="mono muted" style={{ fontSize: 11 }}>Execution</span>
        <button onClick={onClose} className="muted" style={{ fontSize: 11, padding: 0, background: "none", border: "none", cursor: "pointer" }}>
          Close
        </button>
      </div>
      <div className="execution-body">
        <div className="execution-task">
          <strong>Task</strong>
          <div className="mono muted" style={{ fontSize: 12 }}>{task?.description || ""}</div>
          <div style={{ marginTop: 6 }}>
            <StatusBadge status={task?.status || "pending"} />
            {latestRun && (
              <span style={{ marginLeft: 8, fontSize: 12, color: "var(--muted)" }}>
                run {latestRun.status}
              </span>
            )}
          </div>
        </div>
        {latestRun && (
          <div className="execution-run">
            <strong>Last run</strong>
            <div className="mono muted" style={{ fontSize: 12 }}>{latestRun.command || "(no command)"}</div>
            <div style={{ marginTop: 4 }}>
              <span className="mono muted" style={{ fontSize: 11 }}>{latestRun.output_excerpt?.slice(0, 200) || "(no output)"}</span>
            </div>
          </div>
        )}
        {artifacts.length > 0 && (
          <div className="execution-artifacts">
            <strong>Artifacts</strong>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {artifacts.map((art) => (
                <div key={art.id} className="artifact-item">
                  <div className="mono muted" style={{ fontSize: 12 }}>{art.type} · {art.location}</div>
                  <div style={{ marginTop: 4 }}>{art.summary}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!task && view.loading ? (
          <LoadingState lines={2} />
        ) : null}
      </div>
    </div>
  );
}

function ContextPanel({
  type,
  projectId,
  onClose,
  onSelectBot,
}: {
  type: "files" | "bots";
  projectId: string;
  onClose: () => void;
  onSelectBot: (teammateId: string) => void;
}) {
  const data = useAsync(
    () => (type === "bots" ? api.listTeammates(projectId) : Promise.resolve({ teammates: [] })),
    [projectId, type],
  );

  return (
    <div className="context-panel-backdrop" onClick={onClose}>
      <div className="context-panel" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <strong>{type === "bots" ? "Teammates / bots" : "Project files"}</strong>
          <button onClick={onClose} aria-label="Close">Close</button>
        </div>
        {type === "bots" && data ? (
          data.loading ? (
            <LoadingState lines={3} />
          ) : data.error ? (
            <ErrorState error={data.error} onRetry={data.reload} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(data.data?.teammates ?? []).map((mate: Teammate) => (
                <div key={mate.id} className="context-item">
                  <div>
                    <div style={{ fontWeight: 600 }}>{mate.persona || mate.id}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>{mate.instructions?.slice(0, 80) || ""}</div>
                  </div>
                  <button
                    onClick={() => onSelectBot(mate.id)}
                    className="primary"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                  >
                    Select
                  </button>
                </div>
              ))}
            </div>
          )
        ) : null}
        {type === "files" && (
          <div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
              Attach files from an active task workspace. Open a task from the execution view first.
            </div>
            <button
              onClick={onClose}
              style={{ padding: "6px 12px", fontSize: 12, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: "6px", cursor: "pointer" }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

