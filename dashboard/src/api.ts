import type {
  Approval,
  Artifact,
  Capability,
  Event,
  Health,
  Issue,
  KnowledgeSource,
  MemoryEntry,
  Notification,
  PRPackage,
  Project,
  Provider,
  Review,
  Run,
  Schedule,
  TaskView,
  Teammate,
} from "./types";

export interface Session {
  baseUrl: string;
  token: string;
}

/** Session lives in module memory only. Never persisted, never logged. */
let session: Session | null = null;

export function setSession(next: Session | null): void {
  session = next && next.token ? next : null;
}

export function getSession(): Session | null {
  return session;
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
  sweepWebhooks: () => post<{ fired: Array<Record<string, unknown>> }>("/webhooks/sweep"),
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
};
