import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const routes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["#/", "#/work", "#/bots", "#/approvals", "#/settings", "#/projects"];

const widths = (process.env.WIDTHS ?? "1440").split(",").map(Number);
mkdirSync("out/shots", { recursive: true });

const browser = await chromium.launch();
for (const width of widths) {
  const context = await browser.newContext({
    viewport: { width, height: width < 800 ? 844 : 900 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    localStorage.setItem(
      "nerdbot.session",
      JSON.stringify({ baseUrl: "http://127.0.0.1:8080", token: "dev-token-change-me" }),
    );
    localStorage.setItem("nerdbot.theme", "dark");
  });
  const page = await context.newPage();
  for (const route of routes) {
    await page.goto(`http://127.0.0.1:5173/${route}`, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(900);
    const safe = route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
    await page.screenshot({ path: `out/shots/${safe}-${width}.png`, fullPage: false });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    console.log(`${width}px ${route} -> out/shots/${safe}-${width}.png (h-overflow ${overflow}px)`);
  }
  await context.close();
}
await browser.close();
