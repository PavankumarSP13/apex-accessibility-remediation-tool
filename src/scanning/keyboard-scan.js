import { chromium } from 'playwright';
import chalk from 'chalk';
import { waitForStablePage } from './browser.js';
import { relaxTlsVerifyForUrl } from '../core/cli.js';
import { logger } from '../core/logger.js';

const MAX_TAB_PRESSES = 300;
const KEYBOARD_TRAP_THRESHOLD = 3;

export async function phase3c_keyboard(scanUrl) {
  console.log(chalk.dim('  Running keyboard/focus scan...'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: relaxTlsVerifyForUrl(scanUrl) });
    const page = await ctx.newPage();
    await page.goto(scanUrl, { waitUntil: 'load', timeout: 30000 });
    await waitForStablePage(page, scanUrl);

    const issues = [];

    // Detect skip link
    const hasSkipLink = await detectSkipLink(page);
    if (!hasSkipLink) {
      issues.push({
        source: 'keyboard',
        page: scanUrl,
        ruleId: 'skip-link-missing',
        impact: 'serious',
        description: 'Page does not have a skip navigation link reachable in the first 3 tab stops.',
        nodes: [{ html: '<body>', target: 'body' }],
        element: '<body>',
      });
    }

    // Tab through page and collect focus data
    const focusTrace = await traceFocusOrder(page);

    // Detect keyboard traps
    const traps = detectKeyboardTraps(focusTrace);
    for (const trap of traps) {
      issues.push({
        source: 'keyboard',
        page: scanUrl,
        ruleId: 'keyboard-trap',
        impact: 'critical',
        description: `Keyboard trap detected: focus is stuck on element and cannot move forward with Tab.`,
        nodes: [{ html: trap.html, target: trap.selector }],
        element: trap.html,
      });
    }

    // Detect missing focus indicators
    const missingFocus = await detectMissingFocusIndicators(page, focusTrace);
    for (const item of missingFocus) {
      issues.push({
        source: 'keyboard',
        page: scanUrl,
        ruleId: 'focus-not-visible',
        impact: 'serious',
        description: 'Interactive element does not have a visible focus indicator.',
        nodes: [{ html: item.html, target: item.selector }],
        element: item.html,
      });
    }

    // Detect unreachable interactive elements
    const unreachable = await detectUnreachableElements(page, focusTrace);
    for (const item of unreachable) {
      issues.push({
        source: 'keyboard',
        page: scanUrl,
        ruleId: 'interactive-not-reachable',
        impact: 'serious',
        description: 'Interactive element is not reachable via keyboard Tab navigation.',
        nodes: [{ html: item.html, target: item.selector }],
        element: item.html,
      });
    }

    // Detect focusable interactive elements with no accessible name
    const missingNames = detectMissingAccessibleNames(focusTrace);
    for (const item of missingNames) {
      issues.push({
        source: 'keyboard',
        page: scanUrl,
        ruleId: 'focusable-no-accessible-name',
        impact: 'serious',
        description: `Focusable <${item.tag}> element has no accessible name — screen readers cannot identify its purpose.`,
        nodes: [{ html: item.html, target: item.selector }],
        element: item.html,
      });
    }

    await browser.close();

    const counts = { traps: traps.length, missingFocus: missingFocus.length, unreachable: unreachable.length, skipLink: hasSkipLink ? 0 : 1 };
    console.log(chalk.dim(`  Keyboard scan: ${issues.length} issue(s) found (traps: ${counts.traps}, focus: ${counts.missingFocus}, unreachable: ${counts.unreachable})`));
    logger.log(`Keyboard scan: ${issues.length} issue(s) — ${JSON.stringify(counts)}`);

    return { issues, focusTrace, scanFailed: false };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.log(chalk.yellow(`  ⚠ Keyboard scan failed: ${err.message}`));
    logger.warn(`Keyboard scan failed: ${err.message}`);
    return { issues: [], scanFailed: true, failReason: err.message };
  }
}

async function detectSkipLink(page) {
  // Press Tab up to 3 times, check if any focused element is a skip link
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab');
    const isSkipLink = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return false;
      const href = el.getAttribute('href') || '';
      const text = (el.textContent || '').toLowerCase();
      return (href.startsWith('#') && (text.includes('skip') || text.includes('main content') || text.includes('navigation')))
        || el.classList.contains('skip-link') || el.classList.contains('skip-nav');
    });
    if (isSkipLink) return true;
  }
  return false;
}

