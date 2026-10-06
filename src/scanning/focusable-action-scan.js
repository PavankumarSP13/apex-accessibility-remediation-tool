import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import chalk from 'chalk';
import { waitForStablePage } from './browser.js';
import { relaxTlsVerifyForUrl } from '../core/cli.js';

const MAX_TAB_PRESSES = 300;
const SETTLE_MS = 600;
const DIALOG_SETTLE_MS = 800;
const MAX_DIALOG_TAB = 50;

/**
 * ARIA APG key map — keys to press to activate each role/tag.
 * Ref: https://www.w3.org/WAI/ARIA/apg/patterns/
 *
 * Returns array of keys to try in order. First key that produces a DOM change wins.
 * Keys are ordered from "most likely to trigger the primary action" to fallbacks.
 *
 * Sources for each role:
 *   button       → apg/patterns/button/          Enter, Space
 *   link         → apg/patterns/link/             Enter
 *   checkbox     → apg/patterns/checkbox/         Space
 *   radio        → apg/patterns/radio/            Space (primary); ArrowDown/ArrowRight move within group
 *   switch       → apg/patterns/switch/           Space (Enter optional)
 *   tab          → apg/patterns/tabs/             Enter/Space to activate; ArrowRight/ArrowLeft to move
 *   menuitem     → apg/patterns/menubar/          Enter, Space
 *   menubutton   → apg/patterns/menu-button/      Enter, Space (opens menu); ArrowDown (optional, moves to first item)
 *   combobox     → apg/patterns/combobox/         ArrowDown moves into popup; Alt+ArrowDown shows without moving
 *   listbox      → apg/patterns/listbox/          ArrowDown/Up navigate; Space selects
 *   slider       → apg/patterns/slider/           ArrowRight/ArrowUp increase; ArrowLeft/ArrowDown decrease
 *   spinbutton   → apg/patterns/spinbutton/       ArrowUp increases; ArrowDown decreases
 *   treeitem     → apg/patterns/treeview/         Enter = default action; ArrowRight opens; ArrowDown moves
 *   treegrid     → apg/patterns/treegrid/         Enter opens/closes; ArrowDown navigates
 *   toolbar      → apg/patterns/toolbar/          ArrowRight/Left navigate within toolbar
 *   grid/gridcell→ apg/patterns/grid/             ArrowRight/Down navigate; Enter enters edit mode
 *   disclosure   → apg/patterns/disclosure/       Enter, Space (same as button)
 *   accordion    → apg/patterns/accordion/        Enter, Space (expand/collapse)
 */
