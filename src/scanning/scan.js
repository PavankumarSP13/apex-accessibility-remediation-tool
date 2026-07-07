import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import pa11y from 'pa11y';
import chalk from 'chalk';
import ora from 'ora';
import { SCAN_SETTLE_MS } from '../core/config.js';
import { waitForStablePage, primeRuntimeUrl } from './browser.js';
import { resolveExtraUrls, NAV_WAIT_UNTIL, relaxTlsVerifyForUrl } from '../core/cli.js';
import { validatePa11yIssues } from './selector-validator.js';

export const LIGHTHOUSE_USER_DATA_DIR = path.join(os.tmpdir(), 'a11y-lighthouse-chrome');

export function failedLighthouseResult(reason) {
  return {
    score: null,
    failed: [],
    passed: [],
    rawAudits: {},
    pages: [],
    scanFailed: true,
    failReason: reason,
  };
}

export async function phase3a_axe(baseUrl) {
  const spinner = ora('Phase 3a · Axe-core DOM scan...').start();
  const urls    = resolveExtraUrls(baseUrl);
  let browser;
  const results = [];

  try {
    browser = await chromium.launch();
    for (const url of urls) {
      let ctx;
      try {
        ctx = await browser.newContext({ ignoreHTTPSErrors: relaxTlsVerifyForUrl(url) });
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: NAV_WAIT_UNTIL, timeout: 60_000 });
        await waitForStablePage(page, url);
        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
          .analyze();
        results.push({ url, violations: axe.violations, passes: axe.passes.length, inapplicable: axe.inapplicable.length });
      } finally {
        if (ctx) try { await ctx.close(); } catch {}
      }
    }

    const total = results.reduce((s, r) => s + r.violations.length, 0);
    spinner.succeed(`Axe-core: ${chalk.red(total + ' violations')} across ${urls.length} page(s)`);
    return results;
  } catch (err) {
    spinner.fail(`Axe-core scan failed: ${err.message}`);
    throw err;
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

export async function phase3b_lighthouse(baseUrl) {
  const spinner     = ora('Phase 3b · Lighthouse audit...').start();
  const urls = resolveExtraUrls(baseUrl);
  const pageResults = [];
  let chrome;
  let chromeFlagsKey = '';

  async function ensureChrome(insecureFlags, { forceRelaunch = false } = {}) {
    const nextFlagsKey = insecureFlags.join(' ');
    if (!forceRelaunch && chrome && chromeFlagsKey === nextFlagsKey) return chrome;
    if (chrome) {
      try { await chrome.kill(); } catch {}
      chrome = null;
      chromeFlagsKey = '';
    }
    await fs.mkdir(LIGHTHOUSE_USER_DATA_DIR, { recursive: true });
    chrome = await chromeLauncher.launch({
      chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu', ...insecureFlags],
      userDataDir: LIGHTHOUSE_USER_DATA_DIR,
    });
    chromeFlagsKey = nextFlagsKey;
    return chrome;
  }

  try {
    for (const url of urls) {
      const insecureFlags = relaxTlsVerifyForUrl(url)
        ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : [];

      await primeRuntimeUrl(url).catch(() => {});

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const runningChrome = await ensureChrome(insecureFlags, { forceRelaunch: attempt > 1 });
          const result = await lighthouse(url, {
            port: runningChrome.port, onlyCategories: ['accessibility'], output: 'json', logLevel: 'error',
          });
          const score  = Math.round((result.lhr.categories.accessibility.score ?? 0) * 100);
          const audits = Object.values(result.lhr.audits);
          const failed = audits.filter(a => a.score !== null && a.score < 1).map(a => ({ ...a, page: url, details: a.details || {} }));
          const passed = audits.filter(a => a.score === 1).map(a => ({ ...a, page: url }));
          pageResults.push({ url, score, failed, passed, rawAudits: result.lhr.audits });
          break;
        } catch (err) {
          if (chrome) {
            try { await chrome.kill(); } catch {}
            chrome = null;
            chromeFlagsKey = '';
          }
          if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
          throw err;
        }
      }
    }

    const score = Math.round(pageResults.reduce((sum, result) => sum + result.score, 0) / Math.max(1, pageResults.length));
    const failed = pageResults.flatMap(result => result.failed);
    const passed = pageResults.flatMap(result => result.passed);
    const rawAudits = Object.fromEntries(pageResults.map(result => [result.url, result.rawAudits]));
    spinner.succeed(`Lighthouse: ${chalk.yellow(score + '/100')} · ${chalk.red(failed.length + ' failed')} · ${chalk.green(passed.length + ' passed')} across ${urls.length} page(s)`);
    return { score, failed, passed, rawAudits, pages: pageResults.map(({ url, score }) => ({ url, score })) };
  } finally {
    if (chrome) try { await chrome.kill(); } catch {}
  }
}

