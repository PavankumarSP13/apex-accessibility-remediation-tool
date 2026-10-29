import { toAxeRuleId, normalizeIssueText } from './patch.js';
import { isManualVerificationScannerIssue, isPluginGeneratedNode, isRendererGeneratedNode } from '../core/constants.js';

// FIX-13: Structural key strips volatile IDs/classes for robust middle-tier matching
function buildStructuralKey(issue) {
  const rule = issue.ruleId || issue.id || '';
  const page = issue.page || '';
  const html = issue.nodes?.[0]?.html || issue.element || '';
  // Extract tag
  const tag = (html.match(/^<(\w+)/) || [])[1] || '';
  // Extract role
  const role = (html.match(/role="([^"]+)"/) || [])[1] || '';
  // Extract aria-label (normalized)
  const ariaLabel = (html.match(/aria-label="([^"]+)"/) || [])[1] || '';
  return `${rule}|${page}|${tag}|${role}|${ariaLabel}`.toLowerCase();
}

export function createIssueFingerprint(issue) {
  const normalizedRule = toAxeRuleId(issue.ruleId || issue.id, issue.source)
    || String(issue.ruleId || issue.id || '').toLowerCase();
  const target = normalizeIssueText(issue.nodes?.[0]?.target || issue.target || issue.selector || '');
  const element = normalizeIssueText(issue.nodes?.[0]?.html || issue.element || '').slice(0, 180);
  const page = issue.page || '';
  const keyBody = target || element || normalizeIssueText(issue.description || '').slice(0, 120);
  return {
    key: `${page}|${normalizedRule}|${keyBody}`,
    structuralKey: buildStructuralKey(issue),
    looseKey: `${normalizedRule}|${keyBody}`,
    ruleId: normalizedRule,
    page,
    target,
    element,
  };
}

export function normalizeAxeScanIssues(axeResults = []) {
  const issues = [];
  for (const page of axeResults || []) {
    if (page.scanFailed) continue;
    for (const violation of page.violations || []) {
      const nodes = violation.nodes?.length ? violation.nodes : [{ html: '', target: [] }];
      for (const node of nodes) {
        issues.push({
          source: 'axe',
          page: page.url,
          ruleId: violation.id,
          impact: violation.impact,
          description: violation.help || '',
          nodes: [{ html: node.html || '', target: Array.isArray(node.target) ? node.target.join(', ') : (node.target || '') }],
          element: node.html || '',
        });
      }
    }
  }
  return issues;
}

export function normalizePa11yScanIssues(pa11yResult = {}) {
  if (pa11yResult?.scanFailed === true) return [];
  return (pa11yResult?.issues || []).map(issue => ({
    source: 'pa11y',
    page: issue.page,
    ruleId: issue.code || issue.ruleId || 'unknown',
    impact: issue.type === 'error' ? 'serious' : 'moderate',
    description: issue.message || issue.description || '',
    selector: issue.selector || '',
    element: issue.context || issue.element || '',
    nodes: (issue.context || issue.element)
      ? [{ html: issue.context || issue.element || '', target: issue.selector || '' }]
      : [],
  }));
}

export function normalizeLighthouseIssues(lhResult = {}, scanUrl = '') {
  if (lhResult?.scanFailed === true || lhResult?.skipped === true) return [];
  return (lhResult?.failed || []).map(audit => ({
    source: 'lighthouse',
    page: audit.page || scanUrl,
    ruleId: audit.id,
    impact: audit.score === 0 ? 'serious' : 'moderate',
    description: audit.title,
    element: '',
    nodes: [],
  }));
}

export function normalizeKeyboardScanIssues(keyboardResult = {}) {
  if (keyboardResult?.scanFailed === true) return [];
  return (keyboardResult?.issues || []).map(issue => ({
    source: 'keyboard',
    page: issue.page,
    ruleId: issue.ruleId || 'keyboard-unknown',
    impact: issue.impact || 'serious',
    description: issue.description || '',
    element: issue.element || '',
    nodes: issue.nodes || [{ html: issue.element || '', target: issue.nodes?.[0]?.target || '' }],
  }));
}