function getActivationKeys(tag, role, inputType) {
  const r = (role || '').toLowerCase();
  const t = (tag || '').toLowerCase();
  const it = (inputType || '').toLowerCase();

  // Elements whose "action" is simply receiving focus — activating them does nothing extra.
  // These are skipped entirely (return null = don't flag as no-action).
  const SKIP_ROLES = new Set([
    'textbox', 'searchbox', 'scrollbar', 'separator', 'presentation', 'none',
    'status', 'log', 'marquee', 'timer',
    // Container/structural roles — navigation happens inside them via arrow keys,
    // but the container itself has no activation action:
    'alert', 'alertdialog', 'dialog', 'document', 'feed', 'figure',
    'group', 'img', 'list', 'listitem', 'math', 'note', 'region',
    'row', 'rowgroup', 'table', 'term', 'tooltip',
  ]);
  const SKIP_INPUTS = new Set([
    'text', 'email', 'password', 'search', 'url', 'number', 'tel',
    'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'file',
  ]);

  if (SKIP_ROLES.has(r)) return null;
  if (t === 'input' && SKIP_INPUTS.has(it)) return null;
  if (t === 'textarea') return null;

  // ── Role-first mapping (APG-authoritative) ───────────────────────────────

  // Button (apg/patterns/button): Enter activates, Space activates
  if (r === 'button') return ['Enter', 'Space'];

  // Link (apg/patterns/link): Enter follows the link
  if (r === 'link') return ['Enter'];

  // Checkbox (apg/patterns/checkbox): Space toggles state
  if (r === 'checkbox') return ['Space'];

  // Radio (apg/patterns/radio): Space checks focused button;
  // ArrowDown/ArrowRight move within the group (both check the new button)
  if (r === 'radio') return ['Space', 'ArrowDown', 'ArrowRight'];

  // Switch (apg/patterns/switch): Space changes state; Enter is optional
  if (r === 'switch') return ['Space', 'Enter'];

  // Tab widget (apg/patterns/tabs): Enter/Space activate a non-auto-activating tab;
  // ArrowRight moves to next tab (auto-activation mode)
  if (r === 'tab') return ['ArrowRight', 'Enter', 'Space'];

  // Menu items (apg/patterns/menubar): Enter/Space execute; ArrowRight opens submenu
  if (r === 'menuitem') return ['Enter', 'Space'];
  if (r === 'menuitemcheckbox') return ['Space', 'Enter'];
  if (r === 'menuitemradio') return ['Space', 'Enter'];

  // Option in listbox (apg/patterns/listbox): ArrowDown navigates; Space selects
  if (r === 'option') return ['Space', 'Enter'];

  // Combobox (apg/patterns/combobox): ArrowDown moves focus into popup (primary);
  // Alt+ArrowDown shows popup without moving focus; Enter accepts suggestion
  if (r === 'combobox') return ['ArrowDown', 'Alt+ArrowDown', 'Enter'];

  // Listbox (apg/patterns/listbox): ArrowDown navigates options
  if (r === 'listbox') return ['ArrowDown'];

  // Slider (apg/patterns/slider): ArrowRight/ArrowUp increase value
  if (r === 'slider') return ['ArrowRight', 'ArrowUp'];

  // Spinbutton (apg/patterns/spinbutton): ArrowUp increases, ArrowDown decreases
  if (r === 'spinbutton') return ['ArrowUp', 'ArrowDown'];

  // Treeitem (apg/patterns/treeview): Enter = default action; ArrowRight opens closed node
  if (r === 'treeitem') return ['Enter', 'ArrowRight'];

  // Tree container (apg/patterns/treeview): ArrowDown moves to first item
  if (r === 'tree') return ['ArrowDown'];

  // Treegrid (apg/patterns/treegrid): Enter opens/closes rows; ArrowDown navigates
  if (r === 'treegrid') return ['Enter', 'ArrowDown'];

  // Grid / gridcell (apg/patterns/grid): Enter enters edit mode on cell
  if (r === 'grid') return ['ArrowDown', 'ArrowRight'];
  if (r === 'gridcell') return ['Enter'];
  if (r === 'columnheader') return ['Enter'];
  if (r === 'rowheader') return ['Enter'];

  // Toolbar (apg/patterns/toolbar): ArrowRight navigates to next control
  if (r === 'toolbar') return ['ArrowRight'];

  // Menu container (apg/patterns/menubar): ArrowDown moves to first item
  if (r === 'menu') return ['ArrowDown'];

  // Menubar (apg/patterns/menubar): ArrowRight moves to next menu
  if (r === 'menubar') return ['ArrowRight'];

  // ── Tag-based fallbacks (for elements without explicit ARIA roles) ────────

  // Native <a> — Enter follows link (same as role=link)
  if (t === 'a') return ['Enter'];

  // Native <button> — Enter and Space (same as role=button)
  if (t === 'button') return ['Enter', 'Space'];

  // Native <select> — the browser provides Space/Enter/arrow handling, and its popup is
  // drawn outside the DOM, so pressing keys leaves no observable change. Skip it.
  if (t === 'select') return null;

  // Native checkboxes/radios
  if (t === 'input' && it === 'checkbox') return ['Space'];
  if (t === 'input' && it === 'radio') return ['Space', 'ArrowDown'];

  // Submit / reset buttons
  if (t === 'input' && it === 'submit') return ['Enter'];
  if (t === 'input' && it === 'button') return ['Enter', 'Space'];
  if (t === 'input' && it === 'reset') return ['Enter'];

  // <details>/<summary> — disclosure pattern (apg/patterns/disclosure): Enter, Space
  if (t === 'summary') return ['Enter', 'Space'];

  // Unknown interactive element — Enter is the safest default per ARIA spec
  return ['Enter'];
}

/**
 * Inject a MutationObserver into the page that records any DOM additions.
 */
