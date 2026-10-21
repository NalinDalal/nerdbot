import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { api, ApiError } from "./api";
import { notifyError, navigate } from "./app";
import type { ChatMessage, ChatThread, Teammate } from "./types";
import { AttentionBanner, ExecutionRollup, useWorkspaceSummary } from "./views-home";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Button,
  Badge,
  Field,
  StatusBadge,
  StatusDot,
  SectionLabel,
  relativeTime,
  useAsync,
  taskStatusLabel,
  runStatusLabel,
} from "./components";

function openTask(projectId: string, taskId: string): void {
  window.location.hash = `#/p/${projectId}/t/${taskId}`;
}

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
  const summary = useWorkspaceSummary();
  const resolvedProjectId = projectId ?? (home.data?.id ?? "");
  const threads = useAsync(
    () =>
      resolvedProjectId
        ? api.listThreads(resolvedProjectId)
        : Promise.resolve({ threads: [] }),
    [resolvedProjectId],
  );
  const providers = useAsync(
    () =>
      resolvedProjectId
        ? api.listProviders(resolvedProjectId)
        : Promise.resolve({ providers: [] }),
    [resolvedProjectId],
  );
  // The Command Center resume list spans every project the owner owns, so a
  // conversation started in another workspace is still reachable from here.
  const recentThreads = useAsync(() => api.listRecentThreads(20), []);
  const [activeId, setActiveId] = useState<string | null>(initialThreadId ?? null);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [decideBusy, setDecideBusy] = useState(false);

  useEffect(() => {
    if (activeId) {
      onSetActiveThread?.(activeId);
    }
  }, [activeId, onSetActiveThread]);

  const decideApproval = async (
    approvalId: string,
    decision: "approved" | "approved_forever" | "denied",
  ) => {
    setDecideBusy(true);
    try {
      await api.decideApproval(approvalId, decision);
      toast.success(
        decision === "denied" ? "Rejected" : decision === "approved_forever" ? "Approved forever" : "Approved once",
      );
    } catch (err) {
      notifyError(err);
    } finally {
      setDecideBusy(false);
      // Refresh either way: a decision that failed (the approval may have
      // expired) must not leave a dead row on the banner.
      summary.reload();
    }
  };

  if (!resolvedProjectId) {
    return <LoadingState lines={2} />;
  }

  const isHome = !projectId;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      {/* Header. The mobile left padding reserves the gutter the fixed menu
          button floats in (app.tsx: `fixed left-3 top-3`), so "Home" is not
          painted underneath it. */}
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border-dim)] py-3 pl-14 pr-4 md:px-6">
        <div className="min-w-0">
          <h1 className="text-[var(--step-1)] font-semibold tracking-tight">
            {isHome ? "Home" : "Project conversation"}
          </h1>
          <p className="text-[var(--step-minus-1)] text-[var(--muted)]">
            {isHome
              ? "Your default personal conversation. Projects are optional."
              : "Scoped to this workspace — files, tasks, and teammates stay with it."}
          </p>
        </div>
        <Button variant="primary" onClick={() => setShowNew(true)} disabled={!home.data}>
          New chat
        </Button>
      </header>

      {/* Workspace-wide attention banner */}
      <div className="px-4 pt-3 md:px-6">
        {summary.loadFailed && !summary.loading ? (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--danger)]">
            <span>Couldn't load some fleet data — the Command Center below may be incomplete.</span>
            <Button onClick={summary.reload}>Retry</Button>
          </div>
        ) : null}
        <AttentionBanner
          summary={summary.data?.summary ?? null}
          busy={decideBusy}
          onDecide={decideApproval}
          onOpenTask={openTask}
        />
      </div>

      {/* Body: thread rail + active pane */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[280px] shrink-0 flex-col border-r border-[var(--border-dim)] md:flex">
          <div className="px-3 pt-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--step-minus-1)] outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          <div className="px-3 pb-1 pt-4">
            <SectionLabel>Recent conversations</SectionLabel>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-4 pt-1">
            {threads.loading ? (
              <LoadingState lines={3} />
            ) : threads.error ? (
              <ErrorState error={threads.error} onRetry={threads.reload} />
            ) : null}
            {(threads.data?.threads ?? [])
              .filter((t) => !search || t.title.toLowerCase().includes(search.toLowerCase()))
              .map((thread: ChatThread) => (
                <button
                  key={thread.id}
                  onClick={() => {
                    setActiveId(thread.id);
                    onSetActiveThread?.(thread.id);
                  }}
                  title={thread.title || "Untitled"}
                  className={`mb-0.5 flex w-full flex-col rounded-md px-2.5 py-2 text-left transition-colors ${
                    activeId === thread.id
                      ? "bg-[var(--surface-3)] text-[var(--text)]"
                      : "text-[var(--text-soft)] hover:bg-[var(--surface-2)]"
                  }`}
                >
                  <span className="truncate text-[var(--step-minus-1)] font-medium">
                    {thread.title || "Untitled"}
                  </span>
                  <span className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
                    {relativeTime(thread.created_at)}
                  </span>
                </button>
              ))}
            {threads.data && (threads.data.threads ?? []).length === 0 && !threads.loading ? (
              <p className="px-2.5 py-2 text-[var(--step-minus-1)] text-[var(--faint)]">
                No conversations yet
              </p>
            ) : null}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {activeId ? (
            <ThreadPane
              threadId={activeId}
              projectId={resolvedProjectId}
              providers={providers.data?.providers ?? []}
              onReload={() => threads.reload()}
            />
          ) : isHome ? (
            <CommandCenter
              summary={summary}
              projectId={resolvedProjectId}
              recentThreads={recentThreads.data?.threads ?? []}
              providers={providers.data?.providers ?? []}
              onNewChat={() => setShowNew(true)}
              onThreadCreated={(threadId) => {
                setActiveId(threadId);
                onSetActiveThread?.(threadId);
              }}
              onOpenThread={(thread) => {
                setActiveId(thread.id);
                onSetActiveThread?.(thread.id);
                if (thread.project_id !== resolvedProjectId) {
                  // The conversation lives in another workspace: switch the
                  // context so its messages, files and provider come from
                  // there rather than from the workspace we are looking at.
                  navigate(`#/chat/${thread.project_id}`);
                }
              }}
              refreshProviders={() => providers.reload()}
              refreshThreads={() => recentThreads.reload()}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center overflow-y-auto">
              <EmptyState
                title="Select a conversation"
                hint="Pick a recent chat or start a new one."
                action={
                  <Button variant="primary" onClick={() => setShowNew(true)}>
                    New chat
                  </Button>
                }
              />
              {/* The conversation rail is hidden below md, so without this the
                  list of existing conversations is unreachable on a narrow
                  screen. It is the same list, shown here instead. */}
              {(threads.data?.threads ?? []).length > 0 ? (
                <div className="mb-6 w-full max-w-[420px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] md:hidden">
                  {(threads.data?.threads ?? []).map((t, index) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setActiveId(t.id);
                        onSetActiveThread?.(t.id);
                      }}
                      aria-label={`Resume: ${t.title || "Untitled"}`}
                      className={`flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)] ${
                        index > 0 ? "border-t border-[var(--border-dim)]" : ""
                      }`}
                    >
                      <span className="truncate text-[var(--step-minus-1)] text-[var(--text)]">
                        {t.title || "Untitled"}
                      </span>
                      <span className="mono shrink-0 text-[var(--step-minus-2)] text-[var(--faint)]">
                        {relativeTime(t.created_at)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
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
            onSetActiveThread?.(thread.id);
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

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
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
      <form onSubmit={create} className="flex flex-col gap-2">
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Evening check-in"
            autoFocus
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
          />
        </Field>
        <Field label="Model provider">
          <select
            value="__default__"
            disabled
            aria-label="Model provider"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] opacity-70"
          >
            <option value="__default__">Default model</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.kind})
              </option>
            ))}
          </select>
          <p className="text-[var(--step-minus-1)] text-[var(--faint)]">
            The default provider is used for this thread. Change it later in the thread header.
          </p>
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Start chat"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* --- Inline model chip (landing composer) --- */

