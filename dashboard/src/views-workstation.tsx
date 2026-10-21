import { useEffect, useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import type { Task, Teammate } from "./types";
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  StatusBadge,
  useAsync,
} from "./components";

function botStatus(bot: Teammate, tasks: Task[]): string {
  const mine = tasks.filter((t) => t.owner_teammate_id === bot.id);
  const running = mine.some((t) => t.status === "running");
  const ready = mine.some((t) => t.status === "ready");
  if (running) return "running";
  if (ready) return "ready";
  return bot.status;
}

export function WorkstationView() {
  const all = useAsync(() => api.listAllTeammates(), []);
  const projs = useAsync(() => api.listProjects(), []);
  const [bots, setBots] = useState<Array<{ bot: Teammate; tasks: Task[] }>>([]);
  const [refresh, setRefresh] = useState(0);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showCreateBot, setShowCreateBot] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [projId, setProjId] = useState("");
  const [desc, setDesc] = useState("");
  const [cmd, setCmd] = useState("");
  const [assignTo, setAssignTo] = useState<string | null>(null);
  const [botProjId, setBotProjId] = useState("");
  const [botPersona, setBotPersona] = useState("");
  const [botInstructions, setBotInstructions] = useState("");
  const [sweepResults, setSweepResults] = useState<Array<Record<string, unknown>>>(
    []
  );
  const [sweepProcessed, setSweepProcessed] = useState(0);
  const [sweepBusy, setSweepBusy] = useState(false);

  const runSweep = async () => {
    setSweepBusy(true);
    try {
      const result = await api.executorSweep();
      setSweepProcessed(result.processed);
      setSweepResults(result.results);
      setRefresh((r) => r + 1);
    } catch (err) {
      notifyError(err);
    } finally {
      setSweepBusy(false);
    }
  };

  useEffect(() => {
    if (!all.data) return;
    const load = async () => {
      const mates = all.data?.teammates ?? [];
      const out: Array<{ bot: Teammate; tasks: Task[] }> = [];
      await Promise.all(
        mates.map(async (bot) => {
          try {
            const tasks = (await api.teammateTasks(bot.id)).tasks;
            out.push({ bot, tasks });
          } catch {
            out.push({ bot, tasks: [] });
          }
        })
      );
      out.sort((a, b) => {
        const rank = (s: string) => (s === "running" ? 3 : s === "ready" ? 2 : s === "pending" ? 1 : 0);
        return rank(botStatus(b.bot, b.tasks)) - rank(botStatus(a.bot, a.tasks));
      });
      setBots(out);
    };
    load();
  }, [all.data, refresh]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateBusy(true);
    try {
      await api.createTask(projId.trim(), {
        description: desc.trim(),
        command: cmd.trim(),
        owner_teammate_id: assignTo || null,
      });
      setProjId("");
      setDesc("");
      setCmd("");
      setAssignTo(null);
      setShowCreateTask(false);
      setRefresh((r) => r + 1);
    } catch (err) {
      notifyError(err);
    } finally {
      setCreateBusy(false);
    }
  };

  const createBot = async (e: React.FormEvent) => {
    e.preventDefault();
    const pid = botProjId.trim();
    if (!pid || !botPersona.trim()) {
      return notifyError("Pick a project and give the bot a persona.");
    }
    try {
      await api.createTeammate(pid, {
        persona: botPersona.trim(),
        instructions: botInstructions.trim(),
        capabilities: [],
        permissions: [],
        memory_scope: "project",
      });
      setShowCreateBot(false);
      setBotProjId("");
      setBotPersona("");
      setBotInstructions("");
      all.reload();
      setRefresh((r) => r + 1);
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Workstation</h1>
          <p className="subtitle">
            Your fleet of bots. Each bot owns tasks, runs them in isolated workspaces,
            and keeps private memory.
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setShowCreateTask(true)}>
            New task
          </button>
          <button className="primary" onClick={() => setShowCreateBot(true)}>
            New bot
          </button>
          <button className="primary" onClick={runSweep} disabled={sweepBusy}>
            {sweepBusy ? "Executing…" : "Run executor sweep"}
          </button>
          <button onClick={() => setRefresh((r) => r + 1)}>Refresh</button>
          <a href="#/bots" style={{ marginLeft: 12 }}>
            View full fleet →
          </a>
        </div>
      </div>
      {sweepProcessed > 0 ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Last executor sweep</strong>
            <span className="muted mono">{sweepProcessed} task(s) processed</span>
          </div>
          <table className="data" style={{ fontSize: 12, marginTop: 8 }}>
            <thead>
              <tr>
                <th>Task</th>
                <th>Bot</th>
                <th>Run</th>
                <th>Status</th>
                <th>Exit</th>
                <th>Artifact</th>
              </tr>
            </thead>
            <tbody>
              {sweepResults.map((r) => (
                <tr key={String(r.task_id)}>
                  <td className="mono muted">{String(r.task_id).slice(0, 14)}…</td>
                  <td className="mono muted">{String(r.bot_id ?? "-").slice(0, 14)}…</td>
                  <td className="mono muted">{String(r.run_id ?? "-").slice(0, 14)}…</td>
                  <td>
                    <StatusBadge status={String(r.status)} />
                  </td>
                  <td className="mono">{String(r.exit_code ?? "—")}</td>
                  <td className="mono muted">{String(r.artifact_id ?? "-").slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {showCreateTask ? (
        <Modal title="New task" onClose={() => setShowCreateTask(false)}>
          <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Field label="Project ID">
              <input
                value={projId}
                onChange={(e) => setProjId(e.target.value)}
                required
                placeholder="prj_…"
              />
            </Field>
            <Field label="Description">
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                required
                placeholder="implement the login flow"
              />
            </Field>
            <Field label="Command (optional)">
              <input
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                placeholder="npm run build"
              />
            </Field>
            <Field label="Assign to bot (optional)">
              <select value={assignTo ?? ""} onChange={(e) => setAssignTo(e.target.value || null)}>
                <option value="">(unassigned — claim later)</option>
                {all.data?.teammates.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.persona || "Unnamed bot"} ({bot.id.slice(0, 8)}…)
                  </option>
                ))}
              </select>
            </Field>
            <div className="row">
              <button className="primary" type="submit" disabled={createBusy}>
                {createBusy ? "Creating…" : "Create task"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
      {showCreateBot ? (
        <Modal title="New bot" onClose={() => setShowCreateBot(false)}>
          <form onSubmit={createBot} className="row" style={{ gap: 8, flexDirection: "column" }}>
            <label className="field">
              <span>Workspace / project</span>
              <select
                value={botProjId}
                onChange={(e) => setBotProjId(e.target.value)}
                required
                style={{ width: 320 }}
              >
                <option value="">(select project)</option>
                {projs.data?.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.repository || "workspace"} ({p.id.slice(0, 8)}…)
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Persona / name</span>
              <input
                value={botPersona}
                onChange={(e) => setBotPersona(e.target.value)}
                required
                placeholder="engineer"
                style={{ width: 320 }}
              />
            </label>
            <label className="field">
              <span>Instructions (optional)</span>
              <textarea
                value={botInstructions}
                onChange={(e) => setBotInstructions(e.target.value)}
                placeholder="You are a careful engineering bot…"
                rows={2}
                style={{ width: 460 }}
              />
            </label>
            <div className="row">
              <button className="primary" type="submit">Create bot</button>
              <button
                className=""
                onClick={() => {
                  setShowCreateBot(false);
                  setBotProjId("");
                  setBotPersona("");
                  setBotInstructions("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
      {all.loading ? (
        <LoadingState />
      ) : all.error ? (
        <ErrorState error={all.error} onRetry={all.reload} />
      ) : all.data && all.data.teammates.length === 0 ? (
        <EmptyState
          title="No bots yet"
          hint="Create a bot in a project (Teammates tab) so it can own and run tasks here."
        />
      ) : (
        <>
          {bots.length === 0 && all.data && all.data.teammates.length > 0 ? (
            <LoadingState />
          ) : (
            <h2>Bots</h2>
          )}
          <div className="grid3">
            {bots.map(({ bot, tasks }) => {
              const status = botStatus(bot, tasks);
              const current = tasks.find(
                (t) => t.status !== "done" && t.status !== "failed"
              );
              return (
                <div className="card" key={bot.id} style={{ minHeight: 260 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <a href={`#/bot/${bot.id}`}>
                        <strong>{bot.persona || "Unnamed bot"}</strong>
                      </a>
                      <div className="muted mono">{bot.id.slice(0, 10)}…</div>
                    </div>
                    <div className="row">
                      <StatusBadge status={status} />
                    </div>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    project {bot.project_id.slice(0, 10)}…
                  </div>
                  {current ? (
                    <div className="muted mono" style={{ marginTop: 6 }}>
                      current: {current.description.slice(0, 40)}…
                    </div>
                  ) : null}
                  <div className="row" style={{ marginTop: 10, gap: 6 }}>
                    <button
                      className="primary"
                      onClick={() => (window.location.hash = `#/bot/${bot.id}`)}
                    >
                      Open
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
