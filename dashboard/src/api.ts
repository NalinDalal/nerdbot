import type {
  Approval,
  ApprovalInboxItem,
  ApprovalResume,
  Artifact,
  Board,
  BoardMember,
  BoardMessage,
  Capability,
  ChatMessage,
  ChatThread,
  Delegation,
  DecomposeResult,
  Event,
  Health,
  Issue,
  KnowledgeSource,
  MemoryEntry,
  MemoryProvenance,
  Notification,
  Permission,
  PRPackage,
  Project,
  ProjectCounts,
  ProjectMessage,
  Provider,
  Review,
  Run,
  Schedule,
  Task,
  TaskView,
  Team,
  TeamCounts,
  TeamMember,
  Teammate,
  ThreadView,
  WorkspaceFile,
} from "./types";

export interface Session {
  baseUrl: string;
  token: string;
}

/** Session key in this browser's localStorage (personal ops UI, owner's machine). */
const SESSION_KEY = "nerdbot.session";

let session: Session | null = null;

function readStoredSession(): Session | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SESSION_KEY) : null;
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "baseUrl" in parsed &&
      "token" in parsed &&
      typeof (parsed as Session).baseUrl === "string" &&
      typeof (parsed as Session).token === "string" &&
      (parsed as Session).token.length > 0
    ) {
      return parsed as Session;
    }
  } catch {
    // corrupt or sandboxed storage — treat as signed out
  }
  return null;
}

