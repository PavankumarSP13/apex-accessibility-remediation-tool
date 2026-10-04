import { chromium } from 'playwright';
import chalk from 'chalk';
import { waitForStablePage } from './browser.js';
import { detectOpenDialog } from './focusable-action-scan.js';
import { relaxTlsVerifyForUrl } from '../core/cli.js';
import { logger } from '../core/logger.js';

const SOURCE = 'dropdown-keyboard';
const SETTLE_MS = 400;
const RELOAD_STABILITY_MS = 8000;
const MAX_TAB_STOPS = 200;
const MAX_DIALOG_TAB_STOPS = 60;
const MAX_DROPDOWNS_PER_SCOPE = 15;
const MAX_RADIO_GROUPS_PER_SCOPE = 10;
const MAX_DIALOG_TRIGGER_TRIES = 20;
const MAX_DIALOGS = 5;
const MAX_ORDER_ISSUES_PER_SCOPE = 10;

// Generic dialog discovery presses buttons, so never press ones that could change data.
const UNSAFE_TRIGGER_TEXT = /\b(delete|remove|log ?out|sign ?out|submit|pay|purchase|buy|checkout|confirm|unsubscribe)\b/i;

const APG_HELP = {
  dropdown: 'https://www.w3.org/WAI/ARIA/apg/patterns/listbox/',
  combobox: 'https://www.w3.org/WAI/ARIA/apg/patterns/combobox/',
  menuButton: 'https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/',
  radio: 'https://www.w3.org/WAI/ARIA/apg/patterns/radio/',
  focusOrder: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html',
};

/**
 * Helpers injected into every document (survives reloads) so each page.evaluate
 * can identify elements by DOM path — the child-index sequence from <body>.
 */
function installHelpers() {
  if (window.__ddk) return;
  const domPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      parts.unshift([...parent.children].indexOf(node));
      node = parent;
    }
    return parts.join('>');
  };
  const resolve = (path) => {
    if (path === null || path === undefined) return null;
    if (path === '') return document.body;
    let node = document.body;
    for (const i of String(path).split('>')) {
      node = node?.children[Number(i)];
      if (!node) return null;
    }
    return node;
  };
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const selector = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    let sel = el.tagName.toLowerCase();
    const cls = [...el.classList].filter(c => c.length > 2).slice(0, 2);
    if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.');
    return sel;
  };
  const describe = (el) => ({
    path: domPath(el),
    selector: selector(el),
    html: el.outerHTML.slice(0, 200),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
  });
  const isFixed = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  };
  window.__ddk = { domPath, resolve, isVisible, selector, describe, isFixed };
}

// ── Small page utilities ───────────────────────────────────────────────────

async function focusPath(page, path) {
  return page.evaluate((p) => {
    const el = window.__ddk.resolve(p);
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  }, path).catch(() => false);
}

async function activePath(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return window.__ddk.domPath(el);
  }).catch(() => null);
}

async function elementAt(page, path) {
  const handle = await page.evaluateHandle((p) => window.__ddk.resolve(p), path).catch(() => null);
  const element = handle?.asElement() || null;
  if (!element && handle) await handle.dispose().catch(() => {});
  return element;
}

async function press(page, key) {
  await page.keyboard.press(key);
  await page.waitForTimeout(SETTLE_MS);
}

async function scopeIntact(scope) {
  if (scope.page.url() !== scope.baseUrl) return false;
  if (scope.containerPath === null) return true;
  return scope.page.evaluate((p) => window.__ddk.isVisible(window.__ddk.resolve(p)), scope.containerPath).catch(() => false);
}

function makeIssue(scope, ruleId, impact, description, el, fix, helpUrl, extra = {}) {
  const where = scope.context === 'dialog' ? `Inside a dialog (opened by ${scope.triggerSelector}): ` : '';
  return {
    source: SOURCE,
    ruleId,
    impact,
    description: where + description,
    helpUrl,
    nodes: [{ html: el.html, target: el.selector, fix }],
    element: el.html,
    page: scope.scanUrl,
    context: scope.context,
    dialogSelector: scope.dialogSelector || null,
    triggerSelector: scope.triggerSelector || null,
    ...extra,
  };
}

// ── Tab walk + focus order (meaningful sequence) ───────────────────────────

/**
 * Press Tab through the scope and record every stop with its page-coordinate box.
 * `complete` is false when the walk hit the stop cap, so "not reached" is unproven.
 */
