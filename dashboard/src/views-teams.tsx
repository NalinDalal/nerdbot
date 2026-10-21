import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import { EmptyState, ErrorState, LoadingState, Modal, ShortId, useAsync } from "./components";
import { EntityForm } from "./forms";

export function TeamsView() {
  const list = useAsync(() => api.listTeams(), []);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Teams / fleet</h1>
          <p className="subtitle">
            A team groups bots and workspaces under one purpose. Use it to organize the
            fleet — membership never grants permissions by itself.
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setShowCreate(true)}>New team</button>
          <button onClick={list.reload}>Refresh</button>
        </div>
      </div>
      {showCreate ? (
        <Modal title="New team" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create team"
            fields={[
              { name: "name", label: "Name", required: true, placeholder: "platform" },
              { name: "description", label: "Description", placeholder: "What this fleet owns" },
            ]}
            onSubmit={async (values) => {
              await api.createTeam(values);
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
      ) : list.data && list.data.teams.length > 0 ? (
        <div>
          {list.data.teams.map((team) => (
            <div className="card" key={team.id} style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <a href={`#/team/${team.id}`}>
                    <strong>{team.name || "Unnamed team"}</strong>
                  </a>
                  <div className="muted mono" style={{ marginTop: 4 }}>{team.id}</div>
                  {team.description ? <div className="muted" style={{ marginTop: 4 }}>{team.description}</div> : null}
                </div>
                <div className="row">
                  <button onClick={list.reload}>Refresh list</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No teams yet"
          hint="Create a team to group projects into a workspace, then assign bots to tasks and hand them off."
        />
      )}
    </div>
  );
}

export function TeamDetailView({
  teamId,
  onOpenProject,
}: {
  teamId: string;
  onOpenProject: (projectId: string) => void;
}) {
  const detail = useAsync(() => api.getTeam(teamId), [teamId]);
  const allBots = useAsync(() => api.listAllTeammates(), []);
  const [showAdd, setShowAdd] = useState(false);
  const [newProjectId, setNewProjectId] = useState("");
  const [botToAdd, setBotToAdd] = useState("");

  const addProject = async () => {
    const id = newProjectId.trim();
    if (!id) return;
    try {
      await api.addTeamProject(teamId, id);
      setNewProjectId("");
      setShowAdd(false);
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const removeProject = async (projectId: string) => {
    try {
      await api.removeTeamProject(teamId, projectId);
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const addBot = async () => {
    if (!botToAdd) return;
    try {
      await api.addTeamTeammate(teamId, botToAdd);
      setBotToAdd("");
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  const removeBot = async (teammateId: string) => {
    try {
      await api.removeTeamTeammate(teamId, teammateId);
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  if (detail.loading) return <LoadingState lines={3} />;
  if (detail.error || !detail.data) {
    return (
      <div>
        <button onClick={() => (window.location.hash = "#/teams")}>← Back to teams</button>
        <ErrorState error={detail.error ?? "Team not found"} onRetry={detail.reload} />
      </div>
    );
  }

  const { team, projects, teammates = [], members } = detail.data;
  const memberBotIds = new Set(teammates.map((t) => t.id));
  const addable =
    (allBots.data?.teammates ?? []).filter((b) => !memberBotIds.has(b.id));

  return (
    <div>
      <button onClick={() => (window.location.hash = "#/teams")}>← Back to teams</button>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Team: {team.name || "Unnamed team"}</h1>
          <p className="subtitle mono">{team.id}</p>
          {team.description ? <p className="subtitle">{team.description}</p> : null}
        </div>
        <div className="row">
          <button onClick={() => setShowAdd(true)}>Add workspace</button>
        </div>
      </div>
      {showAdd ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <form onSubmit={(e) => { e.preventDefault(); addProject(); }} className="row">
            <input
              value={newProjectId}
              onChange={(e) => setNewProjectId(e.target.value)}
              placeholder="prj_…"
              aria-label="Project ID"
              style={{ maxWidth: 260 }}
            />
            <button className="primary" type="submit">Attach</button>
          </form>
        </div>
      ) : null}

      <h2>Bots in this team</h2>
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Group bots around a purpose. Membership is a team grouping only — it grants no
        permissions; bots act within the tool permissions configured on each bot.
      </p>
      {teammates.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Role</th>
              <th>Status</th>
              <th>Permissions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {teammates.map((bot) => (
              <tr key={bot.id}>
                <td>
                  <a href={`#/bot/${bot.id}`}>
                    <ShortId id={bot.id} />
                  </a>
                </td>
                <td>{bot.persona || "—"}</td>
                <td>
                  <span className={`badge ${bot.status === "active" ? "ok" : "muted"}`}>
                    {bot.status}
                  </span>
                </td>
                <td className="muted">
                  {bot.permissions.length > 0 ? bot.permissions.join(", ") : "—"}
                </td>
                <td>
                  <button className="danger" onClick={() => removeBot(bot.id)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No bots in this team" hint="Add bots to group them into a fleet around a purpose or workflow." />
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <select
          value={botToAdd}
          onChange={(e) => setBotToAdd(e.target.value)}
          aria-label="Bot to add"
          style={{ maxWidth: 320 }}
        >
          <option value="">Add a bot…</option>
          {addable.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.persona || bot.id} ({bot.id.slice(0, 8)})
            </option>
          ))}
        </select>
        <button className="primary" onClick={addBot} disabled={!botToAdd}>Add bot</button>
      </div>

      <h2 style={{ marginTop: 24 }}>Workspaces in this team</h2>
      {projects.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Project</th>
              <th>Repository</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id}>
                <td>
                  <a href={`#/p/${project.id}`} onClick={() => onOpenProject(project.id)}>
                    <ShortId id={project.id} />
                  </a>
                </td>
                <td className="muted mono">{project.repository}</td>
                <td>
                  <button className="danger" onClick={() => removeProject(project.id)}>Detach</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No workspaces" hint="Attach a workspace to this team so its bots and tasks belong to the team." />
      )}
      {members.length > 0 ? (
        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
            {members.length} membership row{members.length === 1 ? "" : "s"}
          </summary>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
            {members.map((m) => (
              <div key={m.id}>
                {m.teammate_id ? `bot ${m.teammate_id}` : `workspace ${m.project_id}`}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
