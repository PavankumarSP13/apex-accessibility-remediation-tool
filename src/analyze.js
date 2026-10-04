import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { logger } from './core/logger.js';
import {
  STYLE_EXTS,
  SCRIPT_EXTS,
  MARKUP_EXTS,
  shouldSkipFile,
  isBinaryFile,
  isThirdPartyFile,
  Solvability,
  NON_FIXABLE_SOLVABILITY,
  MANUAL_REVIEW_SOLVABILITY,
  CLOSED_SOLVABILITY,
  ROOT_CAUSE_RULE_MAP,
  buildIssueEligibility,
  classifyIssueSolvability,
  shouldStopForManualReviewEntry,
  isManualReviewHardStop,
  isUnsupportedSemanticTransformIssue,
  isAttemptableSemanticTransformIssue,
} from './core/constants.js';
import { DOCUMENT_LEVEL_RULES, HEADING_STRUCTURE_RULES, TRANSFORMATION_CATALOG, TRUE_SLIDE_TEMPLATES, classifyFileOwnership, discoverDocumentTemplates } from './architecture/app-architecture.js';
import { normalizeRelPath, collectSourceFiles, getRouteTokens } from './repository/repo-index.js';
import { toAxeRuleId } from './remediation/patch.js';
import { routeIssueToSlideFiles } from './architecture/slide-resolver.js';

