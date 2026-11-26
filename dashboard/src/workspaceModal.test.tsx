import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { browseWorkspace, vetWorkspace, defaultWorkspace } = vi.hoisted(() => ({
  browseWorkspace: vi.fn(),
  vetWorkspace: vi.fn(),
  defaultWorkspace: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { browseWorkspace, vetWorkspace, defaultWorkspace },
  ApiError: class ApiError extends Error { detail: any; status: number; constructor(status: number, detail: any) { super(String(detail)); this.status = status; this.detail = detail; } },
  getSession: () => ({ baseUrl: "http://x", token: "t" }),
}));

vi.mock("./app", () => ({ notifyError: vi.fn(), navigate: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { WorkspacePickerModal } from "./views-chat";

describe("WorkspacePickerModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders directories, navigates, and disables use for non-selectable paths", async () => {
    browseWorkspace
      .mockResolvedValueOnce({ path: "/root", parent: null, dirs: [{ name: "a", path: "/root/a" }], truncated: false, selectable: true })
      .mockResolvedValueOnce({ path: "/root/a", parent: "/root", dirs: [], truncated: false, selectable: false });
    const onSelect = vi.fn();
    render(<WorkspacePickerModal initialPath="/root" onClose={() => {}} onSelect={onSelect} />);
    await screen.findByText("a");
    fireEvent.click(screen.getByText("a"));
    await waitFor(() => expect(browseWorkspace).toHaveBeenLastCalledWith("/root/a"));
    await screen.findByText("..");
    const useBtn = await screen.findByRole("button", { name: "Use this folder" });
    expect((useBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows truncation message and allows Enter path navigation", async () => {
    browseWorkspace
      .mockResolvedValueOnce({ path: "/root", parent: null, dirs: [], truncated: true, selectable: true })
      .mockResolvedValueOnce({ path: "/typed", parent: "/root", dirs: [], truncated: false, selectable: true });
    render(<WorkspacePickerModal initialPath="/root" onClose={() => {}} onSelect={() => {}} />);
    await screen.findByText(/Too many folders to list/);
    const input = screen.getAllByRole("textbox", { name: "Workspace path" })[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/typed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(browseWorkspace).toHaveBeenLastCalledWith("/typed"));
  });
});