async function injectMutationObserver(page) {
  await page.evaluate(() => {
    if (window.__fa11yObs) window.__fa11yObs.disconnect();
    window.__fa11yMutations = [];
    window.__fa11yObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            window.__fa11yMutations.push({
              tag: node.tagName,
              id: node.id || null,
              role: node.getAttribute?.('role') || null,
              ariaModal: node.getAttribute?.('aria-modal') || null,
              className: node.className || '',
              childCount: node.children?.length ?? 0,
              depth: (() => {
                let d = 0, p = node.parentElement;
                while (p && p !== document.body) { d++; p = p.parentElement; }
                return d;
              })(),
            });
          }
        }
        // Track attribute changes on existing elements (e.g., hidden → visible)
        if (m.type === 'attributes' && m.target?.nodeType === 1) {
          const el = m.target;
          window.__fa11yMutations.push({
            tag: el.tagName,
            id: el.id || null,
            role: el.getAttribute?.('role') || null,
            ariaModal: el.getAttribute?.('aria-modal') || null,
            className: el.className || '',
            childCount: el.children?.length ?? 0,
            depth: (() => {
              let d = 0, p = el.parentElement;
              while (p && p !== document.body) { d++; p = p.parentElement; }
              return d;
            })(),
            isAttrChange: true,
          });
        }
      }
    });
    window.__fa11yObs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded', 'aria-modal'] });
  });
}

async function collectMutations(page) {
  return page.evaluate(() => {
    if (window.__fa11yObs) window.__fa11yObs.disconnect();
    const items = window.__fa11yMutations || [];
    delete window.__fa11yMutations;
    delete window.__fa11yObs;
    return items;
  });
}

/**
 * Arm a per-element probe: a window flag that disappears if the page reloads, and a
 * flag set by any form submit/invalid event. Submitting a form that posts back to the
 * same URL reloads the page without changing location.href or the DOM shape.
 */
async function armActivationProbe(page) {
  await page.evaluate(() => {
    window.__fa11yAlive = true;
    window.__fa11yFormEvent = false;
    if (!window.__fa11yFormListeners) {
      window.__fa11yFormListeners = true;
      const mark = () => { window.__fa11yFormEvent = true; };
      document.addEventListener('submit', mark, true);
      document.addEventListener('invalid', mark, true);
    }
  }).catch(() => {});
}

async function readActivationProbe(page) {
  return page.evaluate(() => ({ alive: window.__fa11yAlive === true, formEvent: window.__fa11yFormEvent === true }))
    .catch(() => ({ alive: false, formEvent: false })); // context destroyed mid-navigation
}

/**
 * After a reload or goBack, focus starts at the top of the page again; without this the
 * next Tab revisits earlier elements and the cycle detector ends the scan early.
 */
async function restoreFocusAfterReload(page, elementDomPath) {
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate((p) => {
    let node = document.body;
    for (const i of String(p).split('>')) {
      node = node?.children[Number(i)];
      if (!node) return;
    }
    node.focus();
  }, elementDomPath).catch(() => {});
}

/**
 * Detect if a dialog/modal is now open in the page.
 * Returns { found: boolean, selector: string|null }
 */
export async function detectOpenDialog(page) {
  return page.evaluate(() => {
    // 1. role=dialog or role=alertdialog that is visible
    for (const el of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) {
      const style = getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        return { found: true, selector: el.id ? `#${el.id}` : '[role="dialog"]' };
      }
    }
    // 2. aria-modal=true visible
    for (const el of document.querySelectorAll('[aria-modal="true"]')) {
      const style = getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        return { found: true, selector: el.id ? `#${el.id}` : '[aria-modal="true"]' };
      }
    }
    // 3. Common modal class patterns visible
    const modalSelectors = ['.modal.show', '.modal.is-open', '.modal.active', '.dialog.is-open', '.dialog.active', '[class*="modal"][class*="open"]', '[class*="dialog"][class*="open"]', '[class*="overlay"][class*="open"]', '[class*="overlay"][class*="active"]'];
    for (const sel of modalSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const style = getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
            return { found: true, selector: sel };
          }
        }
      } catch { /* invalid selector */ }
    }
    return { found: false, selector: null };
  });
}

/**
 * Run axe inside a dialog/modal and return violations.
 */
