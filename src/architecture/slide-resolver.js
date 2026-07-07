import fs from 'fs/promises';
import path from 'path';
import { MARKUP_EXTS, shouldSkipFile } from '../core/constants.js';
import {
  DOCUMENT_LEVEL_RULES,
  DOCUMENT_TEMPLATES,
  HEADING_STRUCTURE_RULES,
  TRANSFORMATION_CATALOG,
  classifyFileOwnership,
} from './app-architecture.js';
import {
  conventionForRenderer,
  detectRendererClassesFromAssets,
  detectRendererClassesFromHtml,
} from './slide-registry.js';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeRuleId(ruleId = '') {
  return String(ruleId).toLowerCase();
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

function normalizeSourcePageUrl(urlString) {
  const raw = String(urlString || '').trim();
  if (!raw) return '';
  const withoutHash = raw.split('#')[0].trim();
  return withoutHash || '';
}

function findSlideContextForPage(slideContexts, pageUrl) {
  if (!pageUrl) return null;
  const issueKeySets = buildPageUrlMatchKeySets(pageUrl);
  if (issueKeySets.strictKeys.size === 0 && issueKeySets.relaxedKeys.size === 0) return null;
  const requestedSourceUrl = normalizeSourcePageUrl(pageUrl);

  const strictLookup = new Map();
  const relaxedLookup = new Map();
  const addLookupCandidate = (lookup, key, ctx) => {
    if (!key || !ctx) return;
    let bucket = lookup.get(key);
    if (!bucket) {
      bucket = new Set();
      lookup.set(key, bucket);
    }
    bucket.add(ctx);
  };

  const resolveKeyHit = (lookup, key) => {
    if (!lookup || !key || !lookup.has(key)) return null;
    const candidates = [...(lookup.get(key) || [])].filter(Boolean);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    if (!requestedSourceUrl) return null;
    const exactMatches = candidates.filter(candidate => normalizeSourcePageUrl(candidate?.url) === requestedSourceUrl);
    return exactMatches.length === 1 ? exactMatches[0] : null;
  };

  for (const ctx of slideContexts) {
    const { strictKeys, relaxedKeys } = buildPageUrlMatchKeySets(ctx?.url);
    for (const key of strictKeys) {
      addLookupCandidate(strictLookup, key, ctx);
    }
    for (const key of relaxedKeys) {
      addLookupCandidate(relaxedLookup, key, ctx);
    }
  }

  for (const key of issueKeySets.strictKeys) {
    const hit = resolveKeyHit(strictLookup, key);
    if (hit) return hit;
  }

  for (const key of issueKeySets.relaxedKeys) {
    const hit = resolveKeyHit(relaxedLookup, key);
    if (hit) return hit;
  }

  return null;
}

function roleScore(relFile, role) {
  const normalized = relFile.toLowerCase();
  let score = 0;
  if (role === 'template' && normalized.includes('/templates/')) score += 10;
  if (role === 'document-template' && normalized.includes('/documenttemplates/')) score += 15;
  if (role === 'js-renderer' && /(?:wwwroot|scripts?|js|javascript)/.test(normalized)) score += 8;
  if (role === 'style' && /(?:wwwroot|styles?|css)/.test(normalized)) score += 8;
  if (role.endsWith('model') || role === 'scoring-delegate') {
    if (normalized.endsWith('.cs')) score += 8;
    if (normalized.includes('/models/') || normalized.includes('/services/') || normalized.includes('/delegates/')) score += 4;
  }
  if (shouldSkipFile(relFile)) score -= 100;
  return score;
}

function pickBestBasenameMatch(repoIndexes, basename, role) {
  const hits = repoIndexes.basenameIndex.get(String(basename).toLowerCase()) || [];
  return hits
    .filter(rel => !shouldSkipFile(rel))
    .sort((a, b) => roleScore(b, role) - roleScore(a, role))[0] || null;
}

async function readMaybe(repoPath, relFile) {
  try { return await fs.readFile(path.join(repoPath, relFile), 'utf-8'); }
  catch { return ''; }
}

function makeFileEntry({ relFile, fileRole, confidence, via, repoPath, content = '' }) {
  const ownership = content
    ? classifyFileOwnership(relFile, content).ownership
    : fileRole;
  return {
    path: relFile,
    fileRole,
    ownership,
    confidence,
    via,
  };
}

export function classifySlideUrl(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const lower = parts.map(p => p.toLowerCase());
    const slideIdx = lower.findIndex(p => p === 'slide' || p === 'slideplayer' || p === 'standaloneplayer');
    if (slideIdx === -1) return { routeKind: 'other', slideSerial: null, routeTokens: parts };
    return {
      routeKind: lower[slideIdx],
      slideSerial: parts[slideIdx + 1] || null,
      routeTokens: parts.filter(p => p.length >= 3),
    };
  } catch {
    return { routeKind: 'other', slideSerial: null, routeTokens: [] };
  }
}

