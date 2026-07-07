/**
 * good-to-have-scanner.js
 *
 * "Good-to-have" accessibility checks that go beyond strict WCAG compliance.
 * These detect quality issues that automated scanners typically miss, such as
 * misleading or low-quality alt text on images and visible page sections that
 * lack semantic landmarks.
 *
 * Results are presented as non-blocking suggestions to help improve overall
 * accessibility quality.
 */

import chalk from 'chalk';

// Patterns that indicate generic / auto-generated alt text
const GENERIC_ALT_PATTERNS = /^(image|photo|picture|img|icon|banner|logo|untitled|screenshot|graphic|dsc_|img_|\.\w{2,4})$/i;

/**
 * Finds images with technically-present but potentially misleading or useless
 * alt text (generic phrases, filename echoes, suspicious length, etc.).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<object>>} Array of good-to-have issue objects.
 */
export async function detectAltTextQualityIssues(page) {
  try {
    const images = await page.evaluate(() => {
      return [...document.querySelectorAll('img[alt]')].map(img => {
        const alt = img.getAttribute('alt') || '';
        const src = img.getAttribute('src') || '';
        const rect = img.getBoundingClientRect();
        // Capture surrounding text context from the nearest meaningful ancestor
        let parentContext = '';
        let el = img.parentElement;
        for (let depth = 0; depth < 3 && el && el !== document.body; depth++, el = el.parentElement) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          if (text.length > 20) { parentContext = text; break; }
        }
        return {
          alt,
          src,
          srcFilename: src.split('/').pop().split('?')[0],
          width: rect.width,
          height: rect.height,
          isDecorative: alt === '',
          isVisible: rect.width > 0 && rect.height > 0,
          html: img.outerHTML.slice(0, 300),
          parentContext,
          selector: img.id
            ? '#' + img.id
            : img.className
              ? 'img.' + [...img.classList].slice(0, 2).join('.')
              : 'img[src="' + src.slice(0, 80) + '"]',
        };
      });
    });

    const issues = [];

    for (const img of images) {
      // Skip invisible images and intentionally decorative images (alt="")
      if (!img.isVisible) continue;
      if (img.isDecorative) continue;

      const alt = img.alt.trim();
      const altLower = alt.toLowerCase();

      // --- Generic alt text ---
      if (GENERIC_ALT_PATTERNS.test(altLower)) {
        issues.push({
          type: 'good-to-have',
          category: 'alt-text-quality',
          ruleId: 'alt-text-quality',
          description: `Image has generic alt text "${alt}" that does not describe the content`,
          impact: 'moderate',
          element: img.html,
          selector: img.selector,
          suggestion: 'Replace the alt text with a meaningful description of what the image shows',
          currentAlt: img.alt,
          src: img.src,
        });
        continue; // one issue per image is enough
      }

      // --- Alt text matches filename (likely auto-generated) ---
      if (img.srcFilename) {
        const normalized = img.srcFilename
          .replace(/\.\w{2,5}$/, '') // strip extension
          .replace(/[-_]/g, '')      // strip separators
          .toLowerCase();
        const altNormalized = alt.replace(/[-_\s]/g, '').toLowerCase();

        if (normalized && altNormalized && (normalized === altNormalized || altNormalized.includes(normalized) || normalized.includes(altNormalized))) {
          issues.push({
            type: 'good-to-have',
            category: 'alt-text-quality',
            ruleId: 'alt-text-quality',
            description: `Image alt text "${alt}" appears to match the filename — likely auto-generated`,
            impact: 'moderate',
            element: img.html,
            selector: img.selector,
            suggestion: 'Replace the alt text with a human-written description of the image content',
            currentAlt: img.alt,
            src: img.src,
          });
          continue;
        }
      }

      // --- Alt text too short (placeholder) ---
      if (alt.length < 5 && img.width > 100) {
        issues.push({
          type: 'good-to-have',
          category: 'alt-text-quality',
          ruleId: 'alt-text-quality',
          description: `Image alt text "${alt}" is suspiciously short (${alt.length} chars) for a ${Math.round(img.width)}px-wide image`,
          impact: 'moderate',
          element: img.html,
          selector: img.selector,
          suggestion: 'Provide a more descriptive alt text, or set alt="" if the image is purely decorative',
          currentAlt: img.alt,
          src: img.src,
        });
        continue;
      }

      // --- Alt text too long (paragraph stuffed into alt) ---
      if (alt.length > 150) {
        issues.push({
          type: 'good-to-have',
          category: 'alt-text-quality',
          ruleId: 'alt-text-too-long',
          description: `Image alt text is excessively long (${alt.length} chars) — screen readers will read the full text verbatim`,
          impact: 'moderate',
          element: img.html,
          selector: img.selector,
          suggestion: 'Shorten to a concise description under 150 characters that captures the essential meaning',
          currentAlt: img.alt,
          src: img.src,
          parentContext: img.parentContext || null,
        });
        continue;
      }

      // --- Alt text likely mismatched with image content ---
      if (img.parentContext) {
        const contextWords = img.parentContext.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
        const altWords = altLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
        const overlap = altWords.filter(w => contextWords.includes(w)).length;
        const filenameWords = (img.srcFilename || '').replace(/\.\w{2,5}$/, '').replace(/[-_]/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const filenameInAlt = filenameWords.filter(w => altWords.includes(w)).length;
        // Flag if filename words appear in alt but NOT in surrounding context — suggests copy-paste from filename
        if (filenameInAlt > 0 && overlap === 0 && contextWords.length > 3 && altWords.length > 0) {
          issues.push({
            type: 'good-to-have',
            category: 'alt-text-quality',
            ruleId: 'alt-text-mismatch',
            description: `Image alt text "${alt}" appears derived from the filename and may not match the image's semantic meaning in context`,
            impact: 'moderate',
            element: img.html,
            selector: img.selector,
            suggestion: 'Review the alt text to ensure it describes what the image actually conveys in this context',
            currentAlt: img.alt,
            src: img.src,
            parentContext: img.parentContext,
          });
          continue;
        }
      }
    }

    return issues;
  } catch (err) {
    console.warn(`[good-to-have] detectAltTextQualityIssues failed: ${err.message}`);
    return [];
  }
}

