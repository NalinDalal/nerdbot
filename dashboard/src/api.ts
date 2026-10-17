import type {
  Approval,
  Artifact,
  Capability,
  ChatMessage,
  ChatThread,
  Event,
  Health,
  Issue,
  KnowledgeSource,
  MemoryEntry,
  MemoryProvenance,
  Notification,
  PRPackage,
  Project,
  Provider,
  Review,
  Run,
  Schedule,
  TaskView,
  Teammate,
  ThreadView,
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

  constructor(status: number, detail: string) {
    super(detail || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail || `Request failed (${status})`;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function req<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const current = session;
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
    const detail =
      typeof data === "object" && data !== null && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, detail);
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

  createProject: (repository: string, config: Record<string, unknown> = {}) =>
    post<Project>("/projects", { repository, config }),

  listTeammates: (projectId: string) =>
    req<{ teammates: Teammate[] }>(`/projects/${projectId}/teammates`),
  createTeammate: (projectId: string, body: Record<string, unknown>) =>
    post<Teammate>(`/projects/${projectId}/teammates`, body),
  disableTeammate: (id: string) => post<Teammate>(`/teammates/${id}/disable`),
  archiveTeammate: (id: string) => post<Teammate>(`/teammates/${id}/archive`),

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
  getArtifact: (id: string) => req<Artifact>(`/artifacts/${id}`),
  deleteWorkspace: (taskId: string) =>
    req<{ removed: boolean }>(`/tasks/${taskId}/workspace`, { method: "DELETE" }),
  ensureWorkspace: (taskId: string) => post<{ path: string; branch: string }>(`/tasks/${taskId}/workspace`, {}),

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
  decideApproval: (id: string, decision: "approved" | "denied") =>
    post<Approval>(`/approvals/${id}/decision`, { decision }),
  purgeApprovals: (projectId: string) =>
    post<{ purged: number }>(`/projects/${projectId}/approvals/purge`),

  listProviders: (projectId: string) =>
    req<{ providers: Provider[] }>(`/projects/${projectId}/providers`),
  createProvider: (projectId: string, body: Record<string, unknown>) =>
    post<Provider>(`/projects/${projectId}/providers`, body),
  disableProvider: (id: string) => post<Provider>(`/providers/${id}/disable`),

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
    post<{ message: ChatMessage; provider_id: string | null; memory_used: MemoryProvenance[] }>(
      `/threads/${threadId}/chat`,
      { content },
    ),
  summarizeThread: (threadId: string) => post<ChatThread>(`/threads/${threadId}/summarize`),
  sendChatStream: (
    threadId: string,
    content: string,
    onChunk: (text: string) => void,
  ): Promise<string> => streamChat(threadId, content, onChunk),
};

async function streamChat(
  threadId: string,
  content: string,
  onChunk: (text: string) => void,
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
    });
  } catch (err) {
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