async function walkTabOrder(scope) {
  const { page, containerPath } = scope;
  const maxStops = containerPath === null ? MAX_TAB_STOPS : MAX_DIALOG_TAB_STOPS;
  const stops = [];
  const seen = new Set();

  const readActive = () => page.evaluate((cPath) => {
    const { resolve, describe, isFixed } = window.__ddk;
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const container = cPath === null ? null : resolve(cPath);
    const rect = el.getBoundingClientRect();
    return {
      ...describe(el),
      inside: container ? container.contains(el) : true,
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      w: rect.width,
      h: rect.height,
      visible: rect.width > 0 && rect.height > 0,
      fixed: isFixed(el),
    };
  }, containerPath).catch(() => null);

  if (containerPath === null) {
    await page.evaluate(() => {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    }).catch(() => {});
  } else {
    // Start inside the dialog: wherever it placed focus, or its first focusable element.
    const first = await readActive();
    if (first?.inside) {
      stops.push(first);
      seen.add(first.path);
    } else {
      await page.evaluate((cPath) => {
        const container = window.__ddk.resolve(cPath);
        const target = container?.querySelector(
          'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), ' +
          'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        target?.focus();
      }, containerPath).catch(() => {});
      const forced = await readActive();
      if (forced?.inside) {
        stops.push(forced);
        seen.add(forced.path);
      }
    }
  }

  let emptyPresses = 0;
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    const info = await readActive();
    if (!info) {
      if (stops.length > 0 || ++emptyPresses > 3) return { stops, complete: true };
      continue;
    }
    if (!info.inside) return { stops, complete: true };   // focus left the dialog
    if (seen.has(info.path)) return { stops, complete: true }; // wrapped around
    seen.add(info.path);
    stops.push(info);
  }
  return { stops, complete: false };
}

function overlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/**
 * Compare consecutive Tab stops against visual reading order (top-to-bottom,
 * left-to-right). Only stops sharing a row or a column are comparable, so a
 * move between unrelated layout columns is never reported.
 */
function detectFocusOrderIssues(scope, stops) {
  const boxes = stops.filter(s => s.visible && !s.fixed);
  const sameRow = (a, b) => overlap(a.y, a.y + a.h, b.y, b.y + b.h) >= 0.5 * Math.min(a.h, b.h);
  const sameCol = (a, b) => overlap(a.x, a.x + a.w, b.x, b.x + b.w) >= 0.5 * Math.min(a.w, b.w);
  const cx = s => s.x + s.w / 2;
  const cy = s => s.y + s.h / 2;
  // true: a is visually before b · false: after · null: not comparable
  const precedes = (a, b) => {
    if (sameRow(a, b)) {
      if (Math.abs(cx(a) - cx(b)) < 2) return null;
      return cx(a) < cx(b);
    }
    if (sameCol(a, b)) return cy(a) < cy(b);
    return null;
  };
  const between = (a, c, b) => precedes(a, c) === true && precedes(c, b) === true
    && ((sameRow(a, b) && sameRow(a, c) && sameRow(c, b)) || (sameCol(a, b) && sameCol(a, c) && sameCol(c, b)));

  const flagged = new Map();
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i];
    const b = boxes[i + 1];
    if (precedes(a, b) === true) {
      for (let k = i + 2; k < boxes.length; k++) {
        const c = boxes[k];
        if (!flagged.has(c.path) && between(a, c, b)) {
          flagged.set(c.path, { ruleId: 'focus-order-skipped', stop: c, from: a, to: b });
        }
      }
    }
    if (precedes(b, a) === true && !flagged.has(b.path)) {
      flagged.set(b.path, { ruleId: 'focus-order-not-visual', stop: b, from: a });
    }
  }

  return [...flagged.values()].slice(0, MAX_ORDER_ISSUES_PER_SCOPE).map(f => (f.ruleId === 'focus-order-skipped'
    ? makeIssue(scope, f.ruleId, 'serious',
      `Focus order skips ${f.stop.selector}: Tab moves from ${f.from.selector} straight to ${f.to.selector} and only reaches this element later, although it sits visually between them.`,
      f.stop,
      'Make DOM order match visual order and remove positive tabindex values so Tab visits elements top-to-bottom, left-to-right.',
      APG_HELP.focusOrder)
    : makeIssue(scope, f.ruleId, 'serious',
      `Focus jumps backwards: after ${f.from.selector}, Tab moves to ${f.stop.selector}, which appears before it visually (above it or to its left).`,
      f.stop,
      'Reorder the DOM (or remove positive tabindex / CSS reordering such as flex order) so focus follows the visual reading order.',
      APG_HELP.focusOrder)));
}

// ── Dropdown discovery and popup state ─────────────────────────────────────

