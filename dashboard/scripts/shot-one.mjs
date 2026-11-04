import { chromium } from "@playwright/test";

const targets = process.argv.slice(2);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem(
    "nerdbot.session",
    JSON.stringify({ baseUrl: "http://127.0.0.1:8080", token: "dev-token-change-me" }),
  );
  localStorage.setItem("nerdbot.theme", "dark");
});
const page = await context.newPage();
for (const target of targets) {
  const [route, name, full] = target.split("|");
  await page.goto(`http://127.0.0.1:5173/${route.replace(/^#/, "")}`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: `out/shots/${name}.png`,
    fullPage: full === "full",
  });
  console.log(name, await page.title());
}
await browser.close();
