import path from 'path';
import { parse as parseJs } from '@babel/parser';
import * as parse5 from 'parse5';
import postcss from 'postcss';
import postcssSafeParser from 'postcss-safe-parser';
import postcssScss from 'postcss-scss';
import postcssLess from 'postcss-less';
import chalk from 'chalk';
import { STYLE_EXTS } from '../core/constants.js';

export function getBabelPluginsForFile(relFile, content = '') {
  const ext = path.extname(relFile).toLowerCase();
  const plugins = [
    'classProperties', 'topLevelAwait', 'importAttributes',
    'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport',
    'objectRestSpread', 'optionalCatchBinding', 'numericSeparator',
    'classPrivateProperties', 'classPrivateMethods', 'exportDefaultFrom',
    'exportNamespaceFrom', 'throwExpressions',
    ['decorators', { decoratorsBeforeExport: true }],
  ];
  if (ext === '.ts' || ext === '.tsx') plugins.push('typescript');
  if (ext === '.jsx' || ext === '.tsx' || /<[A-Z][\w]*/.test(content)) plugins.push('jsx');
  return plugins;
}

export function sanitizeServerSideMarkup(content) {
  return content
    .replace(/@\{[\s\S]*?\}/g, ' ')
    .replace(/@\([^)]*\)/g, ' ')
    .replace(/@?[A-Za-z_][\w.]*\([^)]*\)/g, ' ')
    .replace(/@[A-Za-z_][\w.]*/g, ' ');
}

export function getStyleParserForFile(relFile) {
  const ext = path.extname(relFile).toLowerCase();
  if (ext === '.scss' || ext === '.sass') return postcssScss;
  if (ext === '.less') return postcssLess;
  return undefined;
}

export function applyValidatedPatches(fileLines, validPatches) {
  const resultLines = [...fileLines];
  for (const patch of [...validPatches].sort((a, b) => b.startLine - a.startLine)) {
    const start = patch.startLine - 1;
    const deleteCount = patch.endLine - patch.startLine + 1;
    resultLines.splice(start, deleteCount, ...patch.replacement.split('\n'));
  }
  return resultLines.join('\n');
}

