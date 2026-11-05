/** The project detail view keeps its page gutters at every width.
 *
 *  Its Page is width="fill", which once waived the gutters along with the
 *  max-width, so the content touched the sidebar and the window edge while
 *  the Projects list and the task page stayed padded. A layout that looks
 *  fine at 1440 can collide at 390, so both widths are measured here, and
 *  the gutter is compared against the Projects list page — the page the
 *  owner considers correct — instead of pinning the pixel value of one
 *  utility (the spacing scale is var-based and 14px-rooted).
 *
 *  Runs against the real API (default 127.0.0.1:8080) so live state is what
 *  is checked. Start the server first. */
import { test, expect } from "@playwright/test";

const WIDTHS = [1440, 390] as const;

const API_BASE = process.env.NERDBOT_API_BASE ?? "http://127.0.0.1:8080";
const TOKEN = process.env.NERDBOT_TOKEN ?? "dev-token-change-me";

test.beforeEach(async ({ page }) => {
  // Serialized as an init script: it runs in the page, so it cannot close
  // over Node-side constants.
  await page.addInitScript(
    ({ apiBase, token }) => {
      window.localStorage.setItem(
        "nerdbot.session",
        JSON.stringify({ baseUrl: apiBase, token }),
      );
      window.localStorage.setItem("nerdbot.theme", "dark");
    },
    { apiBase: API_BASE, token: TOKEN },
  );
});

/** The padded content wrapper a Page renders: main > scroll box > gutter div. */
async function paddedWrapper(page: import("@playwright/test").Page) {
  return page.locator("main > div > div.mx-auto").first();
}

/** Left gutter of the wrapper, in computed pixels. */
async function gutter(page: import("@playwright/test").Page): Promise<number> {
  const wrapper = await paddedWrapper(page);
  return wrapper.evaluate(
    (el) => Number.parseFloat(getComputedStyle(el).paddingLeft),
  );
}

/** First project id from the live API. */
async function firstProject(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get(`${API_BASE}/projects`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { projects: Array<{ id: string }> };
  expect(body.projects.length).toBeGreaterThan(0);
  return body.projects[0].id;
}

for (const width of WIDTHS) {
  test(`project Tasks tab keeps the same gutters as the Projects list at ${width}px`, async ({ page }) => {
    const projectId = await firstProject(page);

    await page.setViewportSize({ width, height: 900 });
    await page.goto("/projects");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    const reference = await gutter(page);
    expect(reference).toBeGreaterThan(0);

    await page.goto(`/p/${projectId}`);
    // The project header is always rendered; the task table may still load.
    await expect(page.getByRole("heading", { name: /Project/i })).toBeVisible({ timeout: 20_000 });
    expect(await gutter(page)).toBe(reference);

    // No horizontal overflow at this width.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  });

  test(`task page keeps the same gutters as the Projects list at ${width}px`, async ({ page }) => {
    const projectId = await firstProject(page);
    const res = await page.request.get(`${API_BASE}/projects/${projectId}/tasks`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.ok()).toBeTruthy();
    const { tasks } = (await res.json()) as { tasks: Array<{ id: string }> };
    const taskId = tasks[0]?.id ?? "tsk_none";

    await page.setViewportSize({ width, height: 900 });
    await page.goto("/projects");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    const reference = await gutter(page);

    await page.goto(`/p/${projectId}/t/${taskId}`);
    if (tasks.length > 0) {
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    } else {
      // No task in the project yet: the error Page still has the contract.
      await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 20_000 });
    }
    expect(await gutter(page)).toBe(reference);

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  });
}
