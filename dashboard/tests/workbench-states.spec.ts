/** Every workbench panel must own its loading, empty, and error state.
 *
 *  The responsive spec proves the layout; this one proves the other three
 *  answers a panel can give. The API is mocked so each state is reachable
 *  without waiting for a real failure.
 */
import { test, expect } from "@playwright/test";

const API_BASE = process.env.NERDBOT_API_BASE ?? "http://127.0.0.1:8080";
const PROJECT = { id: "p1", owner: "owner", repository: "demo", config: {} };
const TREE = {
  project_id: "p1",
  root: "/tmp/workspace",
  name: "workspace",
  exists: true,
  git: true,
  branch: "main",
  dirty: false,
  changes: [],
  file_count: 0,
  truncated: false,
  attached: true,
  busy: false,
  files: [],
  dirs: [],
};
const DIFF = { diff: "", status: [], git: true, exists: true };

interface Reply {
  status: number;
  body: unknown;
  delay?: number;
}

async function routeApi(
  page: import("@playwright/test").Page,
  respond: (path: string, method: string) => Reply,
) {
  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = respond(path, request.method());
    if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay));
    await route.fulfill({
      status: reply.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reply.body),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ apiBase }) => {
      window.localStorage.setItem(
        "nerdbot.session",
        JSON.stringify({ baseUrl: apiBase, token: "test-token" }),
      );
      window.localStorage.setItem("nerdbot.theme", "dark");
    },
    { apiBase: API_BASE },
  );
});

test("empty workspace gives every panel a next action", async ({ page }) => {
  await routeApi(page, (path, method) => {
    if (method === "GET" && path === "/projects") return { status: 200, body: { projects: [PROJECT] } };
    if (method === "GET" && path === "/projects/p1/workspace/tree") return { status: 200, body: TREE };
    if (method === "GET" && path === "/projects/p1/workspace/diff") return { status: 200, body: DIFF };
    if (method === "GET" && path === "/projects/p1/teammates") return { status: 200, body: { teammates: [] } };
    return { status: 500, body: { detail: "no shell in this test" } };
  });

  await page.goto("/#workbench");
  await expect(page.getByRole("heading", { name: "Workbench", exact: true })).toBeVisible();

  await expect(page.getByText("This workspace is empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create README.md" }).first()).toBeVisible();
  await expect(page.getByText("No bots in this workspace")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Agents" })).toBeVisible();
  await expect(page.getByText("Working tree clean")).toBeVisible();
  await expect(page.getByText("Run a command")).toBeVisible();
  await expect(page.getByRole("button", { name: "git status" })).toBeVisible();
});

test("every panel shows a skeleton while its data is in flight", async ({ page }) => {
  await routeApi(page, (path, method) => {
    if (method === "GET" && path === "/projects") return { status: 200, body: { projects: [PROJECT] } };
    if (method === "GET" && path === "/projects/p1/workspace/tree")
      return { status: 200, body: TREE, delay: 1_500 };
    if (method === "GET" && path === "/projects/p1/workspace/diff")
      return { status: 200, body: DIFF, delay: 1_500 };
    if (method === "GET" && path === "/projects/p1/teammates")
      return { status: 200, body: { teammates: [] }, delay: 1_500 };
    return { status: 500, body: { detail: "no shell in this test" } };
  });

  await page.goto("/#workbench");
  await expect(page.getByRole("heading", { name: "Workbench", exact: true })).toBeVisible();

  // Files, Bots, and Changes each own a skeleton until their request settles.
  await expect(page.getByRole("status", { name: "Loading" })).toHaveCount(3);
  await expect(page.getByText("This workspace is empty")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Working tree clean")).toBeVisible({ timeout: 5_000 });
});

test("panel errors explain what failed and offer a retry", async ({ page }) => {
  await routeApi(page, (path, method) => {
    if (method === "GET" && path === "/projects") return { status: 200, body: { projects: [PROJECT] } };
    if (method === "GET" && path === "/projects/p1/workspace/tree")
      return { status: 500, body: { detail: "workspace read failed" } };
    if (method === "GET" && path === "/projects/p1/workspace/diff")
      return { status: 500, body: { detail: "workspace read failed" } };
    if (method === "GET" && path === "/projects/p1/teammates")
      return { status: 500, body: { detail: "workspace read failed" } };
    if (method === "POST" && path === "/projects/p1/terminal")
      return { status: 500, body: { detail: "terminal denied" } };
    if (method === "POST" && path === "/projects/p1/tasks")
      return { status: 200, body: { id: "t1", project_id: "p1" } };
    if (method === "POST" && path === "/tasks/t1/runs/async")
      return { status: 200, body: { started: true, task_id: "t1" } };
    if (method === "GET" && path === "/tasks/t1")
      return { status: 500, body: { detail: "task read failed" } };
    return { status: 404, body: { detail: "not mocked" } };
  });

  await page.goto("/#workbench");
  await expect(page.getByRole("heading", { name: "Workbench", exact: true })).toBeVisible();

  // Files, Bots, and Changes all state the failure; each offers Retry.
  await expect(page.getByRole("alert")).toHaveCount(3);
  await expect(page.getByText("Error 500: workspace read failed")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(3);

  // The terminal replaces its canvas with a recovery panel.
  await expect(page.getByText("Terminal unavailable")).toBeVisible();
  await expect(page.getByText("Error 500: terminal denied")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  // A started run that cannot be read gets its own error, not a blank panel.
  await page.getByPlaceholder("e.g. npm test").fill("npm test");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Error 500: task read failed")).toBeVisible();
});
