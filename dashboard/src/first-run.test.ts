import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, setSession } from "./api";

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

let seen: Seen[];
let queue: Array<{ status: number; body: unknown }>;

function mockFetch() {
  seen = [];
  queue = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      return new Promise<Response>((resolve, reject) => {
        seen.push({
          url,
          method: init.method ?? "GET",
          auth: (init.headers as Record<string, string>)?.Authorization ?? null,
          body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        const onAbort = () =>
          reject(new DOMException("The operation was aborted", "AbortError"));
        init.signal?.addEventListener("abort", onAbort, { once: true });
        const next = queue.shift() ?? { status: 200, body: {} };
        setTimeout(() => {
          init.signal?.removeEventListener("abort", onAbort);
          if (next.body instanceof ReadableStream) {
            resolve({
              ok: true,
              status: next.status,
              body: next.body as ReadableStream,
            } as Response);
          } else {
            resolve({
              ok: next.status >= 200 && next.status < 300,
              status: next.status,
              json: async () => next.body,
            } as Response);
          }
        }, 0);
      });
    }),
  );
}

function ok(body: unknown = {}) {
  queue.push({ status: 200, body });
  return body;
}

function streamBody(chunks: string[]): ReadableStream {
  let i = 0;
  return new ReadableStream({
    start(controller) {
      const pump = () => {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text: chunks[i] })}\n\n`));
        i++;
        setTimeout(pump, 0);
      };
      pump();
    },
    cancel() {
      /* stop requested */
    },
  });
}

beforeEach(() => {
  mockFetch();
  setSession({ baseUrl: "http://api:8088/", token: "tok-123" });
});

describe("first-run: provider configuration", () => {
  it("createProvider posts to /projects/:id/providers with openai-compatible config", async () => {
    ok({ id: "prv_1", name: "groq", kind: "openai-compatible" });
    await api.createProvider("prj_home", {
      kind: "openai-compatible",
      name: "groq",
      config: { base_url: "https://api.groq.com/openai/v1", model: "mixtral-8x7b-32768" },
    });
    expect(seen[0]).toMatchObject({
      url: "http://api:8088/projects/prj_home/providers",
      method: "POST",
      auth: "Bearer tok-123",
    });
    expect(seen[0].body).toMatchObject({
      kind: "openai-compatible",
      name: "groq",
      config: { base_url: "https://api.groq.com/openai/v1", model: "mixtral-8x7b-32768" },
    });
  });

  it("createProvider omits api_key when none provided", async () => {
    ok({ id: "prv_2" });
    await api.createProvider("prj_home", {
      kind: "openai-compatible",
      name: "mock",
      config: { base_url: "http://localhost:8080/v1" },
    });
    expect((seen[0].body as { config: Record<string, unknown> }).config).not.toHaveProperty("api_key");
  });
});

describe("first-run: starting a conversation", () => {
  it("createThread creates a thread under the Home project", async () => {
    ok({ id: "thr_1", title: "Review login flow", project_id: "prj_home", provider_id: null, summary: "", created_at: "2026-10-21T12:00:00Z" });
    const thread = await api.createThread("prj_home", { title: "Review login flow" });
    expect(thread.id).toBe("thr_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_home/threads");
    expect(seen[0].method).toBe("POST");
  });

  it("sendChatStream accumulates chunks and returns full text", async () => {
    const body = streamBody(["Hello", " world", "!"]);
    queue.push({ status: 200, body });
    const full = await api.sendChatStream("thr_1", "hi", () => {
      // chunks arrive incrementally
    });
    expect(full).toBe("Hello world!");
    expect(seen[0].url).toBe("http://api:8088/threads/thr_1/chat/stream");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toEqual({ content: "hi" });
  });

  it("sendChatStream aborts on stop", async () => {
    const controller = new AbortController();
    queue.push({ status: 200, body: new ReadableStream({ start() { /* hold */ } }) });
    const promise = api.sendChatStream("thr_1", "hi", () => {}, {
      signal: controller.signal,
    });
    // abort before the fetch promise settles — the stop path must surface a
    // readable "Stream stopped" error rather than a raw abort exception
    controller.abort();
    await expect(promise).rejects.toMatchObject({ detail: "Stream stopped" });
  });

  it("streaming surface error becomes a readable ApiError", async () => {
    queue.push({ status: 502, body: { detail: "upstream fault" } });
    await expect(api.sendChatStream("thr_1", "hi", () => {})).rejects.toMatchObject({
      status: 502,
      detail: "upstream fault",
    });
  });
});

describe("first-run: requires a connection", () => {
  it("every api call fails closed without a session", async () => {
    setSession(null);
    await expect(api.createThread("prj_home", { title: "x" })).rejects.toMatchObject({
      status: 0,
      detail: "Not connected. Enter your API token first.",
    });
  });
});
