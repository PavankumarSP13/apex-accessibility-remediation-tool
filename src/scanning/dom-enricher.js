// ENH-04: DOM Context Enrichment
// Integration: Called from main.js after Phase 3 scanning while a Playwright page is still open,
// or integrated into phase3a_axe / phase3e_pa11y before the browser closes.

/**
 * Enrich a single issue with DOM context (parents, siblings, children)
 * extracted via Playwright page evaluation.
 *
 * @param {object} issue  - An accessibility issue object.
 * @param {import('playwright').Page} page - A live Playwright page instance.
 * @returns {Promise<object>} The issue, potentially with `domContext` attached.
 */
export async function enrichIssueWithDomContext(issue, page) {
  try {
    // 1. Determine selector
    const selector = resolveSelector(issue);
    if (!selector) return issue;

    // 2. Locate element on the page
    const handle = await page.$(selector);
    if (!handle) return issue;

    // 3. Extract DOM context via page.evaluate
    const domContext = await page.evaluate((el) => {
      // --- helpers scoped inside evaluate ---
      function describeParent(node) {
        const dataAttrs = {};
        for (const attr of node.attributes) {
          if (attr.name.startsWith('data-')) {
            dataAttrs[attr.name] = attr.value;
          }
        }
        return {
          tag: node.tagName.toLowerCase(),
          id: node.id || undefined,
          classes: [...node.classList],
          dataAttrs,
          role: node.getAttribute('role') || undefined,
          ariaLabel: node.getAttribute('aria-label') || undefined,
        };
      }

      function describeSibling(node) {
        return {
          tag: node.tagName.toLowerCase(),
          text: (node.textContent || '').trim().slice(0, 60),
          forAttr: node.getAttribute('for') || undefined,
          classes: [...node.classList].slice(0, 3),
        };
      }

      function describeChild(node) {
        return {
          tag: node.tagName.toLowerCase(),
          classes: [...node.classList].slice(0, 3),
          text: (node.textContent || '').trim().slice(0, 40),
          src: node.getAttribute('src') || undefined,
        };
      }

      // --- parents (up to 5 ancestor levels) ---
      const parents = [];
      let cur = el.parentElement;
      for (let i = 0; i < 5 && cur && cur !== document.documentElement; i++) {
        parents.push(describeParent(cur));
        cur = cur.parentElement;
      }

      // --- siblings (up to 6 from parent.children, excluding el) ---
      const siblings = [];
      if (el.parentElement) {
        const children = el.parentElement.children;
        for (let i = 0; i < children.length && siblings.length < 6; i++) {
          if (children[i] !== el) {
            siblings.push(describeSibling(children[i]));
          }
        }
      }

      // --- children (up to 5 direct children) ---
      const childNodes = [];
      const directChildren = el.children;
      for (let i = 0; i < Math.min(5, directChildren.length); i++) {
        childNodes.push(describeChild(directChildren[i]));
      }

      return { parents, siblings, children: childNodes };
    }, handle);

    await handle.dispose();

    // 4. Attach context and return
    issue.domContext = domContext;
    return issue;
  } catch {
    // 5. On any failure, return issue unchanged
    return issue;
  }
}

/**
 * Extract grep-friendly search tokens from an enriched issue's domContext.
 *
 * @param {object} issue - An issue object, optionally with `domContext`.
 * @returns {Array<{token: string, priority: number, type: string}>}
 *          Tokens sorted by ascending priority (1 = highest).
 */
export function extractGrepTokens(issue) {
  if (!issue.domContext) return [];

  const tokens = [];
  const { parents, siblings, children } = issue.domContext;

  const GENERIC_CLASS_RE = /^(active|hidden|open|show|col-|row|d-|p-|m-|is-|has-)/;

  // Priority 1: parent IDs
  if (parents) {
    for (const p of parents) {
      if (p.id) {
        tokens.push({ token: p.id, priority: 1, type: 'parent-id' });
      }
    }
  }

  // Priority 2: data-attr key=value pairs from element HTML + parents
  // Extract from issue.element or issue.nodes?.[0]?.html
  const elementHtml = issue.element || issue.nodes?.[0]?.html || '';
  const dataAttrRe = /\b(data-[\w-]+)=["']([^"']*)["']/g;
  let match;
  while ((match = dataAttrRe.exec(elementHtml)) !== null) {
    tokens.push({ token: `${match[1]}=${match[2]}`, priority: 2, type: 'element-data-attr' });
  }

  // data-attrs from parents
  if (parents) {
    for (const p of parents) {
      if (p.dataAttrs) {
        for (const [key, val] of Object.entries(p.dataAttrs)) {
          tokens.push({ token: `${key}=${val}`, priority: 2, type: 'parent-data-attr' });
        }
      }
    }
  }

  // Priority 3: specific parent classes (length > 4, not matching generic pattern)
  if (parents) {
    for (const p of parents) {
      if (p.classes) {
        for (const cls of p.classes) {
          if (cls.length > 4 && !GENERIC_CLASS_RE.test(cls)) {
            tokens.push({ token: cls, priority: 3, type: 'parent-class' });
          }
        }
      }
    }
  }

  // Priority 4: sibling label text (when sibling tag is 'label')
  if (siblings) {
    for (const s of siblings) {
      if (s.tag === 'label' && s.text) {
        tokens.push({ token: s.text, priority: 4, type: 'sibling-label' });
      }
    }
  }

  // Sort by ascending priority (1 = highest)
  tokens.sort((a, b) => a.priority - b.priority);
  return tokens;
}

/**
 * Convenience wrapper: enrich an array of issues with DOM context.
 * Each issue gets a 3-second timeout; failures are silently skipped.
 *
 * @param {object[]} issues - Array of accessibility issue objects.
 * @param {import('playwright').Page} page - A live Playwright page instance.
 * @returns {Promise<object[]>} The same array, with domContext attached where possible.
 */
export async function enrichIssuesWithDomContext(issues, page) {
  let enriched = 0;
  let skipped = 0;

  for (const issue of issues) {
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('enrichment timeout')), 3000),
      );
      const result = await Promise.race([
        enrichIssueWithDomContext(issue, page),
        timeout,
      ]);
      if (result.domContext) {
        enriched++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  console.log(
    `[ENH-04] DOM enrichment complete: ${enriched} enriched, ${skipped} skipped out of ${issues.length} issues.`,
  );
  return issues;
}

// ── internal helpers ──────────────────────────────────────────────────

/**
 * Resolve the best CSS selector from an issue object.
 * @param {object} issue
 * @returns {string|null}
 */
function resolveSelector(issue) {
  // Prefer semanticSelector (from ENH-01) when available
  if (issue.semanticSelector) return issue.semanticSelector;

  // Axe nodes[0].target is an array of selector fragments — join them
  const target = issue.nodes?.[0]?.target;
  if (Array.isArray(target) && target.length > 0) {
    return target.join(' ');
  }

  // Fall back to plain selector string
  if (typeof issue.selector === 'string' && issue.selector) {
    return issue.selector;
  }

  return null;
}