async function scanDialogForIssues(page, dialogSelector, scanUrl) {
  try {
    const result = await new AxeBuilder({ page })
      .include(dialogSelector)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const issues = [];
    for (const violation of result.violations) {
      for (const node of violation.nodes || []) {
        issues.push({
          ruleId: violation.id,
          source: 'focusable-action',
          impact: violation.impact,
          description: violation.help,
          helpUrl: violation.helpUrl,
          nodes: [{ html: node.html, target: node.target?.join(', ') ?? '', fix: node.failureSummary }],
          element: node.html,
          page: scanUrl,
          context: 'dialog',
          dialogSelector,
        });
      }
    }
    return issues;
  } catch {
    return [];
  }
}


/**
 * Audit a dialog/modal for three distinct accessibility issues:
 *
 *  1. dialog-focus-not-moved   — focus did NOT land inside the dialog when it opened
 *  2. dialog-element-unreachable — one or more focusable elements cannot be reached by Tab
 *  3. dialog-focus-order-wrong — Tab order does not follow the visual/DOM order
 *
 * Returns an array of issue objects ready to push into the issues list.
 */
async function auditDialog(page, dialogSelector, scanUrl, triggerSelector, screenshotPath) {
  const issues = [];

  // ── 1. Was focus moved inside the dialog when it opened? ─────────────────
  const focusState = await page.evaluate((sel) => {
    const container = document.querySelector(sel);
    if (!container) return { containerFound: false };
    const active = document.activeElement;
    const insideDialog = container.contains(active) && active !== container;
    return {
      containerFound: true,
      insideDialog,
      activeHtml: active ? active.outerHTML.slice(0, 150) : '',
      activeIsBody: !active || active === document.body,
    };
  }, dialogSelector);

  if (!focusState.containerFound) return issues;

  if (!focusState.insideDialog) {
    issues.push({
      ruleId: 'dialog-focus-not-moved',
      source: 'focusable-action',
      impact: 'critical',
      description: 'Dialog opened but focus was not moved inside it. Screen reader and keyboard users remain stranded outside the dialog.',
      nodes: [{ html: focusState.activeHtml || '<body>', target: dialogSelector, fix: 'When a dialog opens, call .focus() on the first interactive element inside it, or set the dialog container\'s tabindex="-1" and focus it.' }],
      element: focusState.activeHtml || '<body>',
      page: scanUrl,
      triggerSelector,
      dialogSelector,
      screenshotPath,
      context: 'dialog',
    });
    // Force focus into the dialog so checks 2 & 3 can still run accurately
    await page.evaluate((sel) => {
      const container = document.querySelector(sel);
      if (!container) return;
      const first = container.querySelector(
        'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (first) first.focus();
      else if (container.tabIndex >= 0 || container.getAttribute('tabindex') !== null) container.focus();
    }, dialogSelector);
  }

  // ── 2 & 3. Tab-trace the dialog ──────────────────────────────────────────
  // Collect all focusable elements in DOM order (this IS the expected order).
  const expectedOrder = await page.evaluate((sel) => {
    function domPath(element) {
      const parts = [];
      let node = element;
      while (node && node !== document.body) {
        const parent = node.parentElement;
        if (!parent) break;
        parts.unshift([...parent.children].indexOf(node));
        node = parent;
      }
      return parts.join('>');
    }
    const container = document.querySelector(sel);
    if (!container) return [];
    const candidates = container.querySelectorAll(
      'button:not([disabled]), a[href], ' +
      'input:not([disabled]):not([type="hidden"]), ' +
      'select:not([disabled]), textarea:not([disabled]), ' +
      '[tabindex]:not([tabindex="-1"])'
    );
    const results = [];
    for (const el of candidates) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      results.push({
        domPath: domPath(el),
        html: el.outerHTML.slice(0, 150),
        tag: el.tagName.toLowerCase(),
      });
    }
    return results;
  }, dialogSelector);

  if (expectedOrder.length === 0) return issues;

  // Tab through and record the actual order focus lands in
  const actualOrder = [];
  const visitedPaths = new Set();

  // The first focused element (we set it above) counts as step 0
  const firstPath = await page.evaluate(() => {
    function domPath(element) {
      const parts = [];
      let node = element;
      while (node && node !== document.body) {
        const parent = node.parentElement;
        if (!parent) break;
        parts.unshift([...parent.children].indexOf(node));
        node = parent;
      }
      return parts.join('>');
    }
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return domPath(el);
  });
  if (firstPath) { actualOrder.push(firstPath); visitedPaths.add(firstPath); }

  for (let i = 0; i < Math.min(MAX_DIALOG_TAB, expectedOrder.length * 2 + 5); i++) {
    await page.keyboard.press('Tab');
    const path = await page.evaluate(() => {
      function domPath(element) {
        const parts = [];
        let node = element;
        while (node && node !== document.body) {
          const parent = node.parentElement;
          if (!parent) break;
          parts.unshift([...parent.children].indexOf(node));
          node = parent;
        }
        return parts.join('>');
      }
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return domPath(el);
    });
    if (!path) break;
    if (visitedPaths.has(path)) break; // wrapped around
    actualOrder.push(path);
    visitedPaths.add(path);
  }

  // Check 2: unreachable elements
  const expectedPaths = new Set(expectedOrder.map(e => e.domPath));
  const unreachable = expectedOrder.filter(e => !visitedPaths.has(e.domPath));
  for (const el of unreachable) {
    issues.push({
      ruleId: 'dialog-element-unreachable',
      source: 'focusable-action',
      impact: 'serious',
      description: `Focusable <${el.tag}> inside the dialog cannot be reached by pressing Tab.`,
      nodes: [{ html: el.html, target: el.domPath, fix: 'Ensure the element is not removed from tab order (tabindex="-1"), hidden, or made inert.' }],
      element: el.html,
      page: scanUrl,
      triggerSelector,
      dialogSelector,
      screenshotPath,
      context: 'dialog',
    });
  }

  // Check 3: tab order matches DOM order
  // Only compare elements that were actually reached by Tab AND are in the expected list
  const actualInExpected = actualOrder.filter(p => expectedPaths.has(p));
  const expectedInActual = expectedOrder.map(e => e.domPath).filter(p => visitedPaths.has(p));

  // Find first position where the two sequences diverge
  let firstMismatch = -1;
  for (let i = 0; i < Math.min(actualInExpected.length, expectedInActual.length); i++) {
    if (actualInExpected[i] !== expectedInActual[i]) { firstMismatch = i; break; }
  }

  if (firstMismatch !== -1) {
    const actualEl = expectedOrder.find(e => e.domPath === actualInExpected[firstMismatch]);
    const expectedEl = expectedOrder.find(e => e.domPath === expectedInActual[firstMismatch]);
    issues.push({
      ruleId: 'dialog-focus-order-wrong',
      source: 'focusable-action',
      impact: 'moderate',
      description: `Tab order inside the dialog does not follow the visual/DOM order. At step ${firstMismatch + 1}, focus lands on <${actualEl?.tag || '?'}> but the DOM order suggests <${expectedEl?.tag || '?'}> should come next.`,
      nodes: [{ html: actualEl?.html || '', target: actualEl?.domPath || '', fix: 'Remove positive tabindex values. Tab order should follow DOM order naturally.' }],
      element: actualEl?.html || '',
      page: scanUrl,
      triggerSelector,
      dialogSelector,
      screenshotPath,
      context: 'dialog',
    });
  }

  return issues;
}

