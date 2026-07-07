// a11y-tree-scanner.js — Accessibility Tree-based post-scan validation layer
//
// Captures the browser's Accessibility Tree via Playwright and uses it to:
//   1. Filter false positives — issues reported by axe/pa11y that don't exist in the a11y tree
//   2. Enrich issues — add computed accessible name, role, name source
//   3. Detect missed issues — find a11y tree problems that DOM scanners missed
//   4. Filter hidden elements — skip issues on elements not exposed to assistive technology
//
// Integration: call captureAccessibilitySnapshot() while a Playwright page is still open,
// then pass the result to the sync functions for validation, enrichment, and filtering.

// ---------------------------------------------------------------------------
// Rule IDs whose validity depends on whether an accessible name is present
// ---------------------------------------------------------------------------
const NAME_CHECK_RULES = new Set([
  // axe-core
  'button-name',
  'link-name',
  'input-button-name',
  'label',
  'select-name',
  'aria-input-field-name',
  // pa11y / HTML_CodeSniffer
  'H91.Button.Name',
  'H91.A.Name',
  'H91.A.NoContent',
  'H91.InputText.Name',
  'H91.Select.Name',
  'F68',
]);

const IMAGE_ALT_RULES = new Set([
  'image-alt',
]);

// ---------------------------------------------------------------------------
// Internal: element matching
// ---------------------------------------------------------------------------

/**
 * Match an issue object to the closest element captured from the a11y snapshot.
 * Uses multiple strategies in priority order.
 *
 * @param {object} issue    - Unified accessibility issue.
 * @param {object[]} elements - Elements array from captureAccessibilitySnapshot.
 * @returns {object|null} The matching element or null.
 */