async function resolveDocumentTemplates({ repoPath, repoIndexes, pageContext }) {
  const entries = [];
  for (const basename of DOCUMENT_TEMPLATES) {
    const hits = repoIndexes.basenameIndex.get(basename.toLowerCase()) || [];
    for (const relFile of hits) {
      if (shouldSkipFile(relFile)) continue;
      const content = await readMaybe(repoPath, relFile);
      const ownership = classifyFileOwnership(relFile, content);
      if (ownership.ownership !== 'document-template') continue;
      let confidence = 'medium';
      let via = 'document-template-ownership';
      if (content.includes('deliveryModel.Body') || content.includes('deliveryModel).Body')) {
        confidence = 'high';
        via = 'document-template-delivery-body';
      }
      entries.push(makeFileEntry({ relFile, fileRole: 'document-template', confidence, via, repoPath, content }));
    }
  }

  // Prefer route/page-token matches, then deliveryModel.Body owners.
  const tokens = pageContext.routeTokens || [];
  entries.sort((a, b) => {
    const aScore = tokens.some(t => a.path.toLowerCase().includes(t.toLowerCase())) ? 2 : 0;
    const bScore = tokens.some(t => b.path.toLowerCase().includes(t.toLowerCase())) ? 2 : 0;
    return bScore - aScore;
  });
  return entries.slice(0, 2);
}

async function resolveConventionFiles({ repoPath, repoIndexes, convention }) {
  const files = [];
  const addByBasenames = async (basenames, fileRole, confidence, via) => {
    for (const basename of basenames) {
      const relFile = pickBestBasenameMatch(repoIndexes, basename, fileRole);
      if (!relFile) continue;
      const content = await readMaybe(repoPath, relFile);
      files.push(makeFileEntry({ relFile, fileRole, confidence, via, repoPath, content }));
      return;
    }
  };

  await addByBasenames(convention.templateBasenames, 'template', 'high', 'slide-convention-template');
  await addByBasenames(convention.jsBasenames, 'js-renderer', 'high', 'slide-convention-js');
  await addByBasenames(convention.styleBasenames, 'style', 'high', 'slide-convention-style');

  for (const basename of convention.domainBasenames) {
    const role = basename.endsWith('Response.cs')
      ? 'response-model'
      : basename.endsWith('ServiceDelegate.cs')
        ? 'scoring-delegate'
        : 'domain-model';
    const relFile = pickBestBasenameMatch(repoIndexes, basename, role);
    if (relFile) files.push(makeFileEntry({ relFile, fileRole: role, confidence: 'medium', via: 'slide-convention-domain', repoPath }));
  }

  return files;
}

export async function resolveSlideContext({ repoPath, repoIndexes, pageContext }) {
  const urlInfo = classifySlideUrl(pageContext.pageUrl);
  const detections = [
    ...detectRendererClassesFromHtml(pageContext.html || ''),
    ...detectRendererClassesFromAssets(pageContext.assetRefs || []),
  ];
  const best = detections[0] || null;
  const convention = best ? conventionForRenderer(best.rendererClass) : null;
  const files = [];

  if (convention) {
    files.push(...await resolveConventionFiles({ repoPath, repoIndexes, convention }));
  }
  files.push(...await resolveDocumentTemplates({ repoPath, repoIndexes, pageContext }));

  const dedupedFiles = [];
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    dedupedFiles.push(file);
  }

  return {
    url: pageContext.pageUrl,
    ...urlInfo,
    slideType: convention?.slideType || null,
    rendererClass: best?.rendererClass || null,
    detectionConfidence: best?.confidence || 'low',
    detectionEvidence: best?.evidence || 'none',
    files: dedupedFiles,
  };
}

function getFilesByRole(slideContext, role) {
  return (slideContext?.files || []).filter(file => file.fileRole === role);
}

function firstPath(files) {
  return files[0]?.path || null;
}

function issueText(issue) {
  return [
    issue.nodes?.[0]?.html,
    issue.element,
    issue.nodes?.[0]?.target,
    issue.description,
  ].filter(Boolean).join(' ');
}

