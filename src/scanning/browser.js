import http from 'http';
import https from 'https';
import { chromium } from 'playwright';
import chalk from 'chalk';
import { SCAN_SETTLE_MS, SCAN_STABILITY_POLLS, SCAN_STABILITY_INTERVAL_MS, SCAN_STABILITY_TIMEOUT_MS } from '../core/config.js';
import { NAV_WAIT_UNTIL, relaxTlsVerifyForUrl } from '../core/cli.js';

export async function waitForStablePage(page, pageUrl, options = SCAN_STABILITY_TIMEOUT_MS) {
  const config = typeof options === 'number'
    ? { timeoutMs: options }
    : { timeoutMs: SCAN_STABILITY_TIMEOUT_MS, ...options };
  const {
    timeoutMs = SCAN_STABILITY_TIMEOUT_MS,
    requireSelector = null,
    failOnTimeout = false,
  } = config;
  const start = Date.now();
  try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 10000) }); } catch {}
  try { await page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 10000) }); } catch {}
  try { await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10000) }); } catch {}

  let stableCount = 0;
  let lastSignature = null;
  while ((Date.now() - start) < timeoutMs) {
    const signature = await page.evaluate(() => {
      const body = document.body;
      const text = body?.innerText?.replace(/\s+/g, ' ').trim() ?? '';
      return JSON.stringify({
        readyState: document.readyState,
        title: document.title,
        childCount: body?.querySelectorAll('*').length ?? 0,
        textLength: text.length,
        hashProbe: text.slice(0, 200),
        ariaBusyCount: document.querySelectorAll('[aria-busy="true"]').length,
      });
    });

    if (signature === lastSignature) stableCount++;
    else stableCount = 1;
    lastSignature = signature;

    if (stableCount >= SCAN_STABILITY_POLLS) {
      if (requireSelector) {
        const found = await page.$(requireSelector).catch(() => null);
        if (!found) {
          stableCount = 0;
          await page.waitForTimeout(SCAN_STABILITY_INTERVAL_MS);
          continue;
        }
      }
      if (SCAN_SETTLE_MS > 0) await page.waitForTimeout(SCAN_SETTLE_MS);
      return true;
    }
    await page.waitForTimeout(SCAN_STABILITY_INTERVAL_MS);
  }

  const message = `Stability wait timed out for ${pageUrl}`;
  if (failOnTimeout) throw new Error(message);
  console.log(chalk.dim(`  ${message}; continuing with current DOM state.`));
  return false;
}

export async function installNoCacheRoute(context) {
  await context.route('**/*', async route => {
    const headers = {
      ...route.request().headers(),
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    };
    await route.continue({ headers });
  });
}

export async function warmUpRuntimePage(page, url, timeoutMs = 60_000) {
  await page.goto(url, { waitUntil: NAV_WAIT_UNTIL, timeout: timeoutMs });
  await waitForStablePage(page, url, { timeoutMs: Math.min(timeoutMs, SCAN_STABILITY_TIMEOUT_MS), failOnTimeout: false });
}

export async function hardReloadWithCacheBust(page, url, {
  timeoutMs = 60_000,
  requireSelector = 'body',
  failOnTimeout = true,
} = {}) {
  await page.setExtraHTTPHeaders({
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.reload({ waitUntil: NAV_WAIT_UNTIL, timeout: timeoutMs });
  return waitForStablePage(page, url, { timeoutMs, requireSelector, failOnTimeout });
}

export async function primeRuntimeUrl(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: relaxTlsVerifyForUrl(url) });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: NAV_WAIT_UNTIL, timeout: 60_000 });
    await waitForStablePage(page, url);
    await ctx.close();
  } finally {
    await browser.close().catch(() => {});
  }
}


export async function waitForServerReady(url, maxAttempts = 8, intervalMs = 2500) {
  const parsedUrl = new URL(url);
  const isHttps   = parsedUrl.protocol === 'https:';
  const requester = isHttps ? https : http;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const status = await new Promise((resolve, reject) => {
        const req = requester.request({
          hostname: parsedUrl.hostname, port: parsedUrl.port || (isHttps ? 443 : 80),
          path: `${parsedUrl.pathname}${parsedUrl.search}`, method: 'GET', timeout: 5000, rejectUnauthorized: false,
        }, res => resolve(res.statusCode));
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      if (status >= 200 && status < 500) return true;
    } catch { /* retry */ }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, intervalMs));
  }
  console.log(chalk.yellow('  ⚠ Server readiness check failed'));
  return false;
}

export async function validatePageNotBlank(url, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const ctx  = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await waitForStablePage(page, url, 8000).catch(() => {});
      if (!resp || resp.status() >= 500) { await browser.close(); if (attempt < retries) { await new Promise(r => setTimeout(r, 2000)); continue; } return false; }
      const body = await page.evaluate(() => {
        const b = document.body;
        if (!b) return { text: '', childCount: 0, visible: false };
        return { text: (b.innerText || '').trim(), childCount: b.querySelectorAll('*').length, visible: b.getBoundingClientRect().height > 0 };
      });
      await browser.close();
      if ((body.text.length < 10 && body.childCount < 5) || !body.visible) {
        if (attempt < retries) { await new Promise(r => setTimeout(r, 2000)); continue; } return false;
      }
      return true;
    } catch {
      if (browser) await browser.close().catch(() => {});
      if (attempt < retries) { await new Promise(r => setTimeout(r, 2000)); continue; }
      return false;
    }
  }
  return false;
}
