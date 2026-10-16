import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { ApiError, api, getSession, setSession } from "./api";
import { CapabilitiesView } from "./views-projects";
import { ProjectDetailView } from "./views-project";
import { ProjectsView } from "./views-projects";
import { TaskDetailView } from "./views-task";

export type Route =
  | { name: "projects" }
  | { name: "project"; projectId: string }
  | { name: "task"; projectId: string; taskId: string }
  | { name: "capabilities" };

export function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1] && parts[2] === "t" && parts[3]) {
    return { name: "task", projectId: parts[1], taskId: parts[3] };
  }
  if (parts[0] === "p" && parts[1]) {
    return { name: "project", projectId: parts[1] };
  }
  if (parts[0] === "capabilities") return { name: "capabilities" };
  return { name: "projects" };
}

export function navigate(route: string): void {
  window.location.hash = route;
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [connected, setConnected] = useState(() => getSession() !== null);
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openProject = (id: string) => {
    setProjects((prev) => (prev.includes(id) ? prev : [...prev, id]));
    navigate(`#/p/${id}`);
  };

  if (!connected) {
    return <ConnectScreen onConnected={() => setConnected(true)} />;
  }

  const nav = (href: string, label: string, active: boolean) => (
    <a key={href} href={href} className={active ? "active" : ""}>
      {label}
    </a>
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          NerdBot Ops<small>teammate workspace</small>
        </div>
        <nav className="nav">
          {nav("#/", "Projects", route.name === "projects")}
          {projects.map((id) => (
            <span key={id}>
              {nav(`#/p/${id}`, `· ${id.slice(0, 14)}…`, route.name !== "projects" &&
                route.name !== "capabilities" &&
                "projectId" in route &&
                route.projectId === id)}
            </span>
          ))}
          {nav("#/capabilities", "Capabilities", route.name === "capabilities")}
        </nav>
        <div style={{ padding: "16px 12px" }}>
          <button
            onClick={() => {
              setSession(null);
              setConnected(false);
              navigate("#/");
            }}
          >
            Disconnect
          </button>
        </div>
      </aside>
      <main className="main">
        {route.name === "projects" && <ProjectsView onOpen={openProject} />}
        {route.name === "project" && (
          <ProjectDetailView projectId={route.projectId} onOpenTask={(taskId) => navigate(`#/p/${route.projectId}/t/${taskId}`)} />
        )}
        {route.name === "task" && (
          <TaskDetailView
            projectId={route.projectId}
            taskId={route.taskId}
            onBack={() => navigate(`#/p/${route.projectId}`)}
          />
        )}
        {route.name === "capabilities" && <CapabilitiesView />}
        <Toaster position="bottom-right" richColors closeButton />
      </main>
    </div>
  );
}

function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8088");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // Configure in memory so we can probe /health; cleared on failure.
    setSession({ baseUrl: baseUrl.replace(/\/+$/, ""), token });
    try {
      const health = await api.health();
      if (health.status !== "ok") throw new Error("Server reported unhealthy status");
      onConnected();
    } catch (err) {
      setSession(null);
      setError(err instanceof ApiError ? `Error ${err.status}: ${err.detail}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="layout" style={{ gridTemplateColumns: "1fr" }}>
      <main className="main" style={{ margin: "60px auto", width: "100%", maxWidth: 460 }}>
        <h1>NerdBot Ops</h1>
        <p className="subtitle">Connect to a running NerdBot API server.</p>
        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : null}
        <form onSubmit={connect}>
          <label className="field">
            <span>API base URL</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </label>
          <label className="field">
            <span>API token (kept in memory only, never stored)</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      </main>
    </div>
  );
}

export function notifyError(err: unknown): void {
  const message = err instanceof ApiError ? `Error ${err.status}: ${err.detail}` : String(err);
  toast.error(message);
}
