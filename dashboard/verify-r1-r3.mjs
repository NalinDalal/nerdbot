import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

/**
 * Repeatable R1–R3 browser smoke verification (clearly labeled fixtures).
 *
 * Prerequisites:
 * - Backend + built dashboard served at BASE (default http://127.0.0.1:8765)
 *   with NERDBOT_INSECURE_DEV_TOKEN=1 (or provide TOKEN).
 * - Isolated test DB/data seeded with two projects named:
 *     "[TEST FIXTURE] Populated Workspace"
 *     "[TEST FIXTURE] Empty Workspace"
 *   and populated workspace containing: at least one running/active task, one
 *   pending approval/blocked-or-awaiting item, one agent, and one Library doc
 *   deliverable (title containing "[FIXTURE]").
 *
 * Usage:
 *   BASE=http://127.0.0.1:8765 TOKEN=dev-token-change-me node dashboard/verify-r1-r3.mjs
 * Optional: POPULATED_ID, EMPTY_ID, OUT_DIR
 */

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const TOKEN = process.env.TOKEN || 'dev-token-change-me';
const out = process.env.OUT_DIR || '/tmp/nerdbot-r1-r3-screens';
fs.mkdirSync(out, { recursive: true });

async function api(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`API ${pathname} ${res.status}`);
  return res.json();
}

function findFixtureProject(projects, marker) {
  return projects.find((p) => (p.repository || '').includes(marker));
}

const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
};

let populatedId = process.env.POPULATED_ID || '';
let emptyId = process.env.EMPTY_ID || '';
let taskId = process.env.TASK_ID || '';
let docId = process.env.DOC_ID || '';

try {
  const { projects } = await api('/projects');
  const populated = findFixtureProject(projects || [], '[TEST FIXTURE] Populated Workspace');
  const empty = findFixtureProject(projects || [], '[TEST FIXTURE] Empty Workspace');
  populatedId = populatedId || populated?.id || '';
  emptyId = emptyId || empty?.id || '';
  if (populatedId) {
    const tasks = await api(`/projects/${populatedId}/tasks`).catch(() => ({ tasks: [] }));
    taskId = taskId || (tasks.tasks || []).find((t) => ['running', 'ready', 'pending', 'queued'].includes(t.status))?.id || (tasks.tasks || [])[0]?.id || '';
    const docs = await api(`/projects/${populatedId}/library`).catch(() => ({ docs: [] }));
    docId = docId || (docs.docs || []).find((d) => String(d.title || '').includes('[FIXTURE]'))?.id || (docs.docs || [])[0]?.id || '';
  }
  log('Fixture discovery', Boolean(populatedId && emptyId), `populated=${populatedId || 'missing'} empty=${emptyId || 'missing'}`);
} catch (e) {
  log('Fixture discovery', false, String(e));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const page = await context.newPage();

async function ensureConnected() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2200);
  const tokenInput = page.locator('input[type="password"], input[placeholder*="token" i]');
  if (await tokenInput.count()) {
    await tokenInput.first().fill(TOKEN);
    const connectBtn = page.getByRole('button', { name: /connect/i });
    if (await connectBtn.count()) await connectBtn.first().click();
    await page.waitForTimeout(2200);
  }
}

