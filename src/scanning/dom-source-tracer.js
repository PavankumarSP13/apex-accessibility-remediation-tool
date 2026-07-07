// ENH-05: DOM Source Tracer
// Traces accessibility issues to the source file that creates the violating element.
// Uses grep tokens from dom-enricher.js (ENH-04) to search the repo.
// Platform-safe: uses pure Node fs, no shell grep dependency.

import fs from 'fs/promises';
import path from 'path';
import { collectSourceFiles, normalizeRelPath } from '../repository/repo-index.js';
import { extractGrepTokens } from './dom-enricher.js';

const TRACEABLE_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx',
  '.cshtml', '.razor',
  '.html', '.htm',
  '.vue', '.svelte',
]);

const MAX_FILES = 200;
const MAX_FILE_SIZE = 500 * 1024; // 500 KB

const TEST_PATH_RE = /(?:^|[/\\])(?:test|spec|vendor|__tests__)(?:[/\\]|$)/i;

const DOM_MUTATION_RE =
  /createElement|innerHTML|(?:\$\s*\()|<\/|\.append\b|appendChild|\.html\s*\(/;
const DOM_APPEND_RE = /\.append\s*\(|\.appendTo\s*\(/;

/**
 * Score a single match to decide relevance.
 * @param {{ file: string, line: number, text: string }} match
 * @param {string} tokenType - type field from extractGrepTokens
 * @returns {number}
 */
function scoreMatch(match, tokenType) {
  let score = 0;
  const ext = path.extname(match.file).toLowerCase();

  // Extension scoring
  if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) score += 10;
  else if (['.cshtml', '.razor'].includes(ext)) score += 8;
  else if (['.html', '.htm'].includes(ext)) score += 5;

  // Line content scoring
  if (DOM_MUTATION_RE.test(match.text)) score += 5;
  if (DOM_APPEND_RE.test(match.text)) score += 3;

  // Token-type scoring — map enricher types to broad categories
  const category = tokenType.includes('id') ? 'id'
    : tokenType.includes('data-attr') ? 'data-attr'
    : tokenType.includes('class') ? 'class'
    : tokenType.includes('label') ? 'label-text'
    : null;

  if (category === 'id') score += 8;
  else if (category === 'data-attr') score += 6;
  else if (category === 'class') score += 3;
  else if (category === 'label-text') score += 2;

  // Penalise test/vendor paths
  if (TEST_PATH_RE.test(match.file)) score -= 10;

  return score;
}

/**
 * Read a snippet of lines around a target line number.
 * @param {string} filePath - Absolute path to the file.
 * @param {number} lineNum  - 1-based line number to centre on.
 * @param {number} [radius=25] - Number of lines above and below.
 * @returns {Promise<string|null>}
 */
async function readSnippetAround(filePath, lineNum, radius = 25) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, lineNum - 1 - radius);
    const end = Math.min(lines.length, lineNum - 1 + radius + 1);
    const snippet = [];
    for (let i = start; i < end; i++) {
      snippet.push(`${i + 1}: ${lines[i]}`);
    }
    return snippet.join('\n');
  } catch {
    return null;
  }
}

/**
 * Trace a single accessibility issue back to the source file that creates it.
 * @param {object} issue    - An enriched accessibility issue.
 * @param {string} repoPath - Absolute path to the repository root.
 * @returns {Promise<object|null>} Match result or null.
 */
export async function traceIssueToSource(issue, repoPath) {
  // 1. Extract tokens
  const tokens = extractGrepTokens(issue);
  if (!tokens.length) return null;

  // 2. Get file list, filter to traceable extensions, cap at MAX_FILES
  const allFiles = await collectSourceFiles(repoPath);
  const files = [];
  for (const absPath of allFiles) {
    if (files.length >= MAX_FILES) break;
    const ext = path.extname(absPath).toLowerCase();
    if (TRACEABLE_EXTS.has(ext)) files.push(absPath);
  }

  // 3. Lazy content cache
  /** @type {Map<string, string>} */
  const cache = new Map();

  async function getContent(absPath) {
    if (cache.has(absPath)) return cache.get(absPath);
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > MAX_FILE_SIZE) {
        cache.set(absPath, null);
        return null;
      }
      const content = await fs.readFile(absPath, 'utf-8');
      cache.set(absPath, content);
      return content;
    } catch {
      cache.set(absPath, null);
      return null;
    }
  }

  // 4. Search — tokens already sorted by priority (ascending = best first)
  for (const { token, type } of tokens) {
    if (token.length < 4) continue;

    const matches = [];

    for (const absPath of files) {
      const content = await getContent(absPath);
      if (!content) continue;

      const idx = content.indexOf(token);
      if (idx === -1) continue;

      const line = content.slice(0, idx).split('\n').length;
      const lines = content.split('\n');
      const relPath = normalizeRelPath(path.relative(repoPath, absPath));

      matches.push({
        file: relPath,
        line,
        text: lines[line - 1] || '',
      });
    }

    if (!matches.length) continue;

    // Score and pick top match
    matches.sort((a, b) => scoreMatch(b, type) - scoreMatch(a, type));
    const best = matches[0];

    // Read snippet around the match
    const absFile = path.resolve(repoPath, best.file);
    const snippet = await readSnippetAround(absFile, best.line);

    return {
      file: best.file,
      line: best.line,
      text: best.text,
      score: scoreMatch(best, type),
      tokenUsed: token,
      tokenType: type,
      snippet,
    };
  }

  // 5. Nothing found
  return null;
}

/**
 * Trace an array of issues to their source files.
 * Sets `issue.jsCreationSite` on each issue that has `domContext`.
 * @param {object[]} issues  - Array of accessibility issues.
 * @param {string}   repoPath - Absolute path to the repository root.
 * @returns {Promise<object[]>} The same array, mutated with jsCreationSite where found.
 */
export async function traceIssuesToSource(issues, repoPath) {
  let traced = 0;
  let skipped = 0;

  for (const issue of issues) {
    if (!issue.domContext) {
      skipped++;
      continue;
    }

    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('trace timeout')), 2000),
      );
      const result = await Promise.race([
        traceIssueToSource(issue, repoPath),
        timeout,
      ]);
      issue.jsCreationSite = result;
      if (result) traced++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  console.log(
    `[ENH-05] Source tracing complete: ${traced} traced, ${skipped} skipped out of ${issues.length} issues.`,
  );
  return issues;
}