/** Grok-pattern model switcher: a quiet chip in the composer that opens a
 *  small menu, so model selection lives in the composer instead of buried
 *  in the thread header. */
function ModelChip({
  providers,
  value,
  onChange,
  disabled,
}: {
  providers: { id: string; name: string; kind: string }[];
  value: "__default__" | string;
  onChange: (id: "__default__" | string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = providers.find((p) => p.id === value);
  const label = current ? current.name : "Default model";
  const options: Array<{ id: "__default__" | string; label: string; kind?: string }> = [
    { id: "__default__", label: "Default model" },
    ...providers.map((p) => ({ id: p.id, label: p.name, kind: p.kind })),
  ];
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Model provider"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[var(--step-minus-1)] text-[var(--text-soft)] transition-colors hover:border-[var(--faint)] disabled:pointer-events-none disabled:opacity-50"
      >
        <span aria-hidden className="text-[var(--faint)]">Model:</span> {label}
        <span aria-hidden className="text-[var(--faint)]">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <>
          <div
            aria-hidden
            className="fixed inset-0 z-20"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label="Model provider options"
            className="absolute bottom-full right-0 z-30 mb-2 w-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg"
          >
            {options.map((option) => {
              const selected = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--step-minus-1)] transition-colors ${
                    selected
                      ? "bg-[var(--surface-3)] text-[var(--text)]"
                      : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                  }`}
                >
                  <span className="truncate">{option.label}</span>
                  {selected ? (
                    <span aria-hidden className="text-[var(--accent)]">✓</span>
                  ) : option.kind ? (
                    <span className="text-[var(--faint)]">{option.kind}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* --- Thread pane --- */

const PROVIDER_SELECT_CLASS =
  "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[var(--step-minus-1)] text-[var(--text-soft)] outline-none transition-colors hover:border-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";

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
  const [execView, setExecView] = useState<{ kind: "task"; taskId: string; projectId: string } | null>(null);
  const [contextPanel, setContextPanel] = useState<"files" | "bots" | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; content: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const providerId = view.data?.thread.provider_id ?? "__default__";

  /* Stick to the newest message while streaming. */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [view.data?.messages.length, streaming]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStreaming("");
    setRetryFrom(null);
    let stopped = false;
    try {
      let fullContent = content;
      if (attachedFiles.length > 0) {
        const fileText = attachedFiles
          .map((f) => `\n\n[Attachment: ${f.name}]\n${f.content}`)
          .join("");
        fullContent = content + fileText;
        setAttachedFiles([]);
      }
      if (useStream) {
        await api.sendChatStream(threadId, fullContent, (chunk) => {
          setStreaming((prev) => prev + chunk);
        }, { signal: controller.signal });
      } else {
        await api.sendChat(threadId, fullContent);
      }
      setDraft("");
      await onReload();
    } catch (err) {
      if (controller.signal.aborted && err instanceof ApiError && err.detail === "Stream stopped") {
        stopped = true;
        setStreaming((prev) => (prev ? `${prev}\n[stopped]` : ""));
      } else {
        notifyError(err);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      if (!stopped) setStreaming("");
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const retry = async () => {
    if (!view.data) return;
    const target = retryFrom ?? view.data.messages[view.data.messages.length - 1]?.id;
    if (!target) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStreaming("");
    let stopped = false;
    try {
      const content =
        view.data.messages.find((m) => m.id === target)?.content ?? "";
      if (useStream) {
        await api.sendChatStream(threadId, content, (chunk) => {
          setStreaming((prev) => prev + chunk);
        }, { signal: controller.signal });
      } else {
        await api.sendChat(threadId, content);
      }
      setRetryFrom(null);
      await onReload();
    } catch (err) {
      if (controller.signal.aborted && err instanceof ApiError && err.detail === "Stream stopped") {
        stopped = true;
        setStreaming((prev) => (prev ? `${prev}\n[stopped]` : ""));
      } else {
        notifyError(err);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      if (!stopped) setStreaming("");
    }
  };

  const switchProvider = async (id: string) => {
    try {
      await api.updateThread(threadId, {
        provider_id: id === "__default__" ? null : id,
      });
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
      toast.success("Task created — its live execution view is one click away.");
      openTask(projectId, task.id);
      await onReload();
    } catch (err) {
      notifyError(err);
    }
  };

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
            setAttachedFiles((prev) => [
              ...prev,
              { name: file.name, content: String(reader.result ?? "") },
            ]);
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Thread header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-dim)] px-4 py-2.5 md:px-6">
        <div className="min-w-0">
          <div className="truncate text-[var(--step-0)] font-semibold">
            {view.data?.thread.title || "Untitled"}
          </div>
          <div className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
            {relativeTime(view.data?.thread.created_at ?? "")}
            {view.data?.thread.provider_id ? ` · ${view.data.thread.provider_id.slice(0, 10)}…` : ""}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={providerId}
            onChange={(e) => void switchProvider(e.target.value)}
            aria-label="Model provider"
            className={PROVIDER_SELECT_CLASS}
          >
            <option value="__default__">Default model</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.kind})
              </option>
            ))}
          </select>
          <Button variant="ghost" onClick={view.reload} title="Refresh">
            ⟳
          </Button>
          <Button variant="ghost" onClick={summarize} disabled={busy} title="Summarize thread">
            Summarize
          </Button>
          <Button variant="ghost" onClick={() => setContextPanel("bots")} title="Teammates / bots">
            Bots
          </Button>
        </div>
      </div>

      {view.data?.thread.summary ? (
        <div className="mx-4 mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 md:mx-6">
          <div className="text-[var(--step-minus-2)] uppercase tracking-wider text-[var(--faint)]">
            Summary · recalled by other threads
          </div>
          <div className="mt-1 whitespace-pre-wrap text-[var(--step-minus-1)] text-[var(--text-soft)]">
            {view.data.thread.summary}
          </div>
        </div>
      ) : null}

      {execView && <ExecutionView state={execView} onClose={() => setExecView(null)} />}

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-[var(--max-width-read)] flex-col gap-4">
          {view.loading ? (
            <LoadingState lines={4} />
          ) : view.error ? (
            <ErrorState error={view.error} onRetry={view.reload} />
          ) : view.data ? (
            <>
              {view.data.messages.length === 0 && !streaming && (
                <EmptyState title="Empty conversation" hint="Say hello to begin." />
              )}
              {view.data.messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}
              {streaming && (
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
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* Composer */}
      <form onSubmit={send} className="border-t border-[var(--border-dim)] px-4 py-3 md:px-6">
        <div className="mx-auto w-full max-w-[var(--max-width-read)]">
          {attachedFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachedFiles.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[var(--step-minus-2)] text-[var(--muted)]"
                >
                  <span className="mono">{f.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove attachment ${f.name}`}
                    onClick={() => setAttachedFiles(attachedFiles.filter((_, j) => j !== i))}
                    className="text-[var(--danger)] hover:text-[var(--text)]"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-sm focus-within:border-[var(--border-focus)] sm:flex-row sm:items-end">
            <div className="flex items-center gap-1 pb-1 pl-1">
              <button
                type="button"
                onClick={() => setContextPanel("bots")}
                title="Mention a bot"
                aria-label="Mention a bot"
                className="rounded-md px-2 py-1.5 text-[var(--step-minus-1)] text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                ∞ Bots
              </button>
              <button
                type="button"
                onClick={handleAttachFile}
                title="Attach local file"
                aria-label="Attach local file"
                className="rounded-md px-2 py-1.5 text-[var(--step-minus-1)] text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                +
              </button>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: "none" }}
                onChange={handleFileSelect}
                multiple
              />
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(e);
                }
              }}
              placeholder="Talk to NerdBot…"
              aria-label="Chat message"
              disabled={busy}
              spellCheck
              rows={1}
              autoComplete="off"
              className="max-h-40 min-h-[36px] w-full min-w-0 resize-none bg-transparent py-1.5 text-[var(--step-0)] leading-relaxed outline-none placeholder:text-[var(--faint)] disabled:opacity-50 sm:w-auto sm:flex-1"
            />
            <div className="flex items-center gap-1.5 justify-end pb-0.5">
              <button
                type="button"
                onClick={createTaskFromChat}
                title="Create a task from this conversation"
                className="rounded-md px-2.5 py-1.5 text-[var(--step-minus-1)] text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                Task
              </button>
              {busy ? (
                <Button variant="danger" onClick={stop} title="Stop streaming">
                  ■ Stop
                </Button>
              ) : (
                <>
                  {retryFrom ? (
                    <Button onClick={retry} title="Retry last message">
                      Retry
                    </Button>
                  ) : null}
                  <Button variant="primary" type="submit" disabled={!draft.trim() || busy}>
                    Send ⏎
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1">
            <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
              Enter to send · Shift+Enter for a new line
            </span>
            <label className="flex cursor-pointer items-center gap-1.5 text-[var(--step-minus-2)] text-[var(--faint)]">
              <input
                type="checkbox"
                checked={useStream}
                onChange={(e) => setUseStream(e.target.checked)}
                className="h-3 w-3"
              />
              Stream
            </label>
          </div>
        </div>
      </form>

      {contextPanel && (
        <ContextPanel
          type={contextPanel}
          projectId={projectId}
          onClose={() => setContextPanel(null)}
          onSelectBot={handleBotSelect}
        />
      )}
    </div>
  );
}