/**
 * Sanitize a selector string to be safe as part of a filename.
 */
function selectorToFilename(sel) {
  return (sel || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

/**
 * Phase 3g: Focusable Action Scan
 *
 * - Takes a baseline screenshot before any interaction
 * - Tabs through every focusable element one by one
 * - Activates each with the APG-correct key(s)
 * - Flags elements that do nothing when activated
 * - Screenshots any opened dialog/modal, scans it for accessibility issues,
 *   checks its internal keyboard navigability
 *
 * @param {string} scanUrl
 * @param {string} outputDir - run output dir (logger.dir or opts.output)
 * @returns {{ issues: Array, screenshots: string[], scannedCount: number, scanFailed?: boolean }}
 */
export async function phase3g_focusableAction(scanUrl, outputDir) {
  console.log(chalk.dim('  Running focusable-action scan (Phase 3g)...'));
  let browser;
  try {
    // Ensure screenshots dir exists
    const screenshotsDir = path.join(outputDir, 'screenshots');
    await fs.mkdir(screenshotsDir, { recursive: true });

    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: relaxTlsVerifyForUrl(scanUrl) });
    const page = await ctx.newPage();
    await page.goto(scanUrl, { waitUntil: 'load', timeout: 30000 });
    await waitForStablePage(page, scanUrl);

    // ── Baseline screenshot ──────────────────────────────────────────
    const ts = Date.now();
    const hostname = (() => { try { return new URL(scanUrl).hostname.replace(/[^a-z0-9]/gi, '_'); } catch { return 'page'; } })();
    const baselinePath = path.join(screenshotsDir, `baseline_${hostname}_${ts}.png`);
    await page.screenshot({ path: baselinePath, fullPage: true });
    console.log(chalk.dim(`  Phase 3g: baseline screenshot → ${path.basename(baselinePath)}`));

    const issues = [];
    const screenshots = [baselinePath];
    let scannedCount = 0;
    let noActionCount = 0;
    let dialogCount = 0;

    // ── Reset focus and start tabbing ───────────────────────────────
    await page.evaluate(() => document.body.focus());

    const visitedSelectors = new Set();
    let cycleCount = 0;

    for (let i = 0; i < MAX_TAB_PRESSES; i++) {
      await page.keyboard.press('Tab');

      // Capture a live ElementHandle pointing at document.activeElement right now.
      // This is a direct reference to the exact DOM node — no selector, no coordinates.
      // Clicking it later will always hit the right element regardless of viewport
      // size, zoom level, or how many other elements share the same CSS selector.
      const activeHandle = await page.evaluateHandle(() => document.activeElement);

      const elInfo = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;

        function buildSelector(element) {
          if (element.id) return `#${element.id}`;
          let sel = element.tagName.toLowerCase();
          if (element.className && typeof element.className === 'string') {
            sel += '.' + [...element.classList].filter(c => c.length > 2).slice(0, 2).join('.');
          }
          return sel;
        }

        // DOM path fingerprint: the sequence of child-index values from <body> down
        // to this element.  Two distinct DOM nodes always have different paths even
        // when they share the same tag, classes, text, and screen position (e.g.
        // identical pencil-edit buttons stacked in different card rows).
        // This is purely structural — viewport size, resolution, and zoom have no
        // effect on it, making it completely generic across any website.
        function domPath(element) {
          const parts = [];
          let node = element;
          while (node && node !== document.body) {
            const parent = node.parentElement;
            if (!parent) break;
            parts.unshift([...parent.children].indexOf(node));
            node = parent;
          }
          return parts.join('>');
        }

        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          inputType: el.getAttribute('type') || '',
          selector: buildSelector(el),
          domPath: domPath(el),   // unique structural identity — used for cycle detection
          html: el.outerHTML.slice(0, 200),
          isCheckbox: el.type === 'checkbox',
          isRadio: el.type === 'radio',
          checkedBefore: el.type === 'checkbox' || el.type === 'radio' ? el.checked : null,
          valueBefore: el.value ?? null,
          urlBefore: location.href,
          elementCountBefore: document.querySelectorAll('*').length,
        };
      });

      if (!elInfo) {
        if (visitedSelectors.size > 0) break;
        continue;
      }

      // Cycle detection: use DOM path (child-index sequence from body to element)
      // as the unique identity.  Each DOM node has exactly one path, so this
      // correctly distinguishes every element on the page regardless of whether
      // they share a selector, text, aria-label, or screen position.
      // When Tab wraps around, the first element's path is seen again → stop.
      if (visitedSelectors.has(elInfo.domPath)) {
        cycleCount++;
        if (cycleCount >= 3) break;
        continue;
      }
      visitedSelectors.add(elInfo.domPath);
      cycleCount = 0;

      // Determine which keys to press
      const keys = getActivationKeys(elInfo.tag, elInfo.role, elInfo.inputType);
      if (keys === null) continue; // text input or non-interactive role — skip

      scannedCount++;

      // Snapshot state before activation
      const urlBefore = elInfo.urlBefore;

      // Inject MutationObserver and the reload / form-submit probe
      await injectMutationObserver(page);
      await armActivationProbe(page);

      // Try each key in order — stop at first one that produces a change
      let activated = false;
      let navigated = false;
      for (const key of keys) {
        await page.keyboard.press(key);
        await page.waitForTimeout(SETTLE_MS);

        // Form submitted (or blocked by validation), or the page reloaded in place.
        const probe = await readActivationProbe(page);
        if (!probe.alive) {
          await restoreFocusAfterReload(page, elInfo.domPath);
          activated = true;
          break;
        }
        if (probe.formEvent) {
          activated = true;
          break;
        }

        const afterState = await page.evaluate(() => ({
          url: location.href,
          elementCount: document.querySelectorAll('*').length,
        })).catch(() => ({ url: urlBefore, elementCount: elInfo.elementCountBefore }));

        navigated = afterState.url !== urlBefore;

        if (navigated) {
          // Navigated away — go back
          await page.goBack({ waitUntil: 'load', timeout: 10000 }).catch(async () => {
            await page.goto(scanUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
          });
          await restoreFocusAfterReload(page, elInfo.domPath);
          activated = true;
          break;
        }

        // Check for checkbox/radio toggle. Read state from the focused node itself:
        // a selector such as "input" would match a different (e.g. hidden) input first.
        if (elInfo.isCheckbox || elInfo.isRadio) {
          const nowChecked = await activeHandle.evaluate(el => el.checked).catch(() => null);
          if (nowChecked !== null && nowChecked !== elInfo.checkedBefore) {
            activated = true;
            // Restore original state
            await page.keyboard.press(key);
            await page.waitForTimeout(200);
            break;
          }
        }

        const mutations = await collectMutations(page);
        const elementCountChanged = afterState.elementCount !== elInfo.elementCountBefore;

        if (mutations.length > 0 || elementCountChanged) {
          activated = true;

          // Check if a dialog opened
          const dialogState = await detectOpenDialog(page);
          if (dialogState.found) {
            dialogCount++;
            const screenshotFilename = `dialog_${selectorToFilename(elInfo.selector)}_${Date.now()}.png`;
            const dialogScreenshotPath = path.join(screenshotsDir, screenshotFilename);
            await page.screenshot({ path: dialogScreenshotPath, fullPage: false });
            screenshots.push(dialogScreenshotPath);
            console.log(chalk.dim(`    Phase 3g: dialog opened by ${elInfo.selector} → screenshot ${screenshotFilename}`));

            // Axe scan + all three dialog keyboard checks (focus placement,
            // element reachability, tab order) — all emitted as distinct issues.
            const dialogIssues = await scanDialogForIssues(page, dialogState.selector, scanUrl);
            for (const issue of dialogIssues) {
              issue.triggerSelector = elInfo.selector;
              issue.screenshotPath = dialogScreenshotPath;
              issues.push(issue);
            }
            const dialogKeyboardIssues = await auditDialog(page, dialogState.selector, scanUrl, elInfo.selector, dialogScreenshotPath);
            issues.push(...dialogKeyboardIssues);

            // Close the dialog
            await page.keyboard.press('Escape');
            await page.waitForTimeout(DIALOG_SETTLE_MS);

            // If still open, try clicking outside
            const stillOpen = await detectOpenDialog(page);
            if (stillOpen.found) {
              await page.mouse.click(10, 10).catch(() => {});
              await page.waitForTimeout(SETTLE_MS);
            }
          }

          break; // mutation observed — no need to try next key
        }

        // Re-inject observer for next key attempt
        await injectMutationObserver(page);
      }

      // A form submit can reload the page a moment after the submit event fired.
      if (activated && !(await readActivationProbe(page)).alive) {
        await restoreFocusAfterReload(page, elInfo.domPath);
      }

      // Cleanup observer if not already collected
      await page.evaluate(() => {
        if (window.__fa11yObs) window.__fa11yObs.disconnect();
        delete window.__fa11yObs;
        delete window.__fa11yMutations;
      }).catch(() => {});

      // ── Click fallback: even if keyboard failed, try a click to reveal any
      // dialog/modal the element opens so we can screenshot and scan it.
      // We still flag focusable-no-action because keyboard activation is broken.
      // We use activeHandle — the live DOM reference captured right after Tab —
      // so we always click the exact focused element, not the first element
      // matching a CSS selector (which may be completely different on any site).
      if (!activated && !navigated) {
        let clickWorked = false;
        try {
          const urlBefore2 = await page.evaluate(() => location.href);
          await injectMutationObserver(page);
          await armActivationProbe(page);
          await activeHandle.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(SETTLE_MS);

          const clickProbe = await readActivationProbe(page);
          const urlAfter2 = await page.evaluate(() => location.href).catch(() => urlBefore2);
          if (!clickProbe.alive || clickProbe.formEvent || urlAfter2 !== urlBefore2) {
            clickWorked = true;
            if (urlAfter2 !== urlBefore2) {
              // Click navigated — go back, skip dialog scan
              await page.goBack({ waitUntil: 'load', timeout: 10000 }).catch(async () => {
                await page.goto(scanUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
              });
            }
            if (!(await readActivationProbe(page)).alive) await restoreFocusAfterReload(page, elInfo.domPath);
          } else {
            const clickMutations = await collectMutations(page);
            const clickElementCount = await page.evaluate(() => document.querySelectorAll('*').length);
            if (clickMutations.length > 0 || clickElementCount !== elInfo.elementCountBefore) {
              clickWorked = true;
              const dialogState = await detectOpenDialog(page);
              if (dialogState.found) {
                dialogCount++;
                const screenshotFilename = `dialog_${selectorToFilename(elInfo.selector)}_${Date.now()}.png`;
                const dialogScreenshotPath = path.join(screenshotsDir, screenshotFilename);
                await page.screenshot({ path: dialogScreenshotPath, fullPage: false });
                screenshots.push(dialogScreenshotPath);
                console.log(chalk.dim(`    Phase 3g: dialog opened by click fallback on ${elInfo.selector} → screenshot ${screenshotFilename}`));

                const dialogIssues = await scanDialogForIssues(page, dialogState.selector, scanUrl);
                for (const issue of dialogIssues) {
                  issue.triggerSelector = elInfo.selector;
                  issue.screenshotPath = dialogScreenshotPath;
                  issue.activatedBy = 'click-fallback';
                  issues.push(issue);
                }
                const dialogKeyboardIssues = await auditDialog(page, dialogState.selector, scanUrl, elInfo.selector, dialogScreenshotPath);
                for (const issue of dialogKeyboardIssues) {
                  issue.activatedBy = 'click-fallback';
                  issues.push(issue);
                }

                await page.keyboard.press('Escape');
                await page.waitForTimeout(DIALOG_SETTLE_MS);
                const stillOpen = await detectOpenDialog(page);
                if (stillOpen.found) {
                  await page.mouse.click(10, 10).catch(() => {});
                  await page.waitForTimeout(SETTLE_MS);
                }
              }
            }
          }
        } catch {
          // Click fallback failed — best effort, continue
        } finally {
          await page.evaluate(() => {
            if (window.__fa11yObs) window.__fa11yObs.disconnect();
            delete window.__fa11yObs;
            delete window.__fa11yMutations;
          }).catch(() => {});
        }

        // Always flag the keyboard-activation failure; the wording says whether a mouse click helped.
        noActionCount++;
        issues.push({
          ruleId: 'focusable-no-action',
          source: 'focusable-action',
          impact: 'serious',
          description: clickWorked
            ? `Focusable element does nothing when activated with keyboard (tried: ${keys.join(', ')}). Only responds to mouse click.`
            : `Focusable element does nothing when activated with keyboard (tried: ${keys.join(', ')}) or mouse click. Give it an action, or remove it from the Tab order if it is not interactive.`,
          nodes: [{ html: elInfo.html, target: elInfo.selector }],
          element: elInfo.html,
          page: scanUrl,
          keysAttempted: keys,
        });
      }

      // Ensure any open state is closed before next element
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);

      // Release the ElementHandle so the JS engine can GC the backing DOM reference
      await activeHandle.dispose().catch(() => {});
    }

    await browser.close();

    console.log(chalk.dim(`  Phase 3g: ${scannedCount} element(s) checked, ${noActionCount} no-action, ${dialogCount} dialog(s) opened, ${issues.length} issue(s)`));

    return { issues, screenshots, scannedCount, scanFailed: false };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.log(chalk.yellow(`  ⚠ Focusable-action scan failed: ${err.message}`));
    return { issues: [], screenshots: [], scannedCount: 0, scanFailed: true, failReason: err.message };
  }
}