export function setSession(next: Session | null): void {
  session = next && next.token ? next : null;
  try {
    if (typeof localStorage !== "undefined") {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // storage unavailable (private mode etc.) — memory-only session still works
  }
}

export function getSession(): Session | null {
  return session ?? readStoredSession();
}

export class ApiError extends Error {
  status: number;
  detail: string;
  /** Attached when the server answers 409 with a pending gate approval
   *  ({detail: {message, approval}}) so callers can show the approve flow. */
  approval: unknown;

  constructor(status: number, detail: string, approval?: unknown) {
    super(detail || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail || `Request failed (${status})`;
    this.approval = approval;
  }
}

/** Human-readable form for any thrown error. Gated bot actions (409) carry a
 *  pending approval object — say where to approve it instead of dumping JSON. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const base = `Error ${err.status}: ${err.detail}`;
    return err.approval !== undefined
      ? `${base} — approve it in the project's Approvals tab, then retry the same action.`
      : base;
  }
  return String(err);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function req<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  // getSession (not the bare module var) so a request path keeps working
  // after a full page reload restores the session from localStorage.
  const current = getSession();
  if (!current) throw new ApiError(0, "Not connected. Enter your API token first.");
  let res: Response;
  try {
    res = await fetch(joinUrl(current.baseUrl, path), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${current.token}`,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? `Network error: ${err.message}` : "Network error");
  }
  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    // Server errors carry either a plain string detail or, for gated bot
    // actions, {detail: {message, approval}} — keep both readable.
    let detail = `Request failed (${res.status})`;
    let approval: unknown;
    const raw =
      typeof data === "object" && data !== null
        ? (data as { detail?: unknown }).detail
        : undefined;
    if (typeof raw === "string") {
      detail = raw;
    } else if (raw && typeof raw === "object") {
      const obj = raw as { message?: unknown; approval?: unknown };
      if (typeof obj.message === "string") detail = obj.message;
      approval = obj.approval;
    }
    throw new ApiError(res.status, detail, approval);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown = {}): Promise<T> =>
  req<T>(path, { method: "POST", body });
const patch = <T>(path: string, body: unknown = {}): Promise<T> =>
  req<T>(path, { method: "PATCH", body });

/** One loader per view. All errors surface as ApiError with server detail. */
export const api = {
  health: () => req<Health>("/health"),
  capabilities: () => req<{ capabilities: Capability[] }>("/capabilities"),
  /** Canonical permission catalogue — the UI never hard-codes permission names. */
  permissions: () =>
    req<{
      permissions: Permission[];
      admin_permissions: string[];
      agent_permissions: string[];
    }>("/permissions"),

  // -- Home context -----------------------------------------------------------
  /** Resolve (or create on first access) the default Home project used for
   *  project-free conversation. The backend keeps ownership enforcement. */
  getHome: () => req<Project>("/home"),

  // -- Workspace (projects = workspaces) -------------------------------------
  listProjects: () =>
    req<{ projects: Project[]; counts: Record<string, ProjectCounts> }>("/projects"),
  projectTasks: (projectId: string) =>
    req<{ tasks: Task[] }>(`/projects/${projectId}/tasks`),
  projectMessages: (projectId: string, toTeammateId?: string) =>
    req<{ messages: ProjectMessage[] }>(
      `/projects/${projectId}/messages${
        toTeammateId ? `?to_teammate_id=${encodeURIComponent(toTeammateId)}` : ""
      }`,
    ),
  projectApprovals: (projectId: string, decision?: string) =>
    req<{ approvals: Approval[] }>(
      `/projects/${projectId}/approvals${
        decision ? `?decision=${encodeURIComponent(decision)}` : ""
      }`,
    ),

  createProject: (repository: string, config: Record<string, unknown> = {}) =>
    post<Project>("/projects", { repository, config }),

  listTeammates: (projectId: string) =>
    req<{ teammates: Teammate[] }>(`/projects/${projectId}/teammates`),
  createTeammate: (projectId: string, body: Record<string, unknown>) =>
    post<Teammate>(`/projects/${projectId}/teammates`, body),
  disableTeammate: (id: string) => post<Teammate>(`/teammates/${id}/disable`),
  archiveTeammate: (id: string) => post<Teammate>(`/teammates/${id}/archive`),
  patchTeammate: (id: string, body: Record<string, unknown>) => patch<Teammate>(`/teammates/${id}`, body),

  createTeam: (body: Record<string, unknown>) => post<Team>("/teams", body),
  listTeams: () => req<{ teams: Team[]; counts: Record<string, TeamCounts> }>("/teams"),
  getTeam: (teamId: string) =>
    req<{ team: Team; projects: Project[]; teammates: Teammate[]; members: TeamMember[] }>(
      `/teams/${teamId}`,
    ),
  addTeamProject: (teamId: string, projectId: string) =>
    post<TeamMember>(`/teams/${teamId}/projects`, { project_id: projectId }),
  removeTeamProject: (teamId: string, projectId: string) =>
    req<{ removed: boolean }>(`/teams/${teamId}/projects/${projectId}`, { method: "DELETE" }),
  addTeamTeammate: (teamId: string, teammateId: string) =>
    post<TeamMember>(`/teams/${teamId}/teammates`, { teammate_id: teammateId }),
  removeTeamTeammate: (teamId: string, teammateId: string) =>
    req<{ removed: boolean }>(`/teams/${teamId}/teammates/${teammateId}`, { method: "DELETE" }),

  delegateTask: (taskId: string, body: Record<string, unknown>) =>
    post<Delegation>(`/tasks/${taskId}/delegate`, body),
  listTaskDelegations: (taskId: string) =>
    req<{ delegations: Delegation[] }>(`/tasks/${taskId}/delegations`),
  decideDelegation: (delegationId: string, decision: string) =>
    post<Delegation>(`/delegations/${delegationId}/decide`, { decision }),
  cancelDelegation: (delegationId: string, reason = "") =>
    post<Delegation>(`/delegations/${delegationId}/cancel`, { reason }),
  cancelTask: (taskId: string, reason = "") =>
    post<Task>(`/tasks/${taskId}/cancel`, { reason }),

  // -- Boards (agent part) --------------------------------------------------
  listBoards: (projectId?: string) =>
    req<{ boards: Board[] }>(`/boards${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`),
  createBoard: (body: Record<string, unknown>) => post<Board>("/boards", body),
  getBoard: (boardId: string) =>
    req<{ board: Board; members: BoardMember[]; messages: BoardMessage[]; inbox: BoardMessage[] }>(
      `/boards/${boardId}`
    ),
  updateBoard: (boardId: string, body: Record<string, unknown>) =>
    patch<Board>(`/boards/${boardId}`, body),
  deleteBoard: (boardId: string) =>
    req<Board>(`/boards/${boardId}`, { method: "DELETE" }),
  addBoardMember: (boardId: string, body: Record<string, unknown>) =>
    post<BoardMember>(`/boards/${boardId}/members`, body),
  removeBoardMember: (boardId: string, teammateId: string) =>
    req<{ removed: boolean }>(`/boards/${boardId}/members/${teammateId}`, { method: "DELETE" }),
  listBoardMembers: (boardId: string) =>
    req<{ members: BoardMember[] }>(`/boards/${boardId}/members`),
  createBoardMessage: (boardId: string, body: Record<string, unknown>) =>
    post<BoardMessage>(`/boards/${boardId}/messages`, body),
  listBoardMessages: (boardId: string) =>
    req<{ messages: BoardMessage[] }>(`/boards/${boardId}/messages`),
  listBoardInbox: (boardId: string) =>
    req<{ inbox: BoardMessage[] }>(`/boards/${boardId}/inbox`),
  requestBoardApproval: (boardId: string, body: Record<string, unknown>) =>
    post<Approval>(`/boards/${boardId}/approval-request`, body),
  /** Plan-review flow: `{preview: true}` returns a side-effect-free plan;
   *  posting back `{objective, plan}` materializes exactly that plan. */
  decomposeBoard: (boardId: string, body: Record<string, unknown>) =>
    post<DecomposeResult>(`/boards/${boardId}/decompose`, body),

  claimTask: (taskId: string, teammateId: string) =>
    post<TaskView["task"]>(`/tasks/${taskId}/claim`, { teammate_id: teammateId }),

  listAllTeammates: () => req<{ teammates: Teammate[] }>("/teammates"),
  teammateTasks: (teammateId: string) =>
    req<{ tasks: Task[] }>(`/teammates/${teammateId}/tasks`),
  teammateRuns: (teammateId: string) =>
    req<{ runs: Run[] }>(`/teammates/${teammateId}/runs`),
  teammateMemory: (teammateId: string) =>
    req<{ entries: MemoryEntry[] }>(
      `/memory?scope=${encodeURIComponent(`teammate:${teammateId}`)}`
    ),
  writeTeammateMemory: (teammateId: string, body: Record<string, unknown>) =>
    post<MemoryEntry>("/memory", { ...body, scope: `teammate:${teammateId}` }),

  executorSweep: () =>
    post<{ processed: number; results: Array<Record<string, unknown>> }>(
      "/executor/sweep"
    ),

  createTask: (projectId: string, body: Record<string, unknown>) =>
    post<TaskView["task"]>(`/projects/${projectId}/tasks`, body),
  taskView: (taskId: string) => req<TaskView>(`/tasks/${taskId}`),
  assignTask: (taskId: string, ownerTeammateId: string | null) =>
    post<TaskView["task"]>(`/tasks/${taskId}/assign`, { owner_teammate_id: ownerTeammateId }),
  updateTask: (taskId: string, body: Record<string, unknown>) =>
    patch<TaskView["task"]>(`/tasks/${taskId}`, body),
  runTask: (taskId: string) => post<{ run: Run; task_status: string }>(`/tasks/${taskId}/runs`),
  retryTask: (taskId: string) =>
    post<{ run: Run }>(`/tasks/${taskId}/retry`),
  projectRuns: (projectId: string) => req<{ runs: Run[] }>(`/projects/${projectId}/runs`),
  getRun: (runId: string) => req<{ run: Run; artifacts: Artifact[] }>(`/runs/${runId}`),
  cancelRun: (runId: string) =>
    post<{ run: Run; cancel_requested: boolean; signalled: boolean }>(`/runs/${runId}/cancel`),
  getArtifact: (id: string) => req<Artifact>(`/artifacts/${id}`),
  deleteWorkspace: (taskId: string) =>
    req<{ removed: boolean }>(`/tasks/${taskId}/workspace`, { method: "DELETE" }),
  ensureWorkspace: (taskId: string) => post<{ path: string; branch: string }>(`/tasks/${taskId}/workspace`, {}),
  /** The files across every task checkout in a workspace. */
  projectWorkspaceFiles: (projectId: string) =>
    req<{
      checkouts: Array<{
        task_id: string;
        task_description: string;
        branch: string;
        root: string;
        files: WorkspaceFile[];
      }>;
      file_count: number;
    }>(`/projects/${projectId}/workspace/files`),
  workspaceFiles: (taskId: string) =>
    req<{ files: WorkspaceFile[]; root: string }>(`/tasks/${taskId}/workspace/files`),
  workspaceFile: (taskId: string, path: string) =>
    req<{ path: string; content: string }>(
      `/tasks/${taskId}/workspace/file?path=${encodeURIComponent(path)}`,
    ),
  workspaceDiff: (taskId: string) =>
    req<{ diff: string; exists: boolean }>(`/tasks/${taskId}/workspace/diff`),

  submitReview: (taskId: string, body: Record<string, unknown>) =>
    post<{ review: Review; artifact_id: string }>(`/tasks/${taskId}/reviews`, body),
  capturePatch: (taskId: string, runId: string) =>
    post<{ artifact_id: string; diff_chars: number }>(`/tasks/${taskId}/patch`, { run_id: runId }),
  generatePackage: (taskId: string, body: Record<string, unknown>) =>
    post<PRPackage>(`/tasks/${taskId}/pr-package`, body),
  requestPackageApproval: (taskId: string) =>
    post<Approval>(`/tasks/${taskId}/package-approval`),
  buildRollup: (taskId: string) =>
    post<Record<string, unknown>>(`/tasks/${taskId}/rollup`),

  requestApproval: (runId: string, action: string, ttl?: number) =>
    post<Approval>(`/runs/${runId}/approvals`, ttl ? { action, ttl_s: ttl } : { action }),
  listRunApprovals: (runId: string) =>
    req<{ approvals: Approval[] }>(`/runs/${runId}/approvals`),
  decideApproval: (id: string, decision: "approved" | "approved_forever" | "denied") =>
    post<Approval & { resume: ApprovalResume | null; idempotent: boolean }>(
      `/approvals/${id}/decision`,
      { decision },
    ),
  purgeApprovals: (projectId: string) =>
    post<{ purged: number }>(`/projects/${projectId}/approvals/purge`),
  /** The owner's cross-workspace inbox: pending, expired and resolved. */
  approvalsInbox: (state: "pending" | "expired" | "resolved" | "all" = "pending") =>
    req<{ approvals: ApprovalInboxItem[]; state: string }>(
      `/approvals?state=${encodeURIComponent(state)}`,
    ),
  /** Close the work whose request expired unanswered, and recover the work
   *  a crash left behind. */
  sweepApprovals: () =>
    post<{
      closed: Array<Record<string, unknown>>;
      count: number;
      recovered: Array<Record<string, unknown>>;
    }>("/approvals/sweep"),
  /** Ask again: re-run the task that made the request. */
  reaskApproval: (id: string) =>
    post<{ run: Run; exit_code: number | null; artifact_id: string | null }>(
      `/approvals/${id}/reask`,
    ),

  listProviders: (projectId: string) =>
    req<{ providers: Provider[] }>(`/projects/${projectId}/providers`),
  createProvider: (projectId: string, body: Record<string, unknown>) =>
    post<Provider>(`/projects/${projectId}/providers`, body),
  disableProvider: (id: string) => post<Provider>(`/providers/${id}/disable`),
  patchProvider: (id: string, body: Record<string, unknown>) => patch<Provider>(`/providers/${id}`, body),
  providerModels: (id: string) => req<{ models: string[] }>(`/providers/${id}/models`),

  ingestKnowledge: (projectId: string, body: Record<string, unknown>) =>
    post<{ source_id: string; chunks: number }>(`/projects/${projectId}/knowledge`, body),
  listKnowledge: (projectId: string) =>
    req<{ sources: KnowledgeSource[] }>(`/projects/${projectId}/knowledge`),
  searchKnowledge: (taskId: string, query: string) =>
    post<{ citations: Array<Record<string, unknown>> }>(`/tasks/${taskId}/knowledge/search`, {
      query,
    }),
  attachKnowledge: (taskId: string, query: string, runId = "") =>
    post<{ artifact_id: string }>(`/tasks/${taskId}/knowledge/attach`, {
      query,
      run_id: runId,
    }),

  listSchedules: (projectId: string) =>
    req<{ schedules: Schedule[] }>(`/projects/${projectId}/schedules`),
  createSchedule: (projectId: string, body: Record<string, unknown>) =>
    post<Schedule>(`/projects/${projectId}/schedules`, body),
  fireSchedule: (id: string) => post<Record<string, unknown>>(`/schedules/${id}/fire`),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    patch<Schedule>(`/schedules/${id}`, { enabled }),

  sendNotification: (projectId: string, body: Record<string, unknown>) =>
    post<Notification>(`/projects/${projectId}/notify`, body),
  listNotifications: (projectId: string) =>
    req<{ notifications: Notification[] }>(`/projects/${projectId}/notifications`),
  deliverNotification: (id: string) => post<Notification>(`/notifications/${id}/deliver`),
  unlockNotification: (id: string) => post<{ id: string; locked: boolean }>(`/notifications/${id}/unlock`),
  sweepWebhooks: () =>
    post<{ fired: Array<{ id: string; status: string; attempts: number; reclaimed?: boolean; error?: string }> }>(
      "/webhooks/sweep",
    ),
  listWebhookTargets: (projectId: string) =>
    req<{ targets: Array<Record<string, unknown>> }>(`/projects/${projectId}/webhook-targets`),
  addWebhookTarget: (projectId: string, url: string) =>
    post<Record<string, unknown>>(`/projects/${projectId}/webhook-targets`, { url }),
  deleteWebhookTarget: (id: string) =>
    req<Record<string, unknown>>(`/webhook-targets/${id}`, { method: "DELETE" }),

  listIssues: (projectId: string) => req<{ issues: Issue[] }>(`/projects/${projectId}/issues`),
  createIssue: (projectId: string, body: Record<string, unknown>) =>
    post<Issue>(`/projects/${projectId}/issues`, body),
  previewGithubIssue: (projectId: string, repository: string, number: number) =>
    post<Record<string, unknown>>(`/projects/${projectId}/github/preview`, {
      repository,
      number,
    }),
  ingestInbound: (projectId: string, body: Record<string, unknown>) =>
    post<{ issue: Issue; task: TaskView["task"] }>(`/projects/${projectId}/ingress`, body),

  projectMemory: (projectId: string) =>
    req<{ entries: MemoryEntry[] }>(`/projects/${projectId}/memory`),
  writeProjectMemory: (projectId: string, body: Record<string, unknown>) =>
    post<MemoryEntry>(`/projects/${projectId}/memory`, body),

  projectEvents: (projectId: string, entity?: string) =>
    req<{ events: Event[] }>(
      `/projects/${projectId}/events${entity ? `?entity=${encodeURIComponent(entity)}` : ""}`,
    ),
  exportBackup: (projectId: string) =>
    req<Record<string, unknown>>(`/projects/${projectId}/backup`),
  validateBackup: (projectId: string, manifest: unknown) =>
    post<{ valid: boolean; errors: string[] }>(`/projects/${projectId}/backup/validate`, {
      manifest,
    }),
  importBackup: (projectId: string, manifest: unknown, dryRun: boolean) =>
    post<Record<string, unknown>>(`/projects/${projectId}/backup/import`, {
      manifest,
      dry_run: dryRun,
    }),
  projectMetrics: (projectId: string) =>
    req<Record<string, unknown>>(`/projects/${projectId}/metrics`),

  listThreads: (projectId: string) =>
    req<{ threads: ChatThread[] }>(`/projects/${projectId}/threads`),
  /** Recent conversations across every project the caller owns. */
  listRecentThreads: (limit = 20) =>
    req<{ threads: ChatThread[] }>(`/threads?limit=${limit}`),
  createThread: (projectId: string, body: Record<string, unknown>) =>
    post<ChatThread>(`/projects/${projectId}/threads`, body),
  updateThread: (threadId: string, body: Record<string, unknown>) =>
    patch<ChatThread>(`/threads/${threadId}`, body),
  threadView: (threadId: string, limit = 50, before?: string) =>
    req<ThreadView>(
      `/threads/${threadId}?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  appendMessage: (threadId: string, role: string, content: string) =>
    post<ChatMessage>(`/threads/${threadId}/messages`, { role, content }),
  sendChat: (threadId: string, content: string) =>
    post<{
      message: ChatMessage;
      provider_id: string | null;
      memory_used: MemoryProvenance[];
      /** True when the reply came from the mock provider: canned text, no work done. */
      mock?: boolean;
    }>(`/threads/${threadId}/chat`, { content }),
  summarizeThread: (threadId: string) => post<ChatThread>(`/threads/${threadId}/summarize`),
  sendChatStream: (
    threadId: string,
    content: string,
    onChunk: (text: string) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<string> =>
    streamChat(threadId, content, onChunk, opts),
};

async function streamChat(
  threadId: string,
  content: string,
  onChunk: (text: string) => void,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const current = getSession();
  if (!current) throw new ApiError(0, "Not connected. Enter your API token first.");
  let res: Response;
  try {
    res = await fetch(joinUrl(current.baseUrl, `/threads/${threadId}/chat/stream`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${current.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
      signal: opts?.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(0, "Stream stopped");
    }
    // undici (node fetch) surfaces abort as a plain Error named AbortError
    if ((err as { name?: string })?.name === "AbortError") {
      throw new ApiError(0, "Stream stopped");
    }
    throw new ApiError(
      0,
      err instanceof Error ? `Network error: ${err.message}` : "Network error",
    );
  }
  if (!res.ok || !res.body) {
    let detail = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data.detail === "string") detail = data.detail;
    } catch {
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
    let result: Awaited<ReturnType<typeof reader.read>>;
    try {
      result = await reader.read();
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        throw new ApiError(0, "Stream stopped");
      }
      throw err;
    }
    if (result.done) break;
    const value = result.value ?? new Uint8Array(0);
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const text = line.trim();
        if (!text.startsWith("data:")) continue;
        const payload = text.slice(5).trim();
        if (payload === "[DONE]") continue;
        let data: { text?: unknown; error?: unknown };
        try {
          data = JSON.parse(payload) as { text?: unknown; error?: unknown };
        } catch {
          throw new ApiError(502, "Unreadable stream payload");
        }
        if (typeof data.error === "string" && data.error) {
          throw new ApiError(res.status, data.error);
        }
        if (typeof data.text === "string" && data.text) {
          full += data.text;
          onChunk(data.text);
        }
      }
    }
  }
  return full;
}