/**
 * Finds visible, substantial page sections (direct children of <body>) that
 * lack semantic landmark roles, making keyboard/screen-reader navigation
 * harder.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<object>>} Array of good-to-have issue objects.
 */
export async function detectLandmarkGaps(page) {
  try {
    const sections = await page.evaluate(() => {
      const bodyChildren = [...document.body.children];
      const results = [];

      for (const el of bodyChildren) {
        const rect = el.getBoundingClientRect();
        if (rect.height < 50 || rect.width < 100) continue;
        if (getComputedStyle(el).display === 'none') continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const isLandmark =
          ['header', 'footer', 'main', 'nav', 'aside', 'section', 'form'].includes(tag) ||
          ['banner', 'contentinfo', 'main', 'navigation', 'complementary', 'region', 'form', 'search'].includes(role);

        // Check if this element is inside a landmark
        let parent = el.parentElement;
        let insideLandmark = false;
        while (parent && parent !== document.body) {
          const pTag = parent.tagName.toLowerCase();
          const pRole = parent.getAttribute('role');
          if (
            ['header', 'footer', 'main', 'nav', 'aside'].includes(pTag) ||
            ['banner', 'contentinfo', 'main', 'navigation', 'complementary', 'region'].includes(pRole)
          ) {
            insideLandmark = true;
            break;
          }
          parent = parent.parentElement;
        }

        if (!isLandmark && !insideLandmark) {
          const text = (el.textContent || '').trim().slice(0, 100);
          const hasInteractiveContent = el.querySelector('a, button, input, select, textarea') !== null;
          results.push({
            tag,
            id: el.id || null,
            classes: [...el.classList].slice(0, 3),
            role,
            height: rect.height,
            text,
            hasInteractive: hasInteractiveContent,
            childCount: el.children.length,
            html: el.outerHTML.slice(0, 200),
          });
        }
      }

      return results;
    });

    const issues = [];

    for (const section of sections) {
      // Only flag substantial sections (tall enough or has interactive content)
      if (section.height <= 100 && !section.hasInteractive) continue;

      issues.push({
        type: 'good-to-have',
        category: 'landmark-gap',
        ruleId: 'landmark-gap',
        description: `Visible page section <${section.tag}> with ${section.childCount} children has no landmark role`,
        impact: 'minor',
        element: section.html,
        selector: section.id
          ? '#' + section.id
          : section.tag + (section.classes.length ? '.' + section.classes.join('.') : ''),
        suggestion: 'Consider adding an appropriate landmark role (e.g., role="region" with aria-label, or use a semantic HTML element like <section>, <nav>, <aside>)',
      });
    }

    return issues;
  } catch (err) {
    console.warn(`[good-to-have] detectLandmarkGaps failed: ${err.message}`);
    return [];
  }
}