export async function phase3e_pa11y(baseUrl) {
  const spinner = ora('Phase 3e · pa11y (HTML_CodeSniffer) scan...').start();
  const urls    = resolveExtraUrls(baseUrl);
  const allIssues = [];
  const failedUrls = [];

  for (const url of urls) {
    try {
      await primeRuntimeUrl(url).catch(() => {});
      const result = await pa11y(url, {
        standard: 'WCAG2AA', includeNotices: false, includeWarnings: true,
        timeout: 30_000, wait: Math.max(1_000, SCAN_SETTLE_MS),
        chromeLaunchConfig: {
          args: ['--no-sandbox', '--disable-gpu',
            ...(relaxTlsVerifyForUrl(url) ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : [])],
        },
      });
      allIssues.push(...result.issues.map(i => ({ ...i, page: url })));
    } catch (err) {
      const failReason = err.message || String(err);
      failedUrls.push({ url, failReason });
      spinner.warn(`pa11y skipped for ${url}: ${failReason}`);
    }
  }

  // ── ENH-01: Validate pa11y selectors against live page via Playwright ──
  if (allIssues.length > 0) {
    let validationBrowser;
    try {
      validationBrowser = await chromium.launch();
      // Group issues by page URL so we open each page only once
      const issuesByUrl = new Map();
      for (const issue of allIssues) {
        const url = issue.page;
        if (!issuesByUrl.has(url)) issuesByUrl.set(url, []);
        issuesByUrl.get(url).push(issue);
      }
      for (const [url, issues] of issuesByUrl) {
        let ctx;
        try {
          ctx = await validationBrowser.newContext({ ignoreHTTPSErrors: relaxTlsVerifyForUrl(url) });
          const page = await ctx.newPage();
          await page.goto(url, { waitUntil: NAV_WAIT_UNTIL, timeout: 60_000 });
          await validatePa11yIssues({ issues }, page);
        } catch (valErr) {
          // Non-fatal: leave issues unvalidated for this URL
          spinner.warn?.(`Selector validation skipped for ${url}: ${valErr.message}`);
        } finally {
          if (ctx) try { await ctx.close(); } catch {}
        }
      }
    } catch (valErr) {
      console.warn(`[pa11y] Selector validation failed, continuing with unvalidated results: ${valErr.message}`);
    } finally {
      if (validationBrowser) try { await validationBrowser.close(); } catch {}
    }
  }

  const errors   = allIssues.filter(i => i.type === 'error').length;
  const warnings = allIssues.filter(i => i.type === 'warning').length;
  const unavailableCount = failedUrls.length;
  const scannedCount = urls.length - unavailableCount;
  const failureMetadata = unavailableCount > 0
    ? { unavailableCount, scannedCount, unavailable: failedUrls }
    : {};

  if (urls.length > 0 && unavailableCount === urls.length) {
    const failReason = `pa11y failed for all ${urls.length} page(s): ${failedUrls.map(f => `${f.url} (${f.failReason})`).join('; ')}`;
    spinner.fail(`pa11y: scan failed for all ${urls.length} page(s)`);
    return { issues: allIssues, errorCount: errors, warningCount: warnings, scanFailed: true, failReason, ...failureMetadata };
  }

  spinner.succeed(`pa11y: ${chalk.red(errors + ' errors')} · ${chalk.yellow(warnings + ' warnings')} across ${urls.length} page(s)`);
  return { issues: allIssues, errorCount: errors, warningCount: warnings, ...(unavailableCount > 0 ? { partialScanFailed: true, ...failureMetadata } : {}) };
}

export async function phase3f_hiddenElements(page) {
  try {
    // Find aria-hidden elements that are keyboard-reachable
    const hiddenReachable = await page.evaluate(() => {
      function buildSel(el) {
        if (el.id) return '#' + el.id;
        let s = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = [...el.classList].filter(c => c.length > 2).slice(0, 3);
          if (cls.length) s += '.' + cls.join('.');
        }
        return s;
      }
      const results = [];
      document.querySelectorAll('[aria-hidden="true"]').forEach(el => {
        if (el.tabIndex >= 0 || el.querySelector('[tabindex]')) {
          results.push({
            html: el.outerHTML.slice(0, 300),
            selector: buildSel(el),
            reason: 'aria-hidden-but-focusable',
          });
        }
      });
      // Find collapsed expandable controls
      document.querySelectorAll('[aria-expanded="false"]').forEach(el => {
        const controlsId = el.getAttribute('aria-controls');
        if (!controlsId) return;
        const controlled = document.getElementById(controlsId);
        if (controlled && getComputedStyle(controlled).display === 'none') {
          results.push({
            html: el.outerHTML.slice(0, 300),
            selector: buildSel(el),
            controlsId,
            reason: 'collapsed-expandable',
          });
        }
      });
      return results;
    });
    return {
      issues: hiddenReachable.map(h => ({
        source: 'hidden-scan',
        ruleId: h.reason,
        description: h.reason === 'aria-hidden-but-focusable'
          ? 'Element is aria-hidden but keyboard-reachable (tabindex)'
          : 'Collapsed expandable control may contain accessibility issues when expanded',
        impact: 'serious',
        element: h.html,
        selector: h.selector,
        nodes: [{ html: h.html, target: h.selector }],
      })),
    };
  } catch (err) {
    return { issues: [], scanFailed: true, failReason: err.message };
  }
}
