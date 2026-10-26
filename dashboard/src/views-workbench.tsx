/** The workspace workbench: files, editor, terminal, changes, and runs.
 *
 *  The layout is the product's three answers, left to right: what exists
 *  (files and bots), what I am working on (editor and terminal), and what
 *  happened (changes and the latest run). On a narrow screen those become
 *  four tabs rather than a column of unreachable panels.
 *
 *  Every panel owns its loading, empty, and error state. State that belongs
 *  to one workspace is tagged with that workspace id before it is rendered,
 *  so switching projects never leaves another project's files on screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, FormEvent, ReactNode, RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";
import { ApiError, api } from "./api";
import { describeError, navigate, notifyError } from "./app";
import {
  Badge,
  BotFace,
  Button,
  EmptyState,
  ErrorState,
  FORM_INPUT,
  FORM_SELECT,
  LoadingState,
  Modal,
  ShortId,
  StatusBadge,
  StatusDot,
  taskStatusLabel,
  useAsync,
  useTheme,
} from "./components";
import type { TaskView, WorkspaceFile } from "./types";
import {
  WORKBENCH_PANES,
  diffStats,
  filterFiles,
  formatBytes,
  isTaskActive,
  lineCount,
  modifierLabel,
  pickInitialFile,
  shortcutFor,
  stepFile,
  suggestFiles,
  terminalStatusLabel,
  terminalTheme,
  type TerminalStatus,
  type WorkbenchCommand,
  type WorkbenchPane,
} from "./workbench";

const PLATFORM = typeof navigator === "undefined" ? "" : navigator.platform;
const IS_MAC = /Mac|iPod|iPhone|iPad/i.test(PLATFORM);
const MOD = modifierLabel(PLATFORM);
const PROJECT_KEY = "nerdbot.workbench.project";
const EMPTY_FILES: WorkspaceFile[] = [];
const COMMAND_SUGGESTIONS = ["git status", "ls -la", "npm test"];
const MAX_DIFF_LINES = 600;

const SHORTCUTS: Array<{ label: string; keys: string }> = [
  { label: "Save file", keys: `${MOD}+S` },
  { label: "Open a path", keys: `${MOD}+O` },
  { label: "Find a file", keys: `${MOD}+P` },
  { label: "Run command", keys: `${MOD}+↵` },
  { label: "Focus terminal", keys: `${MOD}+\`` },
  { label: "Collapse terminal", keys: `${MOD}+J` },
  { label: "Previous file", keys: "Alt+↑" },
  { label: "Next file", keys: "Alt+↓" },
  { label: "Keyboard shortcuts", keys: "?" },
  { label: "Close dialog", keys: "Esc" },
];

const ICONS = {
  refresh: "M13.5 8a5.5 5.5 0 1 1-1.7-3.9M13.5 2.5v3.2h-3.2",
  chevronDown: "m4 6 4 4 4-4",
  file: "M4 1.5h5.5L12.5 4.5v10H4zM9.5 1.5v3h3",
  terminal: "M2.5 3.5h11v9h-11zM4.5 6l1.8 1.8-1.8 1.8M8.5 9.5h3",
  branch: "M5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5 5.5v4A2.5 2.5 0 0 0 7.5 12h3.5M11 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 0v1.5A2.5 2.5 0 0 1 8.5 10H7",
  plus: "M8 3v10M3 8h10",
} as const;

function readStoredProject(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function storeProject(id: string | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    // A blocked storage API must not make the workbench unusable.
  }
}

function Icon({ path, className = "" }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
    >
      <path d={path} />
    </svg>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-[var(--border-dim)] bg-[var(--surface-2)] px-1 font-mono text-step--2 font-medium text-[var(--text-soft)]">
      {children}
    </span>
  );
}

function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] ${className}`}
    />
  );
}

/** A compact panel state sized for a rail, not a whole page. */
function PanelEmpty({
  title,
  hint,
  children,
  icon,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      {icon ? <div className="mb-1 text-[var(--faint)]">{icon}</div> : null}
      <p className="text-step--1 font-medium text-[var(--text)]">{title}</p>
      {hint ? (
        <p className="max-w-[40ch] text-step--2 leading-relaxed text-[var(--muted)]">
          {hint}
        </p>
      ) : null}
      {children ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/** The one panel chrome every workbench surface uses. */
function Panel({
  title,
  count,
  meta,
  actions,
  children,
  className = "",
  bodyClassName = "",
  ...rest
}: {
  title: string;
  count?: number;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
} & Omit<ComponentPropsWithoutRef<"section">, "title" | "children" | "className">) {
  return (
    <section
      {...rest}
      className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      <div className="flex h-10 max-lg:h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-dim)] px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="truncate text-step--2 font-semibold uppercase tracking-[0.14em] text-[var(--faint)]">
            {title}
          </h2>
          {count !== undefined ? (
            <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-1.5 py-px text-step--2 tabular-nums text-[var(--text-soft)]">
              {count}
            </span>
          ) : null}
          {meta ? (
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">{meta}</span>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
      </div>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  expanded,
  children,
  className = "",
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  expanded?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 w-7 max-lg:h-11 max-lg:w-11 items-center justify-center rounded-md text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("#workbench-terminal")) return true;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

function focusAfterPaint(ref: RefObject<HTMLElement | null>) {
  const focus = () => ref.current?.focus();
  if (typeof requestAnimationFrame !== "function") {
    focus();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(focus));
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-[var(--faint)]";
  if (line.startsWith("@@")) return "text-[var(--info)]";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-[var(--faint)]";
  if (line.startsWith("+")) return "bg-[var(--accent-dim)] text-[var(--accent)]";
  if (line.startsWith("-")) return "bg-[var(--danger-dim)] text-[var(--danger)]";
  return "text-[var(--text-soft)]";
}

function DiffBody({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-b-lg bg-[var(--surface-2)]">
      <div className="min-w-max py-2 font-mono text-step--2 leading-relaxed">
        {shown.map((line, index) => (
          <div key={index} className={`whitespace-pre px-3 ${diffLineClass(line)}`}>
            {line || " "}
          </div>
        ))}
      </div>
      {lines.length > MAX_DIFF_LINES ? (
        <div className="border-t border-[var(--border-dim)] px-3 py-2 text-step--2 text-[var(--faint)]">
          Showing the first {MAX_DIFF_LINES} lines. The rest is in the task's diff artifact.
        </div>
      ) : null}
    </div>
  );
}

/* --- Task feed ----------------------------------------------------------- */

interface TaskFeed {
  data: TaskView | null;
  error: unknown;
  loading: boolean;
}

const EMPTY_TASK_FEED: TaskFeed = { data: null, error: null, loading: false };
const LOADING_TASK_FEED: TaskFeed = { data: null, error: null, loading: true };

/** The Run panel's data source. Unlike the generic loader it keeps polling
 *  while a task can still change, and it never replaces a good result with a
 *  blank panel when one background refresh fails. */
function useTaskView(taskId: string | null): TaskFeed & { reload: () => void } {
  const [nonce, setNonce] = useState(0);
  const key = taskId ? `${taskId}:${nonce}` : null;
  const [snapshot, setSnapshot] = useState<{ key: string; feed: TaskFeed } | null>(null);

  useEffect(() => {
    if (!taskId || !key) return;
    let cancelled = false;
    api.taskView(taskId).then(
      (data) => {
        if (!cancelled) setSnapshot({ key, feed: { data, error: null, loading: false } });
      },
      (error: unknown) => {
        if (!cancelled) setSnapshot({ key, feed: { data: null, error, loading: false } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, key]);

  /* A new task (or an explicit reload) is loading straight away, without a
   * render pass that briefly shows the previous task's result. */
  const feed = !key ? EMPTY_TASK_FEED : snapshot?.key === key ? snapshot.feed : LOADING_TASK_FEED;
  const active = isTaskActive(feed.data?.task.status);

  useEffect(() => {
    if (!taskId || !key || !active) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api.taskView(taskId).then(
        (data) => {
          if (!cancelled) setSnapshot({ key, feed: { data, error: null, loading: false } });
        },
        (error: unknown) => {
          if (!cancelled) {
            setSnapshot((previous) =>
              previous?.key === key
                ? { key, feed: { ...previous.feed, error, loading: false } }
                : previous,
            );
          }
        },
      );
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId, key, active]);

  return { ...feed, reload: () => setNonce((n) => n + 1) };
}

/* --- View ---------------------------------------------------------------- */

export function WorkbenchView() {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(readStoredProject);
  const projects = useAsync(() => api.listProjects(), []);
  const projectList = projects.data?.projects ?? [];
  /* Restore the stored pick when the list arrives. Falling back to index 0
   *  silently opened whatever project the backend returned first, so a owner
   *  who had been working in project B landed in A's empty workspace. */
  const project =
    projectList.find((candidate) => candidate.id === selectedProjectId) ??
    (selectedProjectId ? null : projectList[0] ?? null);
  const activeId = project?.id ?? null;

  useEffect(() => {
    storeProject(activeId);
  }, [activeId]);

  /* Every workspace-scoped response carries its project id, so a response
   * that arrives after a switch is ignored instead of shown in the wrong
   * workspace. */
  const tree = useAsync(async () => {
    if (!activeId) return null;
    return { projectId: activeId, data: await api.projectWorkspaceTree(activeId) };
  }, [activeId]);
  const treeForActive = tree.data?.projectId === activeId ? tree.data.data : null;
  const treeLoading = treeForActive === null && tree.loading;
  const files = treeForActive?.files ?? EMPTY_FILES;
  const workspaceBusy = treeForActive?.busy ?? false;

  const diff = useAsync(async () => {
    if (!activeId) return null;
    return { projectId: activeId, data: await api.projectWorkspaceDiff(activeId) };
  }, [activeId]);
  const diffForActive = diff.data?.projectId === activeId ? diff.data.data : null;
  const diffLoading = diffForActive === null && diff.loading;
  const changes = diffForActive?.status ?? [];
  const stats = diffStats(diffForActive?.diff ?? "");

  const teammates = useAsync(async () => {
    if (!activeId) return null;
    const response = await api.listTeammates(activeId);
    return { projectId: activeId, teammates: response.teammates };
  }, [activeId]);
  const matesForActive = teammates.data?.projectId === activeId ? teammates.data.teammates : null;
  const mates = matesForActive ?? [];
  const matesLoading = matesForActive === null && teammates.loading;

  // --- Files ---------------------------------------------------------------
  const [path, setPath] = useState("README.md");
  const [fileQuery, setFileQuery] = useState("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const dirty = loadedPath !== null && (savedContent === null || content !== savedContent);
  const isNewFile = loadedPath !== null && savedContent === null;
  const visibleFiles = useMemo(() => filterFiles(files, fileQuery), [files, fileQuery]);
  const visiblePaths = useMemo(() => visibleFiles.map((file) => file.path), [visibleFiles]);
  const previousPath = stepFile(visiblePaths, loadedPath, -1);
  const nextPath = stepFile(visiblePaths, loadedPath, 1);

  // --- Tasks ---------------------------------------------------------------
  const [cmd, setCmd] = useState("");
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const taskState = useTaskView(lastTaskId);
  const taskView = taskState.data;
  const task = taskView?.task ?? null;
  const taskActive = isTaskActive(task?.status);
  const refreshedTask = useRef<string | null>(null);

  // --- Terminal ------------------------------------------------------------
  const terminalHost = useRef<HTMLDivElement | null>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitInstance = useRef<FitAddon | null>(null);
  const isDarkRef = useRef(isDark);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>("idle");
  const [terminalError, setTerminalError] = useState<unknown>(null);
  const [terminalGeneration, setTerminalGeneration] = useState(0);

  // --- UI ------------------------------------------------------------------
  const [mobilePane, setMobilePane] = useState<WorkbenchPane>("editor");
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const pathInput = useRef<HTMLInputElement | null>(null);
  const fileSearch = useRef<HTMLInputElement | null>(null);
  const cmdInput = useRef<HTMLInputElement | null>(null);
  const editorInput = useRef<HTMLTextAreaElement | null>(null);

  const confirmDiscard = useCallback((): boolean => {
    if (!dirty) return true;
    return window.confirm("You have unsaved changes. Discard them?");
  }, [dirty]);

  const openPath = useCallback(
    async (raw: string, createOnMissing = false, reveal = true) => {
      const requested = raw.trim();
      if (!activeId || !requested) return;
      if (!confirmDiscard()) return;
      setFileLoading(true);
      setFileError(null);
      try {
        const result = await api.projectWorkspaceFile(activeId, requested);
        setPath(result.path);
        setContent(result.content);
        setSavedContent(result.content);
        setLoadedPath(result.path);
        if (reveal) setMobilePane("editor");
      } catch (error) {
        if (createOnMissing && error instanceof ApiError && error.status === 404) {
          setPath(requested);
          setContent("");
          setSavedContent(null);
          setLoadedPath(requested);
          if (reveal) setMobilePane("editor");
          focusAfterPaint(editorInput);
          toast.info(`New file: ${requested}. Save to create it.`);
        } else {
          setFileError(error);
        }
      } finally {
        setFileLoading(false);
      }
    },
    [activeId, confirmDiscard],
  );

  const saveFile = useCallback(async () => {
    if (!activeId || !loadedPath || !dirty || saving) return;
    if (workspaceBusy) {
      toast.error("A live run is using this workspace. Save when it finishes.");
      return;
    }
    setSaving(true);
    setFileError(null);
    try {
      await api.saveProjectWorkspaceFile(activeId, loadedPath, content);
      setSavedContent(content);
      setPath(loadedPath);
      toast.success(`Saved ${loadedPath}`);
      tree.reload();
      diff.reload();
    } catch (error) {
      setFileError(error);
      notifyError(error);
    } finally {
      setSaving(false);
    }
  }, [activeId, loadedPath, dirty, saving, workspaceBusy, content, tree, diff]);

  const startNewFile = useCallback(
    (name: string) => {
      const target = name.trim();
      if (!target || !confirmDiscard()) return;
      setPath(target);
      setContent("");
      setSavedContent(null);
      setLoadedPath(target);
      setFileError(null);
      setMobilePane("editor");
      focusAfterPaint(editorInput);
    },
    [confirmDiscard],
  );

  const beginNewPath = useCallback(() => {
    setMobilePane("editor");
    setPath("");
    focusAfterPaint(pathInput);
  }, []);

  /* Switching projects swaps every piece of workspace-owned state at the
   * point of the switch, before the new tree request is even made. */
  const resetWorkspaceUi = useCallback(() => {
    setPath("README.md");
    setFileQuery("");
    setContent("");
    setSavedContent(null);
    setLoadedPath(null);
    setFileError(null);
    setLastTaskId(null);
    setCmd("");
    setSessionId(null);
    setTerminalError(null);
    setTerminalStatus("idle");
  }, []);

  // Open a README (or the first text file) so the workspace is never a blank
  // page with no next action.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId || !treeForActive || autoOpened.current === activeId) return;
    if (loadedPath) {
      autoOpened.current = activeId;
      return;
    }
    const initial = pickInitialFile(treeForActive.files);
    autoOpened.current = activeId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- this is the async file load for a newly arrived tree, not derived state written during render.
    if (initial) void openPath(initial, false, false);
  }, [activeId, treeForActive, loadedPath, openPath]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Refresh the diff and file list once a run reaches a terminal state.
  useEffect(() => {
    if (!lastTaskId || !task?.status || isTaskActive(task.status)) return;
    if (refreshedTask.current === lastTaskId) return;
    refreshedTask.current = lastTaskId;
    tree.reload();
    diff.reload();
  }, [lastTaskId, task?.status, tree, diff]);

  const runTask = useCallback(async () => {
    const command = cmd.trim();
    if (!activeId || running) return;
    if (workspaceBusy) {
      toast.error("A live run is using this workspace. Run something else when it finishes.");
      return;
    }
    if (!command) {
      setMobilePane("review");
      focusAfterPaint(cmdInput);
      return;
    }
    setRunning(true);
    try {
      const created = await api.createTask(activeId, {
        description: command,
        command,
        workspace_mode: "workspace",
      });
      setLastTaskId(created.id);
      await api.runTaskAsync(created.id);
      setMobilePane("review");
      toast.success("Task started");
    } catch (error) {
      notifyError(error);
    } finally {
      setRunning(false);
    }
  }, [activeId, cmd, running, workspaceBusy]);

  // --- Terminal lifecycle --------------------------------------------------
  /* Keep the ref used by the terminal builder current, then repaint the
   * existing terminal. A theme change must never rebuild the PTY. This runs
   * before the lifecycle effect below so a newly mounted terminal is created
   * with the theme that is on screen. */
  useEffect(() => {
    isDarkRef.current = isDark;
    if (terminalInstance.current) {
      terminalInstance.current.options.theme = terminalTheme(isDark);
    }
  }, [isDark]);

  useEffect(() => {
    const host = terminalHost.current;
    if (!activeId || !host) return;

    setTerminalStatus("idle");
    setTerminalError(null);

    const term = new Terminal({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      fontFamily: '"Geist Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.25,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: terminalTheme(isDarkRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    terminalInstance.current = term;
    fitInstance.current = fit;

    let session: string | null = null;
    let started = false;
    let closed = false;
    let dataListener: { dispose: () => void } | null = null;
    let frame = 0;
    const abort = new AbortController();

    const start = async () => {
      if (closed || started) return;
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      started = true;
      fit.fit();
      setTerminalStatus("connecting");
      try {
        const info = await api.createTerminal(
          activeId,
          Math.max(20, term.cols),
          Math.max(5, term.rows),
        );
        if (closed) {
          void api.closeTerminal(activeId, info.session_id).catch(() => undefined);
          return;
        }
        session = info.session_id;
        setSessionId(info.session_id);
        setTerminalStatus("ready");
        dataListener = term.onData((data) => {
          if (session) void api.sendTerminalInput(activeId, session, data).catch(() => undefined);
        });
        void api
          .streamTerminal(
            activeId,
            info.session_id,
            {
              onSnapshot: (data) => {
                if (closed) return;
                term.write(data);
                setTerminalStatus("ready");
              },
              onData: (data) => {
                if (!closed) term.write(data);
              },
              onExit: () => {
                if (closed) return;
                term.write("\r\n[process exited]\r\n");
                setTerminalStatus("exited");
              },
            },
            abort.signal,
          )
          .then(() => {
            if (!closed) setTerminalStatus((previous) => (previous === "error" ? previous : "exited"));
          })
          .catch((error: unknown) => {
            if (closed || (error as { name?: string })?.name === "AbortError") return;
            setTerminalError(error);
            setTerminalStatus("error");
          });
      } catch (error) {
        if (closed) return;
        setTerminalError(error);
        setTerminalStatus("error");
      }
    };

    const scheduleFit = () => {
      if (closed) return;
      if (typeof requestAnimationFrame !== "function") return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (closed || host.clientWidth === 0 || host.clientHeight === 0) return;
        fit.fit();
        if (!started) {
          void start();
          return;
        }
        if (session) {
          void api.resizeTerminal(activeId, session, term.cols, term.rows).catch(() => undefined);
        }
      });
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    void start();

    return () => {
      closed = true;
      abort.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataListener?.dispose();
      if (session) void api.closeTerminal(activeId, session).catch(() => undefined);
      term.dispose();
      if (terminalInstance.current === term) {
        terminalInstance.current = null;
        fitInstance.current = null;
      }
    };
  }, [activeId, terminalGeneration]);

  const restartTerminal = useCallback(() => {
    setSessionId(null);
    setTerminalError(null);
    setTerminalStatus("connecting");
    setTerminalGeneration((generation) => generation + 1);
  }, []);

  // --- Focus + navigation --------------------------------------------------
  const focusPath = useCallback(() => {
    setMobilePane("editor");
    focusAfterPaint(pathInput);
  }, []);

  const focusFileSearch = useCallback(() => {
    setMobilePane("files");
    focusAfterPaint(fileSearch);
  }, []);

  const focusTerminal = useCallback(() => {
    setTerminalOpen(true);
    setMobilePane("terminal");
    if (typeof requestAnimationFrame !== "function") {
      terminalInstance.current?.focus();
      return;
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fitInstance.current?.fit();
        terminalInstance.current?.focus();
      }),
    );
  }, []);

  const toggleTerminal = useCallback(() => {
    const next = !terminalOpen;
    setTerminalOpen(next);
    if (!next) return;
    setMobilePane("terminal");
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fitInstance.current?.fit();
        terminalInstance.current?.focus();
      }),
    );
  }, [terminalOpen]);

  const openRelative = useCallback(
    (direction: 1 | -1) => {
      const target = stepFile(visiblePaths, loadedPath, direction);
      if (target) void openPath(target);
    },
    [visiblePaths, loadedPath, openPath],
  );

  // --- Keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && showHelp) {
        event.preventDefault();
        setShowHelp(false);
        return;
      }
      const command = shortcutFor(event, IS_MAC);
      if (!command) return;

      const inTerminal =
        event.target instanceof HTMLElement &&
        event.target.closest("#workbench-terminal") !== null;
      // The shell owns its keystrokes. Save is the one action the owner may
      // still want while the terminal has focus.
      if (inTerminal && command !== "save") return;

      const editable = isEditableTarget(event.target);
      const allowedWhileEditing =
        command === "save" ||
        command === "open" ||
        command === "find-file" ||
        command === "run" ||
        command === "focus-terminal" ||
        command === "toggle-terminal";
      if (editable && !allowedWhileEditing) return;

      const handled: Record<WorkbenchCommand, () => void> = {
        save: () => void saveFile(),
        open: focusPath,
        "find-file": focusFileSearch,
        run: () => void runTask(),
        "focus-terminal": focusTerminal,
        "toggle-terminal": toggleTerminal,
        "prev-file": () => openRelative(-1),
        "next-file": () => openRelative(1),
        help: () => setShowHelp(true),
      };
      event.preventDefault();
      handled[command]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showHelp,
    saveFile,
    runTask,
    focusPath,
    focusFileSearch,
    focusTerminal,
    toggleTerminal,
    openRelative,
  ]);

  const changeProject = (nextId: string) => {
    if (nextId === activeId) return;
    if (!confirmDiscard()) return;
    resetWorkspaceUi();
    setSelectedProjectId(nextId);
  };

  const refreshAll = () => {
    projects.reload();
    tree.reload();
    diff.reload();
    teammates.reload();
    taskState.reload();
  };

  const terminalTone =
    terminalStatus === "ready"
      ? "bg-[var(--accent)]"
      : terminalStatus === "error"
        ? "bg-[var(--danger)]"
        : terminalStatus === "connecting"
          ? "bg-[var(--warn)] animate-pulse"
          : "bg-[var(--faint)]";

  const paneIndicator: Record<WorkbenchPane, string | number | null> = {
    files: files.length || null,
    editor: dirty ? "•" : null,
    terminal:
      terminalStatus === "error" ? "!" : terminalStatus === "connecting" ? "…" : null,
    review: changes.length || null,
  };

  // --- Guards --------------------------------------------------------------
  if (projects.loading && !projects.data) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md">
          <LoadingState lines={6} />
        </div>
      </div>
    );
  }
  if (projects.error && !projects.data) {
    return (
      <div className="p-4">
        <ErrorState error={projects.error} onRetry={projects.reload} />
      </div>
    );
  }
  if (!activeId) {
    return (
      <EmptyState
        title="No workspace yet"
        hint="The workbench needs a workspace. Create a project, then return here to edit files, run commands, and see what changed."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={() => navigate("#/projects")}>
              Create project
            </Button>
            <Button onClick={() => navigate("#/")}>Back to chat</Button>
          </div>
        }
      />
    );
  }

  const showEditor = mobilePane === "editor";
  const showTerminal = mobilePane === "terminal";
  const showMain = showEditor || showTerminal;
  const showFiles = mobilePane === "files";
  const showReview = mobilePane === "review";
  /* activeId is narrowed, but `project` can still be null when the stored
   *  selection points at a project that has since been deleted. */
  const projectName = project?.repository || "this workspace";
  const latestRun =
    taskView && taskView.runs.length > 0
      ? taskView.runs.reduce((latest, run) =>
          Date.parse(run.started_at) >= Date.parse(latest.started_at) ? run : latest,
        )
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <header className="shrink-0 border-b border-[var(--border-dim)] bg-[var(--surface)] px-3 py-2 pl-14 md:px-4 md:py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-step-0 font-semibold tracking-tight">Workbench</h1>
            <p className="hidden text-step--2 text-[var(--muted)] sm:block">
              Files, shell, and evidence for {projectName}.
            </p>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label className="flex min-w-0 items-center gap-2">
              <span className="sr-only">Workspace</span>
              <select
                value={activeId}
                onChange={(event) => changeProject(event.target.value)}
                className={`${FORM_SELECT} h-8 max-lg:min-h-11 min-w-[10rem] max-w-[min(14rem,70vw)] shrink-0 bg-[var(--surface-2)] !py-0 !text-step--1`}
                aria-label="Workspace"
              >
                {projectList.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.repository || "Workspace"}
                  </option>
                ))}
              </select>
            </label>

            {treeForActive?.branch ? (
              <span className="hidden items-center gap-1.5 text-step--2 text-[var(--muted)] sm:flex">
                <Icon path={ICONS.branch} />
                <span className="max-w-[10rem] truncate font-mono">{treeForActive.branch}</span>
              </span>
            ) : null}
            {treeForActive?.dirty ? <Badge variant="warn">Uncommitted</Badge> : null}
            {workspaceBusy ? <Badge variant="info">Run in progress</Badge> : null}
            {treeForActive?.truncated ? <Badge variant="neutral">Partial listing</Badge> : null}
            {treeForActive?.root ? (
              <span
                className="mono hidden max-w-[24ch] truncate text-step--2 text-[var(--faint)] xl:inline"
                title={treeForActive.root}
              >
                {treeForActive.root}
              </span>
            ) : null}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              onClick={refreshAll}
              title="Refresh workspace"
              ariaLabel="Refresh workspace"
              className="h-8 px-2"
            >
              <Icon
                path={ICONS.refresh}
                className={projects.loading || tree.loading || diff.loading ? "animate-spin" : ""}
              />
              <span className="hidden md:inline">Refresh</span>
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowHelp(true)}
              title={`Keyboard shortcuts (?)`}
              ariaLabel="Keyboard shortcuts"
              className="h-8 px-2"
            >
              <span className="font-mono">?</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Small screens get one pane at a time; the tab bar is the map. */}
      <div className="shrink-0 border-b border-[var(--border-dim)] bg-[var(--bg)] px-2 py-1.5 lg:hidden">
        <div role="tablist" aria-label="Workbench panes" className="grid grid-cols-4 gap-1">
          {WORKBENCH_PANES.map((pane) => {
            const selected = mobilePane === pane.id;
            const indicator = paneIndicator[pane.id];
            return (
              <button
                key={pane.id}
                id={`workbench-tab-${pane.id}`}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls={`workbench-pane-${pane.id}`}
                onClick={() => setMobilePane(pane.id)}
                className={`flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-step--2 font-medium transition-colors ${
                  selected
                    ? "bg-[var(--surface-3)] text-[var(--text)]"
                    : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
                }`}
              >
                <span className="truncate">{pane.label}</span>
                {indicator !== null ? (
                  <span
                    className={`shrink-0 rounded-full px-1 text-step--3 leading-4 ${
                      pane.id === "editor" && dirty
                        ? "bg-[var(--warn-dim)] text-[var(--warn)]"
                        : pane.id === "terminal" && terminalStatus === "error"
                          ? "bg-[var(--danger-dim)] text-[var(--danger)]"
                          : "bg-[var(--surface-2)] text-[var(--faint)]"
                    }`}
                  >
                    {indicator}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden p-3 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-4 lg:p-4 xl:h-full xl:grid-cols-[240px_minmax(0,1fr)_320px] xl:overflow-hidden">
        {/* Left rail: what exists. */}
        <aside
          id="workbench-pane-files"
          role="tabpanel"
          aria-labelledby="workbench-tab-files"
          className={`${showFiles ? "flex" : "hidden"} min-h-0 flex-col gap-3 lg:flex lg:max-h-[620px] lg:overflow-y-auto xl:max-h-none`}
        >
          <Panel
            title="Files"
            count={files.length}
            actions={
              <>
                <IconButton label="Open or create a file" onClick={beginNewPath}>
                  <Icon path={ICONS.plus} />
                </IconButton>
                <IconButton label="Refresh files" onClick={tree.reload} disabled={tree.loading}>
                  <Icon path={ICONS.refresh} className={tree.loading ? "animate-spin" : ""} />
                </IconButton>
              </>
            }
            className="min-h-[240px] max-h-[55vh] shrink-0 lg:max-h-none lg:flex-1"
            bodyClassName="flex flex-col"
          >
            <div className="shrink-0 border-b border-[var(--border-dim)] p-2">
              <div className="relative">
                <input
                  ref={fileSearch}
                  value={fileQuery}
                  onChange={(event) => setFileQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && fileQuery) {
                      event.stopPropagation();
                      setFileQuery("");
                    }
                  }}
                  placeholder="Filter files"
                  aria-label="Filter files"
                  className={`${FORM_INPUT} h-8 max-lg:min-h-11 !py-0 !text-step--1 pr-8 max-lg:pr-12`}
                />
                {fileQuery ? (
                  <button
                    type="button"
                    onClick={() => setFileQuery("")}
                    aria-label="Clear file filter"
                    className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[var(--faint)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] max-lg:h-11 max-lg:w-11"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {treeLoading ? (
                <div className="p-2">
                  <LoadingState lines={6} />
                </div>
              ) : tree.error && !treeForActive ? (
                <div className="p-2">
                  <ErrorState error={tree.error} onRetry={tree.reload} />
                </div>
              ) : files.length === 0 ? (
                <PanelEmpty
                  title="This workspace is empty"
                  hint="Create a file to start. The path bar in the editor can make nested folders."
                  icon={<Icon path={ICONS.file} className="h-5 w-5" />}
                >
                  <Button variant="primary" onClick={() => startNewFile("README.md")}>
                    Create README.md
                  </Button>
                </PanelEmpty>
              ) : visibleFiles.length === 0 ? (
                <PanelEmpty title="No matching files" hint="Try a shorter filter, or clear it.">
                  <Button onClick={() => setFileQuery("")}>Clear filter</Button>
                </PanelEmpty>
              ) : (
                <ul aria-label="Workspace files">
                  {visibleFiles.map((file) => {
                    const active = file.path === loadedPath;
                    return (
                      <li key={file.path}>
                        <button
                          type="button"
                          onClick={() => void openPath(file.path)}
                          aria-current={active ? "true" : undefined}
                          title={file.path}
                          className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                            active
                              ? "bg-[var(--surface-3)] text-[var(--text)] shadow-[inset_2px_0_0_var(--accent)]"
                              : "text-[var(--text-soft)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                          }`}
                        >
                          <Icon path={ICONS.file} className="h-3 w-3 text-[var(--faint)]" />
                          <span className="mono min-w-0 flex-1 truncate text-step--2">
                            {file.path}
                          </span>
                          <span className="shrink-0 text-step--3 tabular-nums text-[var(--faint)]">
                            {formatBytes(file.size)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {treeForActive?.truncated ? (
              <p className="shrink-0 border-t border-[var(--border-dim)] px-3 py-2 text-step--2 text-[var(--warn)]">
                Listing stopped at {files.length} files.
              </p>
            ) : fileQuery && files.length > 0 ? (
              <p className="shrink-0 border-t border-[var(--border-dim)] px-3 py-2 text-step--2 text-[var(--faint)]">
                {visibleFiles.length} of {files.length} files
              </p>
            ) : null}
          </Panel>

          <Panel
            title="Bots"
            count={mates.length}
            actions={
              <IconButton
                label="Refresh bots"
                onClick={teammates.reload}
                disabled={teammates.loading}
              >
                <Icon
                  path={ICONS.refresh}
                  className={teammates.loading ? "animate-spin" : ""}
                />
              </IconButton>
            }
            className="min-h-[160px] max-h-[36vh] shrink-0 lg:max-h-[40%]"
            bodyClassName="overflow-y-auto"
          >
            {matesLoading ? (
              <div className="p-2">
                <LoadingState lines={4} />
              </div>
            ) : teammates.error && !matesForActive ? (
              <div className="p-2">
                <ErrorState error={teammates.error} onRetry={teammates.reload} />
              </div>
            ) : mates.length === 0 ? (
              <PanelEmpty
                title="No bots in this workspace"
                hint="Bots join from Fleet. They can pick up tasks you create here."
              >
                <Button onClick={() => navigate("#/bots")}>Open Agents</Button>
              </PanelEmpty>
            ) : (
              <ul aria-label="Workspace bots">
                {mates.map((mate) => (
                  <li
                    key={mate.id}
                    className="flex min-w-0 items-center gap-2 border-b border-[var(--border-dim)] px-3 py-2 last:border-b-0"
                  >
                    <BotFace face={mate.face} size={22} status={mate.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-step--2 text-[var(--text)]">
                        {mate.persona || "Unnamed bot"}
                      </div>
                      <div className="truncate text-step--3 capitalize text-[var(--faint)]">
                        {mate.status}
                      </div>
                    </div>
                    <a
                      href={`#/bot/${mate.id}`}
                      className="shrink-0 text-step--2 text-[var(--muted)] hover:text-[var(--text)] hover:underline"
                    >
                      View
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>

        {/* Center: what I am working on. */}
        <main
          className={`${showMain ? "flex" : "hidden"} min-h-0 flex-col gap-3 lg:flex lg:h-[620px] xl:h-auto`}
        >
          <Panel
            id="workbench-pane-editor"
            role="tabpanel"
            aria-labelledby="workbench-tab-editor"
            title="Editor"
            meta={
              loadedPath ? (
                <span className="min-w-0 truncate font-mono text-step--2 text-[var(--muted)]">
                  {loadedPath}
                </span>
              ) : undefined
            }
            actions={
              <>
                <IconButton
                  label="Previous file (Alt+Up)"
                  onClick={() => openRelative(-1)}
                  disabled={!previousPath}
                >
                  <Icon path={ICONS.chevronDown} className="rotate-180" />
                </IconButton>
                <IconButton
                  label="Next file (Alt+Down)"
                  onClick={() => openRelative(1)}
                  disabled={!nextPath}
                >
                  <Icon path={ICONS.chevronDown} className="-rotate-90" />
                </IconButton>
              </>
            }
            className={`${showEditor ? "flex" : "hidden"} h-[60vh] min-h-[380px] max-h-[680px] lg:flex lg:h-auto lg:min-h-0 lg:max-h-none lg:flex-1`}
            bodyClassName="flex flex-col"
          >
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                if (path.trim()) void openPath(path, true);
              }}
              className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-dim)] px-3 py-2"
            >
              <label className="min-w-0 flex-1 basis-full sm:basis-[12rem]">
                <span className="sr-only">File path</span>
                <input
                  ref={pathInput}
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="Open or create a path, e.g. README.md"
                  disabled={fileLoading}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${FORM_INPUT} h-8 max-lg:min-h-11 !py-0 !text-step--1`}
                />
              </label>
              <Button
                type="submit"
                disabled={fileLoading || !path.trim()}
                title={`Open file (${MOD}+O)`}
              >
                Open
                <span className="hidden sm:inline-flex">
                  <Kbd>{MOD}+O</Kbd>
                </span>
              </Button>
              <Button
                variant="primary"
                onClick={() => void saveFile()}
                disabled={!dirty || saving || fileLoading || workspaceBusy}
                title={
                  workspaceBusy
                    ? "A live run is using this workspace"
                    : dirty
                      ? `Save file (${MOD}+S)`
                      : "No unsaved changes"
                }
              >
                {saving ? <Spinner /> : null}
                {isNewFile ? "Create" : "Save"}
                <span className="hidden sm:inline-flex">
                  <Kbd>{MOD}+S</Kbd>
                </span>
              </Button>
            </form>

            {loadedPath ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-dim)] px-3 py-1.5">
                <Icon path={ICONS.file} className="text-[var(--faint)]" />
                <span
                  className="mono min-w-0 flex-1 truncate text-step--2 text-[var(--text-soft)]"
                  title={loadedPath}
                >
                  {loadedPath}
                </span>
                {isNewFile ? (
                  <Badge variant="info">New</Badge>
                ) : dirty ? (
                  <Badge variant="warn">Unsaved</Badge>
                ) : (
                  <Badge variant="ok">Saved</Badge>
                )}
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col">
              {fileError ? (
                <div className="shrink-0 p-2">
                  <ErrorState
                    error={fileError}
                    onRetry={() => {
                      if (isNewFile) setFileError(null);
                      else void openPath(loadedPath ?? path, false);
                    }}
                  />
                </div>
              ) : null}

              {fileLoading ? (
                <div className="shrink-0 px-3 pt-2">
                  <LoadingState lines={1} />
                </div>
              ) : null}

              {!loadedPath ? (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
                  <PanelEmpty
                    title={files.length === 0 ? "Start with a file" : "Open a file to begin"}
                    hint={
                      files.length === 0
                        ? "Type a path above and press Open, then Save to create it. A README is a good first file."
                        : "Pick a file from Files, use the suggestions below, or type a path above."
                    }
                    icon={<Icon path={ICONS.file} className="h-5 w-5" />}
                  >
                    {files.length === 0 ? (
                      <Button variant="primary" onClick={() => startNewFile("README.md")}>
                        Create README.md
                      </Button>
                    ) : (
                      suggestFiles(files, 3).map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() => void openPath(file.path)}
                          className="mono inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] px-2 py-1 text-step--2 text-[var(--text-soft)] transition-colors hover:border-[var(--faint)] hover:text-[var(--text)]"
                        >
                          <Icon path={ICONS.file} className="h-3 w-3" />
                          <span className="truncate">{file.path}</span>
                        </button>
                      ))
                    )}
                    <Button onClick={focusPath}>Open a path</Button>
                  </PanelEmpty>
                </div>
              ) : (
                <textarea
                  ref={editorInput}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  aria-label={loadedPath}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="min-h-[240px] flex-1 resize-none border-0 bg-transparent px-3 py-3 font-mono text-step--1 leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--faint)] focus:ring-0 lg:min-h-0"
                  placeholder="Start typing…"
                />
              )}
            </div>

            <div
              aria-live="polite"
              className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--border-dim)] px-3 py-1.5 text-step--2"
            >
              <span
                className={
                  workspaceBusy
                    ? "text-[var(--warn)]"
                    : saving
                      ? "text-[var(--info)]"
                      : dirty
                        ? "text-[var(--warn)]"
                        : loadedPath
                          ? "text-[var(--accent)]"
                          : "text-[var(--faint)]"
                }
              >
                {workspaceBusy
                  ? "Run in progress — saving paused"
                  : saving
                    ? "Saving…"
                    : fileLoading
                      ? "Opening…"
                      : isNewFile
                        ? `Not on disk yet — ${MOD}+S creates it`
                        : dirty
                          ? `Unsaved changes — ${MOD}+S to save`
                          : loadedPath
                            ? "Saved"
                            : "No file open"}
              </span>
              <span className="text-[var(--faint)]">
                {lineCount(content)} lines · {content.length} chars
              </span>
            </div>
          </Panel>

          <Panel
            id="workbench-pane-terminal"
            role="tabpanel"
            aria-labelledby="workbench-tab-terminal"
            title="Terminal"
            meta={
              <span className="flex min-w-0 items-center gap-1.5 text-step--2 text-[var(--muted)]">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${terminalTone}`} />
                <span className="hidden truncate sm:inline">
                  {terminalStatusLabel(terminalStatus)}
                </span>
              </span>
            }
            actions={
              <>
                {sessionId ? (
                  <span className="mr-1 hidden md:inline">
                    <ShortId id={sessionId} />
                  </span>
                ) : null}
                <IconButton
                  label="Restart terminal"
                  onClick={restartTerminal}
                  disabled={terminalStatus === "connecting"}
                >
                  <Icon
                    path={ICONS.refresh}
                    className={terminalStatus === "connecting" ? "animate-spin" : ""}
                  />
                </IconButton>
                <IconButton
                  label={terminalOpen ? "Collapse terminal" : "Expand terminal"}
                  onClick={toggleTerminal}
                  expanded={terminalOpen}
                >
                  <Icon
                    path={ICONS.chevronDown}
                    className={`transition-transform ${terminalOpen ? "rotate-180" : ""}`}
                  />
                </IconButton>
              </>
            }
            className={`${showTerminal ? "flex" : "hidden"} shrink-0 lg:flex ${
              terminalOpen
                ? "h-[320px] lg:h-[240px] xl:h-[clamp(200px,32vh,340px)]"
                : "h-auto"
            }`}
            bodyClassName={terminalOpen ? "flex flex-col" : "hidden"}
          >
            <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--surface-2)]">
              <div
                ref={terminalHost}
                id="workbench-terminal"
                className="h-full w-full"
                data-workbench-terminal
              />

              {terminalStatus === "connecting" ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--surface-2)] px-4 text-center">
                  <Spinner className="h-5 w-5" />
                  <p className="text-step--1 text-[var(--text-soft)]">
                    Starting a shell in this workspace…
                  </p>
                  <p className="text-step--2 text-[var(--faint)]">
                    It opens in {(treeForActive?.root ?? project?.repository) || "the workspace root"}.
                  </p>
                </div>
              ) : terminalStatus === "error" ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--surface-2)] px-4 text-center">
                  <p className="text-step--1 font-medium text-[var(--text)]">
                    Terminal unavailable
                  </p>
                  <p className="max-w-[44ch] text-step--2 leading-relaxed text-[var(--muted)]">
                    {describeError(terminalError)}
                  </p>
                  <Button variant="primary" onClick={restartTerminal}>
                    Try again
                  </Button>
                  <p className="text-step--2 text-[var(--faint)]">
                    The workspace may be busy, or the shell could not start.
                  </p>
                </div>
              ) : terminalStatus === "exited" ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--surface-2)] px-4 text-center">
                  <p className="text-step--1 font-medium text-[var(--text)]">
                    Session ended
                  </p>
                  <p className="text-step--2 text-[var(--muted)]">
                    The shell is no longer running. Start a new one in the same workspace.
                  </p>
                  <Button onClick={restartTerminal}>Start a new session</Button>
                </div>
              ) : null}
            </div>
          </Panel>
        </main>

        {/* Right rail: what happened. */}
        <aside
          id="workbench-pane-review"
          role="tabpanel"
          aria-labelledby="workbench-tab-review"
          className={`${showReview ? "grid" : "hidden"} grid-cols-1 gap-3 lg:col-span-2 lg:grid lg:grid-cols-2 lg:gap-4 xl:col-span-1 xl:flex xl:min-h-0 xl:flex-col xl:overflow-hidden`}
        >
          <Panel
            title="Changes"
            count={changes.length}
            meta={
              stats.additions || stats.deletions ? (
                <span className="font-mono text-step--2">
                  <span className="text-[var(--accent)]">+{stats.additions}</span>{" "}
                  <span className="text-[var(--danger)]">−{stats.deletions}</span>
                </span>
              ) : undefined
            }
            actions={
              <IconButton label="Refresh changes" onClick={diff.reload} disabled={diff.loading}>
                <Icon
                  path={ICONS.refresh}
                  className={diff.loading ? "animate-spin" : ""}
                />
              </IconButton>
            }
            className="min-h-[280px] max-h-[62vh] lg:max-h-none lg:h-[420px] xl:h-auto xl:flex-1"
            bodyClassName="flex flex-col"
          >
            {diffLoading ? (
              <div className="p-3">
                <LoadingState lines={5} />
              </div>
            ) : diff.error && !diffForActive ? (
              <div className="p-3">
                <ErrorState error={diff.error} onRetry={diff.reload} />
              </div>
            ) : !diffForActive ? (
              <PanelEmpty
                title="Changes unavailable"
                hint="The workspace diff could not be loaded."
              >
                <Button onClick={diff.reload}>Retry</Button>
              </PanelEmpty>
            ) : !diffForActive.exists ? (
              <PanelEmpty
                title="Workspace not found"
                hint="This project's workspace folder is missing. Recreate it from the project page."
              >
                <Button onClick={() => navigate(`#/p/${activeId}`)}>Open project</Button>
              </PanelEmpty>
            ) : !diffForActive.git ? (
              <PanelEmpty
                title="Not a Git repository"
                hint="File edits still save here. A Git workspace adds diffs and changed-file evidence."
                icon={<Icon path={ICONS.branch} className="h-5 w-5" />}
              >
                <Button onClick={() => navigate(`#/p/${activeId}`)}>Open project</Button>
              </PanelEmpty>
            ) : (
              <>
                {diff.error ? (
                  <div className="shrink-0 border-b border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-1.5 text-step--2 text-[var(--danger)]">
                    Refresh failed. Showing the last known changes.
                  </div>
                ) : null}

                {changes.length > 0 ? (
                  <div className="shrink-0 overflow-y-auto border-b border-[var(--border-dim)] p-1">
                    <ul aria-label="Changed files">
                      {changes.map((change) => (
                        <li key={`${change.status}:${change.path}`}>
                          <button
                            type="button"
                            onClick={() => void openPath(change.path)}
                            title={`Open ${change.path}`}
                            className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-[var(--surface-2)]"
                          >
                            <span
                              className={`mono w-5 shrink-0 text-step--3 font-semibold ${
                                change.status === "??" || change.status === "A"
                                  ? "text-[var(--info)]"
                                  : change.status === "D"
                                    ? "text-[var(--danger)]"
                                    : "text-[var(--warn)]"
                              }`}
                            >
                              {change.status}
                            </span>
                            <span className="mono min-w-0 flex-1 truncate text-step--2 text-[var(--text-soft)]">
                              {change.path}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {diffForActive.diff ? (
                  <DiffBody diff={diffForActive.diff} />
                ) : (
                  <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
                    <PanelEmpty
                      title="Working tree clean"
                      hint="Saved edits and new files appear here as a diff."
                      icon={<Icon path={ICONS.branch} className="h-5 w-5" />}
                    />
                  </div>
                )}
              </>
            )}
          </Panel>

          <Panel
            title="Run"
            meta={
              taskActive ? (
                <span className="flex items-center gap-1.5 text-step--2 text-[var(--info)]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--info)]" />
                  Live
                </span>
              ) : task?.status ? (
                <StatusBadge status={task.status} />
              ) : undefined
            }
            actions={
              <IconButton
                label="Refresh run"
                onClick={taskState.reload}
                disabled={!lastTaskId || taskState.loading}
              >
                <Icon
                  path={ICONS.refresh}
                  className={taskState.loading ? "animate-spin" : ""}
                />
              </IconButton>
            }
            className="min-h-[260px] max-h-[70vh] lg:max-h-none lg:h-[420px] xl:h-auto xl:flex-1"
            bodyClassName="flex flex-col"
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void runTask();
              }}
              className="shrink-0 border-b border-[var(--border-dim)] p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">Command to run</span>
                  <input
                    ref={cmdInput}
                    value={cmd}
                    onChange={(event) => setCmd(event.target.value)}
                    placeholder="e.g. npm test"
                    disabled={running}
                    autoComplete="off"
                    spellCheck={false}
                    className={`${FORM_INPUT} h-8 max-lg:min-h-11 !py-0 font-mono !text-step--2`}
                  />
                </label>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={running || !cmd.trim() || workspaceBusy}
                  title={
                    workspaceBusy
                      ? "A live run is using this workspace"
                      : `Run command (${MOD}+Enter)`
                  }
                  className="shrink-0"
                >
                  {running ? <Spinner /> : null}
                  {running ? "Starting" : "Run"}
                </Button>
              </div>
              <p className="mt-1.5 text-step--2 text-[var(--faint)]">
                <Kbd>{MOD}</Kbd> + <Kbd>↵</Kbd> starts a task in this workspace.
              </p>
            </form>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {taskState.loading && !taskView ? (
                <LoadingState lines={5} />
              ) : taskState.error && !taskView ? (
                <ErrorState error={taskState.error} onRetry={taskState.reload} />
              ) : taskView && task ? (
                <div className="flex flex-col gap-3">
                  {taskState.error ? (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-2 py-1 text-step--2 text-[var(--danger)]">
                      <span>Live refresh failed.</span>
                      <button
                        type="button"
                        onClick={taskState.reload}
                        className="font-medium underline"
                      >
                        Retry
                      </button>
                    </div>
                  ) : null}

                  <div className="flex min-w-0 items-center gap-2">
                    <StatusDot status={task.status} pulse={taskActive} />
                    <span className="text-step--1 text-[var(--text)]">
                      {taskStatusLabel(task.status)}
                    </span>
                    <span className="mono ml-auto truncate text-step--3 text-[var(--faint)]">
                      {task.id}
                    </span>
                  </div>

                  {task.status === "awaiting_approval" ? (
                    <button
                      type="button"
                      onClick={() => navigate("#/approvals")}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-2.5 py-2 text-left"
                    >
                      <span className="text-step--2 text-[var(--text)]">
                        Waiting on your decision
                      </span>
                      <span className="text-step--2 font-medium text-[var(--warn)]">
                        Review →
                      </span>
                    </button>
                  ) : null}

                  <dl className="grid grid-cols-3 gap-2">
                    {[
                      ["Approvals", taskView.approvals.length],
                      ["Artifacts", taskView.artifacts.length],
                      ["Runs", taskView.runs.length],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] px-2 py-1.5"
                      >
                        <dt className="text-step--3 uppercase tracking-wide text-[var(--faint)]">
                          {label}
                        </dt>
                        <dd className="text-step-0 font-semibold tabular-nums text-[var(--text)]">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  {latestRun ? (
                    <div className="rounded-md border border-[var(--border-dim)] p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-step--3 uppercase tracking-wide text-[var(--faint)]">
                          Latest run
                        </span>
                        <span className="ml-auto">
                          <StatusBadge status={latestRun.status} />
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-step--2 text-[var(--muted)]">
                        <span>exit {latestRun.exit_code ?? "—"}</span>
                        <span>
                          {Number.isFinite(latestRun.duration_s)
                            ? `${latestRun.duration_s.toFixed(1)}s`
                            : "—"}
                        </span>
                      </div>
                      {latestRun.output_excerpt ? (
                        <details className="mt-2 rounded border border-[var(--border-dim)] bg-[var(--surface-2)]">
                          <summary className="cursor-pointer px-2 py-1 text-step--2 text-[var(--text-soft)]">
                            Output
                          </summary>
                          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-step--3 leading-relaxed text-[var(--text-soft)]">
                            {latestRun.output_excerpt}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  ) : null}

                  {taskView.approvals.length > 0 ? (
                    <div>
                      <div className="mb-1 text-step--3 uppercase tracking-wide text-[var(--faint)]">
                        Approvals
                      </div>
                      <ul className="flex flex-col gap-1">
                        {taskView.approvals.slice(0, 4).map((approval) => (
                          <li key={approval.id} className="flex min-w-0 items-center gap-2">
                            <StatusDot status={approval.decision ?? "pending"} />
                            <span className="min-w-0 flex-1 truncate text-step--2 text-[var(--text-soft)]">
                              {approval.action}
                            </span>
                            <span className="shrink-0 text-step--3 text-[var(--faint)]">
                              {approval.decision ?? "pending"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {taskView.artifacts.length > 0 ? (
                    <div>
                      <div className="mb-1 text-step--3 uppercase tracking-wide text-[var(--faint)]">
                        Artifacts
                      </div>
                      <ul className="flex flex-col gap-1">
                        {taskView.artifacts.slice(0, 3).map((artifact) => (
                          <li key={artifact.id} className="flex min-w-0 items-baseline gap-1.5">
                            <span className="mono shrink-0 text-step--3 text-[var(--info)]">
                              {artifact.type}
                            </span>
                            <span
                              className="min-w-0 truncate text-step--2 text-[var(--muted)]"
                              title={artifact.summary || artifact.location}
                            >
                              {artifact.summary || artifact.location}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="pt-1">
                    <Button
                      onClick={() => navigate(`#/p/${task.project_id}/t/${task.id}`)}
                      className="w-full"
                    >
                      Open task →
                    </Button>
                  </div>
                </div>
              ) : (
                <PanelEmpty
                  title="Run a command"
                  hint="Start with a shell command. Status, approvals, artifacts, and the latest output land here."
                >
                  {COMMAND_SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        setCmd(suggestion);
                        focusAfterPaint(cmdInput);
                      }}
                      className="mono rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] px-2 py-1 text-step--2 text-[var(--text-soft)] transition-colors hover:border-[var(--faint)] hover:text-[var(--text)]"
                    >
                      {suggestion}
                    </button>
                  ))}
                </PanelEmpty>
              )}
            </div>
          </Panel>
        </aside>
      </div>

      {showHelp ? (
        <Modal title="Keyboard shortcuts" onClose={() => setShowHelp(false)}>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {SHORTCUTS.map((shortcut) => (
              <div
                key={shortcut.label}
                className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] px-3 py-2"
              >
                <span className="text-step--1 text-[var(--muted)]">
                  {shortcut.label}
                </span>
                <Kbd>{shortcut.keys}</Kbd>
              </div>
            ))}
          </div>
          <p className="mt-4 text-step--2 leading-relaxed text-[var(--faint)]">
            Shortcuts pause inside the terminal so your shell receives every key. {MOD} is
            Control on Windows and Linux. Save still works while the terminal has focus.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
