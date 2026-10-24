import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";
import { notifyError } from "./app";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  useAsync,
} from "./components";

export function WorkbenchView() {
  const [projectId] = useState<string | null>(null);
  const projects = useAsync(() => api.listProjects(), []);
  const project = projects.data?.projects?.[0] ?? null;
  const activeId = projectId ?? project?.id ?? null;

  const meta = useAsync(() => (activeId ? api.projectWorkspace(activeId) : Promise.resolve(null)), [activeId]);
  const tree = useAsync(() => (activeId ? api.projectWorkspaceTree(activeId) : Promise.resolve(null)), [activeId]);
  const diff = useAsync(() => (activeId ? api.projectWorkspaceDiff(activeId) : Promise.resolve(null)), [activeId]);
  const teammates = useAsync(() => (activeId ? api.listTeammates(activeId) : Promise.resolve(null)), [activeId]);

  const [path, setPath] = useState("README.md");
  const [content, setContent] = useState("");
  const [loadedPath, setLoadedPath] = useState<string | null>(null);

  const loadFile = async (p: string) => {
    if (!activeId) return;
    try {
      const r = await api.projectWorkspaceFile(activeId, p);
      setPath(p);
      setContent(r.content);
      setLoadedPath(p);
    } catch (e) {
      notifyError(e);
    }
  };

  const saveFile = async () => {
    if (!activeId || !loadedPath) return;
    try {
      await api.saveProjectWorkspaceFile(activeId, loadedPath, content);
      tree.reload();
      diff.reload();
    } catch (e) {
      notifyError(e);
    }
  };

  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState("");
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);
  const taskView = useAsync(() => (lastTaskId ? api.taskView(lastTaskId) : Promise.resolve(null)), [lastTaskId]);

  const runTask = async () => {
    if (!activeId) return;
    try {
      const t = await api.createTask(activeId, { description: cmd || "workspace task", command: cmd, workspace_mode: "workspace" });
      await api.runTask(t.id);
      setLastTaskId(t.id);
      setOut(`started task ${t.id}`);
    } catch (e) {
      notifyError(e);
    }
  };

  // Terminal
  const termRef = useRef<HTMLDivElement | null>(null);
  const termInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  useEffect(() => {
    if (!activeId || !termRef.current) return;
    const term = new Terminal({ convertEol: true, fontSize: 12 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    fit.fit();
    termInstance.current = term;
    fitAddon.current = fit;

    let sid: string | null = null;
    const abort = new AbortController();
    const termCols = term.cols;
    const termRows = term.rows;
    (async () => {
      try {
        const info = await api.createTerminal(activeId, termCols, termRows);
        sid = info.session_id;
        setSessionId(info.session_id);
        const onData = (d: string) => {
          if (sid) api.sendTerminalInput(activeId, sid, d).catch(() => {});
        };
        term.onData(onData);
        api.streamTerminal(activeId, info.session_id, {
          onSnapshot: (d: string) => term.write(d),
          onData: (d: string) => term.write(d),
          onExit: () => term.write("\\r\\n[exit]\\r\\n"),
        }, abort.signal).catch((e) => notifyError(e));
      } catch (e) {
        notifyError(e);
      }
    })();

    const onResize = () => {
      fit.fit();
      if (sid) api.resizeTerminal(activeId, sid, term.cols, term.rows).catch(() => {});
    };
    window.addEventListener("resize", onResize);

    return () => {
      abort.abort();
      window.removeEventListener("resize", onResize);
      if (sid) api.closeTerminal(activeId, sid).catch(() => {});
      term.dispose();
      termInstance.current = null;
      fitAddon.current = null;
    };
  }, [activeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loadedPath, content]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!termRef.current || !termInstance.current || !fitAddon.current) return;
    const ro = new ResizeObserver(() => {
      fitAddon.current?.fit();
      const sid = sessionIdRef.current;
      if (activeId && sid && termInstance.current) {
        api.resizeTerminal(activeId, sid, termInstance.current.cols, termInstance.current.rows).catch(() => {});
      }
    });
    ro.observe(termRef.current);
    return () => ro.disconnect();
  }, [activeId]);
  if (projects.error) return <ErrorState error={projects.error} onRetry={projects.reload} />;
  if (!activeId) return <EmptyState title="No workspace" hint="Create a project first." />;

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Workbench</h2>
        <span className="text-xs text-[var(--muted)]">{meta.data?.root}</span>
      </header>
      <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[260px_1fr_320px]">
      <aside className="border border-[var(--border-dim)] rounded-lg p-4 overflow-auto">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-3">Files</h3>
        {tree.loading ? <LoadingState lines={3} /> : tree.error ? <ErrorState error={tree.error} onRetry={tree.reload} /> : (tree.data?.files?.length ? (
          <ul className="text-sm space-y-1">
            {(tree.data?.files ?? []).map((f: { path: string }) => (
              <li key={f.path}>
                <button className="hover:underline text-left w-full truncate" onClick={() => loadFile(f.path)}>{f.path}</button>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No files" hint="Workspace is empty." />)}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mt-6 mb-3">Bits</h3>
        {teammates.loading ? <LoadingState lines={2} /> : teammates.error ? <ErrorState error={teammates.error} onRetry={teammates.reload} /> : (
          <ul className="text-sm space-y-1">
            {(teammates.data?.teammates ?? []).map((t) => (
              <li key={t.id} className="flex items-center justify-between">
                <span className="truncate">{t.persona}</span>
                <span className="text-xs text-[var(--muted)]">{t.status}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className="border border-[var(--border-dim)] rounded-lg p-4 flex flex-col gap-3 overflow-auto min-h-0">
        <div className="flex gap-2 items-center">
          <input className="flex-1 border rounded px-2 py-1 text-sm" value={path} onChange={(e) => setPath(e.target.value)} />
          <Button variant="ghost" onClick={() => loadFile(path)}>Open</Button>
          <Button variant="primary" onClick={saveFile}>Save</Button>
        </div>
        <textarea className="flex-1 min-h-[240px] border rounded p-3 text-xs font-mono" value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="flex gap-2 items-center">
          <input className="flex-1 border rounded px-2 py-1 text-sm" placeholder="command / task" value={cmd} onChange={(e) => setCmd(e.target.value)} />
          <Button variant="primary" onClick={runTask}>Run task</Button>
        </div>
        {out && <div className="text-xs text-[var(--muted)]">{out}</div>}
        <div className="border border-[var(--border-dim)] rounded-lg p-3">
          <div className="text-xs font-semibold mb-2">Terminal {sessionId ? `(${sessionId.slice(0,8)})` : ""}</div>
          <div ref={termRef} className="h-64 w-full" />
        </div>
      </main>

      <aside className="border border-[var(--border-dim)] rounded-lg p-4 overflow-auto">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-3">Diff</h3>
        <pre className="text-xs whitespace-pre-wrap mb-4">{diff.data?.diff ?? ""}</pre>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-3">Task context</h3>
        {taskView.loading ? <LoadingState lines={2} /> : taskView.error ? <ErrorState error={taskView.error} onRetry={taskView.reload} /> : taskView.data ? (
          <div className="text-sm space-y-2">
            <div>Status: {taskView.data.task.status}</div>
            <div>Approvals: {taskView.data.approvals.length}</div>
            <ul className="space-y-1 text-xs">
              {taskView.data.approvals.map((a) => (
                <li key={a.id}>{a.action} — {a.decision}</li>
              ))}
            </ul>
            <div>Artifacts: {taskView.data.artifacts.length}</div>
            <ul className="space-y-1 text-xs">
              {taskView.data.artifacts.map((a) => (
                <li key={a.id}>{a.type}: {a.summary}</li>
              ))}
            </ul>
            <div>Runs: {taskView.data.runs.length}</div>
          </div>
        ) : <div className="text-xs text-[var(--muted)]">Run a task to see context.</div>}
      </aside>
    </div>
    </div>
  );
}
