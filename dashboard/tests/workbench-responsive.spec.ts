/** The workbench at every width the owner cares about.
 *
 *  The workbench is the one surface whose layout is a function of width: two
 *  rails and a main column collapse into one pane at a time on small screens.
 *  A width that looks fine at 1440 can clip at 390, so widths are measured
 *  here instead of trusted.
 *
 *  Runs against the real API (default 127.0.0.1:8080) so populated state is
 *  what is checked. Start the server first:
 *
 *      NERDBOT_INSECURE_DEV_TOKEN=1 uv run uvicorn ...   (or `nerdbot serve`)
 *
 *  Screenshots and the measured report land in dashboard/out/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WIDTHS = [1440, 1280, 1024, 768, 640, 390, 375] as const;
const PANES = ["files", "editor", "terminal", "review"] as const;
const OUT_DIR = join(process.cwd(), "out");
const SHOT_DIR = join(OUT_DIR, "screenshots");

const API_BASE = process.env.NERDBOT_API_BASE ?? "http://127.0.0.1:8080";
const TOKEN = process.env.NERDBOT_TOKEN ?? "dev-token-change-me";

interface Overflow {
  tag: string;
  id: string;
  text: string;
  clientWidth: number;
  scrollWidth: number;
  overflowX: string;
}

/** Horizontal overflow the owner can see: the document scrolled sideways, or
 *  an element clipped by a non-scrolling box. Elements that own a scroll
 *  container (auto/scroll/hidden) are excluded because their overflow is the
 *  intended affordance, not a layout leak. */
async function measureOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const leaks: Overflow[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const overflowX = style.overflowX;
      if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") continue;
      const clientWidth = el.clientWidth;
      if (clientWidth === 0) continue;
      if (el.scrollWidth > clientWidth + 1) {
        leaks.push({
          tag: el.tagName.toLowerCase(),
          id: el.id,
          text: (el.textContent ?? "").trim().slice(0, 80),
          clientWidth,
          scrollWidth: el.scrollWidth,
          overflowX,
        });
      }
    }
    return {
      innerWidth: window.innerWidth,
      documentScrollWidth: doc.scrollWidth,
      leaks,
    };
  });
}

test.beforeEach(async ({ page }) => {
  // Passed as an argument: functions serialized by addInitScript run in the
  // page, so they cannot close over Node-side constants.
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

test("workbench fits every breakpoint and every mobile pane", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(join(OUT_DIR, "audit"), { recursive: true });

  const report: Array<{
    width: number;
    pane?: string;
    documentScrollWidth: number;
    leaks: Overflow[];
  }> = [];

  await page.goto("/#workbench");
  await expect(page.getByRole("heading", { name: "Workbench", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  // The workspace tree is the slowest first request; wait for its panel to
  // settle instead of networkidle (the terminal's SSE stream never idles).
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);

    const result = await measureOverflow(page);
    report.push({ width, ...result });

    await page.screenshot({
      path: join(SHOT_DIR, `workbench-${width}x900.png`),
      fullPage: false,
    });

    expect(
      result.documentScrollWidth,
      `document overflow at ${width}px`,
    ).toBeLessThanOrEqual(width + 1);
    expect(result.leaks, `clipped elements at ${width}px`).toEqual([]);

    // Below lg the four panes are tabs. Every pane must fit on its own.
    if (width < 1024) {
      for (const pane of PANES) {
        await page.getByRole("tab", { name: new RegExp(`^${pane}`, "i") }).click();
        await page.waitForTimeout(150);
        const paneResult = await measureOverflow(page);
        report.push({ width, pane, ...paneResult });
        expect(
          paneResult.leaks,
          `clipped elements in ${pane} pane at ${width}px`,
        ).toEqual([]);
      }
    }
  }

  writeFileSync(join(OUT_DIR, "audit", "responsive.json"), JSON.stringify(report, null, 2));
});
