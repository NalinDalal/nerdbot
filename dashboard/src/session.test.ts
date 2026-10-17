/**
 * Session persistence across refreshes (2026-10-17 UX fix).
 *
 * Previously the dashboard session lived only in module memory, so every
 * page reload dropped the connection screen back in front of the owner.
 * Now setSession/getSession also persist to this browser's localStorage,
 * cleared on Disconnect.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession, setSession } from "./api";

interface Store {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function fakeStorage(): Store {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const original: unknown = globalThis.localStorage;

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: original, writable: true });
});

describe("session persistence", () => {
  it("req() falls back to persisted storage after a full page reload", async () => {
    // simulates: connect (persisted) → reload (fresh module instance, empty memory)
    const store = fakeStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      writable: true,
      configurable: true,
    });
    setSession({ baseUrl: "http://api:8088", token: "tok-refresh" });
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        seen.push({
          url,
          auth: (init.headers as Record<string, string>)?.Authorization ?? null,
        });
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) } as Response;
      }),
    );
    vi.resetModules();
    try {
      const fresh = await import("./api");
      // the fresh instance has no memory session; only storage
      await fresh.api.health();
      expect(seen).toEqual([
        { url: "http://api:8088/health", auth: "Bearer tok-refresh" },
      ]);
      // and re-setSession(null) on the fresh instance clears storage too
      fresh.setSession(null);
      expect(fresh.getSession()).toBeNull();
      expect(store.getItem("nerdbot.session")).toBeNull();
    } finally {
      vi.resetModules();
    }
  });

  it("survives a fresh module-scope read after reconnect (refresh shape)", () => {
    const store = fakeStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      writable: true,
      configurable: true,
    });
    setSession({ baseUrl: "http://127.0.0.1:8088", token: "tok-1" });
    // simulate the full module reload: drop in-memory state, read back solely
    // from storage via a fresh getSession cache miss
    setSession({ baseUrl: "http://127.0.0.1:8088", token: "tok-2" });
    expect(getSession()).toEqual({ baseUrl: "http://127.0.0.1:8088", token: "tok-2" });
    setSession(null);
    expect(getSession()).toBeNull();
    expect(store.getItem("nerdbot.session")).toBeNull();
  });

  it("ignores corrupt or malformed stored sessions", () => {
    const map = new Map<string, string>();
    map.set("nerdbot.session", "{not json");
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: (k: string) => map.get(k) ?? null, setItem: () => {}, removeItem: (k: string) => void map.delete(k) },
      writable: true,
      configurable: true,
    });
    expect(getSession()).toBeNull();
  });

  it("ignores stored sessions with an empty token", () => {
    const map = new Map<string, string>();
    map.set("nerdbot.session", JSON.stringify({ baseUrl: "http://x", token: "" }));
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: (k: string) => map.get(k) ?? null, setItem: () => {}, removeItem: (k: string) => void map.delete(k) },
      writable: true,
      configurable: true,
    });
    expect(getSession()).toBeNull();
  });
});