function Message({ message, streaming = false }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-[var(--step-0)] leading-relaxed ${
          isUser
            ? "border border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--text)]"
            : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text-soft)]"
        } ${streaming ? "animate-pulse" : ""}`}
      >
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
        {streaming ? (
          <div className="mt-2 inline-block h-4 w-2 animate-pulse rounded-[1px] bg-[var(--accent)]" aria-hidden />
        ) : null}
      </div>
      <div className={`mono mt-1 text-[var(--step-minus-2)] text-[var(--faint)] ${isUser ? "mr-1" : "ml-1"}`}>
        {isUser ? "you" : "nerdbot"}
        {streaming ? " · streaming…" : ""}
      </div>
    </div>
  );
}

/* --- Inline execution view (live task status inside the chat) --- */

function ExecutionView({
  state,
  onClose,
}: {
  state: { kind: "task"; taskId: string; projectId: string };
  onClose: () => void;
}) {
  const view = useAsync(() => api.taskView(state.taskId), [state.taskId]);
  const [poll, setPoll] = useState(0);
  const [mates, setMates] = useState<Teammate[] | null>(null);

  useEffect(() => {
    if (view.error) return;
    if (
      !view.data ||
      (view.data.task.status !== "done" &&
        view.data.task.status !== "failed" &&
        view.data.task.status !== "blocked")
    ) {
      const t = setTimeout(() => setPoll((n) => n + 1), 3000);
      return () => clearTimeout(t);
    }
  }, [view.data, view.error, poll]);

  useEffect(() => {
    if (view.data?.task.owner_teammate_id && !mates) {
      api.listTeammates(state.projectId)
        .then((res) => setMates(res.teammates))
        .catch(() => setMates([]));
    }
  }, [view.data?.task.owner_teammate_id, state.projectId, mates]);

  const task = view.data?.task;
  const runs = view.data?.runs ?? [];
  const artifacts = view.data?.artifacts ?? [];
  const latestRun = runs[runs.length - 1];
  const owner = task?.owner_teammate_id
    ? mates?.find((m) => m.id === task.owner_teammate_id)
    : null;
  const terminal = task?.status === "done" || task?.status === "failed" || task?.status === "cancelled";
  const awaitingDecision = task?.status === "blocked";

  if (view.error) {
    return (
      <div className="mx-4 mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm md:mx-6">
        <div className="flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-2">
          <span className="text-[var(--step-minus-2)] font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
            Execution
          </span>
          <button
            onClick={onClose}
            aria-label="Close execution view"
            className="rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            ×
          </button>
        </div>
        <div className="px-4 py-4">
          <ErrorState error={view.error} onRetry={view.reload} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-4 mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm md:mx-6">
      <div className="flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-2">
        <span className="text-[var(--step-minus-2)] font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
          Execution
        </span>
        <div className="flex items-center gap-2">
          {task ? (
            <button
              onClick={() => openTask(task.project_id, task.id)}
              className="text-[var(--step-minus-1)] text-[var(--accent)] hover:underline"
            >
              Open task →
            </button>
          ) : null}
          <button
            onClick={onClose}
            aria-label="Close execution view"
            className="rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            ×
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3 text-[var(--step-minus-1)]">
        <div>
          <div className="font-medium text-[var(--text)]">{task?.description || "Loading task…"}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <StatusBadge status={task?.status || "pending"} label={taskStatusLabel(task?.status || "pending")} />
            {owner && (
              <span className="text-[var(--muted)]">{owner.persona || "bot"} is responsible</span>
            )}
            {latestRun && (
              <StatusDot
                status={latestRun.status}
                label={`run ${runStatusLabel(latestRun.status)}`}
                pulse={latestRun.status === "running"}
              />
            )}
          </div>
        </div>
        {awaitingDecision && (
          <div className="rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-[var(--warn)]">
            This run needs your decision — it appears in the banner above.
          </div>
        )}
        {!terminal && !awaitingDecision && latestRun && latestRun.status === "failed" && (
          <div className="rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]">
            The last run failed. Retry it from the task page.
          </div>
        )}
        {latestRun && (
          <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
            <div className="mono truncate text-[var(--text-soft)]">{latestRun.command || "(no command)"}</div>
            <div className="mono mt-1 line-clamp-3 text-[var(--step-minus-2)] text-[var(--faint)]">
              {latestRun.output_excerpt?.slice(0, 240) || "(no output)"}
            </div>
          </div>
        )}
        {artifacts.length > 0 && (
          <div>
            <SectionLabel className="mb-1.5">Artifacts</SectionLabel>
            <div className="flex flex-col gap-1.5">
              {artifacts.map((art) => (
                <div key={art.id} className="rounded-md bg-[var(--surface-2)] px-3 py-1.5">
                  <div className="mono text-[var(--step-minus-2)] text-[var(--faint)]">
                    {art.type} · {art.location}
                  </div>
                  <div className="text-[var(--text-soft)]">{art.summary}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!task && view.loading ? <LoadingState lines={2} /> : null}
      </div>
    </div>
  );
}

/* --- Bots context drawer --- */

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
    () =>
      type === "bots"
        ? api.listTeammates(projectId)
        : Promise.resolve({ teammates: [] as Teammate[] }),
    [projectId, type],
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <aside
        className="absolute right-0 top-0 flex h-full w-[340px] flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={type === "bots" ? "Teammates / bots" : "Project files"}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-3">
          <span className="text-[var(--step-0)] font-semibold">
            {type === "bots" ? "Teammates / bots" : "Project files"}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            ×
          </button>
        </div>
        {type === "bots" ? (
          data.loading ? (
            <LoadingState lines={3} />
          ) : data.error ? (
            <ErrorState error={data.error} onRetry={data.reload} />
          ) : (
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
              {(data.data?.teammates ?? []).map((mate: Teammate) => (
                <div
                  key={mate.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[var(--step-minus-1)] font-medium text-[var(--text)]">
                      {mate.persona || mate.id}
                    </div>
                    <div className="mono truncate text-[var(--step-minus-2)] text-[var(--faint)]">
                      {mate.instructions?.slice(0, 80) || ""}
                    </div>
                  </div>
                  <Button variant="primary" onClick={() => onSelectBot(mate.id)}>
                    Open
                  </Button>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="p-4 text-[var(--step-minus-1)] text-[var(--muted)]">
            Attach files from an active task workspace. Open a task from the execution view first.
          </div>
        )}
      </aside>
    </div>
  );
}

/* --- Command Center (Home landing) --- */

function CommandCenter({
  projectId,
  recentThreads,
  providers,
  summary,
  onNewChat,
  onThreadCreated,
  onOpenThread,
  refreshProviders,
  refreshThreads,
}: {
  projectId: string;
  /** Recent conversations across every project the owner owns. */
  recentThreads: ChatThread[];
  providers: { id: string; name: string; kind: string }[];
  summary: ReturnType<typeof useWorkspaceSummary>;
  onNewChat: () => void;
  onThreadCreated: (threadId: string) => void;
  onOpenThread: (thread: ChatThread) => void;
  refreshProviders?: () => void;
  refreshThreads?: () => void;
}) {
  const hasProvider = providers.length > 0;
  const [draft, setDraft] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<"__default__" | string>("__default__");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showConfigure, setShowConfigure] = useState(false);
  const [provName, setProvName] = useState("");
  const [provBaseUrl, setProvBaseUrl] = useState("");
  const [provModel, setProvModel] = useState("");
  const [provApiKey, setProvApiKey] = useState("");
  const [provBusy, setProvBusy] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [streaming]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStreaming("");
    let stopped = false;
    try {
      const thread = await api.createThread(projectId, { title: content.slice(0, 60) });
      onThreadCreated(thread.id);
      await api.sendChatStream(thread.id, content, (chunk) => {
        setStreaming((prev) => prev + chunk);
      }, { signal: controller.signal });
      setDraft("");
      refreshThreads?.();
    } catch (err) {
      if (err instanceof ApiError && err.detail === "Stream stopped") {
        stopped = true;
        setStreaming((prev) => (prev ? `${prev}\n[stopped]` : ""));
      } else {
        notifyError(err);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      if (!stopped) setStreaming("");
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  // The resume list spans every project the owner owns, so a conversation
  // started elsewhere is still one click away from here.
  const sorted = [...recentThreads].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const projectLabel = (id: string) => {
    const bundle = summary.data?.summary.bundles.find((b) => b.project.id === id);
    return bundle?.project.repository || "workspace";
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-8 px-4 py-10 md:px-6">
        {/* The workspace banner renders once above this pane (ConversationView). */}

        {/* Landing composer */}
        <div className="scroll-mt-6">
          <h1 className="text-[var(--step-3)] font-semibold tracking-tight">Command Center</h1>
          <p className="mt-1 text-[var(--step-0)] text-[var(--muted)]">
            Your AI fleet. One place to get work done.
          </p>
          <form onSubmit={send} className="mt-5">
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-sm focus-within:border-[var(--border-focus)] sm:flex-row sm:items-end">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(e);
                  }
                }}
                placeholder={
                  hasProvider
                    ? "Ask anything, delegate work, or continue a task…"
                    : "No model configured yet — connect a provider first."
                }
                disabled={busy || !hasProvider}
                spellCheck
                rows={2}
                aria-label="Start a conversation"
                className="max-h-48 min-h-[52px] w-full min-w-0 resize-none bg-transparent p-2.5 leading-relaxed outline-none placeholder:text-[var(--faint)] disabled:opacity-50 sm:w-auto sm:flex-1"
              />
              {/* The model chip and the send button keep their own row so the
                  textarea gets the full width on a narrow screen instead of
                  being squeezed to a few characters wide. */}
              <div className="flex items-center gap-2 justify-end">
                <ModelChip
                  providers={providers}
                  value={selectedProviderId}
                  onChange={setSelectedProviderId}
                  disabled={busy || !hasProvider}
                />
                {busy ? (
                  <Button variant="danger" type="button" onClick={stop} disabled={!streaming}>
                    ■ Stop
                  </Button>
                ) : (
                  <Button variant="primary" type="submit" disabled={busy || !draft.trim() || !hasProvider}>
                    Send ⏎
                  </Button>
                )}
              </div>
            </div>
            {streaming && (
              <div className="mono mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--text-soft)]">
                {streaming}
                <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-[1px] bg-[var(--accent)] align-middle" aria-hidden />
              </div>
            )}
          </form>
          {!hasProvider && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
              <Badge variant="bad">No model configured</Badge>
              <Button onClick={() => setShowConfigure((v) => !v)}>
                Configure model
              </Button>
              <span className="text-[var(--step-minus-1)] text-[var(--muted)]">
                The mock provider answers canned output for zero-setup verification; add a real connection to chat with your model.
              </span>
            </div>
          )}
          {showConfigure && (
            <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <SectionLabel className="mb-3">Configure model connection</SectionLabel>
              <form
                onSubmit={async (e: React.FormEvent) => {
                  e.preventDefault();
                  setProvBusy(true);
                  try {
                    await api.createProvider(projectId, {
                      kind: "openai-compatible",
                      name: provName.trim() || "model",
                      config: {
                        base_url: provBaseUrl.trim(),
                        model: provModel.trim() || undefined,
                        ...(provApiKey.trim() ? { api_key: provApiKey.trim() } : {}),
                      },
                    });
                    setShowConfigure(false);
                    setProvName("");
                    setProvBaseUrl("");
                    setProvModel("");
                    setProvApiKey("");
                    refreshProviders?.();
                  } catch (err) {
                    notifyError(err);
                  } finally {
                    setProvBusy(false);
                  }
                }}
                className="flex flex-wrap items-end gap-3"
              >
                <input
                  value={provName}
                  onChange={(e) => setProvName(e.target.value)}
                  placeholder="Name (e.g. groq)"
                  aria-label="Provider name"
                  className="w-40 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <input
                  value={provBaseUrl}
                  onChange={(e) => setProvBaseUrl(e.target.value)}
                  placeholder="Base URL (e.g. https://api.groq.com/openai/v1)"
                  aria-label="Base URL"
                  required
                  className="mono min-w-64 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <input
                  value={provModel}
                  onChange={(e) => setProvModel(e.target.value)}
                  placeholder="Model (optional)"
                  aria-label="Model"
                  className="w-44 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <input
                  type="password"
                  value={provApiKey}
                  onChange={(e) => setProvApiKey(e.target.value)}
                  placeholder="API key"
                  aria-label="API key"
                  autoComplete="off"
                  className="w-48 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <Button variant="primary" type="submit" disabled={provBusy || !provBaseUrl.trim()}>
                  {provBusy ? "Connecting…" : "Connect"}
                </Button>
                <Button type="button" onClick={() => setShowConfigure(false)}>
                  Cancel
                </Button>
              </form>
              <p className="mt-2 text-[var(--step-minus-2)] text-[var(--faint)]">
                Keys are stored Fernet-encrypted at rest when the server has NERDBOT_SECRET_KEY set.
              </p>
            </div>
          )}
        </div>

        {/* Quick entry points */}
        <div className="grid gap-2 sm:grid-cols-3">
          <button
            onClick={onNewChat}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:border-[var(--faint)] hover:bg-[var(--surface-2)]"
          >
            <div className="text-[var(--step-minus-1)] font-medium text-[var(--text)]">New conversation</div>
            <div className="mono mt-0.5 text-[var(--step-minus-2)] text-[var(--faint)]">→ Home context</div>
          </button>
          <button
            onClick={() => { window.location.hash = "#/bots"; }}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:border-[var(--faint)] hover:bg-[var(--surface-2)]"
          >
            <div className="text-[var(--step-minus-1)] font-medium text-[var(--text)]">AI fleet</div>
            <div className="mono mt-0.5 text-[var(--step-minus-2)] text-[var(--faint)]">→ Agents &amp; teams</div>
          </button>
          <button
            onClick={() => { window.location.hash = "#/projects"; }}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:border-[var(--faint)] hover:bg-[var(--surface-2)]"
          >
            <div className="text-[var(--step-minus-1)] font-medium text-[var(--text)]">Workspaces</div>
            <div className="mono mt-0.5 text-[var(--step-minus-2)] text-[var(--faint)]">→ Projects</div>
          </button>
        </div>

        {/* Team-level execution rollup */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionLabel>Fleet execution</SectionLabel>
            {summary.data ? (
              <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
                {summary.data.summary.runningTasks} running · {summary.data.summary.queuedTasks} queued ·{" "}
                {summary.data.summary.blockedTasks} blocked
              </span>
            ) : null}
          </div>
          <ExecutionRollup
            summary={summary.data?.summary ?? null}
            onOpenTeam={(teamId) => { window.location.hash = `#/team/${teamId}`; }}
          />
        </section>

        {/* Recent conversations, across every workspace the owner owns. The
            scope is spelled out because the conversation rail beside this
            panel lists only the current workspace's conversations. */}
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <SectionLabel>Recent conversations</SectionLabel>
              <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
                across all workspaces
              </span>
            </div>
            {sorted.length > 0 && refreshThreads ? (
              <Button variant="ghost" onClick={() => void refreshThreads()}>
                Refresh
              </Button>
            ) : null}
          </div>
          {sorted.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border-dim)] px-4 py-6 text-center text-[var(--step-minus-1)] text-[var(--faint)]">
              No recent conversations yet. Start one above.
            </p>
          ) : (            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {sorted.slice(0, 8).map((t, index) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenThread(t)}
                  aria-label={`Resume: ${t.title || "Untitled"}`}
                  className={`flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)] ${
                    index > 0 ? "border-t border-[var(--border-dim)]" : ""
                  }`}
                >
                  <span className="truncate text-[var(--step-minus-1)] text-[var(--text)]">
                    {t.title || "Untitled"}
                  </span>
                  {t.project_id !== projectId ? (
                    <span className="mono shrink-0 text-[var(--step-minus-2)] text-[var(--faint)]">
                      {projectLabel(t.project_id)}
                    </span>
                  ) : null}
                  <span className="mono shrink-0 text-[var(--step-minus-2)] text-[var(--faint)]">
                    {relativeTime(t.created_at)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
