/* Screenshot driver for the live API server.
 * The bearer token is read from the NERDBOT_TOKEN env of the running server
 * via the parent shell — it is never printed, logged, or written to disk.
 * Usage: NERDBOT_TOKEN=... node scripts/shot-live.mjs "#/" "#/work" ...
 * WIDTHS=1440,1024,... to set viewport widths. */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";

const token = process.env.NERDBOT_TOKEN ?? "";
if (!token) {
  console.error("no token provided");
  process.exit(1);
}

const routes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["/", "/work", "/bots", "/approvals", "/settings", "/projects"];

const widths = (process.env.WIDTHS ?? "1440").split(",").map(Number);
mkdirSync("out/shots-live", { recursive: true });

const browser = await chromium.launch();
for (const width of widths) {
  const context = await browser.newContext({
    viewport: { width, height: width < 800 ? 844 : 900 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript((t) => {
    localStorage.setItem(
      "nerdbot.session",
      JSON.stringify({ baseUrl: (process.env.NERDBOT_BASE ?? "http://127.0.0.1:8080"), token: t }),
    );
    localStorage.setItem("nerdbot.theme", "dark");
  }, token);
  const page = await context.newPage();
  for (const route of routes) {
    await page
      .goto(`http://127.0.0.1:5173/${route.replace(/^#/, "")}`, { waitUntil: "networkidle" })
      .catch(() => {});
    await page.waitForTimeout(900);
    const safe = route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
    await page.screenshot({
      path: `out/shots-live/${safe}-${width}.png`,
      fullPage: false,
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    console.log(`${width}px ${route} -> out/shots-live/${safe}-${width}.png (h-overflow ${overflow}px)`);
  }
}
await browser.close();
