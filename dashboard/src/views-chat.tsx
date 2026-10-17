import { useState } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { notifyError } from "./app";
import type { ChatMessage, ChatThread } from "./types";
import { EmptyState, ErrorState, LoadingState, ShortId, useAsync } from "./components";
import { EntityForm } from "./forms";

export function ChatHome({ projects, onOpen }: { projects: string[]; onOpen: (id: string) => void }) {
  const [projectId, setProjectId] = useState(projects[0] ?? "");
  const [manualId, setManualId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(projects[0] ?? null);

  const talk = () => {
    const trimmed = (manualId.trim() || projectId).trim();
    if (!trimmed) return;
    onOpen(trimmed);
    setProjectId(trimmed);
    setActiveId(trimmed);
  };

  return (
    <div>
      <h1>Chat</h1>
      <p className="subtitle">Talk to NerdBot. Pick a project to begin — no setup needed.</p>
      <div className="row" style={{ marginBottom: 16 }}>
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setManualId("");
          }}
          aria-label="Chat project"
          style={{ maxWidth: 300 }}
        >
          <option value="">Select a project…</option>
          {projects.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <input
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          placeholder="or paste prj_…"
          aria-label="Project ID"
          style={{ maxWidth: 260 }}
        />
        <button className="primary" onClick={talk}>
          Talk
        </button>
      </div>
      {activeId ? (
        <ChatView projectId={activeId} />
      ) : (
        <EmptyState title="No project selected" hint="Choose or paste a project ID to start chatting." />
      )}
    </div>
  );
}

export function ChatView({ projectId }: { projectId: string }) {
  const threads = useAsync(() => api.listThreads(projectId), [projectId]);
  const providers = useAsync(() => api.listProviders(projectId), [projectId]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setShowNew(true)}>
          New thread
        </button>
        <button onClick={threads.reload}>Refresh</button>
      </div>
      {showNew ? (
        <div className="card">
          <EntityForm
            submitLabel="Start thread"
            fields={[{ name: "title", label: "Title", placeholder: "Evening check-in" }]}
            onSubmit={async (values) => {
              const thread = await api.createThread(projectId, values);
              setShowNew(false);
              threads.reload();
              setActiveId(thread.id);
            }}
          />
        </div>
      ) : null}
      <div className="grid2">
        <div>
          <h2 style={{ marginTop: 0 }}>Threads</h2>
          {threads.loading ? (
            <LoadingState />
          ) : threads.error ? (
            <ErrorState error={threads.error} onRetry={threads.reload} />
          ) : threads.data && threads.data.threads.length > 0 ? (
            threads.data.threads.map((thread: ChatThread) => (
              <div className="card" key={thread.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <strong>{thread.title || "Untitled"}</strong>
                    <div className="muted mono" style={{ fontSize: 12 }}>
                      {thread.id}
                      {thread.provider_id ? ` · model ${thread.provider_id.slice(0, 12)}…` : ""}
                    </div>
                  </div>
                  <button onClick={() => setActiveId(thread.id)}>Open</button>
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No threads" hint="Start one to talk to NerdBot." />
          )}
        </div>
        <div>
          {activeId ? (
            <ThreadPane
              key={activeId}
              threadId={activeId}
              providers={providers.data?.providers ?? []}
              onSwitched={() => threads.reload()}
            />
          ) : (
            <EmptyState title="No thread selected" hint="Pick a thread to read and reply." />
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadPane({
  threadId,
  providers,
  onSwitched,
}: {
  threadId: string;
  providers: { id: string; name: string; kind: string }[];
  onSwitched: () => void;
}) {
  const view = useAsync(() => api.threadView(threadId, 50), [threadId]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [useStream, setUseStream] = useState(true);
  const [providerId, setProviderId] = useState("__default__");
  void providers;
  void onSwitched;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setStreaming("");
    try {
      if (useStream) {
        await api.sendChatStream(threadId, content, (chunk) => {
          setStreaming((prev) => prev + chunk);
        });
      } else {
        await api.sendChat(threadId, content);
      }
      setDraft("");
      view.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
      setStreaming("");
    }
  };

  const switchProvider = async (id: string) => {
    setProviderId(id);
    try {
      await api.updateThread(threadId, { provider_id: id === "__default__" ? null : id });
      onSwitched();
    } catch (err) {
      notifyError(err);
    }
  };

  const summarize = async () => {
    setBusy(true);
    try {
      const updated = await api.summarizeThread(threadId);
      toast.success("Summary saved");
      void updated;
      view.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <select
          value={providerId}
          onChange={(e) => void switchProvider(e.target.value)}
          aria-label="Model provider"
          style={{ maxWidth: 260 }}
        >
          <option value="__default__">Default model</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} ({provider.kind})
            </option>
          ))}
        </select>
        <label className="muted" style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={useStream}
            onChange={(e) => setUseStream(e.target.checked)}
            style={{ width: "auto", marginRight: 4 }}
          />
          Stream
        </label>
        <button onClick={view.reload}>Refresh</button>
        <button onClick={() => void summarize()} disabled={busy}>
          Summarize thread
        </button>
      </div>
      {view.data?.thread.summary ? (
        <div className="card">
          <div className="muted" style={{ fontSize: 12 }}>Summary (recalled by other threads)</div>
          <div>{view.data.thread.summary}</div>
        </div>
      ) : null}
      {view.loading ? (
        <LoadingState lines={5} />
      ) : view.error || !view.data ? (
        <ErrorState error={view.error ?? "Thread not found"} onRetry={view.reload} />
      ) : (
        <MessageList messages={view.data.messages} streaming={streaming} />
      )}
      <form onSubmit={send} style={{ marginTop: 12 }}>
        <div className="row">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Talk to NerdBot…"
            aria-label="Chat message"
            disabled={busy}
          />
          <button className="primary" type="submit" disabled={busy || !draft.trim()}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageList({ messages, streaming }: { messages: ChatMessage[]; streaming: string }) {
  if (messages.length === 0 && !streaming) {
    return <EmptyState title="Empty thread" hint="Say hello to begin." />;
  }
  return (
    <div>
      {messages.map((message) => (
        <div className="card" key={message.id}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            {message.role} · <ShortId id={message.id} />
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
        </div>
      ))}
      {streaming ? (
        <div className="card" aria-live="polite">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            assistant · streaming…
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{streaming}</div>
        </div>
      ) : null}
    </div>
  );
}
