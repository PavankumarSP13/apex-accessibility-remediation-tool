/**
 * ENH-01: Pa11y Selector Validation
 *
 * Builds stable CSS selectors from pa11y issue context HTML and validates
 * them against the live page via Playwright.  Issues are annotated in place
 * with `selectorStable`, `selectorReason`, and (when stable) `semanticSelector`.
 * No issues are ever dropped.
 */

// ─── Generic CSS-class denylist ──────────────────────────────────────────────
const GENERIC_CLASS_RX = /^(?:btn|active|hidden|show|col-.*|row|d-.*|p-.*|m-.*|disabled|open|closed|fade|in|out|on|off|is-.*|has-.*)$/;

function isGenericClass(cls) {
  return cls.length <= 4 || GENERIC_CLASS_RX.test(cls);
}

// ─── Lightweight HTML-tag regex parser ───────────────────────────────────────

function parseOpeningTag(html) {
  const str = String(html || '').trim();
  // Match the opening tag only (up to the first '>').
  const m = str.match(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)\s*([\s\S]*?)\/?\s*>/);
  if (!m) return null;

  const tag = m[1].toLowerCase();
  const attrStr = m[2];

  let id = null;
  const classes = [];
  const dataAttrs = {};  // key → value
  const ariaAttrs = {};  // key → value

  // Extract all attributes
  const attrRx = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let am;
  while ((am = attrRx.exec(attrStr)) !== null) {
    const name = am[1].toLowerCase();
    const value = am[2] ?? am[3] ?? am[4] ?? '';

    if (name === 'id') {
      id = value;
    } else if (name === 'class') {
      for (const c of value.split(/\s+/).filter(Boolean)) classes.push(c);
    } else if (name.startsWith('data-')) {
      dataAttrs[name] = value;
    } else if (name.startsWith('aria-') || name === 'role') {
      ariaAttrs[name] = value;
    }
  }

  return { tag, id, classes, dataAttrs, ariaAttrs };
}

// ─── buildSemanticSelector ───────────────────────────────────────────────────

/**
 * Build a stable CSS selector from a pa11y `issue.context` HTML snippet.
 *
 * Priority:
 *  1. id                → `#myId`
 *  2. data-* attrs      → `tag[data-foo="bar"]`
 *  3. ARIA attrs        → `[role="menuitem"][aria-label="Save"]`
 *  4. ≥2 non-generic classes → `tag.cls1.cls2`
 *  5. 1 specific class (>4 chars, not generic) → `.cls`
 *  6. null
 */
export function buildSemanticSelector(contextHtml) {
  const parsed = parseOpeningTag(contextHtml);
  if (!parsed) return null;

  const { tag, id, classes, dataAttrs, ariaAttrs } = parsed;

  // 1. id
  if (id) return `#${id}`;

  // 2. data-* attributes
  const dataKeys = Object.keys(dataAttrs);
  if (dataKeys.length > 0) {
    const parts = dataKeys.map(k => `[${k}="${dataAttrs[k]}"]`).join('');
    return `${tag}${parts}`;
  }

  // 3. ARIA attributes (role, aria-*)
  const ariaKeys = Object.keys(ariaAttrs);
  if (ariaKeys.length > 0) {
    const parts = ariaKeys.map(k => `[${k}="${ariaAttrs[k]}"]`).join('');
    return parts;
  }

  // 4. ≥2 non-generic classes
  const specific = classes.filter(c => !isGenericClass(c));
  if (specific.length >= 2) {
    return `${tag}.${specific.slice(0, 3).join('.')}`;
  }

  // 5. Single specific class
  if (specific.length === 1) {
    return `.${specific[0]}`;
  }

  // 6. Nothing stable
  return null;
}

// ─── htmlFingerprintMatches ──────────────────────────────────────────────────

const FINGERPRINT_ATTRS = ['class', 'id', 'role'];
const FINGERPRINT_PREFIX = ['data-', 'aria-'];

function extractFingerprint(html) {
  const parsed = parseOpeningTag(html);
  if (!parsed) return null;

  const attrs = {};
  // Merge relevant attributes into a normalised bag
  if (parsed.id) attrs.id = parsed.id;
  if (parsed.classes.length) attrs.class = [...parsed.classes].sort().join(' ');
  for (const [k, v] of Object.entries(parsed.ariaAttrs)) attrs[k] = v;
  for (const [k, v] of Object.entries(parsed.dataAttrs)) attrs[k] = v;

  return { tag: parsed.tag, attrs };
}

/**
 * Loosely compare two HTML snippets by tag name and key attributes.
 * Ignores whitespace, attribute order, and dynamic values.
 */
export function htmlFingerprintMatches(originalHtml, liveHtml) {
  const a = extractFingerprint(originalHtml);
  const b = extractFingerprint(liveHtml);
  if (!a || !b) return false;
  if (a.tag !== b.tag) return false;

  // Compare attribute bags — all keys present in the *original* must match in live
  for (const key of Object.keys(a.attrs)) {
    if (!(key in b.attrs)) return false;
    if (a.attrs[key] !== b.attrs[key]) return false;
  }
  return true;
}

// ─── validatePa11yIssues ────────────────────────────────────────────────────

/**
 * Validate every issue's selector against the live page.
 *
 * Annotates each issue with:
 *   - `selectorStable`    (boolean)
 *   - `selectorReason`    (string, only when unstable)
 *   - `semanticSelector`  (string, only when stable)
 *
 * Never drops issues — only annotates them.
 *
 * @param {{ issues: object[] }} pa11yResult  – the pa11y result object
 * @param {import('playwright').Page} page    – a Playwright page already navigated to the URL
 * @returns {Promise<typeof pa11yResult>}
 */
export async function validatePa11yIssues(pa11yResult, page) {
  if (!pa11yResult?.issues?.length) return pa11yResult;

  for (const issue of pa11yResult.issues) {
    const semanticSelector = buildSemanticSelector(issue.context);

    // 1. Could not build a stable selector
    if (!semanticSelector) {
      issue.selectorStable = false;
      issue.selectorReason = 'no-stable-attributes';
      continue;
    }

    // 2. Try to find the element on the live page
    let el;
    try {
      el = await page.$(semanticSelector);
    } catch {
      // Selector syntax rejected by the browser (edge case)
      issue.selectorStable = false;
      issue.selectorReason = 'element-not-found';
      continue;
    }

    if (!el) {
      issue.selectorStable = false;
      issue.selectorReason = 'element-not-found';
      continue;
    }

    // 3. Grab live outerHTML (first 200 chars) and fingerprint-check
    let liveHtml;
    try {
      liveHtml = await el.evaluate(node => node.outerHTML.slice(0, 200));
    } catch {
      issue.selectorStable = false;
      issue.selectorReason = 'html-mismatch';
      continue;
    }

    if (!htmlFingerprintMatches(issue.context, liveHtml)) {
      issue.selectorStable = false;
      issue.selectorReason = 'html-mismatch';
      continue;
    }

    // 4. All good — stable
    issue.selectorStable = true;
    issue.semanticSelector = semanticSelector;
  }

  return pa11yResult;
}