/**
 * Detects images that are missing the alt attribute entirely.
 * This is a WCAG 1.1.1 Level A violation — NOT a good-to-have suggestion.
 * Returns issues in the standard issue shape so they flow into the unified pipeline.
 *
 * @param {import('playwright').Page} page
 * @param {string} pageUrl
 * @returns {Promise<Array<object>>}
 */
export async function detectMissingAltIssues(page, pageUrl) {
  try {
    const noAltImages = await page.evaluate(() => {
      return [...document.querySelectorAll('img:not([alt])')].map(img => {
        const src = img.getAttribute('src') || '';
        const rect = img.getBoundingClientRect();
        return {
          src,
          isVisible: rect.width > 0 && rect.height > 0,
          html: img.outerHTML.slice(0, 300),
          selector: img.id
            ? '#' + img.id
            : img.className
              ? 'img.' + [...img.classList].slice(0, 2).join('.')
              : 'img[src="' + src.slice(0, 80) + '"]',
        };
      });
    });

    return noAltImages
      .filter(img => img.isVisible)
      .map(img => ({
        source: 'image-alt',
        ruleId: 'image-alt',
        impact: 'critical',
        description: 'Image is missing the alt attribute (WCAG 1.1.1 Level A). Screen readers cannot describe this image to users.',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.7/image-alt',
        nodes: [{ html: img.html, target: img.selector, fix: 'Add a descriptive alt attribute, or alt="" if the image is purely decorative' }],
        element: img.html,
        page: pageUrl,
      }));
  } catch (err) {
    console.warn(`[image-alt] detectMissingAltIssues failed: ${err.message}`);
    return [];
  }
}

/**
 * Runs all good-to-have scans and returns combined results.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{altTextIssues: Array, landmarkGaps: Array, totalSuggestions: number}>}
 */
export async function runGoodToHaveScans(page) {
  const results = { altTextIssues: [], landmarkGaps: [], totalSuggestions: 0 };

  try {
    results.altTextIssues = await detectAltTextQualityIssues(page);
  } catch { /* ignore */ }

  try {
    results.landmarkGaps = await detectLandmarkGaps(page);
  } catch { /* ignore */ }

  results.totalSuggestions = results.altTextIssues.length + results.landmarkGaps.length;
  return results;
}

/**
 * Displays a human-readable summary of good-to-have suggestions and returns
 * the collected items for inclusion in reports.
 *
 * @param {object} goodToHaveResults - Output from runGoodToHaveScans().
 * @returns {Promise<{apply: boolean, items: Array}>}
 */
export async function promptGoodToHaveActions(goodToHaveResults) {
  if (goodToHaveResults.totalSuggestions === 0) return { apply: false, items: [] };

  console.log(chalk.bold.cyan('\n  ──────────────────────────────────────────────────────────'));
  console.log(chalk.bold.cyan('  Good-to-have suggestions found'));
  console.log(chalk.bold.cyan('  ──────────────────────────────────────────────────────────\n'));

  const items = [];

  if (goodToHaveResults.altTextIssues.length > 0) {
    console.log(chalk.yellow(`  Alt text quality issues: ${goodToHaveResults.altTextIssues.length}`));
    for (const issue of goodToHaveResults.altTextIssues.slice(0, 5)) {
      console.log(chalk.dim(`    · ${issue.description}`));
      if (issue.currentAlt) console.log(chalk.dim(`      Current alt: "${issue.currentAlt}"`));
    }
    if (goodToHaveResults.altTextIssues.length > 5) {
      console.log(chalk.dim(`    ... and ${goodToHaveResults.altTextIssues.length - 5} more`));
    }
    items.push(...goodToHaveResults.altTextIssues);
  }

  if (goodToHaveResults.landmarkGaps.length > 0) {
    console.log(chalk.yellow(`\n  Landmark gap suggestions: ${goodToHaveResults.landmarkGaps.length}`));
    for (const issue of goodToHaveResults.landmarkGaps.slice(0, 5)) {
      console.log(chalk.dim(`    · ${issue.description}`));
    }
    if (goodToHaveResults.landmarkGaps.length > 5) {
      console.log(chalk.dim(`    ... and ${goodToHaveResults.landmarkGaps.length - 5} more`));
    }
    items.push(...goodToHaveResults.landmarkGaps);
  }

  console.log(chalk.bold(`\n  Total: ${goodToHaveResults.totalSuggestions} suggestion(s)`));
  console.log(chalk.dim('  These are enhancement suggestions beyond WCAG compliance.\n'));

  // Return the items for the report — actual interactive prompt would need readline
  // For non-interactive mode, just include in report
  return { apply: false, items };
}