function findMatchingElement(issue, elements) {
  const issueHtml = (issue.nodes?.[0]?.html || issue.element || '').slice(0, 150);
  const issueTarget = String(issue.nodes?.[0]?.target || issue.selector || '');

  // Strategy 1: semantic selector (from ENH-01)
  if (issue.semanticSelector) {
    const match = elements.find(el => el.stableSelector === issue.semanticSelector);
    if (match) return match;
  }

  // Strategy 2: ID match
  const idMatch = issueTarget.match(/#([\w-]+)/);
  if (idMatch) {
    const match = elements.find(el => el.id === idMatch[1]);
    if (match) return match;
  }

  // Strategy 3: class + tag match
  const classMatches = [...issueTarget.matchAll(/\.([\w-]+)/g)]
    .map(m => m[1])
    .filter(c => c.length > 3);
  if (classMatches.length > 0) {
    const match = elements.find(el =>
      classMatches.every(cls => el.classes.includes(cls)),
    );
    if (match) return match;
  }

  // Strategy 4: HTML snippet match (first 150 chars)
  if (issueHtml.length > 20) {
    const match = elements.find(el =>
      el.html.slice(0, 150) === issueHtml.slice(0, 150),
    );
    if (match) return match;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 1. captureAccessibilitySnapshot
// ---------------------------------------------------------------------------

/**
 * Capture the browser Accessibility Tree and interactive-element metadata.
 *
 * @param {import('playwright').Page} page - A live Playwright page.
 * @returns {Promise<{snapshot: string, elements: object[]}>}
 */
export async function captureAccessibilitySnapshot(page) {
  try {
    // Full ARIA snapshot from Playwright
    const snapshot = await page.ariaSnapshot({ mode: 'default' });

    // Detailed per-element info for every interactive element
    const elements = await page.evaluate(() => {
      const interactiveSelectors =
        'a, button, input, select, textarea, ' +
        '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
        '[role="checkbox"], [role="radio"], [tabindex]';

      const els = [...document.querySelectorAll(interactiveSelectors)];

      return els.map(el => {
        const rect = el.getBoundingClientRect();

        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          computedRole: el.computedRole || null,
          id: el.id || null,
          classes: [...el.classList].slice(0, 5),
          ariaLabel: el.getAttribute('aria-label') || null,
          ariaLabelledBy: el.getAttribute('aria-labelledby') || null,
          title: el.title || null,
          textContent: (el.textContent || '').trim().slice(0, 100),
          alt: el.getAttribute('alt'),
          href: el.getAttribute('href'),
          type: el.getAttribute('type'),
          ariaHidden: el.getAttribute('aria-hidden'),
          hidden: el.hidden || false,
          disabled: el.disabled || false,
          tabIndex: el.tabIndex,
          isVisible:
            rect.width > 0 &&
            rect.height > 0 &&
            getComputedStyle(el).display !== 'none' &&
            getComputedStyle(el).visibility !== 'hidden',
          html: el.outerHTML.slice(0, 300),

          // Compute accessible name using the browser's algorithm
          accessibleName:
            el.ariaLabel ||
            el.title ||
            el.textContent?.trim().slice(0, 100) ||
            el.getAttribute('alt') ||
            '',

          accessibleNameSource: el.ariaLabel
            ? 'aria-label'
            : el.getAttribute('aria-labelledby')
              ? 'aria-labelledby'
              : el.title
                ? 'title'
                : el.getAttribute('alt')
                  ? 'alt'
                  : (el.textContent || '').trim()
                    ? 'contents'
                    : 'none',

          // Build a stable selector
          stableSelector: (() => {
            if (el.id) return '#' + el.id;
            let sel = el.tagName.toLowerCase();
            const role = el.getAttribute('role');
            if (role) sel = `[role="${role}"]`;
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) sel += `[aria-label="${ariaLabel}"]`;
            const dataAttrs = [...el.attributes]
              .filter(a => a.name.startsWith('data-'))
              .slice(0, 2);
            if (dataAttrs.length)
              sel += dataAttrs.map(a => `[${a.name}="${a.value}"]`).join('');
            if (!el.id && !role && !ariaLabel && dataAttrs.length === 0) {
              const cls = [...el.classList]
                .filter(c => c.length > 3)
                .slice(0, 2);
              if (cls.length) sel += '.' + cls.join('.');
            }
            return sel;
          })(),
        };
      });
    });

    return { snapshot, elements };
  } catch (err) {
    console.error('[a11y-tree-scanner] captureAccessibilitySnapshot failed:', err.message);
    return { snapshot: '', elements: [] };
  }
}

// ---------------------------------------------------------------------------
// 2. validateIssuesAgainstA11yTree
// ---------------------------------------------------------------------------

/**
 * Validate each issue against the captured Accessibility Tree data.
 * Marks issues as false-positive, confirmed, not-exposed, or element-not-in-tree.
 *
 * @param {object[]} issues  - Unified issue list.
 * @param {{snapshot: string, elements: object[]}} a11yData - From captureAccessibilitySnapshot.
 * @returns {object[]} The mutated issues array.
 */
export function validateIssuesAgainstA11yTree(issues, a11yData) {
  try {
    if (!Array.isArray(issues) || !a11yData?.elements?.length) return issues;

    for (const issue of issues) {
      const ruleId = issue.ruleId || issue.id || '';
      const element = findMatchingElement(issue, a11yData.elements);

      // --- hidden-from-AT check (all issues) ---
      if (element && element.ariaHidden === 'true' && element.tabIndex < 0) {
        issue.a11yTreeStatus = 'not-exposed';
        issue.a11yTreeReason = 'aria-hidden-and-not-focusable';
        continue;
      }

      // --- accessible-name rules ---
      if (NAME_CHECK_RULES.has(ruleId)) {
        if (!element) {
          issue.a11yTreeStatus = 'element-not-in-tree';
          issue.a11yTreeReason = 'no-matching-element-found';
          continue;
        }

        if (element.accessibleName && element.accessibleName.trim().length > 0) {
          issue.a11yTreeStatus = 'false-positive';
          issue.a11yTreeReason = 'accessible-name-present-in-tree';
          issue.computedAccessibleName = element.accessibleName;
          issue.accessibleNameSource = element.accessibleNameSource;
        } else {
          issue.a11yTreeStatus = 'confirmed';
          issue.a11yTreeReason = 'no-accessible-name-in-tree';
        }
        continue;
      }

      // --- image-alt rules ---
      if (IMAGE_ALT_RULES.has(ruleId)) {
        if (!element) {
          issue.a11yTreeStatus = 'element-not-in-tree';
          issue.a11yTreeReason = 'no-matching-element-found';
          continue;
        }

        if (element.alt != null && element.alt.trim().length > 0) {
          issue.a11yTreeStatus = 'false-positive';
          issue.a11yTreeReason = 'alt-text-present';
          issue.computedAccessibleName = element.alt;
          issue.accessibleNameSource = 'alt';
        } else {
          issue.a11yTreeStatus = 'confirmed';
          issue.a11yTreeReason = 'missing-or-empty-alt';
        }
        continue;
      }
    }

    return issues;
  } catch (err) {
    console.error('[a11y-tree-scanner] validateIssuesAgainstA11yTree failed:', err.message);
    return issues;
  }
}

// ---------------------------------------------------------------------------
// 3. detectMissedIssues
// ---------------------------------------------------------------------------

/**
 * Scan a11yData.elements for accessibility problems that DOM scanners missed.
 *
 * @param {{snapshot: string, elements: object[]}} a11yData - From captureAccessibilitySnapshot.
 * @param {object[]} existingIssues - Already-reported issues (to avoid duplicates).
 * @returns {object[]} Newly detected issues with source: 'a11y-tree'.
 */
export function detectMissedIssues(a11yData, existingIssues) {
  try {
    if (!a11yData?.elements?.length) return [];

    const existing = Array.isArray(existingIssues) ? existingIssues : [];
    const newIssues = [];

    // Build a quick lookup of existing issue HTML snippets + selectors for dedup
    const existingHtmlSet = new Set(
      existing.map(i => (i.nodes?.[0]?.html || i.element || '').slice(0, 100)).filter(Boolean),
    );
    const existingSelectorSet = new Set(
      existing.map(i => String(i.nodes?.[0]?.target || i.selector || '')).filter(Boolean),
    );

    function alreadyReported(el) {
      if (existingHtmlSet.has(el.html.slice(0, 100))) return true;
      if (el.stableSelector && existingSelectorSet.has(el.stableSelector)) return true;
      return false;
    }

    for (const el of a11yData.elements) {
      // --- Buttons/links with no accessible name ---
      const isNameable =
        el.tag === 'button' ||
        el.tag === 'a' ||
        el.role === 'button' ||
        el.role === 'link' ||
        el.role === 'tab' ||
        el.role === 'menuitem';

      if (
        isNameable &&
        (!el.accessibleName || el.accessibleName.trim().length === 0) &&
        el.accessibleNameSource === 'none' &&
        !alreadyReported(el)
      ) {
        newIssues.push({
          source: 'a11y-tree',
          ruleId: el.tag === 'a' || el.role === 'link' ? 'link-name' : 'button-name',
          impact: 'critical',
          description: `Interactive ${el.tag} element has no accessible name (role: ${el.role}).`,
          help: 'Ensure interactive elements have an accessible name for assistive technology.',
          selector: el.stableSelector,
          element: el.html,
          a11yTreeStatus: 'confirmed',
          a11yTreeReason: 'detected-by-a11y-tree-scan',
        });
      }

      // --- Focusable but aria-hidden (conflict) ---
      if (el.ariaHidden === 'true' && el.tabIndex >= 0 && !alreadyReported(el)) {
        newIssues.push({
          source: 'a11y-tree',
          ruleId: 'aria-hidden-focus',
          impact: 'serious',
          description: `Element is aria-hidden="true" but focusable (tabIndex=${el.tabIndex}).`,
          help: 'Focusable elements must not be hidden from assistive technology via aria-hidden.',
          selector: el.stableSelector,
          element: el.html,
          a11yTreeStatus: 'confirmed',
          a11yTreeReason: 'focusable-but-aria-hidden',
        });
      }

      // --- Images with missing/empty alt ---
      if (el.tag === 'img' && (el.alt == null || el.alt.trim() === '') && !alreadyReported(el)) {
        newIssues.push({
          source: 'a11y-tree',
          ruleId: 'image-alt',
          impact: 'critical',
          description: 'Image element has missing or empty alt attribute.',
          help: 'Images must have an alt attribute so that assistive technology can describe them.',
          selector: el.stableSelector,
          element: el.html,
          a11yTreeStatus: 'confirmed',
          a11yTreeReason: 'detected-by-a11y-tree-scan',
        });
      }
    }

    return newIssues;
  } catch (err) {
    console.error('[a11y-tree-scanner] detectMissedIssues failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4. filterHiddenFromIssues
// ---------------------------------------------------------------------------

/**
 * Flag issues that are on elements not exposed to assistive technology.
 *
 * @param {object[]} issues  - Unified issue list.
 * @param {{snapshot: string, elements: object[]}} a11yData - From captureAccessibilitySnapshot.
 * @returns {object[]} The mutated issues array.
 */
export function filterHiddenFromIssues(issues, a11yData) {
  try {
    if (!Array.isArray(issues) || !a11yData?.elements?.length) return issues;

    for (const issue of issues) {
      const element = findMatchingElement(issue, a11yData.elements);
      if (!element) continue;

      const notExposed =
        (element.ariaHidden === 'true' && element.tabIndex < 0 && element.isVisible === false) ||
        element.hidden === true;

      if (notExposed) {
        issue.a11yTreeStatus = 'not-exposed';
        issue.manualOnly = true;
        issue.manualReason = 'element-not-exposed-to-assistive-technology';
      }
    }

    return issues;
  } catch (err) {
    console.error('[a11y-tree-scanner] filterHiddenFromIssues failed:', err.message);
    return issues;
  }
}

// ---------------------------------------------------------------------------
// 5. enrichIssueIdentification
// ---------------------------------------------------------------------------

/**
 * Enrich each issue with stable a11y-tree identification data, replacing
 * fragile nth-child selectors with robust role + name identification.
 *
 * @param {object[]} issues  - Unified issue list.
 * @param {{snapshot: string, elements: object[]}} a11yData - From captureAccessibilitySnapshot.
 * @returns {object[]} The mutated issues array.
 */
export function enrichIssueIdentification(issues, a11yData) {
  try {
    if (!Array.isArray(issues) || !a11yData?.elements?.length) return issues;

    for (const issue of issues) {
      const element = findMatchingElement(issue, a11yData.elements);
      if (!element) continue;

      issue.a11yIdentification = {
        role: element.computedRole || element.role,
        accessibleName: element.accessibleName,
        accessibleNameSource: element.accessibleNameSource,
        stableSelector: element.stableSelector,
        isVisible: element.isVisible,
        tag: element.tag,
      };
    }

    return issues;
  } catch (err) {
    console.error('[a11y-tree-scanner] enrichIssueIdentification failed:', err.message);
    return issues;
  }
}