export function extractTaggedBlocks(content, tagName) {
  const re = new RegExp(`<${tagName}([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  return [...content.matchAll(re)].map(m => ({ attrs: m[1] || '', content: m[2] || '' }));
}

// Canonical event.key values that Copilot frequently writes in wrong casing.
// Keys: wrong-casing pattern → correct value.
const EVENT_KEY_WRONG_CASING = {
  tab: 'Tab', enter: 'Enter', escape: 'Escape', esc: 'Escape',
  space: ' ', spacebar: ' ',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  delete: 'Delete', backspace: 'Backspace', insert: 'Insert',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
};

function checkEventKeyCasing(content) {
  // Match: .key === 'value', .key !== 'value', .key == 'value'
  const keyPattern = /\.key\s*[!=]==?\s*['"]([^'"]+)['"]/g;
  const warnings = [];
  let m;
  while ((m = keyPattern.exec(content)) !== null) {
    const used = m[1];
    const correct = EVENT_KEY_WRONG_CASING[used.toLowerCase()];
    if (correct && used !== correct) {
      warnings.push(`event.key value '${used}' should be '${correct}' (wrong casing — see MDN KeyboardEvent.key)`);
    }
  }
  return warnings;
}

export function validatePatchedContent(relFile, original, fixed) {
  const ext = path.extname(relFile).toLowerCase();
  try {
    if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
      parseJs(fixed, { sourceType: 'unambiguous', plugins: getBabelPluginsForFile(relFile, fixed), errorRecovery: false });
      const keyWarnings = checkEventKeyCasing(fixed);
      if (keyWarnings.length > 0) return { ok: false, reason: keyWarnings[0], keyWarnings };
      return { ok: true };
    }
    if (['.html', '.htm'].includes(ext)) {
      parse5.parse(fixed);
      const keyWarnings = checkEventKeyCasing(fixed);
      if (keyWarnings.length > 0) return { ok: false, reason: keyWarnings[0], keyWarnings };
      return { ok: true };
    }
    if (['.cshtml', '.razor'].includes(ext)) {
      const sanitizedOriginal = sanitizeServerSideMarkup(original);
      const sanitizedFixed = sanitizeServerSideMarkup(fixed);
      parse5.parseFragment(sanitizedFixed);
      const count = (text, token) => (text.match(token) || []).length;
      const originalBraceDrift = Math.abs(count(sanitizedOriginal, /\{/g) - count(sanitizedOriginal, /\}/g));
      const fixedBraceDrift = Math.abs(count(sanitizedFixed, /\{/g) - count(sanitizedFixed, /\}/g));
      if (fixedBraceDrift > originalBraceDrift + 1) throw new Error('razor-template-brace-drift');
      if (/<[^>]*$/.test(sanitizedFixed.trim())) throw new Error('razor-template-truncated-tag');
      const keyWarnings = checkEventKeyCasing(fixed);
      if (keyWarnings.length > 0) return { ok: false, reason: keyWarnings[0], keyWarnings };
      return { ok: true };
    }
    if (STYLE_EXTS.includes(ext)) {
      postcss.parse(fixed, { parser: getStyleParserForFile(relFile) || postcssSafeParser });
      return { ok: true };
    }
    if (ext === '.vue' || ext === '.svelte') {
      parse5.parseFragment(fixed);
      for (const block of extractTaggedBlocks(fixed, 'script')) {
        const lang = /lang\s*=\s*["']([^"']+)["']/i.exec(block.attrs)?.[1]?.toLowerCase() || '';
        const virtualExt = lang.includes('ts') ? '.ts' : '.js';
        if (block.content.trim()) {
          parseJs(block.content, { sourceType: 'module', plugins: getBabelPluginsForFile(`x${virtualExt}`, block.content) });
          const keyWarnings = checkEventKeyCasing(block.content);
          if (keyWarnings.length > 0) return { ok: false, reason: keyWarnings[0], keyWarnings };
        }
      }
      for (const block of extractTaggedBlocks(fixed, 'style')) {
        const lang = /lang\s*=\s*["']([^"']+)["']/i.exec(block.attrs)?.[1]?.toLowerCase() || 'css';
        const virtualExt = lang.includes('scss') ? '.scss' : lang.includes('less') ? '.less' : '.css';
        postcss.parse(block.content, { parser: getStyleParserForFile(`x${virtualExt}`) || postcssSafeParser });
      }
      return { ok: true };
    }
    return { ok: true };
  } catch (err) {
    const msg = err.message || 'parser-validation-failed';
    // Log the line that caused the parse failure for debugging
    const lineMatch = msg.match(/\((\d+):(\d+)\)/);
    let context = '';
    if (lineMatch) {
      const line = parseInt(lineMatch[1]);
      const lines = fixed.split('\n');
      const start = Math.max(0, line - 3);
      const end = Math.min(lines.length, line + 2);
      context = lines.slice(start, end).map((l, i) => `  ${start + i + 1}${start + i + 1 === line ? ' →' : '  '} ${l}`).join('\n');
      console.log(chalk.dim(`\n  Parse failure in ${relFile} at line ${line}:\n${context}\n`));
    }
    return { ok: false, reason: msg, failureLine: lineMatch ? parseInt(lineMatch[1]) : null, context };
  }
}

export const PA11Y_TO_AXE = {
  'WCAG2AA.Principle1.Guideline1_4.1_4_3': 'color-contrast',
  'WCAG2AA.Principle1.Guideline1_4.1_4_3.G18': 'color-contrast',
  'WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail': 'color-contrast',
  'WCAG2AA.Principle1.Guideline1_4.1_4_3.G145': 'color-contrast',
  'WCAG2AA.Principle1.Guideline1_1.1_1_1': 'image-alt',
  'WCAG2AA.Principle1.Guideline1_1.1_1_1.H37': 'image-alt',
  'WCAG2AA.Principle1.Guideline1_1.1_1_1.H67': 'image-alt',
  // H91 sub-types: more specific entries MUST come before the generic H91 fallback
  // because toAxeRuleId uses prefix matching — longer prefixes are checked via exact match first.
  'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Button.Name': 'button-name',
  'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.A.Name': 'link-name',
  'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.A.NoContent': 'link-name',
  'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.InputText.Name': 'label',
  'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Select.Name': 'select-name',
  'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Select.Value': 'select-name',
  'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Textarea.Name': 'label',
  'WCAG2AA.Principle4.Guideline4_1.4_1_2': 'label',
  'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91': 'label',
  'WCAG2AA.Principle1.Guideline1_3.1_3_1': 'label',
  'WCAG2AA.Principle1.Guideline1_3.1_3_1.F68': 'label',
  'WCAG2AA.Principle1.Guideline1_3.1_3_1.H44': 'label',
  'WCAG2AA.Principle1.Guideline1_3.1_3_1.H71': 'fieldset',
  'WCAG2AA.Principle2.Guideline2_4.2_4_1': 'bypass',
  'WCAG2AA.Principle2.Guideline2_4.2_4_2': 'document-title',
  'WCAG2AA.Principle2.Guideline2_4.2_4_4': 'link-name',
  'WCAG2AA.Principle3.Guideline3_1.3_1_1': 'html-has-lang',
  'WCAG2AA.Principle3.Guideline3_1.3_1_2': 'valid-lang',
  'WCAG2AA.Principle1.Guideline1_3.1_3_1.H48': 'list',
  'WCAG2AA.Principle1.Guideline1_3.1_3_1.H49': 'p-as-heading',
  // NOTE: G18.BgImage is NOT mapped — it's about background images where contrast
  // can't be computed algorithmically. It's permanently manual-review.
};

/**
 * Normalize a violation's ruleId to an Axe-compatible rule ID.
 * Returns null if no Axe equivalent exists (verification should be skipped).
 */
export function toAxeRuleId(ruleId, source) {
  if (!ruleId) return null;
  // Axe rule IDs are lowercase, short, hyphenated (e.g. "color-contrast", "image-alt")
  if (source === 'axe') return ruleId;
  if (source === 'lighthouse') return ruleId; // Lighthouse IDs mostly match Axe
  if (source === 'pa11y') {
    // Try exact match first, then prefix matches
    if (PA11Y_TO_AXE[ruleId]) return PA11Y_TO_AXE[ruleId];
    const prefix = Object.keys(PA11Y_TO_AXE).find(k => ruleId.startsWith(k));
    if (prefix) return PA11Y_TO_AXE[prefix];
    return null; // No Axe equivalent — skip verification for this rule
  }
  if (ruleId.includes('page-has-heading') || ruleId === 'page-has-heading-one') return 'page-has-heading-one';
  return null;
}

// Hot-served assets reflected by the target app without a rebuild.
export const STATIC_SERVE_EXTS = new Set(['.css', '.js', '.mjs', '.cjs', '.html', '.htm', '.cshtml', '.razor']);

// FIX-07: .NET precompiled apps require rebuild for Razor views even though
// they look like templates.  When projectType is 'dotnet', .cshtml/.razor
// are NOT treated as hot-served.
export function fixNeedsBuild(relFile, projectType = null) {
  const ext = path.extname(relFile).toLowerCase();
  if (projectType === 'dotnet' && (ext === '.cshtml' || ext === '.razor')) return true;
  return !STATIC_SERVE_EXTS.has(ext);
}

export function normalizeIssueText(text) {
  return String(text || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/\b(?:mjx|mathjax)[-_]?[a-z0-9:_-]*\b/gi, '<math-renderer>')
    .replace(/:nth-(?:child|of-type)\(\d+\)/gi, ':nth-child(<n>)')
    .replace(/\b(id|for|aria-labelledby|aria-describedby)=["'][^"']*(?:\d{3,}|[0-9a-f]{6,})[^"']*["']/gi, '$1="<volatile>"')
    .replace(/#[A-Za-z_-]*\d{3,}[A-Za-z0-9_-]*/g, '#<volatile>')
    .replace(/\.[A-Za-z_-]*\d{3,}[A-Za-z0-9_-]*/g, '.<volatile>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