async function traceFocusOrder(page) {
  // Reset focus to body
  await page.evaluate(() => document.body.focus());
  const trace = [];
  const startTime = Date.now();
  const TRACE_TIMEOUT_MS = 30000; // 30 second hard cap

  for (let i = 0; i < MAX_TAB_PRESSES; i++) {
    if (Date.now() - startTime > TRACE_TIMEOUT_MS) break; // timeout
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const rect = el.getBoundingClientRect();

      // Resolve aria-labelledby to actual text
      let labelledByText = '';
      const labelledById = el.getAttribute('aria-labelledby');
      if (labelledById) {
        labelledByText = labelledById.split(/\s+/)
          .map(id => document.getElementById(id)?.textContent?.trim() || '')
          .filter(Boolean)
          .join(' ')
          .slice(0, 60);
      }

      const accessibleName = el.getAttribute('aria-label') || labelledByText || el.title
        || el.getAttribute('alt') || (el.textContent || '').trim().slice(0, 60) || '';
      const accessibleNameSource = el.getAttribute('aria-label') ? 'aria-label'
        : labelledByText ? 'aria-labelledby'
        : el.title ? 'title'
        : el.getAttribute('alt') ? 'alt'
        : (el.textContent || '').trim() ? 'contents'
        : 'none';

      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        accessibleName,
        accessibleNameSource,
        selector: buildSelector(el),
        html: el.outerHTML.slice(0, 200),
        visible: rect.width > 0 && rect.height > 0,
        x: rect.x,
        y: rect.y,
      };

      function buildSelector(element) {
        if (element.id) return `#${element.id}`;
        let sel = element.tagName.toLowerCase();
        if (element.className && typeof element.className === 'string') {
          sel += '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.');
        }
        return sel;
      }
    });

    if (!info) {
      if (trace.length > 0) break;
      continue;
    }

    trace.push(info);

    // Cycle detection: use selector + accessibleName + rounded position so that
    // multiple different elements with the same weak selector (e.g. all "<div>"
    // or all "button.foo") don't trigger a false early-exit.
    const posKey = `${Math.round(info.x / 5) * 5},${Math.round(info.y / 5) * 5}`;
    const cycleKey = `${info.selector}|${info.accessibleName}|${posKey}`;
    const firstKey = `${trace[0].selector}|${trace[0].accessibleName}|${Math.round(trace[0].x / 5) * 5},${Math.round(trace[0].y / 5) * 5}`;
    if (trace.length > 3 && cycleKey === firstKey) break;
  }

  return trace;
}

function detectKeyboardTraps(focusTrace) {
  const traps = [];
  const seen = new Map();

  for (const item of focusTrace) {
    // Use selector + accessible name + rounded position as identity so that
    // multiple different elements sharing the same weak CSS selector (e.g. all
    // "div" or all "button.foo") are not mistakenly counted as the same element.
    const identity = `${item.selector}|${item.accessibleName}|${Math.round(item.x / 5) * 5},${Math.round(item.y / 5) * 5}`;
    const count = (seen.get(identity) || 0) + 1;
    seen.set(identity, count);
    if (count >= KEYBOARD_TRAP_THRESHOLD) {
      traps.push(item);
    }
  }

  return traps;
}

async function detectMissingFocusIndicators(page, focusTrace) {
  const checked = new Set();
  const missing = [];

  await page.evaluate(() => document.body.focus());

  for (const item of focusTrace) {
    if (checked.has(item.selector)) continue;
    checked.add(item.selector);

    const hasFocusStyle = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return true;
      el.focus();
      const focused = getComputedStyle(el);
      const outline = focused.outline;
      const boxShadow = focused.boxShadow;
      const borderColor = focused.borderColor;
      el.blur();
      const unfocused = getComputedStyle(el);
      return outline !== unfocused.outline
        || boxShadow !== unfocused.boxShadow
        || borderColor !== unfocused.borderColor
        || outline !== 'none' && outline !== '0px none rgb(0, 0, 0)';
    }, item.selector).catch(() => true);

    if (!hasFocusStyle) {
      missing.push(item);
    }
  }

  return missing;
}

async function detectUnreachableElements(page, focusTrace) {
  const reachedSelectors = new Set(focusTrace.map(t => t.selector));

  const interactiveElements = await page.evaluate(() => {
    // Include ARIA-role interactive elements and onclick divs/spans that have no tabindex
    // (these are keyboard-inaccessible by design flaw — they should be flagged)
    const elements = document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, ' +
      '[tabindex]:not([tabindex="-1"]), ' +
      '[role="button"], [role="link"], [role="menuitem"], [role="checkbox"], ' +
      '[role="radio"], [role="tab"], [role="option"], [role="switch"]'
    );
    const results = [];
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      let selector;
      if (el.id) selector = `#${el.id}`;
      else {
        selector = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          selector += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
        }
      }

      // Record whether the element is natively focusable or only via ARIA role
      const nativelyFocusable = ['button', 'a', 'input', 'select', 'textarea'].includes(el.tagName.toLowerCase())
        || el.tabIndex >= 0;

      results.push({
        selector,
        html: el.outerHTML.slice(0, 200),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        nativelyFocusable,
        missingTabindex: !nativelyFocusable,
      });
    }
    return results;
  });

  return interactiveElements
    .filter(el => !reachedSelectors.has(el.selector))
    .slice(0, 30);
}

function detectMissingAccessibleNames(focusTrace) {
  // Interactive elements (not plain text containers) with no accessible name
  const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'checkbox', 'radio', 'tab', 'switch', 'option', 'combobox', 'listbox', 'treeitem']);

  return focusTrace.filter(item => {
    if (item.accessibleNameSource !== 'none') return false;
    const tag = (item.tag || '').toLowerCase();
    const role = (item.role || '').toLowerCase();
    const isInteractive = INTERACTIVE_TAGS.has(tag) || INTERACTIVE_ROLES.has(role);
    // Skip plain divs/spans that are focusable containers — only flag truly interactive ones
    return isInteractive;
  });
}