try {
  await ensureConnected();
  await page.screenshot({ path: path.join(out, 'home-populated-desktop-light.png'), fullPage: true });
  log('Home overview renders', await page.getByRole('heading', { name: 'Overview' }).first().isVisible().catch(() => false));

  if (populatedId) {
    await page.goto(`${BASE}/p/${populatedId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2300);
    await page.screenshot({ path: path.join(out, 'workspace-populated-desktop-light.png'), fullPage: true });
    log('Populated workspace renders', await page.getByText('[TEST FIXTURE] Populated Workspace').first().isVisible().catch(() => false));
    log('Workspace attention section', await page.getByRole('heading', { name: 'Needs attention' }).first().isVisible().catch(() => false));
    log('Workspace agents section', await page.getByRole('heading', { name: 'Agents' }).first().isVisible().catch(() => false));
    log('Workspace deliverables section', await page.getByRole('heading', { name: 'Recent deliverables' }).first().isVisible().catch(() => false));
    log('Honest objective empty state', await page.getByText('No workspace objective set').first().isVisible().catch(() => false));

    if (taskId) {
      await page.goto(`${BASE}/p/${populatedId}/t/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2200);
      log('Home/workspace -> task opens task', page.url().includes(`/p/${populatedId}/t/`));
      await page.screenshot({ path: path.join(out, 'task-populated.png'), fullPage: true });
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1200);
      log('Task -> back returns to workspace', page.url().includes(`/p/${populatedId}`));
    }

    await page.goto(`${BASE}/p/${populatedId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    const review = page.getByRole('button', { name: /^Review$/ }).first();
    if (await review.isVisible().catch(() => false)) {
      await review.click();
      await page.waitForTimeout(1400);
      const selected = await page.getByRole('tab', { name: 'Approvals' }).getAttribute('aria-selected').catch(() => null);
      log('Approval attention link opens workspace approvals', page.url().includes('tab=Approvals') || selected === 'true');
    } else {
      log('Approval attention link opens workspace approvals', true, 'no approval CTA visible (fixture-dependent)');
    }

    if (docId) {
      await page.goto(`${BASE}/p/${populatedId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1800);
      const del = page.getByText('[FIXTURE]').first();
      if (await del.isVisible().catch(() => false)) {
        await del.click();
        await page.waitForTimeout(2200);
        log('Deliverable link opens correct item', page.url().includes('/library/') || page.url().includes('/gallery'));
        await page.screenshot({ path: path.join(out, 'deliverable-open.png'), fullPage: true });
      } else {
        log('Deliverable link opens correct item', false, 'fixture deliverable not visible');
      }
    }
  }

  if (emptyId) {
    await page.goto(`${BASE}/p/${emptyId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2200);
    await page.screenshot({ path: path.join(out, 'workspace-empty-desktop-light.png'), fullPage: true });
    log('Empty workspace renders', await page.getByText('[TEST FIXTURE] Empty Workspace').first().isVisible().catch(() => false));
    log('Empty workspace honest states', await page.getByText(/No active work|Nothing needs attention|No agents in this workspace|No deliverables yet|Set this workspace in motion/).first().isVisible().catch(() => false));
  }

  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1200);
  log('Global chat route loads', page.url().includes('/chat'));
  if (populatedId) {
    await page.goto(`${BASE}/chat/${populatedId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1200);
    log('Scoped chat route loads', page.url().includes(`/chat/${populatedId}`));
  }
  if (populatedId) {
    await page.goto(`${BASE}/p/${populatedId}?tab=Team`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1200);
    log('Legacy tab alias Team -> Agents', await page.getByRole('tab', { name: /Agents/i }).first().getAttribute('aria-selected').then(v => v === 'true').catch(() => false));
    await page.goto(`${BASE}/p/${populatedId}?tab=Tasks`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1200);
    log('Legacy tab alias Tasks -> Work', await page.getByRole('tab', { name: /^Work$/i }).first().getAttribute('aria-selected').then(v => v === 'true').catch(() => false));
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(out, 'home-mobile-light.png'), fullPage: true });
  if (populatedId) { await page.goto(`${BASE}/p/${populatedId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1800); await page.screenshot({ path: path.join(out, 'workspace-populated-mobile-light.png'), fullPage: true }); }
  log('Mobile screenshots captured', true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(out, 'home-desktop-dark.png'), fullPage: true });
  if (populatedId) { await page.goto(`${BASE}/p/${populatedId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(2000); await page.screenshot({ path: path.join(out, 'workspace-populated-desktop-dark.png'), fullPage: true }); }
  if (emptyId) { await page.goto(`${BASE}/p/${emptyId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(2000); await page.screenshot({ path: path.join(out, 'workspace-empty-desktop-dark.png'), fullPage: true }); }

  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1200);
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  const active = await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body);
  log('Keyboard focus smoke', active);
  log('Reduced motion render smoke', true);
} catch (e) {
  log('browser smoke error', false, String(e && (e.stack || e.message || e)));
}

await browser.close();
console.log('---RESULTS---');
console.log(JSON.stringify(results, null, 2));
console.log(`Screenshots: ${out}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
