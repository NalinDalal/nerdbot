import { beforeEach, describe, expect, it, vi } from "vitest";

const { browseWorkspace, vetWorkspace, defaultWorkspace } = vi.hoisted(() => ({
  browseWorkspace: vi.fn(),
  vetWorkspace: vi.fn(),
  defaultWorkspace: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { browseWorkspace, vetWorkspace, defaultWorkspace },
}));

import { basename, clearWorkspace, getWorkspace, initWorkspace, setWorkspace, vetAndSetWorkspace } from "./workspace";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
}

describe("workspace chat binding state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).localStorage = new MemoryStorage();
    clearWorkspace();
  });

  it("basename handles posix and windows paths", () => {
    expect(basename("/a/b/c")).toBe("c");
    expect(basename("C:\\a\\b\\c")).toBe("c");
  });

  it("initWorkspace restores a valid saved workspace", async () => {
    setWorkspace("/saved");
    vetWorkspace.mockResolvedValue({ ok: true, path: "/saved-real" });
    const res = await initWorkspace();
    expect(res).toEqual({ ok: true, path: "/saved-real" });
    expect(getWorkspace()).toBe("/saved-real");
    expect(defaultWorkspace).not.toHaveBeenCalled();
  });

  it("initWorkspace clears stale saved workspace and falls back to default", async () => {
    setWorkspace("/stale");
    vetWorkspace.mockResolvedValueOnce({ ok: false, path: null }).mockResolvedValueOnce({ ok: true, path: "/default" });
    defaultWorkspace.mockResolvedValue({ ok: true, path: "/default" });
    const res = await initWorkspace();
    expect(res).toEqual({ ok: true, path: "/default" });
    expect(getWorkspace()).toBe("/default");
  });

  it("initWorkspace clears stale saved workspace when default invalid", async () => {
    setWorkspace("/stale");
    vetWorkspace.mockResolvedValue({ ok: false, path: null });
    defaultWorkspace.mockResolvedValue({ ok: true, path: "/bad-default" });
    const res = await initWorkspace();
    expect(res).toEqual({ ok: false, path: null });
    expect(getWorkspace()).toBe("");
  });

  it("vetAndSetWorkspace does not persist invalid paths", async () => {
    vetWorkspace.mockResolvedValue({ ok: false, path: null });
    const res = await vetAndSetWorkspace("/bad");
    expect(res.ok).toBe(false);
    expect(getWorkspace()).toBe("");
  });
});
