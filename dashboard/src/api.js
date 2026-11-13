/** Session key in this browser's localStorage (personal ops UI, owner's machine). */
const SESSION_KEY = "nerdbot.session";
let session = null;
function readStoredSession() {
    try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SESSION_KEY) : null;
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" &&
            parsed !== null &&
            "baseUrl" in parsed &&
            "token" in parsed &&
            typeof parsed.baseUrl === "string" &&
            typeof parsed.token === "string" &&
            parsed.token.length > 0) {
            return parsed;
        }
    }
    catch {
        // corrupt or sandboxed storage — treat as signed out
    }
    return null;
}
export function setSession(next) {
    session = next && next.token ? next : null;
    try {
        if (typeof localStorage !== "undefined") {
            if (session)
                localStorage.setItem(SESSION_KEY, JSON.stringify(session));
            else
                localStorage.removeItem(SESSION_KEY);
        }
    }
    catch {
        // storage unavailable (private mode etc.) — memory-only session still works
    }
}
export function getSession() {
    return session ?? readStoredSession();
}
export class ApiError extends Error {
    status;
    detail;
    /** Attached when the server answers 409 with a pending gate approval
     *  ({detail: {message, approval}}) so callers can show the approve flow. */
    approval;
    constructor(status, detail, approval) {
        super(detail || `Request failed (${status})`);
        this.name = "ApiError";
        this.status = status;
        this.detail = detail || `Request failed (${status})`;
        this.approval = approval;
    }
}
/** Human-readable form for any thrown error. Gated bot actions (409) carry a
 *  pending approval object — say where to approve it instead of dumping JSON. */
export function describeError(err) {
    if (err instanceof ApiError) {
        const base = `Error ${err.status}: ${err.detail}`;
        return err.approval !== undefined
            ? `${base}. Approve it in the project's Approvals tab, then retry the same action.`
            : base;
    }
    return String(err);
}
/** Silent first connect when the server runs in dev-token mode.
 *
 *  A first-ever visit should not ask the owner to retype a value the server
 *  already published in /health (NERDBOT_INSECURE_DEV_TOKEN=1 is an explicit
 *  human opt-in and the token is a well-known constant). Any other auth mode
 *  says nothing about its token, so this resolves to false and the Connect
 *  screen shows normally. */
