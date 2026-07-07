import path from 'path';
import { MARKUP_EXTS, SCRIPT_EXTS, STYLE_EXTS, SOURCE_EXTS, shouldSkipFile } from '../core/constants.js';
import { collectSourceFiles, normalizeRelPath } from '../repository/repo-index.js';
import { COPILOT_MAX_TEMPLATE_FILES } from '../core/config.js';

const ROLE_ORDER = {
  template: 0,
  'document-template': 1,
  script: 2,
  style: 3,
  other: 4,
};

const sourceFilesByRepoCache = new Map();

async function getTemplateBundleSourceFiles(repoPath) {
  const cacheKey = path.resolve(String(repoPath || ''));
  if (!sourceFilesByRepoCache.has(cacheKey)) {
    const pending = collectSourceFiles(repoPath)
      .then(absFiles => absFiles
        .map(absFile => ({ absFile, relFile: normalizeRelPath(path.relative(repoPath, absFile)) }))
        .filter(({ relFile }) => SOURCE_EXTS.includes(path.extname(relFile).toLowerCase()))
        .filter(({ relFile }) => isTemplateBundleExt(relFile))
        .filter(({ relFile }) => !shouldSkipFile(relFile)))
      .catch(err => {
        sourceFilesByRepoCache.delete(cacheKey);
        throw err;
      });
    sourceFilesByRepoCache.set(cacheKey, pending);
  }
  return sourceFilesByRepoCache.get(cacheKey);
}