export function buildViolationDomContext(violation) {
  const html = [violation.element ?? '', ...(violation.nodes || []).map(n => n.html ?? '')].filter(Boolean).join(' ');
  const selector = (violation.nodes || []).map(n => n.target || '').filter(Boolean).join(' ');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const classes = [...html.matchAll(/\bclass(?:Name)?="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)).filter(Boolean);
  const dataAttrs = [...html.matchAll(/\bdata-[\w-]+="([^"]+)"/g)].map(m => m[1]);
  const text = [...html.matchAll(/>([^<]{4,50})</g)].map(m => m[1].trim()).filter(Boolean);
  return {
    pageUrl: violation.page || null,
    html,
    selector,
    ids,
    classes,
    dataAttrs,
    text,
    routeTokens: violation.page ? getRouteTokens(violation.page) : [],
  };
}

/**
 * Extract rendered HTML snippet around a violated element from the full page HTML.
 * Uses the violation's selector/element HTML to locate it in the rendered DOM.
 * Returns a trimmed snippet (max ~2000 chars) showing DOM context around the violation.
 */
export function extractRenderedDomContext(pageHtml, violation) {
  if (!pageHtml) return '';
  const nodeHtml = violation.nodes?.[0]?.html || violation.element || '';
  const selector = violation.nodes?.[0]?.target || '';

  // Try to find the exact element snippet in the rendered page
  let matchIdx = -1;
  if (nodeHtml.length > 10) {
    // Use the first 80 chars of the element HTML as a search anchor
    const searchSnippet = nodeHtml.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(searchSnippet);
    const m = rx.exec(pageHtml);
    if (m) matchIdx = m.index;
  }

  // Fallback: search by class names or ID from the selector
  if (matchIdx === -1 && selector) {
    const classMatches = [...selector.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    const idMatches = [...selector.matchAll(/#([\w-]+)/g)].map(m => m[1]);
    for (const id of idMatches) {
      const idx = pageHtml.indexOf(`id="${id}"`);
      if (idx !== -1) { matchIdx = idx; break; }
    }
    if (matchIdx === -1) {
      for (const cls of classMatches) {
        if (cls.length < 4) continue;
        const idx = pageHtml.indexOf(cls);
        if (idx !== -1) { matchIdx = idx; break; }
      }
    }
  }

  if (matchIdx === -1) return '';

  // Extract ~1000 chars before and after the match point
  const start = Math.max(0, matchIdx - 500);
  const end = Math.min(pageHtml.length, matchIdx + 1500);
  let snippet = pageHtml.slice(start, end);

  // Trim to complete tags at boundaries
  const firstTag = snippet.indexOf('<');
  if (firstTag > 0) snippet = snippet.slice(firstTag);
  const lastClose = snippet.lastIndexOf('>');
  if (lastClose > 0 && lastClose < snippet.length - 1) snippet = snippet.slice(0, lastClose + 1);

  return snippet.length > 50 ? snippet : '';
}

function safeDecodeURIComponentValue(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function trimTrailingSlash(value = '') {
  const normalized = String(value || '');
  if (!normalized || normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
}

function normalizeComparablePathname(pathname = '') {
  const raw = String(pathname || '').replace(/\\/g, '/');
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, '/');
  const decoded = safeDecodeURIComponentValue(collapsed);
  return decoded === '/' ? '/' : (trimTrailingSlash(decoded) || '/');
}

function encodeComparablePathname(pathname = '') {
  return normalizeComparablePathname(pathname)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
    .replace(/%2F/gi, '/');
}

function normalizeSourcePageUrl(urlString) {
  const raw = String(urlString || '').trim();
  if (!raw) return '';
  const withoutHash = raw.split('#')[0].trim();
  return withoutHash || '';
}

function addPageUrlMatchKey(keys, value, { allowTrailingSlashVariant = true } = {}) {
  const normalized = String(value || '').trim();
  if (!normalized) return;
  keys.add(normalized);
  if (!allowTrailingSlashVariant || normalized.includes('?')) return;
  const noTrailing = trimTrailingSlash(normalized);
  if (noTrailing) keys.add(noTrailing);
}

function buildPageUrlMatchKeySets(urlString) {
  const strictKeys = new Set();
  const relaxedKeys = new Set();
  const raw = String(urlString || '').trim();
  if (!raw) return { strictKeys, relaxedKeys };

  const withoutHash = raw.split('#')[0].trim();
  if (!withoutHash) return { strictKeys, relaxedKeys };

  addPageUrlMatchKey(strictKeys, withoutHash);
  addPageUrlMatchKey(relaxedKeys, withoutHash);

  if (!withoutHash.includes('?')) {
    const decodedRaw = safeDecodeURIComponentValue(withoutHash);
    if (decodedRaw && decodedRaw !== withoutHash) {
      addPageUrlMatchKey(relaxedKeys, decodedRaw);
    }
  }

  try {
    const parsed = new URL(withoutHash);
    const protocol = parsed.protocol.toLowerCase();
    const defaultPort = (protocol === 'http:' && parsed.port === '80') || (protocol === 'https:' && parsed.port === '443');
    const host = `${parsed.hostname.toLowerCase()}${parsed.port && !defaultPort ? `:${parsed.port}` : ''}`;
    const hasSearch = Boolean(parsed.search);
    const rawSearch = parsed.search || '';
    const normalizedPath = normalizeComparablePathname(parsed.pathname);

    addPageUrlMatchKey(strictKeys, `${protocol}//${host}${normalizedPath}${rawSearch}`);
    addPageUrlMatchKey(relaxedKeys, `${protocol}//${host}${normalizedPath}${rawSearch}`);

    const pathVariants = new Set([
      normalizedPath,
      encodeComparablePathname(parsed.pathname),
    ]);
    const searchVariants = hasSearch
      ? new Set([rawSearch].filter(Boolean))
      : new Set(['']);

    for (const pathname of pathVariants) {
      for (const search of searchVariants) {
        addPageUrlMatchKey(relaxedKeys, `${protocol}//${host}${pathname}${search}`);
      }
      if (!hasSearch) {
        addPageUrlMatchKey(relaxedKeys, `${protocol}//${host}${pathname}`);
      }
    }
  } catch {
    // Non-URL value: raw/decoded keys already captured.
  }

  return { strictKeys, relaxedKeys };
}

function buildPerPageLookup(sourceFileMap) {
  const strictLookup = new Map();
  const relaxedLookup = new Map();
  const entries = [];
  const entriesBySourceUrl = new Map();

  const addLookupCandidate = (lookup, key, entry) => {
    if (!key || !entry) return;
    let bucket = lookup.get(key);
    if (!bucket) {
      bucket = new Set();
      lookup.set(key, bucket);
    }
    bucket.add(entry);
  };

  const indexEntry = (entry, pageUrl) => {
    const { strictKeys, relaxedKeys } = buildPageUrlMatchKeySets(pageUrl);
    for (const key of strictKeys) {
      addLookupCandidate(strictLookup, key, entry);
    }
    for (const key of relaxedKeys) {
      addLookupCandidate(relaxedLookup, key, entry);
    }
  };

  const attach = pageUrl => {
    const sourceUrl = normalizeSourcePageUrl(pageUrl);
    if (!sourceUrl) return null;

    let entry = entriesBySourceUrl.get(sourceUrl) || null;
    if (!entry) {
      entry = {
        sourceUrl,
        pageUrls: new Set(),
        pageFiles: new Set(),
        slideFiles: new Set(),
        pageContext: null,
        slideContext: null,
      };
      entries.push(entry);
      entriesBySourceUrl.set(sourceUrl, entry);
    }

    if (pageUrl) entry.pageUrls.add(pageUrl);
    indexEntry(entry, sourceUrl);
    return entry;
  };

  for (const [pageUrl, files] of Object.entries(sourceFileMap?.pageToFiles || {})) {
    const entry = attach(pageUrl);
    if (!entry) continue;
    for (const relFile of files || []) {
      if (relFile) entry.pageFiles.add(relFile);
    }
  }

  for (const pageContext of sourceFileMap?.pages || []) {
    const entry = attach(pageContext?.pageUrl);
    if (!entry) continue;
    if (pageContext && (!entry.pageContext || (pageContext.html && !entry.pageContext.html))) {
      entry.pageContext = pageContext;
    }
  }

  for (const slideContext of sourceFileMap?.slideContexts || []) {
    const entry = attach(slideContext?.url);
    if (!entry) continue;
    if (slideContext && !entry.slideContext) entry.slideContext = slideContext;
    for (const file of slideContext?.files || []) {
      if (file?.path) entry.slideFiles.add(file.path);
    }
  }

  for (const candidate of sourceFileMap?.slideCandidateFiles || []) {
    const entry = attach(candidate?.pageUrl);
    if (!entry) continue;
    if (candidate?.localFile) entry.slideFiles.add(candidate.localFile);
  }

  return { strictLookup, relaxedLookup, lookup: strictLookup, entries };
}

function findPageLookupEntry(pageLookup, pageUrl) {
  if (!pageUrl) return null;
  const strictLookup = pageLookup?.strictLookup || pageLookup?.lookup;
  if (!strictLookup) return null;

  const requestedSourceUrl = normalizeSourcePageUrl(pageUrl);
  const resolveKeyHit = (lookup, key) => {
    if (!lookup || !key || !lookup.has(key)) return null;
    const value = lookup.get(key);
    const candidates = value instanceof Set
      ? [...value]
      : Array.isArray(value)
        ? value.filter(Boolean)
        : value
          ? [value]
          : [];
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    if (!requestedSourceUrl) return null;
    const exactMatches = candidates.filter(candidate => normalizeSourcePageUrl(candidate?.sourceUrl) === requestedSourceUrl);
    return exactMatches.length === 1 ? exactMatches[0] : null;
  };

  const { strictKeys, relaxedKeys } = buildPageUrlMatchKeySets(pageUrl);
  for (const key of strictKeys) {
    const hit = resolveKeyHit(strictLookup, key);
    if (hit) return hit;
  }

  const relaxedLookup = pageLookup?.relaxedLookup || strictLookup;
  for (const key of relaxedKeys) {
    const hit = resolveKeyHit(relaxedLookup, key);
    if (hit) return hit;
  }

  return null;
}

function resolvePageLookupEntryForViolation(pageLookup, violation) {
  const matched = findPageLookupEntry(pageLookup, violation?.page);
  if (matched) return matched;
  return pageLookup?.entries?.length === 1 ? pageLookup.entries[0] : null;
}

export function getCandidateFilesForViolation(sourceFileMap, violation, pageLookup = null) {
  const pageEntry = resolvePageLookupEntryForViolation(pageLookup, violation);
  if (pageEntry) {
    const pageSpecific = [...pageEntry.pageFiles].filter(Boolean);
    if (pageSpecific.length > 0) return [...new Set(pageSpecific)];

    const slideScoped = [...pageEntry.slideFiles].filter(Boolean);
    if (slideScoped.length > 0) return [...new Set(slideScoped)];
  }

  const legacyPageSpecific = violation.page && sourceFileMap?.pageToFiles?.[violation.page]
    ? sourceFileMap.pageToFiles[violation.page]
    : [];
  if (legacyPageSpecific.length > 0) return [...new Set(legacyPageSpecific)];

  return [
    ...(sourceFileMap?.htmlFiles || []).map(e => e.localFile),
    ...(sourceFileMap?.cssFiles || []).map(e => e.localFile),
    ...(sourceFileMap?.jsFiles || []).map(e => e.localFile),
    ...(sourceFileMap?.otherFiles || []).map(e => e.localFile),
  ].filter(Boolean);
}

export function scoreViolationAgainstCandidateFile(domContext, relFile, content, violation) {
  const ext = path.extname(relFile).toLowerCase();
  const isStyle = STYLE_EXTS.includes(ext);
  const isScript = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte'].includes(ext);
  const isMarkupFile = MARKUP_EXTS.includes(ext);
  let score = 0;
  const reasons = [];
  const lowerContent = content.toLowerCase();

  for (const id of domContext.ids) {
    if (content.includes(id)) { score += 10; reasons.push(`id:${id}`); }
  }
  for (const cls of domContext.classes) {
    if (content.includes(cls)) { score += cls.includes('-') ? 7 : 3; reasons.push(`class:${cls}`); }
    if (isScript && (content.includes(`.${cls}`) || content.includes(`addClass('${cls}')`) || content.includes(`addClass("${cls}")`))) {
      score += 6; reasons.push(`script-class:${cls}`);
    }
  }
  for (const token of domContext.dataAttrs) {
    if (content.includes(token)) { score += 7; reasons.push(`data:${token}`); }
  }
  for (const token of domContext.text) {
    if (token.length >= 4 && content.includes(token)) { score += isMarkupFile ? 5 : 2; reasons.push(`text:${token}`); }
  }
  for (const route of domContext.routeTokens) {
    if (route.length >= 3 && lowerContent.includes(route.toLowerCase())) { score += 4; reasons.push(`route:${route}`); }
  }

  if (domContext.selector) {
    for (const m of domContext.selector.matchAll(/#([\w-]+)/g)) {
      if (content.includes(m[1])) { score += 9; reasons.push(`selector-id:${m[1]}`); }
    }
    for (const m of domContext.selector.matchAll(/\.([\w-]+)/g)) {
      if (content.includes(m[1])) { score += isStyle || isScript ? 8 : 4; reasons.push(`selector-class:${m[1]}`); }
    }
  }

  const desc = (violation.description || '').toLowerCase();
  const violRuleId = (violation.ruleId || violation.id || '').toLowerCase();
  if (DOCUMENT_LEVEL_RULES.has(violRuleId) || HEADING_STRUCTURE_RULES.has(violRuleId)) {
    if (isMarkupFile) score += 4;
    else score -= 4;
  }
  if ((desc.includes('contrast') || desc.includes('color')) && isStyle) {
    score += 8; reasons.push('style-preferred-for-contrast');
  }
  if (!isStyle && (desc.includes('contrast') || desc.includes('focus'))) score -= 2;
  if (!isMarkupFile && !isScript && !isStyle) score -= 4;

  return { relFile, score, reasons };
}

export function getFileGroupsForPath(relFile) {
  const ext = path.extname(relFile).toLowerCase();
  const groups = [];
  if (MARKUP_EXTS.includes(ext)) groups.push('markup');
  if (SCRIPT_EXTS.includes(ext)) groups.push('script');
  if (STYLE_EXTS.includes(ext)) groups.push('style');
  return groups;
}

export function getTransformationPlan(violation, relFile) {
  const rawRuleId = String(violation.ruleId || violation.rule || violation.id || '').toLowerCase();
  const normalizedRuleId = toAxeRuleId(rawRuleId, violation.source) || rawRuleId;
  const plan = TRANSFORMATION_CATALOG[normalizedRuleId];
  if (!plan) return null;
  const fileGroups = getFileGroupsForPath(relFile);
  if (!plan.fileGroups.some(group => fileGroups.includes(group))) return null;
  return { ...plan, normalizedRuleId };
}

export function isRuleSafeForAutofix(violation, relFile) {
  return Boolean(getTransformationPlan(violation, relFile));
}

export function reduceFalsePositiveFixCandidates(violations) {
  return violations.map(v => {
    // Manual-only items stay in reporting but are excluded from fix candidates.
    if (v.manualOnly) return v;
    const ruleId = String(v.ruleId || v.id || '').toLowerCase();
    if (DOCUMENT_LEVEL_RULES.has(ruleId)) return v;
    if (HEADING_STRUCTURE_RULES.has(ruleId)) return v;
    const hasEvidence = Boolean(v.nodes?.some(n => n.html || n.target) || v.element || v.fix || v.evidence);
    if (hasEvidence) return v;
    return {
      ...v,
      manualOnly: true,
      manualReason: v.manualReason || 'insufficient-evidence',
    };
  });
}

function normalizeSolvabilityRule(issue) {
  const rawRuleId = String(issue?.ruleId || issue?.rule || issue?.id || '').toLowerCase();
  return toAxeRuleId(rawRuleId, issue?.source) || rawRuleId;
}

const ROOT_CAUSE_NEIGHBORHOOD_SIMILARITY_THRESHOLD = 0.45;

function normalizeNeighborhoodText(value, maxLen = 260) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, maxLen);
}

function issueSelectorValue(issue) {
  return normalizeNeighborhoodText(issue?.nodes?.[0]?.target || issue?.selector || '', 320);
}

function issueMarkupValue(issue) {
  return normalizeNeighborhoodText(issue?.nodes?.[0]?.html || issue?.element || '', 260);
}

function issuePageScope(issue) {
  return normalizeSourcePageUrl(issue?.page);
}

function collectNeighborhoodTokens(issue) {
  const tokens = new Set();
  const sources = [
    issue?.nodes?.[0]?.target || issue?.selector || '',
    issue?.nodes?.[0]?.html || issue?.element || '',
  ];
  for (const source of sources) {
    for (const match of String(source || '').matchAll(/[.#]?([A-Za-z_][\w-]{2,})/g)) {
      const token = String(match[1] || '').toLowerCase();
      if (!token || token.length < 3 || /^\d+$/.test(token)) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

function computeIssueNeighborhoodSimilarity(issue, candidate) {
  const selector = issueSelectorValue(issue);
  const candidateSelector = issueSelectorValue(candidate);
  if (selector && candidateSelector) {
    if (selector === candidateSelector) return 1;
    if (selector.includes(candidateSelector) || candidateSelector.includes(selector)) return 0.9;
  }

  const markup = issueMarkupValue(issue);
  const candidateMarkup = issueMarkupValue(candidate);
  if (markup && candidateMarkup && (markup.includes(candidateMarkup) || candidateMarkup.includes(markup))) {
    return 0.75;
  }

  const tokens = collectNeighborhoodTokens(issue);
  const candidateTokens = collectNeighborhoodTokens(candidate);
  if (tokens.size === 0 || candidateTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of tokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  if (overlap === 0) return 0;
  const union = tokens.size + candidateTokens.size - overlap;
  const jaccard = union > 0 ? overlap / union : 0;
  const containment = overlap / Math.max(1, Math.min(tokens.size, candidateTokens.size));
  return Math.max(jaccard, containment);
}

function buildIssueMappingScope(issue, mappingByIssue = new Map()) {
  const mapped = mappingByIssue.get(issue.id) || null;
  const primaryFile = normalizeRelPath(mapped?.file || issue.sourceMapping?.primaryFile || '');
  const groupParts = [
    mapped?.ownership,
    mapped?.fileRole,
    issue.sourceMapping?.slideType,
    issue.sourceMapping?.primaryRole,
  ]
    .filter(Boolean)
    .map(part => String(part).toLowerCase())
    .filter(part => part !== 'unknown' && part !== 'none');
  return {
    primaryFile: primaryFile || null,
    group: groupParts.length > 0 ? groupParts.join('|') : null,
  };
}

function resolveThirdPartyOwnershipFile(issue, mappingByIssue = new Map()) {
  const mappedFile = normalizeRelPath(mappingByIssue.get(issue.id)?.file || '');
  if (mappedFile) {
    if (isThirdPartyFile(mappedFile)) {
      return { file: mappedFile, via: 'mapping.file' };
    }
    return null;
  }
  const sourcePrimaryFile = normalizeRelPath(issue.sourceMapping?.primaryFile || '');
  if (sourcePrimaryFile && isThirdPartyFile(sourcePrimaryFile)) {
    return { file: sourcePrimaryFile, via: 'sourceMapping.primaryFile' };
  }
  return null;
}

function evaluateRootCauseScopeMatch(issueScope, candidateScope) {
  const bothHavePrimaryFile = Boolean(issueScope.primaryFile && candidateScope.primaryFile);
  if (bothHavePrimaryFile && issueScope.primaryFile !== candidateScope.primaryFile) {
    return { inScope: false, samePrimaryFile: false, sameGroup: false, requiresSimilarityGuard: false };
  }
  const samePrimaryFile = bothHavePrimaryFile && issueScope.primaryFile === candidateScope.primaryFile;

  const bothHaveGroup = Boolean(issueScope.group && candidateScope.group);
  // Primary-file match is a stronger ownership signal than group metadata.
  // Only reject on group mismatch when primary-file scope is unavailable.
  if (!samePrimaryFile && bothHaveGroup && issueScope.group !== candidateScope.group) {
    return { inScope: false, samePrimaryFile, sameGroup: false, requiresSimilarityGuard: false };
  }
  const sameGroup = bothHaveGroup && issueScope.group === candidateScope.group;

  return {
    inScope: true,
    samePrimaryFile,
    sameGroup,
    requiresSimilarityGuard: !(samePrimaryFile || sameGroup),
  };
}

function rootRuleCandidatesForIssue(issue) {
  const rule = normalizeSolvabilityRule(issue);
  const roots = [];
  for (const [rootCauseRule, dependents] of Object.entries(ROOT_CAUSE_RULE_MAP)) {
    if (rule === rootCauseRule) continue;
    if (dependents.includes(rule)) roots.push(rootCauseRule);
  }
  return roots;
}

function findScopedRootCauseCandidate(issue, issues, mappingByIssue) {
  const rootRuleCandidates = new Set(rootRuleCandidatesForIssue(issue));
  if (rootRuleCandidates.size === 0) return null;

  const page = issuePageScope(issue);
  if (!page) return null;

  const issueScope = buildIssueMappingScope(issue, mappingByIssue);
  let best = null;

  for (const candidate of issues) {
    if (!candidate || candidate.id === issue.id) continue;
    if (candidate.solvability !== Solvability.FIXABLE) continue;
    if (issuePageScope(candidate) !== page) continue;

    const candidateRule = normalizeSolvabilityRule(candidate);
    if (!rootRuleCandidates.has(candidateRule)) continue;

    const candidateScope = buildIssueMappingScope(candidate, mappingByIssue);
    const scope = evaluateRootCauseScopeMatch(issueScope, candidateScope);
    if (!scope.inScope) continue;

    const neighborhoodSimilarity = computeIssueNeighborhoodSimilarity(issue, candidate);
    if (scope.requiresSimilarityGuard && neighborhoodSimilarity < ROOT_CAUSE_NEIGHBORHOOD_SIMILARITY_THRESHOLD) {
      continue;
    }

    const score =
      (scope.samePrimaryFile ? 5 : 0)
      + (scope.sameGroup ? 2 : 0)
      + neighborhoodSimilarity;
    if (!best || score > best.score || (score === best.score && candidate.id < best.issueId)) {
      const evidence = [];
      if (scope.samePrimaryFile && candidateScope.primaryFile) {
        evidence.push(`shared primary file: ${candidateScope.primaryFile}`);
      } else if (scope.sameGroup && candidateScope.group) {
        evidence.push(`shared mapping group: ${candidateScope.group}`);
      }
      if (scope.requiresSimilarityGuard) {
        evidence.push(`target-neighborhood similarity=${neighborhoodSimilarity.toFixed(2)}`);
      }
      best = {
        rule: candidateRule,
        issueId: candidate.id,
        score,
        evidence: evidence.join('; ') || `same page (${page})`,
      };
    }
  }

  return best;
}

function manualReasonForSolvability(classification) {
  if (classification.reason) return classification.reason;
  switch (classification.solvability) {
    case Solvability.THIRD_PARTY_ASSET: return 'third-party-asset';
    case Solvability.PLUGIN_GENERATED_DOM: return 'plugin-generated-dom';
    case Solvability.DUPLICATE_ROOT_CAUSE: return 'duplicate-root-cause';
    case Solvability.MANUAL_VERIFICATION: return 'manual-verification';
    case Solvability.ALREADY_FIXED: return 'already-fixed';
    case Solvability.UNSUPPORTED_TRANSFORM: return 'unsupported-transform';
    default: return null;
  }
}

function applySolvability(issue, classification) {
  issue.solvability = classification.solvability;
  issue.solvabilityReason = classification.reason || null;
  if (classification.rootCause) issue.rootCause = classification.rootCause;
  else if (classification.solvability !== Solvability.DUPLICATE_ROOT_CAUSE) issue.rootCause = null;
  if (classification.rootCauseIssueId) issue.rootCauseIssueId = classification.rootCauseIssueId;
  else if (classification.solvability !== Solvability.DUPLICATE_ROOT_CAUSE) issue.rootCauseIssueId = null;
  if (classification.owner) issue.owner = classification.owner;
  if (classification.evidence) issue.solvabilityEvidence = classification.evidence;
  Object.assign(issue, buildIssueEligibility(classification.solvability));
  issue.closed = CLOSED_SOLVABILITY.has(classification.solvability);
  if (MANUAL_REVIEW_SOLVABILITY.has(classification.solvability)) {
    issue.manualOnly = true;
    issue.manualReason = manualReasonForSolvability(classification);
  } else {
    issue.manualOnly = false;
    issue.manualReason = null;
  }
  // Persist detection flags at classification time so downstream phases
  // (ledger, judge) use the same result without re-running detection.
  if (classification.solvability === Solvability.PLUGIN_GENERATED_DOM) {
    issue._classifiedRendererGenerated = classification.reason === 'third-party-renderer';
    issue._classifiedPluginGenerated = classification.reason !== 'third-party-renderer';
  } else if (classification.solvability === Solvability.THIRD_PARTY_ASSET) {
    issue._classifiedThirdParty = true;
  }
  return issue;
}

function classifyInitialSolvability(issues) {
  for (const issue of issues) {
    if (issue.manualOnly) {
      applySolvability(issue, {
        solvability: Solvability.MANUAL_VERIFICATION,
        reason: issue.manualReason || 'insufficient-evidence',
      });
      continue;
    }
    applySolvability(issue, classifyIssueSolvability(issue, {
      deferUnsupported: true,
    }));
  }
}

function applyPostMappingThirdPartyClassification(issues, mapping = []) {
  const mappingByIssue = new Map((mapping || []).map(entry => [entry.violationId, entry]));
  for (const issue of issues) {
    if (issue.solvability !== Solvability.FIXABLE) continue;
    const ownedByThirdParty = resolveThirdPartyOwnershipFile(issue, mappingByIssue);
    if (!ownedByThirdParty) continue;
    applySolvability(issue, classifyIssueSolvability(issue, {
      mappedFile: ownedByThirdParty.file,
      thirdPartyFile: ownedByThirdParty.file,
      thirdPartyEvidence: `${ownedByThirdParty.via}: ${ownedByThirdParty.file}`,
      reason: 'third-party-asset',
    }));
  }
}

function applyScopedDuplicateRootCauseClassification(issues, mapping = []) {
  const mappingByIssue = new Map((mapping || []).map(entry => [entry.violationId, entry]));
  for (const issue of issues) {
    if (issue.solvability !== Solvability.FIXABLE) continue;
    const rootCause = findScopedRootCauseCandidate(issue, issues, mappingByIssue);
    if (!rootCause) continue;
    applySolvability(issue, classifyIssueSolvability(issue, {
      rootCause: rootCause.rule,
      rootCauseIssueId: rootCause.issueId,
      evidence: rootCause.evidence,
      reason: 'resolved-by-root-cause',
    }));
  }
}

function classifyManualReviewStop(entry = {}) {
  const reason = entry.reason || entry.why || 'manual-review-stop';
  if (isManualReviewHardStop(entry)) {
    return { solvability: Solvability.UNSUPPORTED_TRANSFORM, reason };
  }
  return { solvability: Solvability.MANUAL_VERIFICATION, reason };
}

function applyManualReviewStops(issues, manualReview) {
  const manualByIssue = new Map();
  for (const entry of manualReview) {
    if (!entry?.violationId || !shouldStopForManualReviewEntry(entry)) continue;
    const existing = manualByIssue.get(entry.violationId);
    if (!existing) {
      manualByIssue.set(entry.violationId, entry);
      continue;
    }
    const existingHardStop = isManualReviewHardStop(existing);
    const nextHardStop = isManualReviewHardStop(entry);
    if (nextHardStop && !existingHardStop) {
      manualByIssue.set(entry.violationId, entry);
    }
  }
  for (const issue of issues) {
    if (NON_FIXABLE_SOLVABILITY.has(issue.solvability)) continue;
    const entry = manualByIssue.get(issue.id);
    if (!entry) continue;
    applySolvability(issue, classifyManualReviewStop(entry));
  }
}

function applyUnsupportedSemanticStops(issues, mapping = []) {
  // Block truly unsupported semantic rules (heading-order, region, bypass,
  // landmark-unique, etc.) that require multi-element page-wide context beyond
  // automation capability.  Preserves the carve-out for attemptable rules like
  // page-has-heading-one and landmark-one-main that ARE fixable when a mapped
  // document template exists.
  for (const issue of issues) {
    if (issue.solvability !== Solvability.FIXABLE) continue;
    if (isAttemptableSemanticTransformIssue(issue)) continue;
    if (!isUnsupportedSemanticTransformIssue(issue)) continue;
    applySolvability(issue, {
      solvability: Solvability.UNSUPPORTED_TRANSFORM,
      reason: 'semantic-human-judgement-required',
    });
  }
}

export function getIssuesPendingDynamicClassification() {
  return [];
}

export function applyDynamicClassificationResults() {
}

function issueSourceCandidates(issue, mappingByIssue, fileContents) {
  const files = [];
  const add = (file) => {
    const rel = file ? normalizeRelPath(file) : '';
    if (rel && fileContents.has(rel) && !files.includes(rel)) files.push(rel);
  };
  add(mappingByIssue.get(issue.id)?.file);
  add(issue.sourceMapping?.primaryFile);
  for (const file of issue.sourceMapping?.candidateFiles || []) add(file);
  for (const file of issue.sourceMapping?.alternates || []) add(file);
  return files;
}

function sourceWindowsForIssue(issue, content) {
  const dom = buildViolationDomContext(issue);
  const tokens = [...new Set([...dom.ids, ...dom.classes, ...(dom.selector.match(/[.#]([A-Za-z_][\w-]*)/g) || []).map(token => token.slice(1))])]
    .filter(token => token && token.length >= 3);
  const windows = [];
  for (const token of tokens) {
    let index = content.indexOf(token);
    while (index !== -1 && windows.length < 8) {
      windows.push(content.slice(Math.max(0, index - 700), Math.min(content.length, index + 1200)));
      index = content.indexOf(token, index + token.length);
    }
  }
  return windows.length ? windows : [content.slice(0, 5000)];
}

function normalizedIssueText(issue) {
  return [
    issue.ruleId,
    issue.id,
    issue.description,
    issue.nodes?.[0]?.target,
    issue.nodes?.[0]?.html,
    issue.element,
  ].filter(Boolean).join(' ');
}

function escapedTextPattern(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

function detectAlreadyFixedInContent(issue, content, file, dynamicTemplates = null) {
  const issueText = normalizedIssueText(issue);
  const lowerRule = normalizeSolvabilityRule(issue);
  const windows = sourceWindowsForIssue(issue, content);
  const joinedWindows = windows.join('\n');
  const lowerWindows = joinedWindows.toLowerCase();
  const dom = buildViolationDomContext(issue);
  const elementText = dom.text.find(text => text.length >= 3) || '';
  const elementTextPattern = escapedTextPattern(elementText);

  if (lowerRule === 'landmark-one-main' && /<main\b|role\s*=\s*["']main["']/i.test(content)) {
    const ownership = classifyFileOwnership(file, content, dynamicTemplates);
    if (ownership.ownership === 'document-template' || ownership.ownership === 'unknown') {
      return 'source already contains a main landmark';
    }
  }
  if (lowerRule === 'page-has-heading-one' && /<h1\b/i.test(content)) {
    const ownership = classifyFileOwnership(file, content, dynamicTemplates);
    if (ownership.ownership === 'document-template') {
      return 'source already contains an h1 in document template';
    }
    // Don't return — h1 in a partial template doesn't prove the page is fixed
  }
  if ((lowerRule === 'button-name' || /H91\.Button\.Name/i.test(issueText))) {
    // Require accessible name attribute to be specifically on the violation target element
    const targetTokens = dom.classes.filter(c => c.length >= 4 && !/^(btn|button|active|disabled|hidden)$/i.test(c));
    if (targetTokens.length > 0) {
      for (const token of targetTokens) {
        // Search for the token near an accessible name attribute within a tight 200-char window
        const tokenIndex = joinedWindows.indexOf(token);
        if (tokenIndex === -1) continue;
        const tightRegion = joinedWindows.slice(Math.max(0, tokenIndex - 100), Math.min(joinedWindows.length, tokenIndex + 100));
        if (/aria-label\s*=|aria-labelledby\s*=|title\s*=/i.test(tightRegion)) {
          return 'source already provides an accessible name on the target element';
        }
      }
    }
    // Remove the old broad fallback — if we can't find a specific match, don't claim it's fixed
  }
  if (/H42/i.test(issueText) && elementTextPattern) {
    const headingPattern = new RegExp(`<h[1-6][^>]*>\\s*${elementTextPattern}\\s*</h[1-6]>`, 'i');
    if (headingPattern.test(content)) return 'source already uses heading markup';
  }
  if (/H85\.2/i.test(issueText) && /<optgroup\b|\$\s*\(\s*["']<optgroup|document\.createElement\(\s*["']optgroup["']/i.test(joinedWindows)) {
    return 'source already groups options with optgroup';
  }
  if (/H91\.Select\.Value/i.test(issueText) && (/\bname\s*[:=]|\.val\s*\(/i.test(joinedWindows))) {
    return 'source already exposes a select name or value';
  }
  if ((/InputText\.Name|F68/i.test(issueText)) && /\.sp-input/i.test(joinedWindows) && /aria-label\s*=|title\s*=|\bname\s*=|\.attr\(\s*["']aria-label["']|\.attr\(\s*["']title["']|\.attr\(\s*["']name["']/i.test(joinedWindows)) {
    return 'source already labels the generated text input';
  }
  if (lowerRule === 'list' && /role\s*[:=]\s*["']toolbar["']|role\s*=\s*["']toolbar["']|<div[^>]+class\s*=\s*["'][^"']*sadtToolbars/i.test(joinedWindows)) {
    return 'source no longer uses invalid list semantics for the toolbar container';
  }
  if (/H32\.2/i.test(issueText) && lowerWindows.includes('<div') && !lowerWindows.includes('<form')) {
    return 'source no longer creates a form for the structural container';
  }
  return null;
}

function applyAlreadyFixedFromSource(issues, fileContents, mapping, dynamicTemplates = null) {
  if (!fileContents?.size) return;
  const mappingByIssue = new Map((mapping || []).map(entry => [entry.violationId, entry]));
  for (const issue of issues) {
    if (issue.solvability !== Solvability.FIXABLE) continue;
    const files = issueSourceCandidates(issue, mappingByIssue, fileContents);
    for (const file of files) {
      const content = fileContents.get(file)?.content || '';
      const evidence = content ? detectAlreadyFixedInContent(issue, content, file, dynamicTemplates) : null;
      if (!evidence) continue;
      applySolvability(issue, {
        solvability: Solvability.ALREADY_FIXED,
        reason: 'source-already-satisfies-rule',
        evidence: `${file}: ${evidence}`,
      });
      break;
    }
  }
}

function logClassificationBreakdown(allIssues, initiallyManualViolations) {
  const COPILOT_ELIGIBLE_EXPLANATION = `Only FIXABLE issues reach Copilot for remediation. All other solvability enums are excluded:
  - FIXABLE                → Sent to Copilot for automated fix
  - MANUAL_VERIFICATION    → Scanner cannot prove failure; needs human eyes (BLOCKED)
  - THIRD_PARTY_ASSET      → File belongs to a third-party library (BLOCKED)
  - PLUGIN_GENERATED_DOM   → DOM generated by a third-party plugin/renderer (BLOCKED)
  - DUPLICATE_ROOT_CAUSE   → Symptom of a parent issue already tracked (BLOCKED)
  - ALREADY_FIXED          → Source already satisfies the rule (CLOSED)
  - UNSUPPORTED_TRANSFORM  → Requires semantic/structural judgement beyond automation (BLOCKED)`;

  const lines = [
    '',
    '══════════════════════════════════════════════════════════════════',
    ' ISSUE CLASSIFICATION BREAKDOWN',
    '══════════════════════════════════════════════════════════════════',
    '',
    COPILOT_ELIGIBLE_EXPLANATION,
    '',
    '── Per-Issue Classification ──',
    '',
  ];

  const bySolvability = {};
  for (const issue of allIssues) {
    const solv = issue.solvability || 'UNKNOWN';
    if (!bySolvability[solv]) bySolvability[solv] = [];
    bySolvability[solv].push(issue);
  }
  for (const issue of initiallyManualViolations) {
    const solv = issue.solvability || 'MANUAL_VERIFICATION';
    if (!bySolvability[solv]) bySolvability[solv] = [];
    if (!bySolvability[solv].some(i => i.id === issue.id)) bySolvability[solv].push(issue);
  }

  const solvabilityOrder = ['FIXABLE', 'MANUAL_VERIFICATION', 'THIRD_PARTY_ASSET', 'PLUGIN_GENERATED_DOM', 'DUPLICATE_ROOT_CAUSE', 'ALREADY_FIXED', 'UNSUPPORTED_TRANSFORM'];
  for (const solv of solvabilityOrder) {
    const issues = bySolvability[solv] || [];
    if (issues.length === 0) continue;
    const goesToCopilot = solv === 'FIXABLE';
    const marker = goesToCopilot ? '→ COPILOT' : '✗ BLOCKED';
    lines.push(`[${solv}] (${issues.length} issue(s)) ${marker}`);
    for (const issue of issues.slice(0, 50)) {
      const rule = issue.ruleId || issue.id || 'unknown';
      const source = issue.source || '?';
      const impact = issue.impact || '?';
      const reason = issue.solvabilityReason || issue.manualReason || '';
      const owner = issue.owner ? ` owner=${issue.owner}` : '';
      const page = issue.page ? ` page=${issue.page}` : '';
      const target = (issue.nodes?.[0]?.target || '').slice(0, 80);
      lines.push(`    ${source}/${rule} [${impact}]${owner} reason="${reason}"${page}${target ? ` target="${target}"` : ''}`);
    }
    if (issues.length > 50) lines.push(`    ... and ${issues.length - 50} more`);
    lines.push('');
  }

  lines.push('── Summary ──');
  lines.push('');
  for (const solv of solvabilityOrder) {
    const count = (bySolvability[solv] || []).length;
    if (count === 0) continue;
    const goesToCopilot = solv === 'FIXABLE';
    lines.push(`  ${solv.padEnd(24)} ${String(count).padStart(4)} issue(s)  ${goesToCopilot ? '→ SENT TO COPILOT' : '✗ excluded'}`);
  }
  const total = allIssues.length + initiallyManualViolations.filter(i => !allIssues.some(a => a.id === i.id)).length;
  const fixableCount = (bySolvability['FIXABLE'] || []).length;
  const alreadyFixedCount = (bySolvability['ALREADY_FIXED'] || []).length;
  const blockedCount = total - fixableCount - alreadyFixedCount;
  lines.push('');
  lines.push(`  TOTAL: ${total} issues | ${fixableCount} reach Copilot | ${blockedCount} blocked | ${alreadyFixedCount} already OK in source (false positive from rendered DOM)`);

  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push('');

  for (const line of lines) {
    logger.remediation(line);
  }
}

export async function phase4_analyzeAndMap(axeResults, lhResult, pa11yResult, repoPath, sourceFileMap = null, keyboardResult = null, interactionResult = null, focusableActionResult = null, missingAltIssues = null, dropdownKeyboardResult = null) {
  const spinner = ora('Phase 4 · Merging results & mapping to source files...').start();

  let dynamicTemplates = null;
  if (repoPath) {
    try { dynamicTemplates = await discoverDocumentTemplates(repoPath); } catch { /* ignore */ }
  }

  const unified = [];
  let instanceCounter = 0;

  for (const page of axeResults) {
    for (const v of page.violations) {
      const nodes = v.nodes || [];
      if (nodes.length === 0) {
        unified.push({ id: `axe-${v.id}-${page.url}-${instanceCounter++}`, ruleId: v.id, source: 'axe', impact: v.impact, description: v.help, helpUrl: v.helpUrl, nodes: [], page: page.url });
      } else {
        for (const node of nodes) {
          const target = node.target?.join(', ') ?? '';
          unified.push({ id: `axe-${v.id}-${target}-${instanceCounter++}`, ruleId: v.id, source: 'axe', impact: v.impact, description: v.help, helpUrl: v.helpUrl, nodes: [{ html: node.html, target, fix: node.failureSummary }], page: page.url });
        }
      }
    }
  }

  for (const audit of lhResult.failed) {
    const detailItems = audit.details?.items || [];
    const lhNodes = detailItems.slice(0, 10).map(item => ({
      html: item.node?.snippet || item.node?.selector || item.snippet || '',
      target: item.node?.selector || '', fix: item.node?.explanation || '',
    })).filter(n => n.html || n.target);

    if (lhNodes.length > 0) {
      for (const node of lhNodes) {
        unified.push({ id: `lh-${audit.id}-${instanceCounter++}`, ruleId: audit.id, source: 'lighthouse', impact: audit.score === 0 ? 'serious' : 'moderate', description: audit.title, helpUrl: audit.description, nodes: [node], element: node.html, page: audit.page });
      }
    } else {
      unified.push({ id: `lh-${audit.id}-${instanceCounter++}`, ruleId: audit.id, source: 'lighthouse', impact: audit.score === 0 ? 'serious' : 'moderate', description: audit.title, helpUrl: audit.description, nodes: [], page: audit.page });
    }
  }

  for (const issue of (pa11yResult?.issues ?? [])) {
    const selector = issue.selector ?? '';
    const code = issue.code ?? 'unknown';
    unified.push({
      id: `pa11y-${code}-${selector}-${instanceCounter++}`,
      ruleId: code, source: 'pa11y',
      impact: issue.type === 'error' ? 'serious' : 'moderate',
      description: issue.message, helpUrl: null, fix: null, element: issue.context,
      nodes: issue.context ? [{ html: issue.context, target: selector, fix: null }] : [],
      page: issue.page,
    });
  }

  if (keyboardResult && !keyboardResult.scanFailed) {
    for (const issue of keyboardResult.issues || []) {
      unified.push({
        id: `kb-${issue.ruleId}-${instanceCounter++}`,
        ruleId: issue.ruleId,
        source: issue.source || 'keyboard',
        impact: issue.impact,
        description: issue.description,
        helpUrl: null,
        nodes: issue.nodes || [],
        element: issue.element || '',
        page: issue.page,
      });
    }
  }

  if (interactionResult && !interactionResult.scanFailed) {
    for (const issue of interactionResult.issues || []) {
      unified.push({
        id: `int-${issue.ruleId}-${instanceCounter++}`,
        ruleId: issue.ruleId,
        source: 'interaction',
        impact: issue.impact,
        description: issue.description,
        helpUrl: issue.helpUrl || null,
        nodes: issue.nodes || [],
        element: issue.element || '',
        page: issue.page,
        triggerSelector: issue.triggerSelector || null,
        triggerType: issue.triggerType || null,
      });
    }
  }

  if (focusableActionResult && !focusableActionResult.scanFailed) {
    for (const issue of focusableActionResult.issues || []) {
      unified.push({
        id: `fa-${issue.ruleId}-${instanceCounter++}`,
        ruleId: issue.ruleId,
        source: 'focusable-action',
        impact: issue.impact,
        description: issue.description,
        helpUrl: issue.helpUrl || null,
        nodes: issue.nodes || [],
        element: issue.element || '',
        page: issue.page,
        triggerSelector: issue.triggerSelector || null,
        dialogSelector: issue.dialogSelector || null,
        screenshotPath: issue.screenshotPath || null,
        keysAttempted: issue.keysAttempted || null,
        context: issue.context || null,
      });
    }
  }

  if (dropdownKeyboardResult && !dropdownKeyboardResult.scanFailed) {
    for (const issue of dropdownKeyboardResult.issues || []) {
      unified.push({
        // Prefix must not form a plugin signature with the rule id (e.g. "ddk-dropdown" contains Kendo's "k-dropdown").
        id: `kbnav-${issue.ruleId}-${instanceCounter++}`,
        ruleId: issue.ruleId,
        source: 'dropdown-keyboard',
        impact: issue.impact,
        description: issue.description,
        helpUrl: issue.helpUrl || null,
        nodes: issue.nodes || [],
        element: issue.element || '',
        page: issue.page,
        triggerSelector: issue.triggerSelector || null,
        dialogSelector: issue.dialogSelector || null,
        keysAttempted: issue.keysAttempted || null,
        context: issue.context || null,
      });
    }
  }

  if (Array.isArray(missingAltIssues) && missingAltIssues.length > 0) {
    for (const issue of missingAltIssues) {
      unified.push({
        id: `img-alt-${instanceCounter++}`,
        ruleId: issue.ruleId || 'image-alt',
        source: 'image-alt',
        impact: issue.impact || 'critical',
        description: issue.description,
        helpUrl: issue.helpUrl || null,
        nodes: issue.nodes || [],
        element: issue.element || '',
        page: issue.page,
      });
    }
  }

  // Deduplicate, preferring direct file/line evidence and stronger sources
  const sourceRank = { axe: 4, keyboard: 4, 'focusable-action': 4, 'dropdown-keyboard': 4, 'image-alt': 4, interaction: 3, pa11y: 3, lighthouse: 2 };
  const seen = new Map();
  const normalizeDedupeText = (value, maxLen = 280) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, maxLen);
  for (const v of unified) {
    const sourceSig = normalizeDedupeText(v.source || 'unknown', 80);
    const elementSig = normalizeDedupeText(v.nodes?.[0]?.html ?? v.element ?? '');
    const targetSig = normalizeDedupeText((v.nodes || []).map(n => n?.target || '').filter(Boolean).join(' '));
    const descriptionSig = normalizeDedupeText(v.description || '');
    const fixSig = normalizeDedupeText(v.fix || v.nodes?.[0]?.fix || '');
    const helpSig = normalizeDedupeText(v.helpUrl || '', 160);
    const fallbackContextSig = [targetSig, descriptionSig, fixSig, helpSig].filter(Boolean).join('|') || 'document-level';
    const contextSig = elementSig || fallbackContextSig;
    const pageSig = (v.page ?? v.file ?? '').toLowerCase();
    const dedupKey = elementSig
      ? `${pageSig}|${contextSig}|${v.ruleId ?? v.id}`
      : `${pageSig}|${sourceSig}|${contextSig}|${v.ruleId ?? v.id}`;
    const existing = seen.get(dedupKey);
    if (!existing) { seen.set(dedupKey, v); continue; }
    const existingScore = (existing.file ? 30 : 0) + (existing.line ? 20 : 0) + ((existing.nodes?.length || 0) * 3) + (sourceRank[existing.source] || 0);
    const nextScore = (v.file ? 30 : 0) + (v.line ? 20 : 0) + ((v.nodes?.length || 0) * 3) + (sourceRank[v.source] || 0);
    if (nextScore > existingScore) seen.set(dedupKey, v);
  }
  const allDeduped = reduceFalsePositiveFixCandidates([...seen.values()]);

  // Assign exactly one primary solvability classification to each scanner issue.
  classifyInitialSolvability(allDeduped);

  // Separate manual-only violations (insufficient evidence, third-party renderer, BgImage, etc.)
  // so they are excluded from mapping/autofix while still included in reporting via
  // permanentlyManualViolations.
  const initiallyManualViolations = allDeduped.filter(v => v.manualOnly);
  const deduped = allDeduped.filter(v => !v.manualOnly);

  let mapping = [];
  const manualReview = [];
  let fileContents = new Map();
  // Build deterministic source-mapping priors. Runtime scanner findings remain
  // the only source of accessibility issues in the denominator.
  if (repoPath && sourceFileMap?.slideContexts?.length) {
    for (const v of deduped) {
      const sourceMapping = await routeIssueToSlideFiles({
        issue: v,
        sourceFileMap,
        repoPath,
      });
      if (sourceMapping) v.sourceMapping = sourceMapping;
    }
  }
  if (repoPath && deduped.length > 0) {
    const isScopedMapping = sourceFileMap && (
      sourceFileMap.htmlFiles.length + sourceFileMap.cssFiles.length +
      sourceFileMap.jsFiles.length + sourceFileMap.otherFiles.length
    ) > 0;
    const pageLookup = isScopedMapping ? buildPerPageLookup(sourceFileMap) : null;

    const allEntries = isScopedMapping
      ? [...sourceFileMap.htmlFiles, ...sourceFileMap.cssFiles, ...sourceFileMap.jsFiles, ...sourceFileMap.otherFiles]
      : (await collectSourceFiles(repoPath)).map(absPath => ({ localFile: normalizeRelPath(path.relative(repoPath, absPath)), reference: '(repo scan)' }));

    for (const entry of allEntries) {
      const relFile = normalizeRelPath(entry.localFile);
      if (shouldSkipFile(relFile) || isBinaryFile(relFile)) continue;
      try {
        const absPath = path.resolve(repoPath, relFile);
        const content = await fs.readFile(absPath, 'utf-8');
        fileContents.set(relFile, { absPath, content, reference: entry.reference ?? '', pageUrl: entry.pageUrl ?? null });
      } catch { /* unreadable */ }
    }

    // If heading-structure violations exist, ensure DocumentTemplates are in the candidate pool.
    // These server-side Razor files are never referenced as client resources, so Phase 2 misses them.
    const hasHeadingViolation = deduped.some(v => HEADING_STRUCTURE_RULES.has(String(v.ruleId || v.id || '').toLowerCase()));
    if (hasHeadingViolation) {
      const docTemplatesDir = path.join(repoPath, 'Templates', 'DocumentTemplates');
      // Also search common .NET project structure paths
      const searchPaths = [
        docTemplatesDir,
        path.join(repoPath, 'Ed.ContentDelivery.App', 'Templates', 'DocumentTemplates'),
      ];
      for (const searchDir of searchPaths) {
        try {
          const entries = await fs.readdir(searchDir, { withFileTypes: true });
          for (const ent of entries) {
            if (!ent.isFile() || !ent.name.endsWith('.cshtml')) continue;
            const absPath = path.join(searchDir, ent.name);
            const relFile = normalizeRelPath(path.relative(repoPath, absPath));
            if (fileContents.has(relFile)) continue;
            try {
              const content = await fs.readFile(absPath, 'utf-8');
              fileContents.set(relFile, { absPath, content, reference: '(DocumentTemplate for heading fix)', pageUrl: null });
            } catch { /* unreadable */ }
          }
        } catch { /* dir doesn't exist at this path — try next */ }
      }
    }

    for (const v of deduped) {
      const ruleIdLower = String(v.ruleId || v.id || '').toLowerCase();
      const pageContextForViolation = isScopedMapping
        ? resolvePageLookupEntryForViolation(pageLookup, v)
        : null;
      const pageScopedFiles = pageContextForViolation
        ? [...new Set([...pageContextForViolation.pageFiles, ...pageContextForViolation.slideFiles])]
        : [];

      // Heading-structure rules (page-has-heading-one, heading-order) produce document-level
      // violations with no element context. Token scoring is unreliable for these.
      // Use ownership classification: ONLY target DocumentTemplates (full HTML pages that
      // own page-level structure). Never target shell templates or interaction partials.
      if (HEADING_STRUCTURE_RULES.has(ruleIdLower)) {
        // Collect script basenames that the page loaded — used to match against DocumentTemplates
        const pageScriptBasenames = isScopedMapping
          ? (pageScopedFiles.length > 0
            ? pageScopedFiles
                .filter(relFile => SCRIPT_EXTS.includes(path.extname(relFile).toLowerCase()))
                .map(relFile => path.basename(relFile).toLowerCase())
            : [...(sourceFileMap?.jsFiles || [])].map(e => path.basename(e.localFile).toLowerCase()))
          : [];

        // Find DocumentTemplate candidates — files that produce the full HTML page
        const docTemplateCandidates = [...fileContents.entries()]
          .filter(([f, { content }]) => {
            const ownership = classifyFileOwnership(f, content, dynamicTemplates);
            if (ruleIdLower === 'page-has-heading-one') {
              return ownership.ownership === 'document-template' && ownership.canOwnH1;
            }
            return ownership.ownership === 'document-template' || ownership.ownership === 'interaction-template';
          })
          .map(([f, { content }]) => {
            const base = scoreViolationAgainstCandidateFile(buildViolationDomContext(v), f, content, v);
            // Boost DocumentTemplates that render deliveryModel.Body (they're the page owner)
            if (content.includes('deliveryModel.Body') || content.includes('deliveryModel).Body')) base.score += 10;
            // Cross-reference: boost if the DocumentTemplate references scripts that the page loaded.
            // This distinguishes item.cshtml (references ed.item.js) from bookend.cshtml (doesn't).
            if (pageScriptBasenames.length > 0) {
              let scriptMatchCount = 0;
              for (const scriptBase of pageScriptBasenames) {
                if (content.toLowerCase().includes(scriptBase.replace(/\.js$/, ''))) scriptMatchCount++;
              }
              base.score += scriptMatchCount * 3;
              if (scriptMatchCount > 0) base.reasons.push(`script-match:${scriptMatchCount}`);
            }
            return base;
          })
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score);

        if (docTemplateCandidates.length > 0) {
          const best = docTemplateCandidates[0];
          const plan = getTransformationPlan(v, best.relFile);
          mapping.push({
            violationId: v.id,
            file: best.relFile,
            confidence: 'medium',
            reason: best.reasons.slice(0, 5).join(', ') || `document-template ownership`,
            via: 'heading-structure-override',
            ownership: classifyFileOwnership(best.relFile, fileContents.get(best.relFile)?.content ?? '', dynamicTemplates).ownership,
            evidenceScore: best.score,
            scoreMargin: best.score - (docTemplateCandidates[1]?.score ?? 0),
            mode: 'safe-autofix',
            autofixAllowed: true,
            transformType: plan?.transformType ?? 'add-primary-heading',
            verificationRuleIds: plan?.verificationRules ?? [ruleIdLower],
          });
          continue;
        }
        // No DocumentTemplate found — send to manual review, never fix in a shell/partial
        manualReview.push({
          violationId: v.id,
          reason: 'heading-rule-no-document-template-found',
          page: v.page || null,
        });
        continue;
      }

      const domContext = buildViolationDomContext(v);
      let candidateFiles = isScopedMapping
        ? getCandidateFilesForViolation(sourceFileMap, v, pageLookup)
        : [...fileContents.keys()];
      if (candidateFiles.length === 0) {
        // FIX-11: Before classifying as no-candidate-files, check if all source files are third-party
        const allSourceFilePaths = [
          ...(sourceFileMap?.htmlFiles || []).map(e => e.localFile),
          ...(sourceFileMap?.cssFiles || []).map(e => e.localFile),
          ...(sourceFileMap?.jsFiles || []).map(e => e.localFile),
          ...(sourceFileMap?.otherFiles || []).map(e => e.localFile),
        ].filter(Boolean);
        const thirdPartyCandidates = allSourceFilePaths.filter(f => isThirdPartyFile(f));
        if (thirdPartyCandidates.length > 0) {
          applySolvability(v, {
            solvability: Solvability.THIRD_PARTY_ASSET,
            owner: thirdPartyCandidates[0],
            evidence: `all candidate files are third-party: ${thirdPartyCandidates.join(', ')}`,
            reason: 'third-party-asset',
          });
          continue;
        }
        manualReview.push({ violationId: v.id, reason: 'no-candidate-files', page: v.page || null });
        continue;
      }

      // Check if this page uses a TRUE_SLIDE_TEMPLATE (interaction slide type).
      // The rendered-DOM boosting for interaction JS/CSS only applies for these slide types.
      const pageHasInteractionTemplate = isScopedMapping && pageScopedFiles.some(relFile =>
        TRUE_SLIDE_TEMPLATES.has(path.basename(relFile).toLowerCase())
      );

      // Get rendered DOM context for this violation — used to boost JS/CSS files that
      // manipulate/style the DOM around the violated element (only for TRUE_SLIDE_TEMPLATE pages)
      const renderedPage = pageHasInteractionTemplate
        ? (pageContextForViolation?.pageContext?.html || '')
        : '';
      const renderedSnippet = renderedPage ? extractRenderedDomContext(renderedPage, v) : '';
      // Extract all class/ID tokens from the rendered snippet (surrounding DOM context)
      const renderedTokens = new Set();
      const pageInteractionBasenames = new Set(
        pageScopedFiles
          .filter(file => {
            const ext = path.extname(file).toLowerCase();
            return SCRIPT_EXTS.includes(ext) || STYLE_EXTS.includes(ext);
          })
          .map(file => path.basename(file).toLowerCase())
      );
      if (renderedSnippet) {
        for (const m of renderedSnippet.matchAll(/\bclass="([^"]+)"/g)) {
          for (const cls of m[1].split(/\s+/).filter(c => c.length > 3)) renderedTokens.add(cls);
        }
        for (const m of renderedSnippet.matchAll(/\bid="([^"]+)"/g)) renderedTokens.add(m[1]);
      }

      const allCandidatesBeforeFilter = [...new Set(candidateFiles)];
      candidateFiles = allCandidatesBeforeFilter.filter(f => fileContents.has(f) && !isThirdPartyFile(f));
      // FIX-11: If all candidates were third-party, classify as THIRD_PARTY_ASSET, not no-candidate-files
      if (candidateFiles.length === 0) {
        const thirdPartyCandidates = allCandidatesBeforeFilter.filter(f => isThirdPartyFile(f));
        if (thirdPartyCandidates.length > 0) {
          applySolvability(v, {
            solvability: Solvability.THIRD_PARTY_ASSET,
            owner: thirdPartyCandidates[0],
            evidence: `all candidate files are third-party: ${thirdPartyCandidates.join(', ')}`,
            reason: 'third-party-asset',
          });
          continue;
        }
      }
      const scored = [];
      for (const relFile of candidateFiles) {
        const { content } = fileContents.get(relFile);
        const tokenScore = extractScoredTokens(v).reduce((sum, token) => sum + (token.token && content.includes(token.token) ? token.weight : 0), 0);
        const base = scoreViolationAgainstCandidateFile(domContext, relFile, content, v);
        base.score += tokenScore;
        // Demote shell templates — they boot JS renderers but don't own DOM elements
        const ownership = classifyFileOwnership(relFile, content, dynamicTemplates);
        if (ownership.ownership === 'shell-template') base.score = Math.floor(base.score * 0.4);
        base.ownership = ownership.ownership;

        // Boost JS/CSS files using rendered DOM context:
        // If the rendered page snippet around the violated element contains class/id tokens
        // that ARE in this file, it means this file creates/styles that DOM area.
        const isInteractionJs = /\.(js|ts)$/i.test(relFile) && /interaction/i.test(relFile);
        const isInteractionCss = /\.(css|scss|less)$/i.test(relFile) && /interaction/i.test(relFile);
        const isSlideTypeFile = isInteractionJs || isInteractionCss;
        if (isSlideTypeFile && renderedTokens.size > 0) {
          let renderedMatchCount = 0;
          for (const token of renderedTokens) {
            if (content.includes(token)) renderedMatchCount++;
          }
          if (renderedMatchCount > 0) {
            base.score += Math.min(renderedMatchCount * 3, 15);
            base.reasons.push(`rendered-dom-match:${renderedMatchCount}`);
          }
        }

        // Also boost any JS/CSS file that is loaded by the page for this slide type
        if ((isInteractionJs || isInteractionCss) && base.score > 0) {
          const basename = path.basename(relFile).toLowerCase();
          const isPageFile = isScopedMapping && pageInteractionBasenames.has(basename);
          if (isPageFile) {
            base.score += 8;
            base.reasons.push('page-loaded-interaction-file');
          }
        }

        if (base.score > 0) scored.push(base);
      }
      scored.sort((a, b) => b.score - a.score);

      const best = scored[0] || null;
      const runnerUp = scored[1] || null;
      const margin = best ? best.score - (runnerUp?.score ?? 0) : 0;
      const isDocumentLevel = DOCUMENT_LEVEL_RULES.has(ruleIdLower);

      if (!best || best.score < 8) {
        manualReview.push({ violationId: v.id, reason: 'insufficient-mapping-evidence', page: v.page || null });
        continue;
      }

      if (margin < 3) {
        manualReview.push({ violationId: v.id, file: best.relFile, reason: `ambiguous-mapping best=${best.score} runnerUp=${runnerUp?.score ?? 0}`, page: v.page || null });
        continue;
      }

      const transformPlan = getTransformationPlan(v, best.relFile);
      const safe = !isDocumentLevel && Boolean(transformPlan) && best.score >= 14 && margin >= 4;
      const confidence = best.score >= 18 && margin >= 5 ? 'high' : best.score >= 12 ? 'medium' : 'low';
      const entry = {
        violationId: v.id,
        file: best.relFile,
        confidence,
        ownership: best.ownership || 'unknown',
        reason: best.reasons.slice(0, 5).join(', ') || `score ${best.score}`,
        via: 'page-dom-scoring',
        evidenceScore: best.score,
        scoreMargin: margin,
        mode: safe ? 'safe-autofix' : 'manual-review',
        autofixAllowed: safe,
        transformType: transformPlan?.transformType ?? null,
        verificationRuleIds: transformPlan?.verificationRules ?? [],
      };
      mapping.push(entry);
      if (!safe) manualReview.push({ ...entry, why: isDocumentLevel ? 'document-level-rule' : 'mapping-not-strong-enough' });
    }

    const unresolvedSevere = deduped.filter(v => !mapping.some(m => m.violationId === v.id) && (v.impact === 'critical' || v.impact === 'serious'));
    for (const v of unresolvedSevere) {
      manualReview.push({ violationId: v.id, reason: 'unresolved-severe-violation', page: v.page || null });
    }
  }

  applyPostMappingThirdPartyClassification(deduped, mapping);
  applyScopedDuplicateRootCauseClassification(deduped, mapping);
  applyUnsupportedSemanticStops(deduped, mapping);
  applyAlreadyFixedFromSource(deduped, fileContents, mapping, dynamicTemplates);

  // Manual-review stops are confidence-driven with explicit hard-stop reasons.
  // Low-confidence/manual mapping signals remain non-blocking unless hard-stopped.
  applyManualReviewStops(deduped, manualReview);

  // Log classification breakdown to remediation.txt for debugging
  logClassificationBreakdown(allDeduped, initiallyManualViolations);

  const closedIssues = allDeduped.filter(v => CLOSED_SOLVABILITY.has(v.solvability));
  const stoppedByManualReview = deduped.filter(v => v.manualOnly);
  const finalDeduped = deduped.filter(v => v.fixerEligible !== false && !v.manualOnly && !v.closed);
  const permanentlyManualViolations = [...initiallyManualViolations, ...stoppedByManualReview];
  const actionableIds = new Set(finalDeduped.map(v => v.id));
  mapping = mapping.filter(m => actionableIds.has(m.violationId));

  const byImpact = finalDeduped.reduce((acc, v) => { acc[v.impact] = (acc[v.impact] || 0) + 1; return acc; }, {});
  const summary = ['critical','serious','moderate','minor'].filter(k => byImpact[k]).map(k => `${k}: ${chalk.bold(byImpact[k])}`).join('  ');
  const manualNote = permanentlyManualViolations.length ? chalk.dim(` + ${permanentlyManualViolations.length} manual-only (insufficient evidence, third-party, BgImage, etc.)`) : '';
  const baselineFixableCount = finalDeduped.filter(v => v.solvability === Solvability.FIXABLE).length;
  spinner.succeed(`${chalk.bold(finalDeduped.length)} actionable violations → ${summary}${manualReview.length ? chalk.dim(` · ${manualReview.length} manual review`) : ''}${manualNote}`);
  return {
    unified: finalDeduped,
    allIssues: allDeduped,
    closedIssues,
    permanentlyManualViolations,
    mapping,
    manualReview,
    baseline: {
      actionableCount: finalDeduped.length,
      closedCount: closedIssues.length,
      permanentlyManualCount: permanentlyManualViolations.length,
      autofixEligibleCount: baselineFixableCount,
      manualReviewCount: finalDeduped.length - baselineFixableCount,
    },
  };
}

export function extractScoredTokens(violation) {
  const tokens     = [];
  const seenTokens = new Set();
  const GENERIC_TOKENS = new Set(['container','wrapper','content','main','header','footer','button','link','label','input','field','icon','image','modal','dialog','panel','section','item','active','disabled','selected','open','close','show','hide','left','right','top','bottom']);
  const addToken   = (token, weight) => {
    if (!token || token.length < 3) return;
    const n = token.trim();
    if (GENERIC_TOKENS.has(n.toLowerCase())) return;
    if (seenTokens.has(n)) return;
    seenTokens.add(n);
    tokens.push({ token: n, weight });
  };

  const htmlSources = [...(violation.nodes || []).map(n => n.html ?? ''), violation.element ?? ''].filter(Boolean);
  const GENERIC_TAGS = new Set(['div','span','button','a','p','li','ul','ol','h1','h2','h3','h4','h5','h6','img','input','label','form','section','nav','header','footer','main','table','tr','td','th','body','head','html']);

  for (const html of htmlSources) {
    for (const m of html.matchAll(/\bid="([^"]+)"/g)) addToken(m[1], 10);
    for (const m of html.matchAll(/\baria-label(?:ledby)?\s*=\s*"([^"]+)"/g)) addToken(m[1], 8);
    for (const m of html.matchAll(/\bdata-[\w-]+="([^"]+)"/g)) if (m[1].length > 3) addToken(m[1], 7);
    for (const m of html.matchAll(/\baria-(?!label)[\w-]+=["']([^"']+)["']/g)) if (m[1].length > 3 && m[1] !== 'true' && m[1] !== 'false') addToken(m[1], 6);
    for (const m of html.matchAll(/\bclass(?:Name)?\s*=\s*"([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/).filter(c => c.length > 2)) {
        addToken(cls, cls.includes('-') || cls.includes('_') || cls.length > 10 ? 5 : 1);
      }
    }
    const tagMatch = html.match(/^<([\w-]+)/);
    if (tagMatch && !GENERIC_TAGS.has(tagMatch[1].toLowerCase())) addToken(tagMatch[1], 4);
    for (const m of html.matchAll(/>([^<]{4,60})</g)) { const t = m[1].trim(); if (t.length >= 4 && t.length <= 60) addToken(t, 2); }
    for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) { const b = path.basename(m[1]); if (b.length > 3) addToken(b, 6); }
  }

  // Extract jQuery/createElement patterns from element HTML for dynamic elements
  for (const html of htmlSources) {
    const jqCreate = html.match(/<([\w-]+)/);
    if (jqCreate) {
      const tag = jqCreate[1].toLowerCase();
      if (!GENERIC_TAGS.has(tag)) addToken(tag, 4);
      addToken(`$('<${tag}`, 6);
      addToken(`$("<${tag}`, 6);
      addToken(`createElement('${tag}')`, 7);
      addToken(`createElement("${tag}")`, 7);
    }
    const classMatch2 = html.match(/\bclass(?:Name)?\s*=\s*"([^"]+)"/);
    if (classMatch2) {
      for (const cls of classMatch2[1].split(/\s+/).filter(c => c.length > 3)) {
        addToken(`addClass('${cls}')`, 5);
        addToken(`addClass("${cls}")`, 5);
        addToken(`'${cls}'`, 3);
      }
    }
  }

  for (const node of (violation.nodes || [])) {
    const target = node.target ?? '';
    for (const m of target.matchAll(/#([\w-]+)/g)) addToken(m[1], 10);
    for (const m of target.matchAll(/\.([\w-]+)/g)) addToken(m[1], m[1].includes('-') || m[1].length > 10 ? 5 : 2);
  }
  return tokens;
}
