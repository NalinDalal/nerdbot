/* Find every element that visually overflows its clipping card at narrow
 * widths. Not a screenshot: measures geometry so fixes target real numbers.
 * Usage: NERDBOT_TOKEN=... node scripts/overflow.mjs "#/bots" ... */
import { chromium } from "@playwright/test";

const token = process.env.NERDBOT_TOKEN ?? "";
if (!token) {
  console.error("no token provided");
  process.exit(1);
}
const routes = process.argv.slice(2);
const width = Number(process.env.W ?? 390);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width, height: 844 },
});
await context.addInitScript((t) => {
  localStorage.setItem(
    "nerdbot.session",
    JSON.stringify({ baseUrl: "http://127.0.0.1:8080", token: t }),
  );
}, token);
const page = await context.newPage();
for (const route of routes) {
  await page
    .goto(`http://127.0.0.1:5173/${route}`, { waitUntil: "networkidle" })
    .catch(() => {});
  await page.waitForTimeout(700);
  const problems = await page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      // Visually clipped mid-content: element extends past the viewport but
      // an ancestor already clips it (otherwise scrollWidth would grow).
      const right = rect.right;
      if (right > vw + 1) {
        const style = getComputedStyle(el);
        const text = (el.textContent ?? "").trim().slice(0, 60);
        out.push(
          `${el.tagName.toLowerCase()}.${(el.className + "").split(" ").slice(0, 4).join(".")}` +
            ` right=${Math.round(right)} vw=${vw} text="${text}"`,
        );
      }
    }
    return out.slice(0, 12);
  });
  console.log(`${route} @${width}px`);
  console.log(problems.length ? problems.join("\n") : "  clean");
}
await browser.close();
