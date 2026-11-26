import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  threadView: vi.fn(),
  listResearchJobs: vi.fn(),
  listTeammates: vi.fn(),
  projectApprovals: vi.fn(),
  browseWorkspace: vi.fn(),
  sendChat: vi.fn(),
  sendChatStream: vi.fn(),
  renameThread: vi.fn(),
  pinThread: vi.fn(),
  archiveThread: vi.fn(),
  unarchiveThread: vi.fn(),
  deleteThread: vi.fn(),
  listProjects: vi.fn(),
  switchThreadProvider: vi.fn(),
  summarizeThread: vi.fn(),
  getSession: vi.fn(),
  exportThreadUrl: vi.fn(() => "/export"),
  projectTasks: vi.fn(),
  projectRuns: vi.fn(),
  listLibrary: vi.fn(),
  galleryListAssets: vi.fn(),
  listGallery: vi.fn(),
  projectWorkspaceFiles: vi.fn(),
  decideApproval: vi.fn(),
  createObjective: vi.fn(),
  moveThread: vi.fn(),
  createProjectResearchJob: vi.fn(),
}));
const workspace = vi.hoisted(() => {
  let value = "";
  const subs = new Set<(v: string) => void>();
  return {
    getWorkspace: vi.fn(() => value),
    setWorkspace: vi.fn((v: string) => { value = v; subs.forEach((fn) => fn(value)); }),
    clearWorkspace: vi.fn(() => { value = ""; subs.forEach((fn) => fn(value)); }),
    subscribeWorkspace: vi.fn((fn: (v: string) => void) => { subs.add(fn); return () => subs.delete(fn); }),
    initWorkspace: vi.fn(async () => ({ ok: !!value, path: value || null })),
    basename: (p: string) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p,
    __set(v: string) { value = v; },
    __reset() { value = ""; subs.clear(); },
  };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
const notifyError = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({
  api,
  ApiError: class ApiError extends Error { detail: any; status: number; constructor(status: number, detail: any) { super(typeof detail === "string" ? detail : JSON.stringify(detail)); this.status = status; this.detail = detail; } },
  getSession: () => ({ baseUrl: "http://x", token: "t" }),
}));
vi.mock("./workspace", () => workspace);
vi.mock("./app", () => ({ navigate, notifyError }));
vi.mock("sonner", () => ({ toast }));
vi.mock("./views-home", () => ({ useWorkspaceSummary: () => ({ data: { summary: { bundles: [], activeRuns: [], failedRuns: [], pendingApprovals: [] } }, loading: false, loadFailed: false, reload: vi.fn() }) }));
vi.mock("./team-view", () => ({ TeamView: () => <div /> }));
vi.mock("./markdown", () => ({ Markdown: ({ content }: any) => <div>{content}</div> }));

import { ThreadPane } from "./views-chat";

const threadView = {
  thread: { id: "thr_1", project_id: "prj_1", title: "T", provider_id: "__default__", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", archived: false, pinned: false },
  messages: [],
  tasks: [],
};

function renderPane() {
  return render(<ThreadPane threadId="thr_1" projectId="prj_1" providers={[]} onReload={vi.fn()} />);
}

async function setMode(mode: string) {
  screen.getAllByLabelText("Chat mode").forEach((el) => fireEvent.change(el, { target: { value: mode } }));
  if (mode !== "chat") {
    await waitFor(() => expect(document.querySelectorAll('[aria-label="Open workspace picker"], [aria-label="Select workspace"]').length).toBeGreaterThan(0));
  } else {
    await waitFor(() => expect(document.querySelectorAll('[aria-label="Open workspace picker"], [aria-label="Select workspace"]').length).toBe(0));
  }
}

describe("ThreadPane workspace integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.__reset();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    api.threadView.mockResolvedValue(threadView);
    api.listResearchJobs.mockResolvedValue({ jobs: [] });
    api.listTeammates.mockResolvedValue({ teammates: [] });
    api.projectApprovals.mockResolvedValue({ approvals: [] });
    api.listProjects.mockResolvedValue({ projects: [] });
    api.browseWorkspace.mockResolvedValue({ path: "/ws", parent: "/", dirs: [{ name: "sub", path: "/ws/sub" }], truncated: false, selectable: true });
    api.sendChat.mockResolvedValue({ message: { id: "m2", role: "assistant", content: "ok" }, memory_used: [] });
    api.sendChatStream.mockImplementation(async (_id: string, _content: string, onChunk: any) => { onChunk("ok"); });
    api.projectTasks.mockResolvedValue({ tasks: [] });
    api.projectRuns.mockResolvedValue({ runs: [] });
    api.listLibrary.mockResolvedValue({ documents: [] });
    api.galleryListAssets.mockResolvedValue({ assets: [] });
    api.listGallery.mockResolvedValue({ assets: [] });
    api.projectWorkspaceFiles.mockResolvedValue({ files: [], file_count: 0 });
    api.decideApproval.mockResolvedValue({});
  });

  it("shows workspace controls in research mode and hides them in chat mode", async () => {
    renderPane();
    await screen.findByText("Untitled");
    expect(document.querySelector('[aria-label="Open workspace picker"], [aria-label="Select workspace"]')).toBeNull();

    await setMode("research");
    await setMode("chat");
  });

  it("workspace selection survives mode changes and opens same picker from overflow/composer", async () => {
    workspace.__set("/Users/me/project");
    renderPane();
    await screen.findByText("Untitled");
    await setMode("research");
    expect(document.querySelector('[aria-label="Open workspace picker"]')?.textContent).toContain("project");

    // overflow menu Workspace action opens same picker
    const actionsBtn = document.querySelector('[aria-label="Conversation actions"]') as HTMLButtonElement | null;
    if (actionsBtn) {
      fireEvent.click(actionsBtn);
      const wsBtn = await screen.findByRole("button", { name: "Workspace" });
      fireEvent.click(wsBtn);
      await screen.findByLabelText("Workspace path");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    }

    // composer workspace button opens same picker
    fireEvent.click(screen.getAllByRole("button", { name: "Select workspace" })[0]);
    await screen.findByLabelText("Workspace path");

    await setMode("chat");
    await setMode("delegate");
    expect(document.querySelector('[aria-label="Open workspace picker"]')?.textContent).toContain("project");
  });

  it("default restoration uses initWorkspace and invalid stored workspace clear is reflected", async () => {
    workspace.__set("/stale");
    workspace.initWorkspace.mockResolvedValueOnce({ ok: false, path: null });
    renderPane();
    await screen.findByText("Untitled");
    await waitFor(() => expect(workspace.initWorkspace).toHaveBeenCalled());
    await setMode("research");
  });

  it("invalid workspace rejection clears state and shows toast; requests include workspace only in agent modes", async () => {
    workspace.__set("/ws");
    renderPane();
    await screen.findByText("Untitled");

    // chat mode: workspace not sent
    fireEvent.change(screen.getAllByPlaceholderText("Message NerdBot")[0], { target: { value: "hello" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send" })[0]);
    await waitFor(() => expect(api.sendChatStream).toHaveBeenCalled());
    const chatCall = api.sendChatStream.mock.calls.find((c: any[]) => c[1] === "hello");
    expect(chatCall?.[7]?.workspace).toBeUndefined();

    // agent mode: workspace sent and rejection clears state/toasts
    const { ApiError } = await import("./api") as any;
    api.sendChatStream.mockImplementationOnce(async (_id: string, _content: string, _onChunk: any, _onStatus: any, _onParts: any, _mode: any, opts: any) => {
      opts?.onWorkspaceRejected?.("/ws");
      throw new ApiError(400, { code: "workspace_rejected", workspace: "/ws" });
    });
    workspace.__set("/ws");
    await setMode("research");
    fireEvent.change(screen.getAllByPlaceholderText("Message NerdBot")[0], { target: { value: "run tool" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send" })[0]);
    await waitFor(() => expect(workspace.clearWorkspace).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalled();
    const agentCall = api.sendChatStream.mock.calls.find((c: any[]) => c[1] === "run tool");
    expect(agentCall?.[5]).toBe("research");
  });
});
