import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import chalk from 'chalk';

const MAX_TRIGGERS = 30;
const SETTLE_MS = 500;

/**
 * Determine the keyboard key to activate a trigger element.
 */
function getTriggerKey(trigger) {
  if (trigger.type === 'tab') return 'ArrowRight';
  if (trigger.popupType === 'listbox') return 'ArrowDown';
  if (trigger.popupType === 'tree') return 'ArrowRight';
  if (trigger.type === 'select') return 'Space'; // open native select
  if (trigger.type === 'custom-dropdown') return 'Enter';
  if (trigger.type === 'data-toggle') return 'Enter';
  if (trigger.type === 'modal-trigger') return 'Enter';
  return 'Enter';
}

/**
 * Produce a dedup fingerprint from an HTML snippet based on tag, class, and data attrs.
 */
function domTokenFingerprint(html) {
  const str = String(html || '');
  const tag = (str.match(/^<(\w+)/) || [])[1] || '';
  const cls = (str.match(/class="([^"]+)"/) || [])[1] || '';
  const data = [...str.matchAll(/data-[\w-]+="[^"]+"/g)].map(m => m[0]).join('|');
  return `${tag}|${cls}|${data}`;
}

/**
 * Phase 3d: Interaction Scan
 *
 * Scans accessibility issues inside interaction-triggered DOM: dropdowns,
 * modals, dialogs, tab panels, tooltips. These elements are not present
 * in the DOM at page load.
 *
 * @param {string} scanUrl - The URL to scan.
 * @returns {{ issues: Array, triggerCount: number, scannedCount: number, scanFailed?: boolean, failReason?: string }}
 */
export async function phase3d_interaction(scanUrl) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto(scanUrl, { waitUntil: 'load', timeout: 30000 });

    // ── Step 2: Enumerate triggers ──────────────────────────────────
    const triggers = await page.evaluate(() => {
      function buildSelector(el) {
        if (el.id) return '#' + el.id;
        let sel = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = [...el.classList].filter(c => c.length > 2).slice(0, 3);
          if (cls.length) sel += '.' + cls.join('.');
        }
        const data = [...el.attributes]
          .filter(a => a.name.startsWith('data-'))
          .slice(0, 2);
        if (data.length) sel += data.map(a => `[${a.name}="${a.value}"]`).join('');
        return sel;
      }

      const results = [];
      const seen = new Set();

      // 1. [aria-expanded] elements
      for (const el of document.querySelectorAll('[aria-expanded]')) {
        const sel = buildSelector(el);
        if (seen.has(sel)) continue;
        seen.add(sel);
        results.push({
          selector: sel,
          type: 'aria-expanded',
          controls: el.getAttribute('aria-controls') || null,
          currentState: el.getAttribute('aria-expanded'),
        });
      }

      // 2. [aria-haspopup] without [aria-expanded]
      for (const el of document.querySelectorAll('[aria-haspopup]:not([aria-expanded])')) {
        const sel = buildSelector(el);
        if (seen.has(sel)) continue;
        seen.add(sel);
        results.push({
          selector: sel,
          type: 'aria-haspopup',
          popupType: el.getAttribute('aria-haspopup') || 'true',
          controls: el.getAttribute('aria-controls') || null,
        });
      }

      // 3. [role="tablist"] [role="tab"]
      for (const el of document.querySelectorAll('[role="tablist"] [role="tab"]')) {
        const sel = buildSelector(el);
        if (seen.has(sel)) continue;
        seen.add(sel);
        results.push({
          selector: sel,
          type: 'tab',
          controls: el.getAttribute('aria-controls') || null,
        });
      }

      // 4. [aria-describedby] (tooltip triggers)
      for (const el of document.querySelectorAll('[aria-describedby]')) {
        const sel = buildSelector(el);
        if (seen.has(sel)) continue;
        seen.add(sel);
        results.push({
          selector: sel,
          type: 'tooltip',
          describedby: el.getAttribute('aria-describedby') || null,
          controls: null,
        });
      }

      // 5. Custom dropdown triggers: buttons/divs that toggle sibling/child visibility
      // Look for click-handler patterns: elements with onclick or that look like toggle buttons
      document.querySelectorAll('button:not([aria-expanded]):not([aria-haspopup]), [role="button"]:not([aria-expanded]):not([aria-haspopup])').forEach(el => {
        // Skip if already found as another trigger type
        const sel = buildSelector(el);
        if (results.some(f => f.selector === sel)) return;
        // Check if this button/element has a sibling or child that looks like a dropdown
        const parent = el.parentElement;
        if (!parent) return;
        const possiblePanel = parent.querySelector('ul, [role="listbox"], [role="menu"], .dropdown-menu, .dropdown-content, .popup, .popover, .tooltip-content, select');
        if (possiblePanel && getComputedStyle(possiblePanel).display === 'none') {
          results.push({
            selector: sel,
            type: 'custom-dropdown',
            controls: possiblePanel.id || null,
          });
        }
      });

      // 6. Native <select> elements — scan their options for issues
      document.querySelectorAll('select').forEach(el => {
        const sel = buildSelector(el);
        if (results.some(f => f.selector === sel)) return;
        results.push({
          selector: sel,
          type: 'select',
          optionCount: el.options.length,
        });
      });

      // 7. Elements with CSS :hover/:focus that reveal content
      // Look for elements that have a hidden sibling that could appear on hover
      document.querySelectorAll('.dropdown, .has-dropdown, .has-submenu, [data-toggle], [data-dropdown]').forEach(el => {
        const sel = buildSelector(el);
        if (results.some(f => f.selector === sel)) return;
        results.push({
          selector: sel,
          type: 'data-toggle',
          controls: el.getAttribute('data-target') || el.getAttribute('data-dropdown') || null,
        });
      });

      // 8. Dialog/modal triggers — buttons with data-dismiss, data-toggle="modal", etc.
      document.querySelectorAll('[data-toggle="modal"], [data-bs-toggle="modal"], [data-dismiss="modal"], [data-bs-dismiss="modal"]').forEach(el => {
        const sel = buildSelector(el);
        if (results.some(f => f.selector === sel)) return;
        const target = el.getAttribute('data-target') || el.getAttribute('data-bs-target') || el.getAttribute('href');
        results.push({
          selector: sel,
          type: 'modal-trigger',
          controls: target ? target.replace('#', '') : null,
        });
      });

      return results;
    });

    const triggerCount = triggers.length;
    if (triggerCount > MAX_TRIGGERS) {
      console.log(chalk.yellow(`  ⚠ Interaction scan: ${triggerCount} triggers found but cap is ${MAX_TRIGGERS} — ${triggerCount - MAX_TRIGGERS} trigger(s) skipped. Set MAX_TRIGGERS higher for full coverage.`));
    }
    const capped = triggers.slice(0, MAX_TRIGGERS);
    const issues = [];
    let scannedCount = 0;
    const seenFingerprints = new Set();
    let keyboardActivated = 0;
    let clickFallbackActivated = 0;

    // ── Step 4: Fire each trigger, scan new content ─────────────────
    for (const trigger of capped) {
      // Special handling for native <select> — don't try to open, just scan the element
      if (trigger.type === 'select') {
        try {
          const axeResults = await new AxeBuilder({ page })
            .include(trigger.selector)
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          for (const violation of axeResults.violations) {
            for (const node of violation.nodes) {
              issues.push({
                ...violation,
                source: 'interaction',
                triggerSelector: trigger.selector,
                triggerType: 'select',
                nodes: [node],
                element: node.html,
              });
            }
          }
          scannedCount++;
        } catch { /* skip */ }
        continue; // skip the keyboard activation path
      }

      try {
        // Focus the trigger element, then press the trigger key
        const handle = await page.$(trigger.selector);
        if (!handle) continue;
        await handle.focus();

        // ── Inject MutationObserver to detect dynamically added content ──
        // Watches the FULL document (not just parent) so portal dropdowns,
        // body-level overlays, color pickers, and modals are all captured.
        await page.evaluate(() => {
          // Disconnect any previous observer first
          if (window.__a11yObs) window.__a11yObs.disconnect();
          delete window.__a11yAdded;
          window.__a11yObs = new MutationObserver((mutations) => {
            for (const m of mutations) {
              for (const node of m.addedNodes) {
                if (node.nodeType === 1) { // ELEMENT_NODE
                  if (!window.__a11yAdded) window.__a11yAdded = [];
                  window.__a11yAdded.push({
                    tag: node.tagName,
                    id: node.id || null,
                    parentId: node.parentElement?.id || null,
                    parentTag: node.parentElement?.tagName || null,
                    // Track depth from body for portal detection
                    depth: (() => {
                      let d = 0, p = node.parentElement;
                      while (p && p !== document.body) { d++; p = p.parentElement; }
                      return d;
                    })(),
                  });
                }
              }
            }
          });
          window.__a11yObs.observe(document.body, { childList: true, subtree: true });
        });

        const key = getTriggerKey(trigger);
        await page.keyboard.press(key);
        await page.waitForTimeout(SETTLE_MS);

        // Determine scan target — check if keyboard activation worked
        let scanTarget = trigger.controls ? `#${trigger.controls}` : null;
        let usedClickFallback = false;

        if (scanTarget) {
          // Check if the controlled element is now visible
          const isVisible = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
          }, scanTarget).catch(() => false);

          if (!isVisible) scanTarget = null; // keyboard didn't open it
        }

        // If keyboard activation didn't work, try click fallback
        if (!scanTarget) {
          const urlBefore = page.url();
          try {
            await page.click(trigger.selector, { timeout: 2000 });
            await page.waitForTimeout(SETTLE_MS);

            // Safety: check we didn't navigate away
            if (page.url() !== urlBefore) {
              await page.goBack({ waitUntil: 'load', timeout: 10000 }).catch(() => {});
              continue; // skip this trigger
            }

            // Re-check for scan target
            if (trigger.controls) {
              const nowVisible = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el && getComputedStyle(el).display !== 'none';
              }, `#${trigger.controls}`).catch(() => false);
              if (nowVisible) scanTarget = `#${trigger.controls}`;
            }

            // If still no target, check if any new visible content appeared
            if (!scanTarget) {
              // 1. Check next sibling
              scanTarget = await page.evaluate((trigSel) => {
                const el = document.querySelector(trigSel);
                if (!el) return null;
                const next = el.nextElementSibling;
                if (next && getComputedStyle(next).display !== 'none' && next.children.length > 0) {
                  return next.id ? `#${next.id}` : null;
                }
                return null;
              }, trigger.selector).catch(() => null);
            }

            // 2. If still no target, use MutationObserver to find where new content landed
            //    (covers portal dropdowns, body-level overlays, color pickers, modals, etc.)
            if (!scanTarget) {
              const addedNodes = await page.evaluate(() => {
                if (window.__a11yObs) window.__a11yObs.disconnect();
                const items = window.__a11yAdded || [];
                delete window.__a11yAdded;
                delete window.__a11yObs;
                return items;
              });

              if (addedNodes.length > 0) {
                // ── Find the common parent of all added nodes ──
                // Use parentId if all share one; otherwise walk up from trigger
                // to find the deepest container that wraps the new content.
                const parentIds = [...new Set(addedNodes.map(n => n.parentId).filter(Boolean))];
                const parentTags = [...new Set(addedNodes.map(n => n.parentTag).filter(Boolean))];
                const hasPortalNode = addedNodes.some(n => n.depth <= 1 && n.parentTag === 'BODY');

                if (parentIds.length === 1) {
                  // All added nodes share the same parent — scan that
                  scanTarget = `#${parentIds[0]}`;
                  console.log(chalk.dim(`    interaction-scan: ${addedNodes.length} new node(s) under #${parentIds[0]} → ${scanTarget}`));
                } else if (hasPortalNode) {
                  // At least one node was added to body (portal/layer pattern)
                  scanTarget = 'body';
                  console.log(chalk.dim(`    interaction-scan: ${addedNodes.length} new node(s), some at body level → full page scan`));
                } else {
                  // Multiple parents — find the deepest common ancestor
                  // by walking up from the trigger until we contain all added nodes
                  scanTarget = await page.evaluate((sel, nodeIds) => {
                    const triggerEl = document.querySelector(sel);
                    if (!triggerEl) return 'body';
                    // Check if any added node has a stable ID we can use
                    const stableIds = nodeIds.filter(id => id && id.length > 0);
                    if (stableIds.length > 0) return `#${stableIds[0]}`;
                    return 'body';
                  }, trigger.selector, addedNodes.map(n => n.id).filter(Boolean)).catch(() => 'body');
                  console.log(chalk.dim(`    interaction-scan: ${addedNodes.length} new node(s) scattered → ${scanTarget === 'body' ? 'full page scan' : scanTarget}`));
                }
              }
            }

            usedClickFallback = true;
          } catch {
            // Click failed — skip this trigger
            continue;
          }
        }

        // Fall back to trigger element itself if no controlled element found
        if (!scanTarget) scanTarget = trigger.selector;

        if (usedClickFallback) clickFallbackActivated++;
        else keyboardActivated++;

        // Run scoped Axe scan
        let axeResult;
        try {
          axeResult = await new AxeBuilder({ page })
            .include(scanTarget)
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
        } catch {
          // Axe include selector failed — fall back to full page with context note
          axeResult = null;
        }

        if (axeResult) {
          for (const violation of axeResult.violations) {
            for (const node of violation.nodes || []) {
              const fp = domTokenFingerprint(node.html);
              const dedupKey = `${violation.id}|${fp}`;
              if (seenFingerprints.has(dedupKey)) continue;
              seenFingerprints.add(dedupKey);

              issues.push({
                ruleId: violation.id,
                source: 'interaction',
                impact: violation.impact,
                description: violation.help,
                helpUrl: violation.helpUrl,
                nodes: [{
                  html: node.html,
                  target: node.target?.join(', ') ?? '',
                  fix: node.failureSummary,
                }],
                element: node.html,
                page: scanUrl,
                triggerSelector: trigger.selector,
                triggerType: trigger.type,
                activatedBy: usedClickFallback ? 'click-fallback' : 'keyboard',
              });
            }
          }
        }

        scannedCount++;

        // Always disconnect the MutationObserver now that we've collected its data.
        await page.evaluate(() => {
          if (window.__a11yObs) window.__a11yObs.disconnect();
          delete window.__a11yObs;
          delete window.__a11yAdded;
        }).catch(() => {});

        // Close interaction state: press Escape, wait, check if still expanded
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        // If still expanded, try clicking the trigger to toggle it closed
        try {
          const stillExpanded = await page.$eval(
            trigger.selector,
            el => el.getAttribute('aria-expanded') === 'true',
          ).catch(() => false);
          if (stillExpanded) {
            await handle.click();
            await page.waitForTimeout(200);
          }
        } catch {
          // Best-effort cleanup
        }
      } catch (triggerErr) {
        // Cleanup observer on error
        await page.evaluate(() => {
          if (window.__a11yObs) window.__a11yObs.disconnect();
          delete window.__a11yAdded;
          delete window.__a11yObs;
        }).catch(() => {});
        console.log(chalk.dim(`    interaction-scan: trigger skipped (${trigger.selector}): ${triggerErr.message}`));
      }
    }

    console.log(chalk.dim(`  Interaction scan: ${keyboardActivated} keyboard, ${clickFallbackActivated} click-fallback`));

    // ── Step 6: Cleanup ─────────────────────────────────────────────
    await page.close();
    await ctx.close();
    await browser.close();

    return { issues, triggerCount, scannedCount };
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    return {
      issues: [],
      triggerCount: 0,
      scannedCount: 0,
      scanFailed: true,
      failReason: err.message,
    };
  }
}