async function findDropdowns(scope) {
  return scope.page.evaluate((cPath) => {
    const { resolve, describe, isVisible } = window.__ddk;
    const root = cPath === null ? document.body : resolve(cPath);
    if (!root) return [];
    const SELECTOR = 'select, [role="combobox"], [aria-haspopup]:not([aria-haspopup="false"]):not([aria-haspopup="dialog"]), '
      + '[aria-expanded][aria-controls], .dropdown-toggle, [data-toggle="dropdown"], [data-bs-toggle="dropdown"]';
    const EXPLICIT = 'select, [role="combobox"], [aria-haspopup]:not([aria-haspopup="false"]), .dropdown-toggle, [data-toggle="dropdown"], [data-bs-toggle="dropdown"]';
    const out = [];
    const seen = new Set();
    for (const found of root.querySelectorAll(SELECTOR)) {
      // ARIA 1.0 comboboxes put the role on a wrapper; the focusable part is inside.
      let el = found;
      if (el.tabIndex < 0) {
        const inner = el.querySelector('input, button, [tabindex]:not([tabindex="-1"])');
        if (inner) el = inner;
      }
      if (!isVisible(el)) continue;
      const ids = (found.getAttribute('aria-controls') || found.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
      const controlled = ids.map(id => document.getElementById(id)).filter(Boolean);
      if (controlled.some(c => c.matches('[role="dialog"], [role="alertdialog"], dialog'))) continue;
      // aria-expanded + aria-controls alone also matches accordions; keep only list-like popups.
      if (!found.matches(EXPLICIT) && !controlled.some(c => c.matches('[role="listbox"], [role="menu"], [role="tree"], [role="grid"], ul, ol')
        || c.querySelector('[role="option"], [role="menuitem"]'))) continue;
      const info = describe(el);
      if (seen.has(info.path)) continue;
      seen.add(info.path);
      const tag = el.tagName.toLowerCase();
      out.push({ ...info, native: tag === 'select', editable: tag === 'input' || tag === 'textarea' || el.isContentEditable });
    }
    return out;
  }, scope.containerPath).catch(() => []);
}

const POPUP_SELECTOR = '[role="listbox"], [role="menu"], [role="tree"], [role="grid"], .dropdown-menu, .dropdown-content, ul, ol';

async function visiblePopupPaths(page) {
  return page.evaluate((sel) => {
    const { domPath, isVisible } = window.__ddk;
    return [...document.querySelectorAll(sel)].filter(isVisible).map(domPath);
  }, POPUP_SELECTOR).catch(() => []);
}

/** Find the popup the trigger opened: its aria-controls target, a newly visible list nearby, or a portal listbox/menu. */
async function findOpenPopup(page, triggerPath, visibleBefore) {
  return page.evaluate(({ tPath, before, sel }) => {
    const { resolve, domPath, isVisible } = window.__ddk;
    const trigger = resolve(tPath);
    if (!trigger) return null;
    const wasHidden = (c) => !before.includes(domPath(c));
    const ids = (trigger.getAttribute('aria-controls') || trigger.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const c = document.getElementById(id);
      if (c && isVisible(c)) return { popupPath: domPath(c) };
    }
    let ancestor = trigger.parentElement;
    for (let level = 0; ancestor && level < 3; level++, ancestor = ancestor.parentElement) {
      for (const c of ancestor.querySelectorAll(sel)) {
        if (c === trigger || c.contains(trigger)) continue;
        if (isVisible(c) && wasHidden(c)) return { popupPath: domPath(c) };
      }
    }
    for (const c of document.querySelectorAll('[role="listbox"], [role="menu"], [role="tree"], [role="grid"]')) {
      if (isVisible(c) && wasHidden(c)) return { popupPath: domPath(c) };
    }
    // No visible popup found, only the attribute claims it is open.
    if (trigger.getAttribute('aria-expanded') === 'true') return { popupPath: null, expandedOnly: true };
    return null;
  }, { tPath: triggerPath, before: visibleBefore, sel: POPUP_SELECTOR }).catch(() => null);
}

async function getItems(page, popupPath, triggerPath) {
  return page.evaluate(({ pPath, tPath }) => {
    const { resolve, describe, isVisible } = window.__ddk;
    let root = pPath ? resolve(pPath) : null;
    if (!root) {
      const trigger = resolve(tPath);
      const adId = trigger?.getAttribute('aria-activedescendant');
      root = adId ? document.getElementById(adId)?.closest('[role="listbox"], [role="menu"], [role="tree"], [role="grid"]') : null;
    }
    if (!root) return [];
    let items = [...root.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"]')].filter(isVisible);
    if (items.length === 0) {
      items = [...root.querySelectorAll('a[href], button, [tabindex], li')].filter(isVisible);
      items = items.filter(item => !items.some(other => other !== item && item.contains(other)));
    }
    return items.map(item => ({
      ...describe(item),
      text: (item.textContent || '').trim(),
      tabbable: item.tabIndex >= 0 && !item.disabled,
    }));
  }, { pPath: popupPath, tPath: triggerPath }).catch(() => []);
}

/** Which item is active — by DOM focus or by aria-activedescendant. -1 when none. */
async function activeItemIndex(page, itemPaths, triggerPath) {
  return page.evaluate(({ paths, tPath }) => {
    const { resolve } = window.__ddk;
    const indexOf = (el) => {
      if (!el) return -1;
      for (let i = 0; i < paths.length; i++) {
        const item = resolve(paths[i]);
        if (item && (item === el || item.contains(el))) return i;
      }
      return -1;
    };
    const active = document.activeElement;
    const byFocus = indexOf(active);
    if (byFocus >= 0) return { index: byFocus, via: 'focus' };
    const adId = active?.getAttribute?.('aria-activedescendant') || resolve(tPath)?.getAttribute('aria-activedescendant');
    const byDescendant = adId ? indexOf(document.getElementById(adId)) : -1;
    if (byDescendant >= 0) return { index: byDescendant, via: 'aria-activedescendant' };
    return { index: -1, via: null };
  }, { paths: itemPaths, tPath: triggerPath }).catch(() => ({ index: -1, via: null }));
}

/** Focus the trigger, press one key, and report whether a popup opened. */
async function tryOpen(scope, dd, key) {
  const { page } = scope;
  const before = await visiblePopupPaths(page);
  if (!(await focusPath(page, dd.path))) return { opened: null, focusable: false };
  await press(page, key);
  if (page.url() !== scope.baseUrl) return { opened: null, navigated: true };
  return { opened: await findOpenPopup(page, dd.path, before), before };
}

async function closeAndRestore(scope, dd, before) {
  const { page } = scope;
  await press(page, 'Escape');
  const stillOpen = before ? await findOpenPopup(page, dd.path, before) : null;
  if (stillOpen || !(await scopeIntact(scope))) await scope.prepare();
}

// ── Per-dropdown checks ────────────────────────────────────────────────────

async function auditDropdown(scope, dd, walk, issues, goodToHave) {
  const { page } = scope;
  const reached = new Set(walk.stops.map(s => s.path));

  // 1. Tab reaches the trigger.
  if (!reached.has(dd.path)) {
    if (walk.complete) {
      issues.push(makeIssue(scope, 'dropdown-trigger-not-reachable', 'serious',
        `Dropdown trigger <${dd.tag}> cannot be reached with Tab, so keyboard users cannot open it.`,
        dd, 'Use a native <button> or <select>, or give the custom trigger tabindex="0".', APG_HELP.dropdown));
    }
    return;
  }

  // 2. Shift+Tab comes back to the trigger.
  if (await focusPath(page, dd.path)) {
    await page.keyboard.press('Tab');
    const next = await activePath(page);
    if (next !== null && next !== dd.path) {
      await page.keyboard.press('Shift+Tab');
      if ((await activePath(page)) !== dd.path) {
        issues.push(makeIssue(scope, 'dropdown-trigger-shift-tab-unreachable', 'serious',
          `Shift+Tab from the next element does not return focus to the dropdown trigger <${dd.tag}>.`,
          dd, 'Remove focus-redirecting script and positive tabindex values so reverse Tab order mirrors forward order.', APG_HELP.dropdown));
      }
    }
  }

  // Native <select> keyboard behaviour (Space/Enter/arrows/Home/End) is provided by the browser.
  if (dd.native) return 'native';

  // 3. Activation keys. Editable comboboxes open with ArrowDown (Space would type a space).
  const keys = dd.editable ? ['ArrowDown'] : ['Enter', 'Space'];
  const failedKeys = [];
  let openKey = null;
  for (const key of keys) {
    const attempt = await tryOpen(scope, dd, key);
    if (attempt.navigated) {
      await scope.prepare();
      return 'navigated'; // behaves as a link, not a dropdown
    }
    if (attempt.focusable === false) return 'skipped';
    if (attempt.opened) {
      openKey = openKey || key;
      await closeAndRestore(scope, dd, attempt.before);
    } else {
      failedKeys.push(key);
      if (!(await scopeIntact(scope))) await scope.prepare();
    }
  }
  for (const key of failedKeys) {
    const ruleId = key === 'Enter' ? 'dropdown-enter-not-activating'
      : key === 'Space' ? 'dropdown-space-not-activating'
      : 'combobox-arrow-down-not-opening';
    const label = key === 'Space' ? 'Space' : key;
    issues.push(makeIssue(scope, ruleId, 'serious',
      `Pressing ${label} on the dropdown trigger <${dd.tag}> does not open its list.`,
      dd,
      dd.editable
        ? 'Open the listbox popup when ArrowDown is pressed in the combobox input.'
        : 'Handle both Enter and Space on the trigger (a native <button> does this automatically) and set aria-expanded="true" when the list opens.',
      dd.editable ? APG_HELP.combobox : APG_HELP.menuButton, { keysAttempted: [key] }));
  }

  // 4. Open the list again (by keyboard if possible, else by click) to test behaviour inside it.
  const openForTesting = async () => {
    if (openKey) return tryOpen(scope, dd, openKey);
    const before = await visiblePopupPaths(page);
    const handle = await elementAt(page, dd.path);
    if (!handle) return { opened: null, before };
    await handle.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    await handle.dispose().catch(() => {});
    if (page.url() !== scope.baseUrl) return { opened: null, navigated: true };
    return { opened: await findOpenPopup(page, dd.path, before), before };
  };
  let { opened, before, navigated } = await openForTesting();
  if (navigated) { await scope.prepare(); return 'navigated'; }
  if (!opened) {
    if (!(await scopeIntact(scope))) await scope.prepare();
    return 'not-opened';
  }

  const items = await getItems(page, opened.popupPath, dd.path);
  const paths = items.map(i => i.path);
  const active = () => activeItemIndex(page, paths, dd.path);
  let downWorks = false;
  if (items.length >= 2) {

    // 5. Up/Down arrows move between items.
    const s0 = await active();
    await press(page, 'ArrowDown');
    const s1 = await active();
    await press(page, 'ArrowDown');
    const s2 = await active();
    await press(page, 'ArrowUp');
    const s3 = await active();
    downWorks = (s1.index >= 0 && s1.index !== s0.index) || (s2.index >= 0 && s2.index !== s1.index);
    const upWorks = s3.index >= 0 && s3.index !== s2.index;
    if (!downWorks || !upWorks) {
      const failed = [!downWorks && 'ArrowDown', !upWorks && 'ArrowUp'].filter(Boolean);
      issues.push(makeIssue(scope, 'dropdown-arrow-keys-not-supported', 'serious',
        `In the open dropdown list of <${dd.tag}>, ${failed.join(' and ')} do${failed.length === 1 ? 'es' : ''} not move focus (or aria-activedescendant) between the ${items.length} items.`,
        dd, 'Move focus between items with ArrowUp/ArrowDown (roving tabindex), or update aria-activedescendant on the focused trigger.',
        APG_HELP.dropdown, { keysAttempted: failed, itemCount: items.length }));
    }

    // 6. Home/End are optional — report as good-to-have only.
    if (downWorks && items.length >= 3) {
      await press(page, 'End');
      const end = await active();
      await press(page, 'Home');
      const home = await active();
      if (end.index !== items.length - 1 || home.index !== 0) {
        const missing = [end.index !== items.length - 1 && 'End', home.index !== 0 && 'Home'].filter(Boolean);
        goodToHave.push({
          type: 'good-to-have',
          category: 'dropdown-keyboard',
          ruleId: 'dropdown-home-end-missing',
          impact: 'minor',
          description: `${scope.context === 'dialog' ? 'Inside a dialog: ' : ''}${missing.join(' and ')} do${missing.length === 1 ? 'es' : ''} not jump to the ${missing.length === 2 ? 'first/last' : missing[0] === 'Home' ? 'first' : 'last'} item of the dropdown list.`,
          element: dd.html,
          selector: dd.selector,
          page: scope.scanUrl,
          context: scope.context,
          suggestion: 'Optional (APG): Home moves to the first item and End to the last, which helps with long lists.',
        });
      }
    }

    // 7. Type-ahead is recommended (APG) — good-to-have only. Editable comboboxes filter instead.
    if (downWorks && !dd.editable) {
      const current = await active();
      const currentLetter = (items[current.index]?.text || '').charAt(0).toLowerCase();
      const target = items.find(i => /^[a-z0-9]/i.test(i.text) && i.text.charAt(0).toLowerCase() !== currentLetter);
      if (target) {
        const letter = target.text.charAt(0).toLowerCase();
        await press(page, letter);
        const after = await active();
        const landed = (items[after.index]?.text || '').charAt(0).toLowerCase();
        if (landed !== letter) {
          goodToHave.push({
            type: 'good-to-have',
            category: 'dropdown-keyboard',
            ruleId: 'dropdown-type-ahead-missing',
            impact: 'minor',
            description: `${scope.context === 'dialog' ? 'Inside a dialog: ' : ''}Typing "${letter}" in the open dropdown list does not move to the item starting with that character ("${target.text.slice(0, 40)}").`,
            element: dd.html,
            selector: dd.selector,
            page: scope.scanUrl,
            context: scope.context,
            suggestion: 'Recommended (APG): typing a character moves to the next item that starts with it, which makes long lists much faster to use.',
          });
        }
      }
    }
  }

  // 8. Escape closes the list and focus returns to the trigger.
  await press(page, 'Escape');
  const afterEscape = await findOpenPopup(page, dd.path, before);
  // A list that is no longer visible counts as closed even if aria-expanded was left "true".
  const stillOpen = afterEscape && !afterEscape.expandedOnly ? afterEscape : null;
  if (stillOpen) {
    issues.push(makeIssue(scope, 'dropdown-escape-not-closing', 'serious',
      `Pressing Escape does not close the open dropdown list of <${dd.tag}>.`,
      dd, 'Close the popup on Escape (and set aria-expanded="false"), keeping focus on the trigger.',
      dd.editable ? APG_HELP.combobox : APG_HELP.dropdown, { keysAttempted: ['Escape'] }));
  } else if ((await activePath(page)) !== dd.path) {
    issues.push(makeIssue(scope, 'dropdown-focus-not-returned', 'serious',
      `After Escape closes the dropdown list of <${dd.tag}>, focus does not return to the trigger, so keyboard users lose their place.`,
      dd, 'When the popup closes, move focus back to the trigger (call trigger.focus()).',
      dd.editable ? APG_HELP.combobox : APG_HELP.dropdown, { keysAttempted: ['Escape'] }));
  }
  if (afterEscape || !(await scopeIntact(scope))) await scope.prepare();

  if (items.length >= 2) {
    // 9. Items must not be Tab stops — Tab should leave the list, not walk through it.
    ({ opened, before, navigated } = await openForTesting());
    if (navigated) { await scope.prepare(); return 'navigated'; }
    const tabbableItems = items.filter(i => i.tabbable).length;
    let tabWalksItems = false;
    const current = await active();
    if (current.via === 'focus') {
      await press(page, 'Tab');
      const afterTab = await active();
      tabWalksItems = afterTab.via === 'focus' && afterTab.index >= 0 && afterTab.index !== current.index;
    }
    if (tabWalksItems || tabbableItems > 1) {
      issues.push(makeIssue(scope, 'dropdown-items-in-tab-order', 'serious',
        `Items in the dropdown list of <${dd.tag}> are separate Tab stops${tabWalksItems ? ' (Tab moved from one item to the next)' : ` (${tabbableItems} of ${items.length} items have tabindex >= 0)`}. A long list then needs one Tab per item to get out.`,
        dd, 'Give list items tabindex="-1" (only the active item may be tabindex="0") and move between them with the arrow keys.',
        APG_HELP.dropdown, { itemCount: items.length, tabbableItems }));
    }
  }

  await closeAndRestore(scope, dd, before);
  return 'tested';
}

// ── Radio groups ───────────────────────────────────────────────────────────

async function findRadioGroups(scope) {
  return scope.page.evaluate((cPath) => {
    const { resolve, domPath, selector } = window.__ddk;
    const root = cPath === null ? document.body : resolve(cPath);
    if (!root) return [];
    // Custom-styled native radios are often visually hidden (opacity/size) yet still focusable,
    // so only rule out display:none / visibility:hidden on the element or any ancestor.
    const shown = (el) => el.isConnected && !el.closest('[aria-hidden="true"]')
      && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0);
    const groups = [];
    const byName = new Map();
    for (const radio of root.querySelectorAll('input[type="radio"]')) {
      if (!radio.name || radio.disabled || !shown(radio)) continue;
      const key = `${radio.form ? domPath(radio.form) : ''}|${radio.name}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(radio);
    }
    for (const radios of byName.values()) {
      if (radios.length < 2) continue;
      const group = radios[0].closest('fieldset, [role="radiogroup"]') || radios[0];
      groups.push({ label: radios[0].name, paths: radios.map(domPath), html: group.outerHTML.slice(0, 200), selector: selector(group), tag: group.tagName.toLowerCase() });
    }
    for (const group of root.querySelectorAll('[role="radiogroup"]')) {
      const radios = [...group.querySelectorAll('[role="radio"]')].filter(shown);
      if (radios.length < 2) continue;
      groups.push({ label: group.getAttribute('aria-label') || '', paths: radios.map(domPath), html: group.outerHTML.slice(0, 200), selector: selector(group), tag: group.tagName.toLowerCase() });
    }
    return groups;
  }, scope.containerPath).catch(() => []);
}

async function auditRadioGroup(scope, group, walk, issues) {
  const { page } = scope;
  const tabStops = walk.stops.filter(s => group.paths.includes(s.path));
  if (tabStops.length > 1) {
    issues.push(makeIssue(scope, 'radio-group-items-in-tab-order', 'serious',
      `Radio group has ${tabStops.length} separate Tab stops; a radio group must be a single Tab stop with arrow keys moving between options.`,
      group, 'Use native radios sharing one name, or a roving tabindex: only the checked (or first) radio has tabindex="0", the rest tabindex="-1".',
      APG_HELP.radio, { radioCount: group.paths.length }));
  }

  const entry = tabStops[0]?.path || group.paths[0];
  let moved = false;
  for (const key of ['ArrowDown', 'ArrowRight']) {
    if (!(await focusPath(page, entry))) return; // cannot focus the group — nothing provable
    await press(page, key);
    const now = await activePath(page);
    if (now && now !== entry && group.paths.includes(now)) { moved = true; break; }
  }
  if (!moved) {
    issues.push(makeIssue(scope, 'radio-group-arrow-keys-not-supported', 'serious',
      'Arrow keys (ArrowDown/ArrowRight) do not move focus to the next radio button in the group.',
      group, 'Move focus and selection to the next/previous radio with the arrow keys (native radios sharing a name do this automatically).',
      APG_HELP.radio, { radioCount: group.paths.length }));
  }
  if (!(await scopeIntact(scope))) await scope.prepare();
}

// ── Scope audit (page or open dialog) ──────────────────────────────────────

async function auditScope(scope, issues, goodToHave, stats) {
  const walk = await walkTabOrder(scope);
  issues.push(...detectFocusOrderIssues(scope, walk.stops));

  const dropdowns = await findDropdowns(scope);
  for (const dd of dropdowns.slice(0, MAX_DROPDOWNS_PER_SCOPE)) {
    if (scope.broken) return;
    try {
      const outcome = await auditDropdown(scope, dd, walk, issues, goodToHave);
      if (outcome === 'native') stats.nativeSelects++;
      else if (outcome !== 'navigated' && outcome !== 'skipped') stats.dropdowns++;
    } catch (err) {
      logger.warn(`Dropdown keyboard scan: ${dd.selector} skipped (${err.message})`);
      await scope.prepare().catch(() => {});
    }
  }

  const radioGroups = await findRadioGroups(scope);
  for (const group of radioGroups.slice(0, MAX_RADIO_GROUPS_PER_SCOPE)) {
    if (scope.broken) return;
    try {
      await auditRadioGroup(scope, group, walk, issues);
      stats.radioGroups++;
    } catch (err) {
      logger.warn(`Dropdown keyboard scan: radio group ${group.selector} skipped (${err.message})`);
      await scope.prepare().catch(() => {});
    }
  }
}

// ── Dialog discovery ───────────────────────────────────────────────────────

async function findDialogTriggerCandidates(page) {
  const candidates = await page.evaluate(() => {
    const { describe, isVisible } = window.__ddk;
    const out = [];
    const seen = new Set();
    const add = (el, signal) => {
      if (!isVisible(el) || el.disabled) return;
      const info = describe(el);
      if (seen.has(info.path)) return;
      seen.add(info.path);
      out.push({
        ...info,
        signal,
        text: (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 80),
        submits: el.type === 'submit' && Boolean(el.form),
        opensList: /^(listbox|menu|tree|grid|true)$/.test(el.getAttribute('aria-haspopup') || ''),
      });
    };
    const isDialog = (el) => el && el.matches('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]');
    document.querySelectorAll('[aria-haspopup="dialog"], [data-toggle="modal"], [data-bs-toggle="modal"]').forEach(el => add(el, 'aria'));
    document.querySelectorAll('[aria-controls]').forEach(el => {
      const ids = el.getAttribute('aria-controls').split(/\s+/);
      if (ids.some(id => isDialog(document.getElementById(id)))) add(el, 'aria-controls');
    });
    document.querySelectorAll('button, [role="button"], input[type="button"]').forEach(el => {
      if (el.closest('[role="dialog"], [role="alertdialog"], dialog')) return;
      add(el, 'generic');
    });
    return out;
  }).catch(() => []);
  return candidates.filter(c => !c.submits && !c.opensList && !UNSAFE_TRIGGER_TEXT.test(c.text));
}

/** Open a dialog from its trigger (keyboard first, click as fallback). Returns null if no dialog opened. */
async function openDialogFromTrigger(page, trigger, baseUrl) {
  const handle = await elementAt(page, trigger.path);
  if (!handle) return null;
  try {
    for (const key of ['Enter', 'Space', 'click']) {
      if (key === 'click') await handle.click({ timeout: 2000 }).catch(() => {});
      else {
        await handle.focus().catch(() => {});
        await page.keyboard.press(key);
      }
      await page.waitForTimeout(SETTLE_MS * 2);
      if (page.url() !== baseUrl) return { navigated: true };
      const state = await detectOpenDialog(page);
      if (!state.found) continue;
      const info = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return { path: window.__ddk.domPath(el), selector: sel, fingerprint: `${sel}|${el.outerHTML.slice(0, 120)}` };
      }, state.selector).catch(() => null);
      if (info) return { ...info, openedBy: key };
    }
    return null;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/**
 * Phase 3i: Dropdown keyboard scan
 *
 * For the page, and again inside every modal dialog it can open:
 *  - Tab / Shift+Tab reach each dropdown trigger; Enter and Space both open it
 *  - ArrowUp/ArrowDown move between list items; items are not Tab stops
 *  - Escape closes the list and focus returns to the trigger
 *  - Home/End and type-ahead (good-to-have only)
 *  - Radio groups are one Tab stop and arrow-navigable
 *  - Tab order follows visual order (no skipped stops, no backward jumps)
 *
 * @param {string} scanUrl
 * @returns {{ issues: Array, goodToHave: Array, stats: object, scanFailed: boolean, failReason?: string }}
 */
export async function phase3i_dropdownKeyboard(scanUrl) {
  console.log(chalk.dim('  Running dropdown keyboard scan (Phase 3i)...'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: relaxTlsVerifyForUrl(scanUrl) });
    await ctx.addInitScript(installHelpers);
    const page = await ctx.newPage();

    let baseUrl = scanUrl;
    const loadFresh = async () => {
      await page.goto(scanUrl, { waitUntil: 'load', timeout: 30000 });
      await waitForStablePage(page, scanUrl, RELOAD_STABILITY_MS);
      baseUrl = page.url();
    };
    await loadFresh();

    const issues = [];
    const goodToHave = [];
    const stats = { dropdowns: 0, nativeSelects: 0, radioGroups: 0, dialogs: 0 };

    const pageScope = { page, scanUrl, context: 'page', containerPath: null, prepare: loadFresh };
    Object.defineProperty(pageScope, 'baseUrl', { get: () => baseUrl });
    await auditScope(pageScope, issues, goodToHave, stats);

    // Re-run the same keyboard walk inside each dialog the page can open.
    await loadFresh();
    const triggers = await findDialogTriggerCandidates(page);
    const seenDialogs = new Set();
    let dirty = false;
    let tries = 0;
    for (const trigger of triggers) {
      if (stats.dialogs >= MAX_DIALOGS || tries >= MAX_DIALOG_TRIGGER_TRIES) break;
      tries++;
      if (dirty) { await loadFresh(); dirty = false; }
      const dialog = await openDialogFromTrigger(page, trigger, baseUrl);
      if (!dialog) {
        await page.keyboard.press('Escape').catch(() => {});
        continue;
      }
      dirty = true;
      if (dialog.navigated || seenDialogs.has(dialog.fingerprint)) continue;
      seenDialogs.add(dialog.fingerprint);
      stats.dialogs++;

      const dialogScope = {
        page,
        scanUrl,
        context: 'dialog',
        containerPath: dialog.path,
        dialogSelector: dialog.selector,
        triggerSelector: trigger.selector,
      };
      Object.defineProperty(dialogScope, 'baseUrl', { get: () => baseUrl });
      dialogScope.prepare = async () => {
        await loadFresh();
        const reopened = await openDialogFromTrigger(page, trigger, baseUrl);
        if (!reopened || reopened.navigated) {
          dialogScope.broken = true;
          throw new Error('dialog could not be reopened');
        }
        dialogScope.containerPath = reopened.path;
      };
      try {
        await auditScope(dialogScope, issues, goodToHave, stats);
      } catch (err) {
        logger.warn(`Dropdown keyboard scan: dialog ${dialog.selector} skipped (${err.message})`);
      }
    }

    await browser.close();

    const summary = `${stats.dropdowns} custom dropdown(s), ${stats.nativeSelects} native select(s), ${stats.radioGroups} radio group(s), ${stats.dialogs} dialog(s) — ${issues.length} issue(s), ${goodToHave.length} good-to-have`;
    console.log(chalk.dim(`  Dropdown keyboard scan: ${summary}`));
    logger.log(`Dropdown keyboard scan: ${summary}`);
    return { issues, goodToHave, stats, scanFailed: false };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.log(chalk.yellow(`  ⚠ Dropdown keyboard scan failed: ${err.message}`));
    logger.warn(`Dropdown keyboard scan failed: ${err.message}`);
    return { issues: [], goodToHave: [], stats: null, scanFailed: true, failReason: err.message };
  }
}