export function normalizeInteractionScanIssues(interactionResult = {}) {
  if (interactionResult?.scanFailed === true) return [];
  return (interactionResult?.issues || []).map(issue => ({
    source: 'interaction',
    page: issue.page || '',
    ruleId: issue.ruleId || 'interaction-unknown',
    impact: issue.impact || 'serious',
    description: issue.description || '',
    element: issue.element || '',
    nodes: issue.nodes || [{ html: issue.element || '', target: '' }],
  }));
}

export function normalizeDropdownKeyboardScanIssues(dropdownKeyboardResult = {}) {
  if (dropdownKeyboardResult?.scanFailed === true) return [];
  return (dropdownKeyboardResult?.issues || []).map(issue => ({
    source: issue.source || 'dropdown-keyboard',
    page: issue.page || '',
    ruleId: issue.ruleId || 'dropdown-keyboard-unknown',
    impact: issue.impact || 'serious',
    description: issue.description || '',
    element: issue.element || '',
    nodes: issue.nodes || [{ html: issue.element || '', target: '' }],
  }));
}

export function normalizeScanIssues(scanData = {}, { includeLighthouse = true, filterManual = false } = {}) {
  const issues = [
    ...normalizeAxeScanIssues(scanData?.axe || []),
    ...normalizePa11yScanIssues(scanData?.pa11y || {}),
    ...normalizeKeyboardScanIssues(scanData?.keyboard || {}),
    ...normalizeInteractionScanIssues(scanData?.interaction || {}),
    ...normalizeDropdownKeyboardScanIssues(scanData?.dropdownKeyboard || {}),
  ];
  if (includeLighthouse) {
    issues.push(...normalizeLighthouseIssues(scanData?.lh || {}, scanData?.scanUrl || ''));
  }
  return filterManual ? issues.filter(isScoredRuntimeIssue) : issues;
}

export function isScoredRuntimeIssue(issue) {
  if (isRendererGeneratedNode(issue)) return false;
  if (isPluginGeneratedNode(issue)) return false;
  if (isManualVerificationScannerIssue(issue)) return false;
  const ruleId = String(issue.ruleId || '').toLowerCase();
  return !ruleId.includes('bgimage');
}

function countByLooseFingerprint(issues) {
  const counts = new Map();
  for (const issue of issues.filter(isScoredRuntimeIssue)) {
    const fp = createIssueFingerprint(issue);
    counts.set(fp.looseKey, (counts.get(fp.looseKey) || 0) + 1);
  }
  return counts;
}

// Selector-independent key: rule + page + element markup. Scanners like pa11y build
// selectors from the nearest ancestor id, so a fix that adds an id (e.g. <main id>)
// rewrites selectors of untouched elements without changing the element itself.
function elementMatchKey(issue, fp) {
  if (!fp.element) return null;
  return `${fp.ruleId}|${issue.page || ''}|${fp.element}`;
}