async function templateContainsIssue(repoPath, templateFile, issue) {
  if (!templateFile) return false;
  const content = await readMaybe(repoPath, templateFile);
  if (!content) return false;
  const html = issue.nodes?.[0]?.html || issue.element || '';
  if (html && html.length > 12 && content.includes(html.slice(0, 80))) return true;
  const target = issue.nodes?.[0]?.target || '';
  const tokenMatches = [...String(target).matchAll(/[#.]?([A-Za-z0-9_-]{4,})/g)].map(match => match[1]);
  return tokenMatches.some(token => content.includes(token));
}

export async function routeIssueToSlideFiles({ issue, sourceFileMap, repoPath }) {
  const slideContexts = sourceFileMap?.slideContexts || [];
  if (slideContexts.length === 0) return null;
  const slideContext = findSlideContextForPage(slideContexts, issue?.page);
  if (!slideContext) return null;

  const ruleId = normalizeRuleId(issue.ruleId || issue.id);
  const plan = TRANSFORMATION_CATALOG[ruleId] || null;
  const fileGroups = plan?.fileGroups || [];
  const docLevel = DOCUMENT_LEVEL_RULES.has(ruleId) || HEADING_STRUCTURE_RULES.has(ruleId);
  const styleFile = firstPath(getFilesByRole(slideContext, 'style'));
  const documentFile = firstPath(getFilesByRole(slideContext, 'document-template'));
  const templateFile = firstPath(getFilesByRole(slideContext, 'template'));
  const jsFile = firstPath(getFilesByRole(slideContext, 'js-renderer'));

  let primaryFile = null;
  let primaryRole = null;
  let isDynamicElement = false;
  let rationale = '';

  if (fileGroups.includes('style') && styleFile) {
    primaryFile = styleFile;
    primaryRole = 'style';
    rationale = `Rule ${ruleId} is style/contrast-related, so the interaction stylesheet is the primary owner.`;
  } else if (docLevel && documentFile) {
    primaryFile = documentFile;
    primaryRole = 'document-template';
    rationale = `Rule ${ruleId} is document/page-level, so the DocumentTemplate wrapper is the primary owner.`;
  } else if ((fileGroups.includes('markup') || fileGroups.includes('script')) && (templateFile || jsFile)) {
    const foundInTemplate = await templateContainsIssue(repoPath, templateFile, issue);
    if (foundInTemplate || !jsFile) {
      primaryFile = templateFile || jsFile;
      primaryRole = templateFile ? 'template' : 'js-renderer';
      rationale = foundInTemplate
        ? 'The scanner element/selector is present in the slide template partial.'
        : 'No JS renderer was resolved; falling back to the template candidate.';
    } else {
      primaryFile = jsFile;
      primaryRole = 'js-renderer';
      isDynamicElement = true;
      rationale = 'The element was not found in the static template partial, so it is likely built by the client-side JS renderer.';
    }
  } else {
    primaryFile = templateFile || jsFile || styleFile || documentFile || null;
    primaryRole = slideContext.files.find(file => file.path === primaryFile)?.fileRole || null;
    rationale = primaryFile
      ? 'Fallback to the highest-confidence slide-aware candidate because no rule-specific route matched.'
      : 'No slide-aware source file was resolved; fallback mapping must explore broader repository candidates.';
  }

  const alternates = unique(slideContext.files.map(file => file.path).filter(path => path !== primaryFile));
  const candidateFiles = unique([primaryFile, ...alternates]);
  const mappingConfidence = primaryFile && slideContext.detectionConfidence === 'high'
    ? 'high'
    : primaryFile
      ? 'medium'
      : 'low';

  return {
    issueId: issue.id,
    primaryFile,
    primaryRole,
    alternates,
    candidateFiles,
    isDynamicElement,
    mappingConfidence,
    rationale,
    slideType: slideContext.slideType,
    rendererClass: slideContext.rendererClass,
    detectionEvidence: slideContext.detectionEvidence,
    fileGroups,
    via: 'deterministic-slide-resolver',
  };
}

export function summarizeSlideArchitecture(sourceFileMap) {
  const contexts = sourceFileMap?.slideContexts || [];
  if (contexts.length === 0) {
    return 'No slide-aware context was detected. Fall back to repository exploration.';
  }

  return contexts.map(ctx => {
    const files = (ctx.files || [])
      .map(file => `- ${file.fileRole}: ${file.path} (${file.confidence}, ${file.via})`)
      .join('\n') || '- no files resolved';
    return [
      `URL: ${ctx.url}`,
      `Route: ${ctx.routeKind}${ctx.slideSerial ? ` / ${ctx.slideSerial}` : ''}`,
      `Detected slide type: ${ctx.slideType || 'unknown'}`,
      `Renderer: ${ctx.rendererClass || 'unknown'} (${ctx.detectionConfidence}; ${ctx.detectionEvidence})`,
      files,
    ].join('\n');
  }).join('\n\n');
}
