/** The Connect screen must default to same-origin behind the API-served flow.
 *
 * Acceptance evidence (2026-10-21, real browser): the page served at
 * http://localhost:8080 defaulted its API base to http://127.0.0.1:8080 — a
 * *different* origin, so every API call was CORS-blocked and the freshly
 * connected dashboard showed "Network error" until the human hand-typed the
 * right base URL. */
import { describe, expect, it } from "vitest";

describe("defaultApiBase", () => {
  it("uses the page origin when the dashboard is served by the API", async () => {
    const { defaultApiBase } = await import("./app");
    // The default page origin in the test environment is :3000 — not the
    // vite dev server, so same-origin applies.
    expect(defaultApiBase().startsWith("http://")).toBe(true);
    expect(defaultApiBase().endsWith(":5173")).toBe(false);
  });

  it("keeps the local default on the vite dev server port", async () => {
    Object.defineProperty(globalThis, "window", {
      value: { location: { protocol: "http:", hostname: "localhost", port: "5173", origin: "http://localhost:5173" } },
      writable: true,
      configurable: true,
    });
    const { defaultApiBase } = await import("./app");
    expect(defaultApiBase()).toBe("http://127.0.0.1:8080");
  });
});
