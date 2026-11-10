import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:8080';
const TOKEN = 'dev-token-change-me';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = [];
  const log = (name, ok, detail='') => { results.push({name, ok, detail}); console.log(`${ok?'PASS':'FAIL'} ${name}${detail?': '+detail:''}`); };

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const tokenInput = page.locator('input[type="password"]');
    if (await tokenInput.count()) {
      await tokenInput.first().fill(TOKEN);
      await page.getByRole('button', { name: /connect/i }).click();
      await page.waitForTimeout(2000);
    }
    log('load/connect', true);

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const chatVisible = await page.locator('text=Chat').first().isVisible().catch(()=>false) || await page.locator('text=NerdBot').first().isVisible().catch(()=>false);
    log('chat/home loads', chatVisible);

    await page.goto(BASE + '/library', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const libTitle = await page.getByRole('heading', { name: /library/i }).first().isVisible().catch(()=>false);
    log('library page loads (Phase 4)', libTitle);

    await page.goto(BASE + '/gallery', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const galTitle = await page.getByRole('heading', { name: /gallery/i }).first().isVisible().catch(()=>false);
    log('gallery page loads (Phase 4)', galTitle);

    await page.goto(BASE + '/activity', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const actTitle = await page.getByRole('heading', { name: /activity/i }).first().isVisible().catch(()=>false);
    log('activity page loads', actTitle);
    const jobsHeading = await page.getByRole('heading', { name: /jobs/i }).first().isVisible().catch(()=>false);
    log('jobs section visible (Phase 5)', jobsHeading);

    // Basic Phase 5 thread UI presence: go to chat/home and look for conversation UI elements
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const hasNewChat = await page.getByRole('button', { name: /new chat/i }).first().isVisible().catch(()=>false);
    log('chat new conversation control visible', hasNewChat);

  } catch (e) {
    log('browser verification error', false, String(e));
  } finally {
    await browser.close();
  }
  const failed = results.filter(r=>!r.ok);
  console.log('---');
  console.log(JSON.stringify(results, null, 2));
  process.exit(failed.length?1:0);
}
main();