export function computeIntroducedIssues(beforeData, afterData, knownNonFixableFingerprints = null) {
  const beforeIssues = normalizeScanIssues(beforeData, { includeLighthouse: false }).filter(isScoredRuntimeIssue);
  const beforeCounts = countByLooseFingerprint(beforeIssues);
  const afterIssues = normalizeScanIssues(afterData, { includeLighthouse: false }).filter(isScoredRuntimeIssue);
  const afterCounts = countByLooseFingerprint(afterIssues);
  const consumed = new Map();
  const candidates = [];

  for (const issue of afterIssues) {
    const fp = createIssueFingerprint(issue);
    const beforeCount = beforeCounts.get(fp.looseKey) || 0;
    const afterCount = afterCounts.get(fp.looseKey) || 0;
    const introducedCount = Math.max(0, afterCount - beforeCount);
    const used = consumed.get(fp.looseKey) || 0;
    if (introducedCount === 0 || used >= introducedCount) continue;
    consumed.set(fp.looseKey, used + 1);
    candidates.push({ issue, fp });
  }

  // Second pass: before-issues not matched by selector can still absorb an after-issue
  // with the same rule and identical element markup (selector drift, not a regression).
  const unmatchedBefore = new Map();
  const beforeMatched = new Map();
  for (const issue of beforeIssues) {
    const fp = createIssueFingerprint(issue);
    const afterCount = afterCounts.get(fp.looseKey) || 0;
    const seen = beforeMatched.get(fp.looseKey) || 0;
    beforeMatched.set(fp.looseKey, seen + 1);
    if (seen < afterCount) continue;
    const key = elementMatchKey(issue, fp);
    if (key) unmatchedBefore.set(key, (unmatchedBefore.get(key) || 0) + 1);
  }

  const introduced = [];
  for (const { issue, fp } of candidates) {
    const key = elementMatchKey(issue, fp);
    const available = key ? (unmatchedBefore.get(key) || 0) : 0;
    if (available > 0) {
      unmatchedBefore.set(key, available - 1);
      continue;
    }
    introduced.push({
      fingerprint: fp.key,
      source: issue.source,
      page: issue.page || '',
      ruleId: issue.ruleId || issue.id,
      impact: issue.impact,
      description: issue.description,
      target: issue.nodes?.[0]?.target || '',
      element: issue.nodes?.[0]?.html || issue.element || '',
    });
  }

  if (knownNonFixableFingerprints && knownNonFixableFingerprints.size > 0) {
    const genuinelyNew = [];
    const knownNonFixableReappeared = [];
    for (const issue of introduced) {
      const fp = createIssueFingerprint(issue);
      if (knownNonFixableFingerprints.has(fp.looseKey) || knownNonFixableFingerprints.has(fp.ruleId)) {
        knownNonFixableReappeared.push(issue);
      } else {
        genuinelyNew.push(issue);
      }
    }
    // Tag the introduced array with metadata
    genuinelyNew._excludedNonFixable = knownNonFixableReappeared.length;
    genuinelyNew._excludedNonFixableRuleIds = [...new Set(knownNonFixableReappeared.map(i => i.ruleId))];
    return genuinelyNew;
  }

  return introduced;
}

export function buildNonFixableFingerprints(analysis) {
  const fingerprints = new Set();
  if (!analysis?.unified) return fingerprints;

  const NON_FIXABLE = new Set([
    'PLUGIN_GENERATED_DOM', 'THIRD_PARTY_ASSET', 'MANUAL_VERIFICATION',
    'DUPLICATE_ROOT_CAUSE', 'ALREADY_FIXED', 'UNSUPPORTED_TRANSFORM',
  ]);

  for (const issue of analysis.unified) {
    if (!NON_FIXABLE.has(issue.solvability)) continue;
    const fp = createIssueFingerprint(issue);
    fingerprints.add(fp.looseKey);
    fingerprints.add(fp.ruleId);
    // Also add the structural key for broader matching
    fingerprints.add(fp.structuralKey);
  }

  // Also add the closed/manual issues
  for (const issue of analysis.permanentlyManualViolations || []) {
    const fp = createIssueFingerprint(issue);
    fingerprints.add(fp.looseKey);
    fingerprints.add(fp.ruleId);
  }

  return fingerprints;
}

export function countIssueMatches(issues, targetIssue) {
  const targetFp = createIssueFingerprint(targetIssue);
  let exact = 0;
  let loose = 0;
  for (const issue of issues || []) {
    const fp = createIssueFingerprint(issue);
    if (fp.key === targetFp.key) exact++;
    if (fp.looseKey === targetFp.looseKey) loose++;
  }
  return { exact, loose };
}
