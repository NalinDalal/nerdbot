import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { api, ApiError } from "./api";
import { notifyError, navigate } from "./app";
import { TeamView } from "./team-view";
import type { ChatMessage, ChatThread, Plan, Provider, ResearchJob, ResearchJobEvent, Teammate } from "./types";
import { useWorkspaceSummary } from "./views-home";
import { Markdown } from "./markdown";
import { insertMention, mentionHandle, splitMentions } from "./mentions";
import { explainRunError } from "./explainRunError";
import { usableProviders } from "./readiness";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  BotFace,
  Button,
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
  navigate(`/p/${projectId}/t/${taskId}`);
}

function ActivityRailContent({
  summary,
  onOpenTask,
  onReload,
}: {
  summary: ReturnType<typeof useWorkspaceSummary>;
  onOpenTask: (projectId: string, taskId: string) => void;
  onReload: () => void;
}) {
  if (summary.loading && !summary.data) return <LoadingState lines={2} />;
  if (summary.loadFailed) {
    return (
      <div className="flex flex-col gap-2">
        <ErrorState error={new Error("Couldn't load activity")} onRetry={onReload} />
      </div>
    );
  }
  const s = summary.summary;
  const { activeRuns, failedRuns, pendingApprovals, queuedTasks } = s;
  const hasAnything =
    activeRuns.length > 0 ||
    failedRuns.length > 0 ||
    pendingApprovals.length > 0 ||
    queuedTasks > 0;
  if (!hasAnything) {
    return (
      <p className="text-step--1 text-[var(--muted)]">
        No work running. Delegate a task from chat to see progress here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {pendingApprovals.length > 0 ? (
        <section>
          <div className="mb-1 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--warn)]">
            Needs approval ({pendingApprovals.length})
          </div>
          <ul className="flex flex-col gap-1.5">
            {pendingApprovals.slice(0, 5).map(({ approval, projectName }) => (
              <li
                key={approval.id}
                className="rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-2.5 py-2 text-step--1"
              >
                <div className="truncate font-medium text-[var(--text)]">
                  {approval.action || "approval requested"}
                </div>
                <div className="truncate text-step--2 text-[var(--muted)]">{projectName}</div>
                {approval.task_id && approval.project_id ? (
                  <button
                    type="button"
                    onClick={() => onOpenTask(approval.project_id!, approval.task_id!)}
                    className="mt-1 text-step--2 text-[var(--accent)] hover:underline"
                  >
                    Open task →
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {activeRuns.length > 0 ? (
        <section>
          <div className="mb-1 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
            Running ({activeRuns.length})
          </div>
          <ul className="flex flex-col gap-1.5">
            {activeRuns.slice(0, 6).map(({ run, task, projectName, projectId }) => (
              <li key={run.id} className="rounded-md bg-[var(--surface-2)] px-2.5 py-2 text-step--1">
                <div className="truncate text-[var(--text)]">
                  {task?.description || run.task_id}
                </div>
                <div className="truncate text-step--2 text-[var(--muted)]">
                  {projectName} · {run.status}
                </div>
                {task ? (
                  <button
                    type="button"
                    onClick={() => onOpenTask(projectId, task.id)}
                    className="mt-1 text-step--2 text-[var(--accent)] hover:underline"
                  >
                    Open task →
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {queuedTasks > 0 ? (
        <div className="text-step--1 text-[var(--muted)]">
          {queuedTasks} task{queuedTasks === 1 ? "" : "s"} queued
        </div>
      ) : null}

      {failedRuns.length > 0 ? (
        <section>
          <div className="mb-1 text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--danger)]">
            Recent failures ({failedRuns.length})
          </div>
          <ul className="flex flex-col gap-1.5">
            {failedRuns.slice(0, 4).map(({ run, task, projectName, projectId }) => (
              <li key={run.id} className="rounded-md bg-[var(--danger-dim)] px-2.5 py-2 text-step--1 text-[var(--danger)]">
                <div className="truncate">
                  {task?.description || run.task_id}
                </div>
                <div className="truncate text-step--2 opacity-80">{projectName}</div>
                {task ? (
                  <button
                    type="button"
                    onClick={() => onOpenTask(projectId, task.id)}
                    className="mt-1 text-step--2 text-[var(--accent)] hover:underline"
                  >
                    Open task →
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
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
  /* Home is a real project, but the owner thinks of models as belonging to
     the machine. On Home, offer every usable model across projects and route
     the new conversation to the project that owns the chosen one. */
  const allProviders = useAsync(async () => {
    if (projectId) return [] as Provider[];
    const { projects } = await api.listProjects();
    const groups = await Promise.all(
      projects.map(async (project) => {
        try {
          const result = await api.listProviders(project.id);
          return result.providers.map((provider) => ({
            ...provider,
            project_id: project.id,
            project_name: project.repository,
          }));
        } catch {
          return [] as Array<Provider & { project_name: string }>;
        }
      }),
    );
    return groups.flat();
  }, [projectId]);
  // The Command Center resume list spans every project the owner owns, so a
  // conversation started in another workspace is still reachable from here.
  const recentThreads = useAsync(() => api.listRecentThreads(20), []);
  const [activeId, setActiveId] = useState<string | null>(initialThreadId ?? null);
  const [objectiveId, setObjectiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  useEffect(() => {
    if (activeId) {
      onSetActiveThread?.(activeId);
    }
  }, [activeId, onSetActiveThread]);

  if (!resolvedProjectId) {
    return <LoadingState lines={2} />;
  }

  const isHome = !projectId;
  const workspaceName = summary.data?.summary.bundles.find(
    (bundle) => bundle.project.id === resolvedProjectId,
  )?.project.repository;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      {/* Header. The mobile left padding reserves the gutter the fixed menu
          button floats in (app.tsx: `fixed left-3 top-3`), so "Home" is not
          painted underneath it. */}
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border-dim)] py-3 pl-14 pr-4 md:px-6">
        <div className="min-w-0">
          <h1 className="text-step-1 font-semibold tracking-tight">
            {isHome ? "Chat" : workspaceName || "Conversation"}
          </h1>
          <p className="mt-0.5 text-step-0 text-[var(--muted)]">
            {isHome
              ? "Ask, delegate, or pick up where you left off."
              : "This project's conversation."}
          </p>
        </div>
        <Button variant="primary" onClick={() => setShowNew(true)} disabled={!home.data}>
          New chat
        </Button>
      </header>

      {/* Workspace-wide attention banner. Kept to the same column as the
          composer and the lists below, so the page has one left edge. */}
      <div className="px-4 pt-3 md:px-6">
        <div className="mx-auto w-full max-w-[860px]">
        {summary.loadFailed && !summary.loading ? (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]">
            <span>Couldn't load some fleet data. This page may be incomplete.</span>
            <Button onClick={summary.reload}>Retry</Button>
          </div>
        ) : null}
        {(() => {
          const s = summary.data?.summary;
          if (!s) return null;
          const parts: string[] = [];
          if (s.pendingApprovals.length) parts.push(`${s.pendingApprovals.length} need${s.pendingApprovals.length === 1 ? "s" : ""} approval`);
          if (s.failedRuns.length) parts.push(`${s.failedRuns.length} failed`);
          if (s.activeRuns.length) parts.push(`${s.activeRuns.length} running`);
          if (parts.length === 0) return null;
          return (
            <div className="mb-2 text-step--1 text-[var(--muted)]">
              {parts.join(" · ")}{" "}
              <button
                type="button"
                onClick={() => navigate("/approvals")}
                className="text-[var(--accent)] hover:underline"
              >
                Open activity →
              </button>
            </div>
          );
        })()}
        </div>
      </div>

      {/* Body: thread rail + active pane. Home has one conversation list
          (below), so the rail would be a second list of the same thing. */}
      <div className="flex min-h-0 flex-1">
        {!isHome ? (
        <aside className="hidden w-[var(--width-conversation-sidebar)] shrink-0 flex-col border-r border-[var(--border-dim)] xl:flex">
          <div className="px-3 pt-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-step--1 outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          <div className="px-3 pb-1 pt-4">
            <SectionLabel>Conversations</SectionLabel>
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
                  <span className="truncate text-step--1 font-medium">
                    {thread.title || "Untitled"}
                  </span>
                  <span className="mono text-step--2 text-[var(--faint)]">
                    {relativeTime(thread.created_at)}
                  </span>
                </button>
              ))}
            {threads.data && (threads.data.threads ?? []).length === 0 && !threads.loading ? (
              <p className="px-2.5 py-2 text-step--1 text-[var(--faint)]">
                No conversations yet
              </p>
            ) : null}
          </div>
        </aside>
        ) : null}

        <section className="flex min-w-0 flex-1 flex-col">
          {activeId ? (
            <ThreadPane
              threadId={activeId}
              projectId={resolvedProjectId}
              providers={providers.data?.providers ?? []}
              onPlanApproved={(id) => setObjectiveId(id)}
              onReload={() => threads.reload()}
            />
          ) : isHome ? (
            <CommandCenter
              summary={summary}
              projectId={resolvedProjectId}
              recentThreads={recentThreads.data?.threads ?? []}
              providers={
                (isHome ? allProviders.data : providers.data?.providers) ?? []
              }
              onThreadCreated={(threadId, targetProjectId) => {
                if (targetProjectId && targetProjectId !== resolvedProjectId) {
                  navigate(`/chat/${targetProjectId}?thread=${threadId}`);
                  return;
                }
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
                  navigate(`/chat/${thread.project_id}`);
                }
              }}
              refreshProviders={() => {
                providers.reload();
                allProviders.reload();
              }}
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
                      <span className="truncate text-step--1 text-[var(--text)]">
                        {t.title || "Untitled"}
                      </span>
                      <span className="mono shrink-0 text-step--2 text-[var(--faint)]">
                        {relativeTime(t.created_at)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </section>

        {/* Contextual activity rail (desktop). */}
        {railOpen ? (
          <aside
            aria-label="Activity"
            className="hidden w-72 shrink-0 flex-col border-l border-[var(--border-dim)] bg-[var(--bg)] lg:flex"
          >
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
                Activity
              </span>
              <button
                type="button"
                aria-label="Collapse activity rail"
                onClick={() => setRailOpen(false)}
                className="rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                ›
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-4">
              {objectiveId ? (
                <TeamView objectiveId={objectiveId} onOpenTask={openTask} />
              ) : (
                <ActivityRailContent
                  summary={summary}
                  onOpenTask={openTask}
                  onReload={() => summary.reload()}
                />
              )}
            </div>
          </aside>
        ) : (
          <button
            type="button"
            aria-label="Expand activity rail"
            onClick={() => setRailOpen(true)}
            className="hidden w-8 shrink-0 items-center justify-center border-l border-[var(--border-dim)] bg-[var(--bg)] text-[var(--muted)] transition-colors hover:text-[var(--text)] lg:flex"
          >
            ‹
          </button>
        )}
      </div>

      {/* Mobile activity drawer. */}
      <button
        type="button"
        aria-label="Open activity"
        onClick={() => setMobileRailOpen(true)}
        className="fixed bottom-20 right-4 z-40 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 text-[var(--text-soft)] shadow-lg transition-colors hover:text-[var(--text)] lg:hidden"
      >
        Activity
      </button>
      {mobileRailOpen ? (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] lg:hidden"
          onClick={() => setMobileRailOpen(false)}
        >
          <aside
            className="absolute right-0 top-0 flex h-full w-full max-w-sm flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-lg"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Activity"
          >
            <div className="flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-3">
              <span className="text-step-0 font-semibold">Activity</span>
              <button
                onClick={() => setMobileRailOpen(false)}
                aria-label="Close"
                className="rounded-sm p-1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <ActivityRailContent
                summary={summary}
                onOpenTask={(pid, tid) => {
                  setMobileRailOpen(false);
                  openTask(pid, tid);
                }}
                onReload={() => summary.reload()}
              />
            </div>
          </aside>
        </div>
      ) : null}

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
  const [providerId, setProviderId] = useState("__default__");
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const thread = await api.createThread(projectId, {
        title: title.trim(),
        provider_id: providerId === "__default__" ? undefined : providerId,
      });
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
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
          />
        </Field>
        <Field label="Model provider">
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            aria-label="Model provider"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
          >
            <option value="__default__">Default model</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.kind})
              </option>
            ))}
          </select>
          <p className="text-step--1 text-[var(--faint)]">
            The conversation uses this model. You can change it from the thread header later.
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
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-step--1 text-[var(--text-soft)] transition-colors hover:border-[var(--faint)] disabled:pointer-events-none disabled:opacity-50"
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
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-step--1 transition-colors ${
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
  "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-step--1 text-[var(--text-soft)] outline-none transition-colors hover:border-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";

function ThreadPane({
  threadId,
  projectId,
  providers,
  onReload,
  onPlanApproved,
}: {
  threadId: string;
  projectId: string;
  providers: { id: string; name: string; kind: string }[];
  onReload: () => void;
  onPlanApproved?: (id: string) => void;
}) {
  const view = useAsync(() => api.threadView(threadId, 50), [threadId]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [streamParts, setStreamParts] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [useStream, setUseStream] = useState(true);
  const [mode, setMode] = useState<"chat" | "research" | "delegate">("chat");
  const [retryFrom, setRetryFrom] = useState<string | null>(null);
  const [execView, setExecView] = useState<{ kind: "task"; taskId: string; projectId: string } | null>(null);
  const [planPreview, setPlanPreview] = useState<{ objective: string; plan: Plan } | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [contextPanel, setContextPanel] = useState<"files" | "bots" | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [mates, setMates] = useState<Teammate[]>([]);
  const [researchJobIds, setResearchJobIds] = useState<string[]>([]);
  // Speaker announced by the stream's first event, so the in-flight bubble
  // already carries the teammate's face and name while the reply arrives.
  const [streamSpeaker, setStreamSpeaker] = useState<{
    teammate_id: string;
    name: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .listResearchJobs(projectId, 20)
      .then((res) => {
        if (!alive) return;
        const jobs = (res.jobs || []) as ResearchJob[];
        const ids = jobs
          .filter((j) => j.thread_id === threadId || (j.thread_id === "" && researchJobIds.includes(j.id)))
          .map((j) => j.id);
        if (ids.length) setResearchJobIds((prev) => Array.from(new Set([...ids, ...prev])).slice(0, 8));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, threadId]);

  const providerId = view.data?.thread.provider_id ?? "__default__";

  useEffect(() => {
    api
      .listTeammates(projectId)
      .then((res) => setMates(res.teammates || []))
      .catch(() => setMates([]));
  }, [projectId]);

  const mateOf = (teammateId?: string): Teammate | null =>
    (teammateId && mates.find((m) => m.id === teammateId)) || null;

  // Name + face to hang on an assistant message; null = the default bot.
  const speakerFor = (teammateId?: string) => {
    const mate = mateOf(teammateId);
    return mate ? { name: mate.name || mate.slug || "teammate", face: mate.face } : null;
  };

  /* Stick to the newest message while streaming. */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [view.data?.messages.length, streaming]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    // Objective-like requests get a reviewable plan instead of a plain reply.
    const lower = content.toLowerCase();
    const adminVerb = /\b(create|configure|change|manage|rename|set|attach|update|edit|disable|archive|delete|remove)\b/;
    const managedNoun = /\b(bots?|teammates?|agents?|workspace|project|teams?)\b/;
    const adminLike = adminVerb.test(lower) && managedNoun.test(lower);
    const questionLike = /^(what|how|why|when|where|who|is|are|does|do|can|could|should|which)\b/.test(lower);
    const objectiveLike =
      /\b(build|create|research|launch|implement|design|compare|analyze|write|generate|develop|plan|delegate|investigate|review|evaluate|prepare|assign)\b/i.test(
        content,
      ) &&
      content.split(/\s+/).length >= 4 &&
      !adminLike &&
      !questionLike;
    if (objectiveLike && projectId) {
      setPlanBusy(true);
      try {
        const res = await api.createObjective(projectId, { objective: content, preview: true });
        setPlanPreview({ objective: content, plan: res.plan as Plan });
        setDraft("");
        return;
      } catch (err) {
        notifyError(err);
      } finally {
        setPlanBusy(false);
      }
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStreaming("");
    setStreamSpeaker(null);
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
        setStreamStatus("");
        setStreamParts([]);
        await api.sendChatStream(threadId, fullContent, (chunk) => {
          setStreaming((prev) => prev + chunk);
        }, (status) => setStreamStatus(status), (parts) => setStreamParts(parts), mode, {
          signal: controller.signal,
          onSpeaker: setStreamSpeaker,
        });
      } else {
        await api.sendChat(threadId, fullContent, mode);
      }
      setDraft("");
      await view.reload();
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
      if (!stopped) { setStreaming(""); setStreamStatus(""); setStreamParts([]); setStreamSpeaker(null); }
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
    setStreamSpeaker(null);
    let stopped = false;
    try {
      const content =
        view.data.messages.find((m) => m.id === target)?.content ?? "";
      if (useStream) {
        setStreamStatus("");
        setStreamParts([]);
        await api.sendChatStream(threadId, content, (chunk) => {
          setStreaming((prev) => prev + chunk);
        }, (status) => setStreamStatus(status), (parts) => setStreamParts(parts), mode, {
          signal: controller.signal,
          onSpeaker: setStreamSpeaker,
        });
      } else {
        await api.sendChat(threadId, content, mode);
      }
      setRetryFrom(null);
      await view.reload();
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
      if (!stopped) { setStreaming(""); setStreamStatus(""); setStreamParts([]); setStreamSpeaker(null); }
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

  const startDeepResearch = async () => {
    const query = draft.trim();
    if (!query) {
      toast.error("Enter a research question first.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.createProjectResearchJob(projectId, {
        query,
        thread_id: threadId,
      });
      const job = res.job as ResearchJob;
      if (job?.id) {
        setResearchJobIds((prev) => [job.id, ...prev.filter((id) => id !== job.id)].slice(0, 8));
        setDraft("");
        setMode("research");
        toast.success("Deep research started in the background.");
      }
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
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
      setExecView({ kind: "task", taskId: task.id, projectId });
      toast.success("Task created. Live execution is open below the conversation.");
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

  const handleBotSelect = (mate: Teammate) => {
    // Mention, don't navigate: picking a teammate here addresses a reply to
    // it, so the handle goes into the composer and the panel closes.
    setContextPanel(null);
    setDraft((prev) => insertMention(prev, mentionHandle(mate)));
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleBotOpen = (teammateId: string) => {
    setContextPanel(null);
    navigate(`/bot/${teammateId}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Thread header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-dim)] px-4 py-2.5 md:px-6">
        <div className="min-w-0">
          <div className="truncate text-step-0 font-semibold">
            {view.data?.thread.title || "Untitled"}
          </div>
          <div className="mono text-step--2 text-[var(--faint)]">
            {relativeTime(view.data?.thread.created_at ?? "")}
            {` · ${providers.find((provider) => provider.id === view.data?.thread.provider_id)?.name ?? "Default model"}`}
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
          <Button variant="ghost" onClick={() => setContextPanel("files")} title="Project files">
            Files
          </Button>
          <Button variant="ghost" onClick={() => setContextPanel("bots")} title="Teammates">
            Teammates
          </Button>
        </div>
      </div>

      {view.data?.thread.summary ? (
        <details className="mx-4 mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 md:mx-6">
          <summary className="cursor-pointer text-step--2 uppercase tracking-wider text-[var(--faint)]">
            Summary · recalled by other threads
          </summary>
          <div className="mt-1 whitespace-pre-wrap text-step--1 text-[var(--text-soft)]">
            {view.data.thread.summary}
          </div>
        </details>
      ) : null}

      {execView && <ExecutionView state={execView} onClose={() => setExecView(null)} />}

      {planPreview && (
        <div className="mx-4 mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 md:mx-6">
          <div className="mb-2 text-step-1 font-semibold text-[var(--text)]">Plan preview</div>
          <div className="mb-2 text-step--1 text-[var(--muted)]">{planPreview.objective}</div>
          <ol className="mb-3 list-decimal pl-5 text-step--1 text-[var(--text-soft)]">
            {planPreview.plan.tasks.map((t, i) => (
              <li key={i} className="mb-1">
                {t.description}
                {t.owner_teammate_id ? <span className="ml-2 text-[var(--faint)]">({t.owner_teammate_id})</span> : null}
                {t.depends_on?.length ? <span className="ml-2 text-[var(--faint)]">depends on {t.depends_on.map((d) => d + 1).join(", ")}</span> : null}
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={planBusy}
              onClick={async () => {
                setPlanBusy(true);
                try {
                  await api.createObjective(projectId!, {
                    objective: planPreview.objective,
                    plan: planPreview.plan,
                    create_board: true,
                  });
                  setPlanPreview(null);
                  toast.success("Plan approved; tasks created.");
                } catch (err) {
                  notifyError(err);
                } finally {
                  setPlanBusy(false);
                }
              }}
            >
              Approve & execute
            </Button>
            <Button onClick={() => setPlanPreview(null)} disabled={planBusy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

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
                <Message
                  key={message.id}
                  message={message}
                  parts={message.parts}
                  projectId={projectId}
                  speaker={speakerFor(message.teammate_id)}
                  onPlanApproved={(id) => onPlanApproved?.(id)}
                  onCreateTask={async (proposal) => {
                    try {
                      const task = await api.createTask(projectId, {
                        description: proposal.title,
                        command: "",
                      });
                      toast.success("Task created");
                      await view.reload();
                      return task;
                    } catch (err) {
                      notifyError(err);
                      return null;
                    }
                  }}
                />
              ))}
              {streamStatus && (
                <div className="mb-2 text-step--1 text-[var(--muted)]">
                  {streamStatus}
                </div>
              )}
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
                  speaker={
                    streamSpeaker
                      ? {
                          name: streamSpeaker.name || "nerdbot",
                          face: mateOf(streamSpeaker.teammate_id)?.face,
                        }
                      : null
                  }
                  parts={streamParts}
                />
              )}
            </>
          ) : null}
        </div>
      </div>

      {researchJobIds.length > 0 ? (
        <div className="border-t border-[var(--border-dim)] px-4 py-3 md:px-6">
          <div className="mx-auto flex w-full max-w-[var(--max-width-read)] flex-col gap-3">
            {researchJobIds.map((id) => (
              <ResearchJobCard
                key={id}
                jobId={id}
                onClose={() => setResearchJobIds((prev) => prev.filter((x) => x !== id))}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Composer */}
      <form onSubmit={send} className="border-t border-[var(--border-dim)] px-4 py-3 md:px-6">
        <div className="mx-auto w-full max-w-[var(--max-width-read)]">
          {attachedFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachedFiles.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-step--2 text-[var(--muted)]"
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
                title="Mention a teammate"
                aria-label="Mention a teammate"
                className="rounded-md px-2 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                ∞ Teammates
              </button>
              <button
                type="button"
                onClick={() => setContextPanel("files")}
                title="Project files"
                aria-label="Project files"
                className="rounded-md px-2 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                Files
              </button>
              <button
                type="button"
                onClick={handleAttachFile}
                title="Attach local file"
                aria-label="Attach local file"
                className="rounded-md px-2 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
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
              ref={composerRef}
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
              className="max-h-40 min-h-[36px] w-full min-w-0 resize-none bg-transparent py-1.5 text-step-0 leading-relaxed outline-none placeholder:text-[var(--faint)] disabled:opacity-50 sm:w-auto sm:flex-1"
            />
            <div className="flex items-center gap-1.5 justify-end pb-0.5">
              <button
                type="button"
                onClick={() => void startDeepResearch()}
                disabled={!draft.trim() || busy}
                title="Run multi-source deep research in the background with citations"
                className="rounded-md px-2.5 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-50"
              >
                Deep research
              </button>
              <button
                type="button"
                onClick={createTaskFromChat}
                title="Create a task from this conversation"
                className="rounded-md px-2.5 py-1.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
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
            <span className="text-step--2 text-[var(--faint)]">
              Enter to send · Shift+Enter for a new line
            </span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "chat" | "research" | "delegate")}
              className="h-6 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 text-step--2 text-[var(--text-soft)]"
              aria-label="Chat mode"
            >
              <option value="chat">Chat</option>
              <option value="research">Research</option>
              <option value="delegate">Delegate</option>
            </select>
            <label className="flex cursor-pointer items-center gap-1.5 text-step--2 text-[var(--faint)]">
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
          onOpenBot={handleBotOpen}
          onAttachFile={(file) => {
            setAttachedFiles((prev) => [...prev, file]);
            setContextPanel(null);
          }}
        />
      )}
    </div>
  );
}

function TaskProposalCard({ proposal, onCreateTask }: { proposal: any; onCreateTask?: (proposal: any) => void | Promise<any> }) {
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [task, setTask] = useState<any>(null);
  const [retryBusy, setRetryBusy] = useState(false);

  const loadTask = async (id: string) => {
    try {
      const t = await api.taskView(id);
      setTask(t.task);
    } catch (err) {
      notifyError(err);
    }
  };

  useEffect(() => {
    if (!createdId) return;
    const id = createdId;
    queueMicrotask(() => {
      void loadTask(id);
    });
  }, [createdId]);

  if (!createdId) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-step--1">
        <div className="font-semibold text-[var(--text)]">{proposal.title}</div>
        {proposal.body ? <div className="mt-1 whitespace-pre-wrap text-[var(--text-soft)]">{proposal.body}</div> : null}
        <div className="mt-2">
          <button
            type="button"
            className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-step--2 font-medium text-white"
            onClick={async () => {
              const t = await onCreateTask?.(proposal);
              if (t?.id) setCreatedId(t.id);
            }}
          >
            Create task
          </button>
        </div>
      </div>
    );
  }

  const status = task?.status || "queued";
  const failedRun = task?.latest_run?.status === "failed" ? task.latest_run : null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-step--1">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-[var(--text)]">{proposal.title}</div>
        <span className="text-step--2 text-[var(--muted)]">{status}</span>
      </div>
      {failedRun ? (
        <div className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-2.5 py-2 text-[var(--danger)]">
          <div className="font-medium">
            {explainRunError(
              { command: task?.command || "", project_id: task?.project_id || "" },
              { stderr: failedRun.stderr || "", output_excerpt: failedRun.output_excerpt || "" },
            ).message || "Run failed."}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={retryBusy}
              className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-step--2 font-medium text-white disabled:opacity-50"
              onClick={async () => {
                if (!createdId) return;
                setRetryBusy(true);
                try {
                  await api.retryTask(createdId);
                  await loadTask(createdId);
                } catch (err) {
                  notifyError(err);
                } finally {
                  setRetryBusy(false);
                }
              }}
            >
              {retryBusy ? "Retrying…" : "Retry"}
            </button>
            <button
              type="button"
              className="text-step--2 text-[var(--accent)] hover:underline"
              onClick={() => task?.project_id && task?.id && openTask(task.project_id, task.id)}
            >
              Open task →
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <button
            type="button"
            className="text-step--2 text-[var(--accent)] hover:underline"
            onClick={() => task?.project_id && task?.id && openTask(task.project_id, task.id)}
          >
            Open task →
          </button>
        </div>
      )}
    </div>
  );
}

function ResearchJobCard({
  jobId,
  initialJob,
  onClose,
}: {
  jobId: string;
  initialJob?: ResearchJob;
  onClose?: () => void;
}) {
  const [job, setJob] = useState<ResearchJob | null>(initialJob ?? null);
  const [events, setEvents] = useState<ResearchJobEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const terminal = job?.status === "done" || job?.status === "failed" || job?.status === "cancelled";

  useEffect(() => {
    let alive = true;
    let after = 0;
    const tick = async () => {
      try {
        const [jr, er] = await Promise.all([
          api.getResearchJob(jobId),
          api.getResearchJobEvents(jobId, after),
        ]);
        if (!alive) return;
        setJob(jr.job as ResearchJob);
        const evs = (er.events || []) as ResearchJobEvent[];
        if (evs.length) {
          after = Math.max(after, ...evs.map((e) => e.seq || 0));
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.seq));
            return [...prev, ...evs.filter((e) => !seen.has(e.seq))].slice(-120);
          });
        }
      } catch {
        /* best effort while polling */
      }
    };
    void tick();
    if (terminal) return () => { alive = false; };
    const t = setInterval(() => { void tick(); }, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [jobId, terminal]);

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await api.cancelResearchJob(jobId);
      setJob(res.job as ResearchJob);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  const statusLabel: Record<string, string> = {
    queued: "Queued", planning: "Planning", searching: "Searching", reading: "Reading sources",
    synthesizing: "Synthesizing", done: "Complete", failed: "Failed", cancelled: "Cancelled",
  };
  const s = job?.status || "queued";
  const sources = (job?.sources || []) as Array<Record<string, unknown>>;
  const readOk = sources.filter((x) => x.read_ok).length;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-step--1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[var(--text)]">Deep research</span>
            <StatusBadge status={s} label={statusLabel[s] || s} />
          </div>
          <p className="mt-1 text-[var(--muted)]">{job?.query || "Research job"}</p>
        </div>
        <div className="flex items-center gap-2">
          {!terminal ? (
            <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
              {busy ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
          {onClose ? <Button variant="ghost" onClick={onClose}>Close</Button> : null}
        </div>
      </div>

      {!terminal ? (
        <div className="mt-3 rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)] px-3 py-2">
          <div className="text-step--2 text-[var(--muted)]">
            {events.length ? events[events.length - 1]?.content : "Starting…"}
          </div>
          {sources.length > 0 ? (
            <div className="mt-1 text-step--2 text-[var(--faint)]">
              {sources.length} sources found · {readOk} read
            </div>
          ) : null}
        </div>
      ) : null}

      {job?.status === "failed" && job.error ? (
        <div className="mt-3 rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]">
          {job.error}
        </div>
      ) : null}

      {job?.status === "done" ? (
        <div className="mt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {job.library_doc_id ? (
              <Button variant="primary" onClick={() => navigate(`/library/${job.library_doc_id}`)}>
                Open in Library
              </Button>
            ) : null}
            {job.report_markdown ? (
              <Button onClick={() => navigator.clipboard?.writeText(job.report_markdown || "")}>Copy report</Button>
            ) : null}
          </div>
          {sources.length > 0 ? (
            <details className="mb-3 rounded-lg border border-[var(--border-dim)]">
              <summary className="cursor-pointer px-3 py-2 text-step--1 font-medium text-[var(--text-soft)]">
                Citations ({sources.length})
              </summary>
              <ol className="border-t border-[var(--border-dim)] px-3 py-2 text-step--2 text-[var(--muted)]">
                {sources.map((src, i) => (
                  <li key={`${src.url}-${i}`} className="mb-1.5 break-all">
                    <span className="text-[var(--faint)]">[{i + 1}]</span>{" "}
                    {src.url ? (
                      <a className="text-[var(--accent)] hover:underline" href={String(src.final_url || src.url)} target="_blank" rel="noreferrer">
                        {String(src.title || src.url)}
                      </a>
                    ) : (
                      String(src.title || "Source")
                    )}
                    {src.read_ok === false && src.read_error ? <span className="text-[var(--faint)]"> (unread)</span> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {job.report_markdown ? (
            <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)] p-3">
              <Markdown text={job.report_markdown} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReportCard({ part }: { part: any }) {
  const [open, setOpen] = useState(false);
  const content = part.content || "";
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-step--1">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-[var(--text)]">{part.title || "Report"}</div>
        <div className="flex gap-2">
          <button type="button" className="text-step--2 text-[var(--accent)] hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Open"}
          </button>
          <button type="button" className="text-step--2 text-[var(--accent)] hover:underline" onClick={() => navigator.clipboard?.writeText(content)}>
            Copy
          </button>
          <button
            type="button"
            className="text-step--2 text-[var(--accent)] hover:underline"
            onClick={() => {
              const blob = new Blob([content], { type: "text/markdown" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${(part.title || "report").replace(/[^a-z0-9]+/gi, "-")}.md`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export
          </button>
        </div>
      </div>
      {open ? (
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-step--1 text-[var(--text-soft)]">{content}</pre>
      ) : (
        <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[var(--text-soft)]">{content.slice(0, 200)}</div>
      )}
    </div>
  );
}

function PlanCard({ part, threadId, projectId, onApproved }: { part: any; threadId: string; projectId?: string; onApproved?: (id: string) => void }) {
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<any[]>(part.steps || []);
  const [mates, setMates] = useState<any[]>([]);
  useEffect(() => {
    if (!projectId) return;
    api.listTeammates(projectId).then((r: any) => setMates(r.teammates || [])).catch(() => {});
  }, [projectId]);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-step--1">
      <div className="font-semibold text-[var(--text)]">{part.objective || "Plan"}</div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {steps.map((st: any, i: number) => (
          <li key={i} className="rounded-md bg-[var(--surface)] px-2.5 py-1.5">
            <input
              value={st.title}
              onChange={(e) => {
                const next = [...steps];
                next[i] = { ...next[i], title: e.target.value };
                setSteps(next);
              }}
              className="w-full bg-transparent text-[var(--text)] outline-none"
            />
            <select
              value={st.assignee_slug || ""}
              onChange={(e) => {
                const next = [...steps];
                next[i] = { ...next[i], assignee_slug: e.target.value };
                setSteps(next);
              }}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 text-step--2 text-[var(--muted)]"
            >
              <option value="">unassigned</option>
              {mates.map((m: any) => (
                <option key={m.id} value={m.slug}>{m.slug || m.id}</option>
              ))}
            </select>
            <button
              type="button"
              className="mt-1 text-step--2 text-[var(--danger)] hover:underline"
              onClick={() => setSteps(steps.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {!approved && !part.approved ? (
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-step--2 font-medium text-white disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              try {
                const obj = await api.approvePlan?.(threadId, part.plan_id, { steps });
                setApproved(true);
                if (obj?.id) onApproved?.(obj.id);
                toast.success("Plan approved");
              } catch (err) {
                notifyError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Approving…" : "Approve plan"}
          </button>
        </div>
      ) : (
        <div className="mt-2 text-step--2 text-[var(--muted)]">Approved</div>
      )}
    </div>
  );
}

/** Split text on @handles so a mention reads as an address, not prose. */
function renderMentions(text: string) {
  return splitMentions(text).map((chunk, i) =>
    chunk.mention ? (
      <span
        key={i}
        className="rounded bg-[var(--accent-dim)] px-0.5 font-medium text-[var(--accent)]"
      >
        {chunk.text}
      </span>
    ) : (
      <span key={i}>{chunk.text}</span>
    ),
  );
}

function Message({
  message,
  streaming = false,
  parts,
  projectId,
  speaker,
  onCreateTask,
  onPlanApproved,
}: {
  message: ChatMessage;
  streaming?: boolean;
  parts?: any[];
  projectId?: string;
  /** Who is answering: name + face, or null for the default bot. */
  speaker?: { name: string; face?: Teammate["face"] } | null;
  onCreateTask?: (proposal: any) => void;
  onPlanApproved?: (id: string) => void;
}) {
  const isUser = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  // Long assistant replies (e.g. a model dumping a whole file) flood the
  // conversation the way a raw tool log would. Collapse them behind a toggle
  // so the chat stays scannable, like Grok/ChatGPT collapsing tool output.
  const COLLAPSE_AT = 6000;
  const isLong = !isUser && !streaming && message.content.length > COLLAPSE_AT;
  const displayContent = isLong && !expanded
    ? `${message.content.slice(0, COLLAPSE_AT)}\n\n…`
    : message.content;
  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-step-0 leading-relaxed ${
          isUser
            ? "border border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--text)]"
            : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text-soft)]"
        } ${streaming ? "animate-pulse" : ""}`}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{renderMentions(message.content)}</div>
        ) : (
          <>
            <Markdown text={displayContent} />
            {isLong ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-2 text-step--1 font-medium text-[var(--accent)] hover:underline"
              >
                {expanded ? "Show less" : `Show more (${Math.round(message.content.length / 1000 * 10) / 10}k chars)`}
              </button>
            ) : null}
          </>
        )}
        {streaming ? (
          <div className="mt-2 inline-block h-4 w-2 animate-pulse rounded-[1px] bg-[var(--accent)]" aria-hidden />
        ) : null}
      </div>
      {parts && parts.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {parts.map((p, i) => (
            <div key={i}>
              {p.type === "report" ? (
                <ReportCard part={p} />
              ) : p.type === "task" && p.proposal ? (
                <TaskProposalCard proposal={p.proposal} onCreateTask={onCreateTask} />
              ) : p.type === "plan" ? (
                <PlanCard part={p} threadId={message.thread_id} projectId={projectId} onApproved={onPlanApproved} />
              ) : (
                <pre className="whitespace-pre-wrap text-[var(--text-soft)]">{JSON.stringify(p)}</pre>
              )}
            </div>
          ))}
        </div>
      ) : null}
      <div className={`mono mt-1 flex items-center gap-1.5 text-step--2 text-[var(--faint)] ${isUser ? "mr-1" : "ml-1"}`}>
        {!isUser && speaker?.face ? <BotFace face={speaker.face} size={16} /> : null}
        <span>{isUser ? "you" : speaker?.name || "nerdbot"}</span>
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
  const [retryBusy, setRetryBusy] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

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
  const awaitingDecision =
    task?.status === "blocked" || task?.status === "awaiting_approval";

  if (view.error) {
    return (
      <div className="mx-4 mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm md:mx-6">
        <div className="flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-2">
          <span className="text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
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
        <span className="text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
          Execution
        </span>
        <div className="flex items-center gap-2">
          {task ? (
            <button
              onClick={() => openTask(task.project_id, task.id)}
              className="text-step--1 text-[var(--accent)] hover:underline"
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
      <div className="flex flex-col gap-3 px-4 py-3 text-step--1">
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
            This run needs your decision. It appears in the banner above.
          </div>
        )}
        {latestRun && latestRun.status === "failed" && (
          <div className="rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]">
            <div className="font-medium">
              {explainRunError(
                { command: task?.command || "", project_id: task?.project_id || state.projectId },
                { stderr: latestRun.stderr || "", output_excerpt: latestRun.output_excerpt || "" },
              ).message || "Run failed."}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={retryBusy}
                onClick={async () => {
                  if (!task) return;
                  setRetryBusy(true);
                  try {
                    await api.retryTask(task.id);
                    toast.message("Retry started.");
                  } catch (err) {
                    notifyError(err);
                  } finally {
                    setRetryBusy(false);
                  }
                }}
              >
                {retryBusy ? "Retrying…" : "Retry"}
              </Button>
              <button
                onClick={() => openTask(task!.project_id, task!.id)}
                className="text-step--1 text-[var(--accent)] hover:underline"
              >
                Open task →
              </button>
            </div>
          </div>
        )}
        {latestRun && (
          <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
            <div className="mono truncate text-[var(--text-soft)]">{latestRun.command || "(no command)"}</div>
            {latestRun.status === "failed" ? (
              <button
                type="button"
                onClick={() => setShowOutput((v) => !v)}
                className="mt-1 text-step--2 text-[var(--accent)] hover:underline"
              >
                {showOutput ? "Hide output" : "Show output"}
              </button>
            ) : null}
            {(latestRun.status !== "failed" || showOutput) && (
              <div className="mono mt-1 line-clamp-3 text-step--2 text-[var(--faint)]">
                {latestRun.output_excerpt?.slice(0, 240) || "(no output)"}
              </div>
            )}
          </div>
        )}
        {artifacts.length > 0 && (
          <div>
            <SectionLabel className="mb-1.5">Artifacts</SectionLabel>
            <div className="flex flex-col gap-1.5">
              {artifacts.map((art) => (
                <div key={art.id} className="rounded-md bg-[var(--surface-2)] px-3 py-1.5">
                  <div className="mono text-step--2 text-[var(--faint)]">
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
  onOpenBot,
  onAttachFile,
}: {
  type: "files" | "bots";
  projectId: string;
  onClose: () => void;
  /** Insert the teammate's @mention into the composer. */
  onSelectBot: (mate: Teammate) => void;
  /** Leave the conversation to open the teammate's own page. */
  onOpenBot: (teammateId: string) => void;
  onAttachFile: (file: { name: string; content: string }) => void;
}) {
  const bots = useAsync(
    () =>
      type === "bots"
        ? api.listTeammates(projectId)
        : Promise.resolve({ teammates: [] as Teammate[] }),
    [projectId, type],
  );
  const files = useAsync(
    () =>
      type === "files"
        ? api.projectWorkspaceFiles(projectId)
        : Promise.resolve({ checkouts: [], file_count: 0 }),
    [projectId, type],
  );
  const [attaching, setAttaching] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

  const attach = async (taskId: string, path: string) => {
    setAttaching(path);
    setAttachError(null);
    try {
      const file = await api.workspaceFile(taskId, path);
      onAttachFile({ name: path, content: file.content });
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <aside
        className="absolute right-0 top-0 flex h-full w-full flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-lg sm:w-[360px]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={type === "bots" ? "Teammates" : "Project files"}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-dim)] px-4 py-3">
          <span className="text-step-0 font-semibold">
            {type === "bots" ? "Teammates" : "Project files"}
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
          bots.loading ? (
            <LoadingState lines={3} />
          ) : bots.error ? (
            <ErrorState error={bots.error} onRetry={bots.reload} />
          ) : (
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
              {(bots.data?.teammates ?? []).length === 0 ? (
                <EmptyState title="No teammates" hint="Create one from the Teammates page." />
              ) : null}
              {(bots.data?.teammates ?? []).map((mate: Teammate) => (
                <div
                  key={mate.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <BotFace face={mate.face} size={32} />
                    <div className="min-w-0">
                      <div className="truncate text-step--1 font-medium text-[var(--text)]">
                        {mate.name || mate.slug || mate.id}
                      </div>
                      <div className="truncate text-step--2 text-[var(--faint)]">
                        {mate.persona?.slice(0, 80) || mate.instructions?.slice(0, 80) || ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="primary" onClick={() => onSelectBot(mate)}>
                      Mention
                    </Button>
                    <Button variant="ghost" onClick={() => onOpenBot(mate.id)}>
                      Open
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : files.loading ? (
          <LoadingState lines={3} />
        ) : files.error ? (
          <ErrorState error={files.error} onRetry={files.reload} />
        ) : (files.data?.checkouts ?? []).length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No project files yet"
              hint="A task writes into its own checkout. Run a task, then its files appear here to attach to the conversation."
            />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3">
            {attachError ? (
              <div className="mb-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--danger)]">
                {attachError}
              </div>
            ) : null}
            {(files.data?.checkouts ?? []).map((checkout) => (
              <div key={checkout.task_id} className="mb-4 last:mb-0">
                <a
                  href={`/p/${projectId}/t/${checkout.task_id}`}
                  className="block truncate text-step--1 font-medium text-[var(--text)] hover:underline"
                >
                  {checkout.task_description || "Untitled task"}
                </a>
                <div className="mono mb-1.5 truncate text-step--2 text-[var(--faint)]">
                  {checkout.branch || "checkout"}
                </div>
                <div className="flex flex-col gap-0.5">
                  {checkout.files.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => void attach(checkout.task_id, file.path)}
                      disabled={attaching === file.path}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-step--1 text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
                      title="Attach this file's contents to the next message"
                    >
                      <span className="mono min-w-0 truncate">{file.path}</span>
                      <span className="shrink-0 text-step--2 text-[var(--faint)]">
                        {attaching === file.path ? "reading…" : `${file.size} B`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
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
  onThreadCreated,
  onOpenThread,
  refreshProviders,
  refreshThreads,
}: {
  projectId: string;
  /** Recent conversations across every project the owner owns. */
  recentThreads: ChatThread[];
  providers: Array<Provider & { project_name?: string }>;
  summary: ReturnType<typeof useWorkspaceSummary>;
  onThreadCreated: (threadId: string, targetProjectId?: string) => void;
  onOpenThread: (thread: ChatThread) => void;
  refreshProviders?: () => void;
  refreshThreads?: () => void;
}) {
  const usable = usableProviders(providers);
  const hasProvider = usable.length > 0;
  const [draft, setDraft] = useState("");
  /* The owner's explicit choice wins; until they make one, start on the
     project's default model when it has one, otherwise on the first usable
     model anywhere so Home is never disabled above a working machine. A
     real model beats a demo one when both exist: defaulting to canned
     replies while a working model is connected is what let Home print
     "Everything is connected" above "Demo mode" at the same time. The
     chosen model decides which project the thread belongs to. */
  const [explicitProviderId, setExplicitProviderId] = useState<string | null>(null);
  const homeHasProvider = providers.some((provider) => provider.project_id === projectId);
  const realFirst = usable.filter((provider) => provider.kind !== "mock");
  const selectedProviderId =
    explicitProviderId ??
    (homeHasProvider
      ? "__default__"
      : (realFirst[0]?.id ?? usable[0]?.id ?? "__default__"));

  // A mock provider answers with canned text and executes nothing. The reply
  // says so, and this says so too, so the interface can label it instead of
  // passing it off as work.
  const isMockModel = providers.some(
    (p) => p.kind === "mock" && (p.id === selectedProviderId || selectedProviderId === "__default__"),
  );

  /* Discovery data for the getting-started path: what workspaces exist,
   * which bots are available, and which models are connected. */
  const workspacesLoader = useAsync(() => api.listProjects(), []);
  const botsLoader = useAsync(() => api.listAllTeammates(), []);
  const workspaces = workspacesLoader.data?.projects ?? [];
  void workspacesLoader.data?.counts;
  const bots = botsLoader.data?.teammates ?? [];

  const providersByProjectLoader = useAsync(async () => {
    const result: Record<string, Provider[]> = {};
    for (const project of workspaces) {
      try {
        const res = await api.listProviders(project.id);
        result[project.id] = res.providers;
      } catch {
        result[project.id] = [];
      }
    }
    return result;
  }, [workspaces]);
  void providersByProjectLoader.data;

  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  type PlanDraftState = { plan?: { tasks?: Array<{ description?: string; command?: string } & Record<string, unknown>> } & Record<string, unknown> } & Record<string, unknown>;
  const [planDraft, setPlanDraft] = useState<PlanDraftState | null>(null);
  const [planObjective, setPlanObjective] = useState("");
  const [researchJobIds, setResearchJobIds] = useState<string[]>([]);
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
      const selected = providers.find(
        (provider) => provider.id === selectedProviderId,
      );
      const targetProjectId = selected?.project_id ?? projectId;
      const thread = await api.createThread(targetProjectId, {
        title: content.slice(0, 60),
        provider_id: selected?.id,
      });
      try {
        await api.sendChatStream(thread.id, content, (chunk) => {
          setStreaming((prev) => prev + chunk);
        }, undefined, undefined, "chat", { signal: controller.signal });
      } catch (err) {
        if (err instanceof ApiError && err.detail === "Stream stopped") {
          stopped = true;
          setStreaming((prev) => (prev ? `${prev}\n[stopped]` : ""));
        } else {
          throw err;
        }
      }
      setDraft("");
      refreshThreads?.();
      onThreadCreated(thread.id, targetProjectId);
    } catch (err) {
      notifyError(err);
    } finally {
      abortRef.current = null;
      setBusy(false);
      if (!stopped) setStreaming("");
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const startDeepResearch = async () => {
    const query = draft.trim();
    if (!query) {
      toast.error("Enter a research question first.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.createProjectResearchJob(projectId, { query });
      const job = res.job as ResearchJob;
      if (job?.id) {
        setResearchJobIds((prev) => [job.id, ...prev.filter((id) => id !== job.id)].slice(0, 6));
        setDraft("");
        toast.success("Deep research started in the background.");
      }
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  // The resume list spans every project the owner owns, so a conversation
  // started elsewhere is still one click away from here.
  const sorted = [...recentThreads].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const projectLabel = (id: string) => {
    const bundle = summary.data?.summary.bundles.find((b) => b.project.id === id);
    return bundle?.project.repository || "project";
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-4 py-8 md:px-6">
        {/* The workspace banner renders once above this pane (ConversationView). */}

        {/* Phase 0: chat-first, teammate-first home */}
        <div className="space-y-2">
          <h1 className="text-step-3 font-semibold tracking-tight text-[var(--text)]">
            Chat with your AI team
          </h1>
          <p className="max-w-2xl text-step-0 text-[var(--text-soft)]">
            Start a conversation, ask for research, or plan work with your teammates. NerdBot shows what is running, what needs your approval, and what finished.
          </p>
        </div>

        {/* Teammate strip */}
        {(summary.summary.bots.length > 0 || bots.length > 0) ? (
          <section aria-label="Your team" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <SectionLabel>Your team</SectionLabel>
              <Button variant="ghost" onClick={() => navigate("/bots")}>View all</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {(summary.summary.bots.length > 0 ? summary.summary.bots : bots).slice(0, 8).map((bot) => {
                const handle = mentionHandle(bot);
                return (
                  <div
                    key={bot.id}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] pr-1"
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-step--1 text-[var(--text)] hover:bg-[var(--surface-3)]"
                      onClick={() => navigate(`/bot/${bot.id}`)}
                      title="Open teammate"
                    >
                      <BotFace face={bot.face} size={18} status={bot.status} />
                      <span className="max-w-[10rem] truncate">{bot.persona || bot.name || "Teammate"}</span>
                      <StatusDot status={bot.status} />
                    </button>
                    {handle ? (
                      <button
                        type="button"
                        className="rounded-full px-1.5 py-0.5 text-step--2 text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
                        onClick={() => setDraft((d) => insertMention(d, handle))}
                        title={`Mention @${handle}`}
                        aria-label={`Mention @${handle}`}
                      >
                        @
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* Capability-honest quick actions (modes available inside conversations) */}
        <section aria-label="What you can do now" className="flex flex-wrap gap-2">
          <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-step--2 text-[var(--text-soft)]">
            Chat
          </span>
          <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-step--2 text-[var(--text-soft)]" title="Available in conversation mode when tools are enabled">
            Research (web search)
          </span>
          <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-step--2 text-[var(--text-soft)]" title="Available in conversation mode">
            Delegate work
          </span>
          <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-step--2 text-[var(--text-soft)]">
            Plan &amp; run tasks
          </span>
        </section>

        {planDraft?.plan?.tasks ? (
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-step-1 font-semibold">Plan preview</h3>
              <Button variant="ghost" onClick={() => { setPlanDraft(null); setPlanObjective(""); }}>
                Cancel
              </Button>
            </div>
            <p className="mb-3 text-step--1 text-[var(--muted)]">{planObjective}</p>
            <div className="space-y-3">
              {(planDraft.plan?.tasks ?? []).map((task, idx) => (
                <div key={idx} className="rounded-lg border border-[var(--border-dim)] p-3">
                  <input
                    className="mb-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-step--1"
                    value={task.description}
                    onChange={(e) => {
                      const next = { ...planDraft };
                      if (next.plan?.tasks?.[idx]) next.plan.tasks[idx] = { ...next.plan.tasks[idx], description: e.target.value };
                      setPlanDraft(next);
                    }}
                  />
                  <input
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-step--2"
                    value={task.command || ""}
                    placeholder="command (optional)"
                    onChange={(e) => {
                      const next = { ...planDraft };
                      if (next.plan?.tasks?.[idx]) next.plan.tasks[idx] = { ...next.plan.tasks[idx], command: e.target.value };
                      setPlanDraft(next);
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await api.createObjective(projectId, {
                      objective: planObjective,
                      plan: planDraft.plan,
                      create_board: true,
                    });
                    toast.success("Plan executed");
                    setPlanDraft(null);
                    setPlanObjective("");
                    const boardId = (result as { board?: { id?: string } })?.board?.id;
                    if (boardId) navigate(`/p/${projectId}?tab=tasks`);
                  } catch (err) {
                    notifyError(err);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Execute plan
              </Button>
            </div>
          </section>
        ) : null}

        {/* Primary composer */}
        <div className="scroll-mt-6">
          <form onSubmit={send}>
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
                    ? "Message your team, ask for research, or describe work to plan…"
                    : "Connect a model to start chatting."
                }
                disabled={busy || !hasProvider}
                spellCheck
                rows={3}
                aria-label="Start a conversation"
                className="max-h-48 min-h-[64px] w-full min-w-0 resize-none bg-transparent p-2.5 leading-relaxed outline-none placeholder:text-[var(--faint)] disabled:opacity-50 sm:w-auto sm:flex-1"
              />
              <div className="flex items-center gap-2 justify-end">
                <ModelChip
                  providers={providers}
                  value={selectedProviderId}
                  onChange={setExplicitProviderId}
                  disabled={busy || !hasProvider}
                />
                {busy ? (
                  <Button variant="danger" type="button" onClick={stop} disabled={!streaming}>
                    ■ Stop
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      disabled={busy || !draft.trim()}
                      onClick={() => void startDeepResearch()}
                      title="Run multi-source deep research in the background with citations"
                    >
                      Deep research
                    </Button>
                    <Button
                      type="button"
                      disabled={busy || !draft.trim() || !hasProvider}
                      onClick={async () => {
                        const content = draft.trim();
                        if (!content) return;
                        setBusy(true);
                        try {
                          const result = await api.createObjective(projectId, { objective: content, preview: true });
                          setPlanObjective(content);
                          setPlanDraft(result as PlanDraftState);
                          setDraft("");
                        } catch (err) {
                          notifyError(err);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      title="Create a plan preview from your message"
                    >
                      Plan &amp; execute
                    </Button>
                    <Button variant="primary" type="submit" disabled={busy || !draft.trim() || !hasProvider}>
                      Send ⏎
                    </Button>
                  </>
                )}
              </div>
            </div>
            {streaming && (
              <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 text-[var(--text-soft)]">
                <Markdown text={streaming} />
                <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-[1px] bg-[var(--accent)] align-middle" aria-hidden />
              </div>
            )}
            {researchJobIds.length > 0 ? (
              <div className="mt-3 flex flex-col gap-3">
                {researchJobIds.map((id) => (
                  <ResearchJobCard
                    key={id}
                    jobId={id}
                    onClose={() => setResearchJobIds((prev) => prev.filter((x) => x !== id))}
                  />
                ))}
              </div>
            ) : null}
          </form>

          {!hasProvider ? (
            <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-step--1">
              <p className="font-medium text-[var(--text)]">Connect a model to start</p>
              <p className="mt-1 text-[var(--muted)]">
                NerdBot needs a model connection to chat, research, or run work. Your data stays in your workspaces.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="primary" type="button" onClick={() => setShowConfigure((v) => !v)}>
                  Connect a model
                </Button>
                <Button type="button" onClick={() => navigate("/settings")}>Open settings</Button>
              </div>
            </div>
          ) : hasProvider && isMockModel ? (
            <div
              className="mt-3 rounded-lg border border-[var(--info)] bg-[var(--info-dim)] px-4 py-3"
              role="status"
            >
              <p className="text-step--1 font-medium text-[var(--text)]">Demo mode</p>
              <p className="mt-1 text-step--1 text-[var(--text-soft)]">
                Replies are simulated and no real work runs. Connect a model to use your team for real tasks.
              </p>
              <button
                type="button"
                onClick={() => setShowConfigure((v) => !v)}
                className="mt-2 text-step--1 font-medium text-[var(--text)] underline underline-offset-4"
              >
                Connect a real model
              </button>
            </div>
          ) : (
            <p className="mt-2 text-step--2 text-[var(--faint)]">
              New messages start in chat. Inside a conversation you can switch to Research (web search) or Delegate work when available.
            </p>
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
                  className="w-40 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <input
                  value={provBaseUrl}
                  onChange={(e) => setProvBaseUrl(e.target.value)}
                  placeholder="Base URL (e.g. https://api.groq.com/openai/v1)"
                  aria-label="Base URL"
                  required
                  className="mono min-w-64 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <input
                  value={provModel}
                  onChange={(e) => setProvModel(e.target.value)}
                  placeholder="Model (optional)"
                  aria-label="Model"
                  className="w-44 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <input
                  type="password"
                  value={provApiKey}
                  onChange={(e) => setProvApiKey(e.target.value)}
                  placeholder="API key"
                  aria-label="API key"
                  autoComplete="off"
                  className="w-48 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <Button variant="primary" type="submit" disabled={provBusy || !provBaseUrl.trim()}>
                  {provBusy ? "Connecting…" : "Connect"}
                </Button>
                <Button type="button" onClick={() => setShowConfigure(false)}>
                  Cancel
                </Button>
              </form>
              <p className="mt-2 text-step--2 text-[var(--faint)]">
                Keys are stored encrypted at rest when the server has NERDBOT_SECRET_KEY set.
              </p>
            </div>
          )}
        </div>


        {/* One list. Home has no conversation rail, so this is the whole
            history rather than a second copy of it. */}
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <SectionLabel>Conversations</SectionLabel>
              <span className="text-step--2 text-[var(--faint)]">
                every workspace
              </span>
            </div>
            {sorted.length > 0 && refreshThreads ? (
              <Button variant="ghost" onClick={() => void refreshThreads()}>
                Refresh
              </Button>
            ) : null}
          </div>
          {sorted.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border-dim)] px-4 py-6 text-center text-step--1 text-[var(--faint)]">
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
                  <span className="truncate text-step--1 text-[var(--text)]">
                    {t.title || "Untitled"}
                  </span>
                  {t.project_id !== projectId ? (
                    <span className="mono shrink-0 text-step--2 text-[var(--faint)]">
                      {projectLabel(t.project_id)}
                    </span>
                  ) : null}
                  <span className="mono shrink-0 text-step--2 text-[var(--faint)]">
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