export async function autoConnectDev(base) {
    const clean = base.replace(/\/+$/, "");
    try {
        const res = await fetch(`${clean}/health`);
        if (!res.ok)
            return false;
        const health = await res.json();
        if (typeof health !== "object" || health === null)
            return false;
        const probe = health;
        if (probe.status !== "ok")
            return false;
        if (typeof probe.dev_token !== "string" || !probe.dev_token)
            return false;
        setSession({ baseUrl: clean, token: probe.dev_token });
        return true;
    }
    catch {
        return false;
    }
}
function joinUrl(base, path) {
    return `${base.replace(/\/+$/, "")}${path}`;
}
async function req(path, options = {}) {
    const current = getSession();
    if (!current)
        throw new ApiError(0, "Not connected. Enter your API token first.");
    let res;
    try {
        const method = options.method ?? (options.textBody !== undefined || options.rawBody !== undefined || options.body !== undefined ? "POST" : "GET");
        const headers = { Authorization: `Bearer ${current.token}` };
        if (options.textBody !== undefined)
            headers["Content-Type"] = "text/plain";
        else if (options.rawBody !== undefined) {
            if (options.contentType)
                headers["Content-Type"] = options.contentType;
        }
        else if (options.body !== undefined)
            headers["Content-Type"] = "application/json";
        res = await fetch(joinUrl(current.baseUrl, path), {
            method,
            headers,
            body: options.textBody !== undefined
                ? options.textBody
                : options.rawBody !== undefined
                    ? options.rawBody
                    : options.body !== undefined
                        ? JSON.stringify(options.body)
                        : undefined,
        });
    }
    catch (err) {
        throw new ApiError(0, err instanceof Error ? `Network error: ${err.message}` : "Network error");
    }
    let data = {};
    try {
        data = await res.json();
    }
    catch {
        data = {};
    }
    if (!res.ok) {
        let detail = `Request failed (${res.status})`;
        let approval;
        const raw = typeof data === "object" && data !== null
            ? data.detail
            : undefined;
        if (typeof raw === "string") {
            detail = raw;
        }
        else if (raw && typeof raw === "object") {
            const obj = raw;
            if (typeof obj.message === "string")
                detail = obj.message;
            approval = obj.approval;
        }
        throw new ApiError(res.status, detail, approval);
    }
    return data;
}
const post = (path, body = {}) => req(path, { method: "POST", body });
const patch = (path, body = {}) => req(path, { method: "PATCH", body });
/** One loader per view. All errors surface as ApiError with server detail. */
export const api = {
    health: () => req("/health"),
    capabilities: () => req("/capabilities"),
    /** Canonical permission catalogue — the UI never hard-codes permission names. */
    permissions: () => req("/permissions"),
    // -- Home context -----------------------------------------------------------
    /** Resolve (or create on first access) the default Home project used for
     *  project-free conversation. The backend keeps ownership enforcement. */
    getHome: () => req("/home"),
    // -- Workspace (projects = workspaces) -------------------------------------
    listProjects: () => req("/projects"),
    deleteProject: (projectId) => req(`/projects/${projectId}`, { method: "DELETE" }),
    projectTasks: (projectId) => req(`/projects/${projectId}/tasks`),
    projectMessages: (projectId, toTeammateId) => req(`/projects/${projectId}/messages${toTeammateId ? `?to_teammate_id=${encodeURIComponent(toTeammateId)}` : ""}`),
    projectApprovals: (projectId, decision) => req(`/projects/${projectId}/approvals${decision ? `?decision=${encodeURIComponent(decision)}` : ""}`),
    createProject: (repository, config = {}, workspaceRoot) => post("/projects", {
        repository,
        config,
        ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
    }),
    listTeammates: (projectId) => req(`/projects/${projectId}/teammates`),
    createTeammate: (projectId, body) => post(`/projects/${projectId}/teammates`, body),
    disableTeammate: (id) => post(`/teammates/${id}/disable`),
    archiveTeammate: (id) => post(`/teammates/${id}/archive`),
    patchTeammate: (id, body) => patch(`/teammates/${id}`, body),
    getPersona: (id) => req(`/teammates/${id}/persona`),
    putPersona: (id, body) => req(`/teammates/${id}/persona`, { method: "PUT", body }),
    createTeam: (body) => post("/teams", body),
    listTeams: (status = "active") => req(`/teams?status=${encodeURIComponent(status)}`),
    getTeam: (teamId) => req(`/teams/${teamId}`),
    updateTeam: (teamId, body) => patch(`/teams/${teamId}`, body),
    archiveTeam: (teamId) => post(`/teams/${teamId}/archive`),
    restoreTeam: (teamId) => post(`/teams/${teamId}/restore`),
    deleteTeam: (teamId) => req(`/teams/${teamId}`, { method: "DELETE" }),
    addTeamProject: (teamId, projectId) => post(`/teams/${teamId}/projects`, { project_id: projectId }),
    removeTeamProject: (teamId, projectId) => req(`/teams/${teamId}/projects/${projectId}`, { method: "DELETE" }),
    addTeamTeammate: (teamId, teammateId) => post(`/teams/${teamId}/teammates`, { teammate_id: teammateId }),
    removeTeamTeammate: (teamId, teammateId) => req(`/teams/${teamId}/teammates/${teammateId}`, { method: "DELETE" }),
    delegateTask: (taskId, body) => post(`/tasks/${taskId}/delegate`, body),
    listTaskDelegations: (taskId) => req(`/tasks/${taskId}/delegations`),
    decideDelegation: (delegationId, decision) => post(`/delegations/${delegationId}/decide`, { decision }),
    cancelDelegation: (delegationId, reason = "") => post(`/delegations/${delegationId}/cancel`, { reason }),
    cancelTask: (taskId, reason = "") => post(`/tasks/${taskId}/cancel`, { reason }),
    // -- Boards (agent part) --------------------------------------------------
    listBoards: (projectId) => req(`/boards${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`),
    createBoard: (body) => post("/boards", body),
    getBoard: (boardId) => req(`/boards/${boardId}`),
    getBoardExecution: (boardId) => req(`/boards/${boardId}/execution`),
    updateBoard: (boardId, body) => patch(`/boards/${boardId}`, body),
    deleteBoard: (boardId) => req(`/boards/${boardId}`, { method: "DELETE" }),
    addBoardMember: (boardId, body) => post(`/boards/${boardId}/members`, body),
    removeBoardMember: (boardId, teammateId) => req(`/boards/${boardId}/members/${teammateId}`, { method: "DELETE" }),
    listBoardMembers: (boardId) => req(`/boards/${boardId}/members`),
    createBoardMessage: (boardId, body) => post(`/boards/${boardId}/messages`, body),
    listBoardMessages: (boardId) => req(`/boards/${boardId}/messages`),
    listBoardInbox: (boardId) => req(`/boards/${boardId}/inbox`),
    requestBoardApproval: (boardId, body) => post(`/boards/${boardId}/approval-request`, body),
    /** Plan-review flow: `{preview: true}` returns a side-effect-free plan;
     *  posting back `{objective, plan}` materializes exactly that plan. */
    decomposeBoard: (boardId, body) => post(`/boards/${boardId}/decompose`, body),
    claimTask: (taskId, teammateId) => post(`/tasks/${taskId}/claim`, { teammate_id: teammateId }),
    listAllTeammates: () => req("/teammates"),
    teammateTasks: (teammateId) => req(`/teammates/${teammateId}/tasks`),
    teammateRuns: (teammateId) => req(`/teammates/${teammateId}/runs`),
    teammateMemory: (teammateId) => req(`/memory?scope=${encodeURIComponent(`teammate:${teammateId}`)}`),
    writeTeammateMemory: (teammateId, body) => post("/memory", { ...body, scope: `teammate:${teammateId}` }),
    executorSweep: () => post("/executor/sweep"),
    createObjective: (projectId, body) => post(`/projects/${projectId}/objectives`, body),
    createTask: (projectId, body) => post(`/projects/${projectId}/tasks`, body),
    taskView: (taskId) => req(`/tasks/${taskId}`),
    runTaskAsync: (taskId) => post(`/tasks/${taskId}/runs/async`),
    runEvents: (runId, after = 0) => req(`/runs/${runId}/events?after=${after}`),
    assignTask: (taskId, ownerTeammateId) => post(`/tasks/${taskId}/assign`, { owner_teammate_id: ownerTeammateId }),
    updateTask: (taskId, body) => patch(`/tasks/${taskId}`, body),
    runTask: (taskId) => post(`/tasks/${taskId}/runs`),
    retryTask: (taskId) => post(`/tasks/${taskId}/retry`),
    projectRuns: (projectId) => req(`/projects/${projectId}/runs`),
    getRun: (runId) => req(`/runs/${runId}`),
    cancelRun: (runId) => post(`/runs/${runId}/cancel`),
    getArtifact: (id) => req(`/artifacts/${id}`),
    deleteWorkspace: (taskId) => req(`/tasks/${taskId}/workspace`, { method: "DELETE" }),
    ensureWorkspace: (taskId) => post(`/tasks/${taskId}/workspace`, {}),
    /** The live project workspace (not a per-task checkout). */
    projectWorkspace: (projectId) => req(`/projects/${projectId}/workspace`),
    projectWorkspaceTree: (projectId) => req(`/projects/${projectId}/workspace/tree`),
    projectWorkspaceFile: (projectId, path) => req(`/projects/${projectId}/workspace/file?path=${encodeURIComponent(path)}`),
    saveProjectWorkspaceFile: (projectId, path, content) => req(`/projects/${projectId}/workspace/file`, {
        method: "PUT",
        body: { path, content },
    }),
    attachProjectWorkspace: (projectId, path, initializeGit = false) => post(`/projects/${projectId}/workspace/attach`, {
        path,
        initialize_git: initializeGit,
    }),
    projectWorkspaceDiff: (projectId) => req(`/projects/${projectId}/workspace/diff`),
    createTerminal: (projectId, cols = 100, rows = 26) => post(`/projects/${projectId}/terminal`, { cols, rows }),
    sendTerminalInput: (projectId, sessionId, data) => post(`/projects/${projectId}/terminal/${sessionId}/input`, { data }),
    resizeTerminal: (projectId, sessionId, cols, rows) => post(`/projects/${projectId}/terminal/${sessionId}/resize`, { cols, rows }),
    closeTerminal: (projectId, sessionId) => req(`/projects/${projectId}/terminal/${sessionId}`, {
        method: "DELETE",
    }),
    /** Fetch-based SSE: EventSource cannot carry the bearer header. */
    streamTerminal: (projectId, sessionId, handlers, signal) => streamTerminal(projectId, sessionId, handlers, signal),
    /** The files across every task checkout in a workspace. */
    projectWorkspaceFiles: (projectId) => req(`/projects/${projectId}/workspace/files`),
    workspaceFiles: (taskId) => req(`/tasks/${taskId}/workspace/files`),
    workspaceFile: (taskId, path) => req(`/tasks/${taskId}/workspace/file?path=${encodeURIComponent(path)}`),
    workspaceDiff: (taskId) => req(`/tasks/${taskId}/workspace/diff`),
    submitReview: (taskId, body) => post(`/tasks/${taskId}/reviews`, body),
    capturePatch: (taskId, runId) => post(`/tasks/${taskId}/patch`, { run_id: runId }),
    generatePackage: (taskId, body) => post(`/tasks/${taskId}/pr-package`, body),
    requestPackageApproval: (taskId) => post(`/tasks/${taskId}/package-approval`),
    buildRollup: (taskId) => post(`/tasks/${taskId}/rollup`),
    requestApproval: (runId, action, ttl) => post(`/runs/${runId}/approvals`, ttl ? { action, ttl_s: ttl } : { action }),
    listRunApprovals: (runId) => req(`/runs/${runId}/approvals`),
    decideApproval: (id, decision) => post(`/approvals/${id}/decision`, { decision }),
    purgeApprovals: (projectId) => post(`/projects/${projectId}/approvals/purge`),
    /** The owner's cross-workspace inbox: pending, expired and resolved. */
    approvalsInbox: (state = "pending") => req(`/approvals?state=${encodeURIComponent(state)}`),
    /** Close the work whose request expired unanswered, and recover the work
     *  a crash left behind. */
    sweepApprovals: () => post("/approvals/sweep"),
    /** Ask again: re-run the task that made the request. */
    reaskApproval: (id) => post(`/approvals/${id}/reask`),
    listProviders: (projectId) => req(`/projects/${projectId}/providers`),
    createProvider: (projectId, body) => post(`/projects/${projectId}/providers`, body),
    disableProvider: (id) => post(`/providers/${id}/disable`),
    patchProvider: (id, body) => patch(`/providers/${id}`, body),
    providerModels: (id) => req(`/providers/${id}/models`),
    providerHealth: (id) => req(`/providers/${id}/health`),
    ingestKnowledge: (projectId, body) => post(`/projects/${projectId}/knowledge`, body),
    listKnowledge: (projectId) => req(`/projects/${projectId}/knowledge`),
    searchKnowledge: (taskId, query) => post(`/tasks/${taskId}/knowledge/search`, {
        query,
    }),
    attachKnowledge: (taskId, query, runId = "") => post(`/tasks/${taskId}/knowledge/attach`, {
        query,
        run_id: runId,
    }),
    // Library: the owner's documents. Access checks (owner vs. acting
    // teammate) are enforced server-side; the dashboard is the owner's UI.
    listLibrary: (projectId) => req(`/projects/${projectId}/library`),
    createLibraryDoc: (projectId, body) => post(`/projects/${projectId}/library`, body),
    uploadLibraryDoc: (projectId, filename, text) => req(`/projects/${projectId}/library/upload?filename=${encodeURIComponent(filename)}`, { textBody: text }),
    getLibraryDoc: (docId) => req(`/library/${docId}`),
    patchLibraryDoc: (docId, body) => patch(`/library/${docId}`, body),
    deleteLibraryDoc: (docId) => req(`/library/${docId}`, { method: "DELETE" }),
    listLibraryVersions: (docId) => req(`/library/${docId}/versions`),
    restoreLibraryVersion: (docId, version) => post(`/library/${docId}/versions/${version}/restore`),
    listLibraryAccess: (docId) => req(`/library/${docId}/access`),
    setLibraryAccess: (docId, teammateId, access) => req(`/library/${docId}/access`, {
        method: "PUT",
        body: { teammate_id: teammateId, access },
    }),
    revokeLibraryAccess: (docId, teammateId) => req(`/library/${docId}/access/${teammateId}`, {
        method: "DELETE",
    }),
    exportLibraryDocUrl: (docId, format = "md", token = "") => {
        const base = (getSession()?.baseUrl || "").replace(/\/+$/, "");
        return `${base}/library/${docId}/export?format=${encodeURIComponent(format)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
    },
    aiSuggestLibraryDoc: (docId, instruction) => post(`/library/${docId}/ai-suggest`, { instruction }),
    // -- Gallery (Phase 4) -----------------------------------------------------
    listGallery: (projectId, params) => {
        const q = new URLSearchParams();
        if (params?.q)
            q.set("q", params.q);
        if (params?.mime)
            q.set("mime", params.mime);
        if (params?.limit)
            q.set("limit", String(params.limit));
        if (params?.offset)
            q.set("offset", String(params.offset));
        const s = q.toString();
        return req(`/projects/${projectId}/gallery${s ? `?${s}` : ""}`);
    },
    uploadGalleryAsset: (projectId, file, meta) => file.arrayBuffer().then((buf) => req(`/projects/${projectId}/gallery?filename=${encodeURIComponent(file.name)}&mime_type=${encodeURIComponent(file.type || "")}&thread_id=${encodeURIComponent(meta?.thread_id || "")}&task_id=${encodeURIComponent(meta?.task_id || "")}&doc_id=${encodeURIComponent(meta?.doc_id || "")}&source=${encodeURIComponent(meta?.source || "")}`, { method: "POST", rawBody: buf, contentType: file.type || "application/octet-stream" })),
    galleryAssetContentUrl: (assetId, token = "") => {
        const base = (getSession()?.baseUrl || "").replace(/\/+$/, "");
        return `${base}/gallery/${assetId}/content${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    },
    deleteGalleryAsset: (assetId) => req(`/gallery/${assetId}`, { method: "DELETE" }),
    schedulePresets: () => req("/schedules/presets"),
    listSchedules: (projectId) => req(`/projects/${projectId}/schedules`),
    getSchedule: (id) => req(`/schedules/${id}`),
    createSchedule: (projectId, body) => post(`/projects/${projectId}/schedules`, body),
    updateSchedule: (id, body) => patch(`/schedules/${id}`, body),
    pauseSchedule: (id) => post(`/schedules/${id}/pause`, {}),
    resumeSchedule: (id) => post(`/schedules/${id}/resume`, {}),
    deleteSchedule: (id) => req(`/schedules/${id}`, { method: "DELETE" }),
    fireSchedule: (id) => post(`/schedules/${id}/fire`),
    listScheduleRuns: (id, limit = 50) => req(`/schedules/${id}/runs?limit=${limit}`),
    setScheduleEnabled: (id, enabled) => patch(`/schedules/${id}`, { enabled }),
    // -- Reminders & jobs (Phase 2) --------------------------------------------
    listReminders: (projectId, status, limit = 100) => {
        const q = new URLSearchParams();
        if (projectId)
            q.set("project_id", projectId);
        if (status)
            q.set("status", status);
        q.set("limit", String(limit));
        return req(`/reminders?${q.toString()}`);
    },
    createReminder: (body) => post("/reminders", body),
    cancelReminder: (id) => post(`/reminders/${id}/cancel`, {}),
    listJobs: (params) => {
        const q = new URLSearchParams();
        if (params?.project_id)
            q.set("project_id", params.project_id);
        if (params?.source)
            q.set("source", params.source);
        if (params?.status)
            q.set("status", params.status);
        if (params?.limit)
            q.set("limit", String(params.limit));
        const s = q.toString();
        return req(`/jobs${s ? `?${s}` : ""}`);
    },
    sendNotification: (projectId, body) => post(`/projects/${projectId}/notify`, body),
    listNotifications: (projectId) => req(`/projects/${projectId}/notifications`),
    deliverNotification: (id) => post(`/notifications/${id}/deliver`),
    unlockNotification: (id) => post(`/notifications/${id}/unlock`),
    sweepWebhooks: () => post("/webhooks/sweep"),
    listWebhookTargets: (projectId) => req(`/projects/${projectId}/webhook-targets`),
    addWebhookTarget: (projectId, url) => post(`/projects/${projectId}/webhook-targets`, { url }),
    deleteWebhookTarget: (id) => req(`/webhook-targets/${id}`, { method: "DELETE" }),
    listIssues: (projectId) => req(`/projects/${projectId}/issues`),
    createIssue: (projectId, body) => post(`/projects/${projectId}/issues`, body),
    previewGithubIssue: (projectId, repository, number) => post(`/projects/${projectId}/github/preview`, {
        repository,
        number,
    }),
    ingestInbound: (projectId, body) => post(`/projects/${projectId}/ingress`, body),
    projectMemory: (projectId, params) => {
        const q = new URLSearchParams();
        if (params?.q)
            q.set("q", params.q);
        if (params?.tier)
            q.set("tier", params.tier);
        if (params?.pinned !== undefined)
            q.set("pinned", String(params.pinned));
        if (params?.limit)
            q.set("limit", String(params.limit));
        if (params?.offset)
            q.set("offset", String(params.offset));
        const s = q.toString();
        return req(`/projects/${projectId}/memory${s ? `?${s}` : ""}`);
    },
    listMemory: (scope, params) => {
        const q = new URLSearchParams({ scope });
        if (params?.q)
            q.set("q", params.q);
        if (params?.tier)
            q.set("tier", params.tier);
        if (params?.pinned !== undefined)
            q.set("pinned", String(params.pinned));
        if (params?.limit)
            q.set("limit", String(params.limit));
        if (params?.offset)
            q.set("offset", String(params.offset));
        return req(`/memory?${q.toString()}`);
    },
    writeProjectMemory: (projectId, body) => post(`/projects/${projectId}/memory`, body),
    patchMemory: (memoryId, body) => patch(`/memory/${memoryId}`, body),
    deleteMemory: (memoryId) => req(`/memory/${memoryId}`, { method: "DELETE" }),
    pruneMemory: (scope, body) => {
        const q = new URLSearchParams({ scope });
        if (body?.keep != null)
            q.set("keep", String(body.keep));
        if (body?.older_than_days != null)
            q.set("older_than_days", String(body.older_than_days));
        return post(`/memory/prune?${q.toString()}`, {});
    },
    // -- Skills (Phase 3) ------------------------------------------------------
    listSkills: (params) => {
        const q = new URLSearchParams();
        if (params?.project_id)
            q.set("project_id", params.project_id);
        if (params?.teammate_id)
            q.set("teammate_id", params.teammate_id);
        if (params?.scope)
            q.set("scope", params.scope);
        if (params?.q)
            q.set("q", params.q);
        if (params?.limit)
            q.set("limit", String(params.limit));
        if (params?.offset)
            q.set("offset", String(params.offset));
        const s = q.toString();
        return req(`/skills${s ? `?${s}` : ""}`);
    },
    createSkill: (body) => post("/skills", body),
    getSkill: (id) => req(`/skills/${id}`),
    patchSkill: (id, body) => patch(`/skills/${id}`, body),
    deleteSkill: (id) => req(`/skills/${id}`, { method: "DELETE" }),
    teammateSkills: (teammateId) => req(`/teammates/${teammateId}/skills`),
    attachSkill: (teammateId, skillId) => post(`/teammates/${teammateId}/skills/${skillId}`, {}),
    detachSkill: (teammateId, skillId) => req(`/teammates/${teammateId}/skills/${skillId}`, { method: "DELETE" }),
    projectEvents: (projectId, entity) => req(`/projects/${projectId}/events${entity ? `?entity=${encodeURIComponent(entity)}` : ""}`),
    exportBackup: (projectId) => req(`/projects/${projectId}/backup`),
    validateBackup: (projectId, manifest) => post(`/projects/${projectId}/backup/validate`, {
        manifest,
    }),
    importBackup: (projectId, manifest, dryRun) => post(`/projects/${projectId}/backup/import`, {
        manifest,
        dry_run: dryRun,
    }),
    projectMetrics: (projectId) => req(`/projects/${projectId}/metrics`),
    listThreads: (projectId, params) => {
        const q = new URLSearchParams();
        if (params?.q)
            q.set("q", params.q);
        if (params?.include_archived)
            q.set("include_archived", "true");
        if (params?.archived_only)
            q.set("archived_only", "true");
        if (params?.pinned_only)
            q.set("pinned_only", "true");
        if (params?.limit != null)
            q.set("limit", String(params.limit));
        const s = q.toString();
        return req(`/projects/${projectId}/threads${s ? `?${s}` : ""}`);
    },
    /** Recent conversations across every project the caller owns. */
    listRecentThreads: (limit = 20, params) => {
        const q = new URLSearchParams({ limit: String(limit) });
        if (params?.q)
            q.set("q", params.q);
        if (params?.include_archived)
            q.set("include_archived", "true");
        return req(`/threads?${q.toString()}`);
    },
    createThread: (projectId, body) => post(`/projects/${projectId}/threads`, body),
    updateThread: (threadId, body) => patch(`/threads/${threadId}`, body),
    renameThread: (threadId, title) => patch(`/threads/${threadId}`, { title }),
    archiveThread: (threadId) => post(`/threads/${threadId}/archive`, {}),
    unarchiveThread: (threadId) => post(`/threads/${threadId}/unarchive`, {}),
    pinThread: (threadId, pinned = true) => post(`/threads/${threadId}/pin`, { pinned }),
    deleteThread: (threadId) => req(`/threads/${threadId}`, { method: "DELETE" }),
    restoreThread: (threadId) => post(`/threads/${threadId}/restore`, {}),
    moveThread: (threadId, projectId) => post(`/threads/${threadId}/move`, { project_id: projectId }),
    exportThreadUrl: (threadId, token = "") => {
        const base = (getSession()?.baseUrl || "").replace(/\/+$/, "");
        return `${base}/threads/${threadId}/export${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    },
    threadView: (threadId, limit = 50, before) => req(`/threads/${threadId}?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
    appendMessage: (threadId, role, content) => post(`/threads/${threadId}/messages`, { role, content }),
    sendChat: (threadId, content, mode) => post(`/threads/${threadId}/chat`, { content, mode }),
    summarizeThread: (threadId) => post(`/threads/${threadId}/summarize`),
    approvePlan: (threadId, planId, body) => post(`/threads/${threadId}/plans/${planId}/approve`, body || {}),
    teamActivity: (objectiveId) => req(`/team/activity?objective_id=${encodeURIComponent(objectiveId)}`),
    attachProviderAll: (projectId, body) => post(`/projects/${projectId}/teammates/attach-provider`, body),
    // -- Search & research (Phase 1) -------------------------------------------
    searchProviders: () => req("/search/providers"),
    createResearchJob: (body) => post("/research/jobs", body),
    createProjectResearchJob: (projectId, body) => post(`/projects/${projectId}/research/jobs`, body),
    listResearchJobs: (projectId, limit = 50) => req(projectId ? `/projects/${projectId}/research/jobs?limit=${limit}` : `/research/jobs?limit=${limit}`),
    getResearchJob: (jobId) => req(`/research/jobs/${jobId}`),
    getResearchJobEvents: (jobId, after = 0) => req(`/research/jobs/${jobId}/events?after=${after}`),
    cancelResearchJob: (jobId) => post(`/research/jobs/${jobId}/cancel`, {}),
    retryResearchJob: (jobId) => post(`/research/jobs/${jobId}/retry`, {}),
    sendChatStream: (threadId, content, onChunk, onStatus, onParts, mode, opts) => streamChat(threadId, content, onChunk, onStatus, onParts, mode, opts),
    /** Live run execution: SSE that replays from ``after`` and closes on the
     *  terminal state. Resolves true when the stream completed; any throw
     *  means the caller should fall back to polling. */
    streamRunEvents: (runId, after, handlers, signal) => streamRunEvents(runId, after, handlers, signal),
};
/** Follow one run's events over the SSE stream.
 *
 *  The stream replays the durable log from ``after``, relays live events,
 *  and closes with an ``end`` frame when the run is terminal. Returns true
 *  when the stream completed cleanly (the caller stops polling); throwing
 *  means the caller should fall back to polling. */
async function streamRunEvents(runId, after, handlers, signal) {
    const current = getSession();
    if (!current)
        throw new ApiError(0, "Not connected. Enter your API token first.");
    let res;
    try {
        res = await fetch(joinUrl(current.baseUrl, `/runs/${runId}/events/stream?after=${after}`), {
            headers: { Authorization: `Bearer ${current.token}` },
            signal,
        });
    }
    catch (err) {
        if (err?.name === "AbortError")
            return true;
        throw new ApiError(0, err instanceof Error ? `Network error: ${err.message}` : "Network error");
    }
    if (!res.ok || !res.body) {
        let detail = `Run stream failed (${res.status})`;
        try {
            const data = (await res.json());
            if (typeof data.detail === "string")
                detail = data.detail;
        }
        catch {
            /* keep default */
        }
        throw new ApiError(res.status, detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        let chunk;
        try {
            chunk = await reader.read();
        }
        catch (err) {
            if (err?.name === "AbortError")
                return true;
            throw err;
        }
        if (chunk.done)
            return true;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => line.slice(6))
                .join("\n");
            if (data) {
                try {
                    const event = JSON.parse(data);
                    if (event.type === "end") {
                        handlers.onEnd();
                        return true;
                    }
                    if (typeof event.seq === "number" && typeof event.kind === "string") {
                        handlers.onEvent(event);
                    }
                }
                catch {
                    /* a malformed frame is ignored, the stream continues */
                }
            }
            boundary = buffer.indexOf("\n\n");
        }
    }
}
async function streamTerminal(projectId, sessionId, handlers, signal) {
    const current = getSession();
    if (!current)
        throw new ApiError(0, "Not connected. Enter your API token first.");
    let res;
    try {
        res = await fetch(joinUrl(current.baseUrl, `/projects/${projectId}/terminal/${sessionId}/stream`), {
            headers: { Authorization: `Bearer ${current.token}` },
            signal,
        });
    }
    catch (err) {
        if (err?.name === "AbortError")
            return;
        throw new ApiError(0, err instanceof Error ? `Network error: ${err.message}` : "Network error");
    }
    if (!res.ok || !res.body) {
        let detail = `Terminal stream failed (${res.status})`;
        try {
            const data = (await res.json());
            if (typeof data.detail === "string")
                detail = data.detail;
        }
        catch {
            /* keep default */
        }
        throw new ApiError(res.status, detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        let chunk;
        try {
            chunk = await reader.read();
        }
        catch (err) {
            if (err?.name === "AbortError")
                return;
            throw err;
        }
        if (chunk.done)
            return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => line.slice(6))
                .join("\n");
            if (data) {
                try {
                    const event = JSON.parse(data);
                    if (event.type === "snapshot" && event.data)
                        handlers.onSnapshot?.(event.data);
                    else if (event.type === "data" && event.data)
                        handlers.onData(event.data);
                    else if (event.type === "exit")
                        handlers.onExit?.();
                }
                catch {
                    /* a malformed frame is ignored, the stream continues */
                }
            }
            boundary = buffer.indexOf("\n\n");
        }
    }
}
async function streamChat(threadId, content, onChunk, onStatus, onParts, mode, opts) {
    const current = getSession();
    if (!current)
        throw new ApiError(0, "Not connected. Enter your API token first.");
    let res;
    try {
        res = await fetch(joinUrl(current.baseUrl, `/threads/${threadId}/chat/stream`), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${current.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ content, mode }),
            signal: opts?.signal,
        });
    }
    catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
            throw new ApiError(0, "Stream stopped");
        }
        // undici (node fetch) surfaces abort as a plain Error named AbortError
        if (err?.name === "AbortError") {
            throw new ApiError(0, "Stream stopped");
        }
        throw new ApiError(0, err instanceof Error ? `Network error: ${err.message}` : "Network error");
    }
    if (!res.ok || !res.body) {
        let detail = `Request failed (${res.status})`;
        try {
            const data = (await res.json());
            if (typeof data.detail === "string")
                detail = data.detail;
        }
        catch {
            /* keep default */
        }
        throw new ApiError(res.status, detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    if (opts?.signal) {
        // reader.cancel() rejects when the stream already errored (that is how an
        // abort surfaces); swallow that so it cannot become an unhandled rejection.
        const onAbort = () => reader.cancel().catch(() => undefined);
        opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    for (;;) {
        let result;
        try {
            result = await reader.read();
        }
        catch (err) {
            if (err?.name === "AbortError") {
                throw new ApiError(0, "Stream stopped");
            }
            throw err;
        }
        if (result.done)
            break;
        const value = result.value ?? new Uint8Array(0);
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
            for (const line of part.split("\n")) {
                const text = line.trim();
                if (!text.startsWith("data:"))
                    continue;
                const payload = text.slice(5).trim();
                if (payload === "[DONE]")
                    continue;
                let data;
                try {
                    data = JSON.parse(payload);
                }
                catch {
                    throw new ApiError(502, "Unreadable stream payload");
                }
                if (typeof data.error === "string" && data.error) {
                    throw new ApiError(res.status, data.error);
                }
                if (data.kind === "speaker" &&
                    typeof data.teammate_id === "string" &&
                    typeof data.name === "string") {
                    opts?.onSpeaker?.({ teammate_id: data.teammate_id, name: data.name });
                }
                else if (data.kind === "memory_used" && Array.isArray(data.memory_used)) {
                    opts?.onMemoryUsed?.(data.memory_used);
                }
                else if (data.kind === "status" && typeof data.text === "string" && data.text) {
                    onStatus?.(data.text);
                }
                else if (data.kind === "parts" && Array.isArray(data.parts)) {
                    onParts?.(data.parts);
                }
                else if (typeof data.text === "string" && data.text) {
                    // Backwards-compat: events without a kind are answer text.
                    if (data.kind === "text" || data.kind === undefined) {
                        full += data.text;
                        onChunk(data.text);
                    }
                }
            }
        }
    }
    return full;
}