export function normalizeTemplateKey(value = '') {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

const NUM_WORD_MAP = Object.freeze({
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten',
});
const WORD_NUM_MAP = Object.freeze(
  Object.fromEntries(Object.entries(NUM_WORD_MAP).map(([k, v]) => [v, k]))
);
const PLURAL_MAP = Object.freeze({
  'columns': 'column', 'rows': 'row', 'graphs': 'graph', 'charts': 'chart',
  'tables': 'table', 'buttons': 'button', 'panels': 'panel', 'tabs': 'tab',
  'fields': 'field', 'labels': 'label', 'values': 'value', 'options': 'option',
  'menus': 'menu', 'items': 'item', 'sections': 'section', 'groups': 'group',
  'boxes': 'box', 'cards': 'card', 'modals': 'modal', 'dialogs': 'dialog',
});
const ABBREV_MAP = Object.freeze({
  'btn': 'button', 'config': 'configuration', 'col': 'column', 'graph': 'graphics',
  'info': 'information', 'nav': 'navigation', 'calc': 'calculator',
  'dialog': 'dialogue', 'img': 'image', 'msg': 'message',
  'num': 'number', 'param': 'parameter', 'props': 'properties',
  'regex': 'regular-expression', 'sel': 'selector', 'temp': 'template',
  'tbl': 'table', 'txt': 'text', 'val': 'value', 'var': 'variable',
});

/**
 * Expand a single part (token) to all its number↔word equivalents.
 * e.g. "2" → ["2", "two"],  "two" → ["two", "2"]
 */
function expandNumberTokens(part) {
  const results = [part];
  const word = NUM_WORD_MAP[part];
  if (word) results.push(word);
  const num = WORD_NUM_MAP[part];
  if (num) results.push(num);
  return [...new Set(results)];
}

/**
 * Given a spaced, normalized template name (e.g. "2 column graph"),
 * produce additional variant forms by swapping numbers↔words,
 * singularizing plurals, and expanding common abbreviations.
 *
 * Each expanded form is then run through buildTemplateNameVariants
 * to produce the full set of casing/separator variants.
 */
function expandSemanticVariants(spaced) {
  if (!spaced) return [];
  const parts = spaced.split(/\s+/).filter(Boolean);
  const expandedSets = parts.map(part => {
    const expansions = [part];
    // Number ↔ word
    const word = NUM_WORD_MAP[part];
    if (word) expansions.push(word);
    const num = WORD_NUM_MAP[part];
    if (num) expansions.push(num);
    // Singularize (if plural)
    const singular = PLURAL_MAP[part];
    if (singular) expansions.push(singular);
    // Pluralize (reverse plural map lookup)
    for (const [pl, sg] of Object.entries(PLURAL_MAP)) {
      if (sg === part) expansions.push(pl);
    }
    // Abbreviation expansion
    const expanded = ABBREV_MAP[part];
    if (expanded) expansions.push(expanded);
    // Abbreviation reverse (abbreviate)
    for (const [abbr, full] of Object.entries(ABBREV_MAP)) {
      if (full === part) expansions.push(abbr);
    }
    return [...new Set(expansions)];
  });

  // Generate all combinations of expanded tokens (cartesian product)
  // but cap at 32 combos to avoid combinatorial explosion
  const combos = cartesianProduct(expandedSets, 32);
  return combos.map(tokens => tokens.join(' '));
}

function cartesianProduct(arrays, maxCombos = 32) {
  if (arrays.length === 0) return [];
  let result = arrays[0].map(item => [item]);
  for (let i = 1; i < arrays.length; i++) {
    const next = [];
    for (const existing of result) {
      for (const item of arrays[i]) {
        next.push([...existing, item]);
        if (next.length >= maxCombos) break;
      }
      if (next.length >= maxCombos) break;
    }
    result = next;
  }
  return result;
}

export function buildTemplateNameVariants(templateName = '') {
  const spaced = normalizeTemplateKey(templateName);
  if (!spaced) return [];

  // 1. Generate the base casing/separator variants
  const parts = spaced.split(/\s+/).filter(Boolean);
  const variants = new Set();

  const addConventionVariants = (phrase) => {
    const p = phrase.split(/\s+/).filter(Boolean);
    if (p.length === 0) return;
    variants.add(p.join(''));           // compact
    variants.add(p.join('-'));          // kebab
    variants.add(p.join('_'));          // snake
    variants.add(p.join(' '));          // spaced
    const pascal = p.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
    variants.add(pascal);               // pascal
    variants.add(pascal.charAt(0).toLowerCase() + pascal.slice(1));  // camel
  };

  // Base variants from original name
  addConventionVariants(spaced);

  // 2. Also generate variants from the original name WITHOUT any separator
  //    (in case the template name is already compact like "2columngraph")
  addConventionVariants(parts.join(''));

  // 3. Semantic expansions: number↔word, singular↔plural, abbreviations
  for (const expanded of expandSemanticVariants(spaced)) {
    addConventionVariants(expanded);
  }

  // 4. Also expand the compact form for cases like "2columngraph"
  const compactSpaced = parts.join('').replace(/([a-zA-Z])(\d)/g, '$1 $2').replace(/(\d)([a-zA-Z])/g, '$1 $2');
  if (compactSpaced !== spaced) {
    for (const expanded of expandSemanticVariants(compactSpaced)) {
      addConventionVariants(expanded);
    }
  }

  return [...variants].filter(Boolean);
}

function compareKey(value = '') {
  return normalizeTemplateKey(value).replace(/\s+/g, '');
}

function classifyRole(relFile) {
  const normalized = relFile.toLowerCase();
  const ext = path.extname(normalized);
  if (normalized.includes('/documenttemplates/') && (ext === '.cshtml' || ext === '.razor')) return 'document-template';
  if (MARKUP_EXTS.includes(ext)) return 'template';
  if (SCRIPT_EXTS.includes(ext)) return 'script';
  if (STYLE_EXTS.includes(ext)) return 'style';
  return 'other';
}

function scoreFile(relFile, role, normalizedKeys) {
  const basename = path.basename(relFile, path.extname(relFile));
  const fileKey = compareKey(basename);
  const pathKey = compareKey(relFile);
  let score = 0;
  let matched = false;
  for (const key of normalizedKeys) {
    const compactKey = compareKey(key);
    if (!compactKey) continue;
    if (fileKey === compactKey) {
      score += 100;
      matched = true;
    } else if (fileKey.includes(compactKey)) {
      score += 45;
      matched = true;
    } else if (pathKey.includes(compactKey)) {
      score += 20;
      matched = true;
    }
  }
  if (!matched) return 0;
  score += Math.max(0, 20 - relFile.split('/').length);
  score -= (ROLE_ORDER[role] ?? ROLE_ORDER.other) * 4;
  return score;
}

function displayVariant(value = '') {
  return path.basename(String(value || ''), path.extname(String(value || '')));
}

function collectMatchedVariants(scoredFiles, normalizedKeys) {
  const variants = new Set(normalizedKeys);
  for (const file of scoredFiles) {
    const basename = displayVariant(file.relFile);
    const pathParts = file.relFile.split(/[\\/]+/).map(part => displayVariant(part)).filter(Boolean);
    for (const value of [basename, ...pathParts]) {
      const key = compareKey(value);
      if (normalizedKeys.some(candidate => key.includes(compareKey(candidate)))) variants.add(value);
    }
  }
  return [...variants];
}

function confidenceFor(score) {
  if (score >= 90) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

function isTemplateBundleExt(relFile) {
  const ext = path.extname(relFile).toLowerCase();
  return MARKUP_EXTS.includes(ext) || SCRIPT_EXTS.includes(ext) || STYLE_EXTS.includes(ext);
}

export async function resolveTemplateNamedSourceFiles(templateName, repoPath, { maxFiles = COPILOT_MAX_TEMPLATE_FILES } = {}) {
  if (!templateName || !repoPath) {
    return {
      templateName: templateName || '',
      normalizedKeys: [],
      files: { templates: [], styles: [], scripts: [], documentTemplates: [], other: [] },
      flatFiles: [],
      confidence: 'low',
      via: 'template-name-bundle',
    };
  }

  const normalizedKeys = buildTemplateNameVariants(templateName);
  const allFiles = await getTemplateBundleSourceFiles(repoPath);

  const scored = [];
  for (const file of allFiles) {
    const role = classifyRole(file.relFile);
    let score = scoreFile(file.relFile, role, normalizedKeys);
    if (score <= 0) continue;
    scored.push({ ...file, role, score, confidence: confidenceFor(score) });
  }

  scored.sort((a, b) => b.score - a.score || (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99));
  const capped = maxFiles > 0 ? scored.slice(0, maxFiles) : scored;
  const files = {
    templates: capped.filter(f => f.role === 'template').map(f => f.relFile),
    styles: capped.filter(f => f.role === 'style').map(f => f.relFile),
    scripts: capped.filter(f => f.role === 'script').map(f => f.relFile),
    documentTemplates: capped.filter(f => f.role === 'document-template').map(f => f.relFile),
    other: capped.filter(f => f.role === 'other').map(f => f.relFile),
  };
  const flatFiles = [...new Set(Object.values(files).flat())];
  return {
    templateName,
    normalizedKeys: collectMatchedVariants(capped, normalizedKeys),
    files,
    flatFiles,
    confidence: capped[0]?.confidence || 'low',
    via: 'template-name-bundle',
  };
}

export async function resolveSlideTemplateFiles(templateName, repoPath, options = {}) {
  return resolveTemplateNamedSourceFiles(templateName, repoPath, options);
}
