import path from 'path';

export const Solvability = Object.freeze({
  FIXABLE: 'FIXABLE',
  MANUAL_VERIFICATION: 'MANUAL_VERIFICATION',
  THIRD_PARTY_ASSET: 'THIRD_PARTY_ASSET',
  PLUGIN_GENERATED_DOM: 'PLUGIN_GENERATED_DOM',
  DUPLICATE_ROOT_CAUSE: 'DUPLICATE_ROOT_CAUSE',
  ALREADY_FIXED: 'ALREADY_FIXED',
  UNSUPPORTED_TRANSFORM: 'UNSUPPORTED_TRANSFORM',
});

export const NON_FIXABLE_SOLVABILITY = new Set([
  Solvability.MANUAL_VERIFICATION,
  Solvability.THIRD_PARTY_ASSET,
  Solvability.PLUGIN_GENERATED_DOM,
  Solvability.DUPLICATE_ROOT_CAUSE,
  Solvability.ALREADY_FIXED,
  Solvability.UNSUPPORTED_TRANSFORM,
]);

export const MANUAL_REVIEW_SOLVABILITY = new Set([
  Solvability.MANUAL_VERIFICATION,
  Solvability.THIRD_PARTY_ASSET,
  Solvability.PLUGIN_GENERATED_DOM,
  Solvability.DUPLICATE_ROOT_CAUSE,
  Solvability.UNSUPPORTED_TRANSFORM,
]);

export const CLOSED_SOLVABILITY = new Set([
  Solvability.ALREADY_FIXED,
]);

export const ROOT_CAUSE_RULE_MAP = Object.freeze({
  'landmark-one-main': ['region'],
  'list': ['listitem'],
  'aria-required-parent': ['aria-required-children'],
  'dlitem': ['definition-list'],
});

export const SOURCE_EXTS = [
  '.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.html', '.htm',
  '.vue', '.svelte', '.css', '.scss', '.sass', '.less',
  '.cshtml', '.razor',          // ← .NET Razor views
];

export const STYLE_EXTS = ['.css', '.scss', '.sass', '.less'];
export const SCRIPT_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
export const MARKUP_EXTS = ['.tsx', '.jsx', '.html', '.htm', '.vue', '.svelte', '.cshtml', '.razor'];

export const IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.cache',
  'Properties', 'Migrations', 'TestResults', 'packages',   // .NET artefacts
  // NOTE: we do NOT ignore wwwroot entirely — the app's own CSS/JS lives there.
  // Third-party libs in wwwroot/lib are caught by THIRD_PARTY_PATTERNS below.
];

// ─── BUILD OUTPUT & THIRD-PARTY DETECTION ────────────────────────────────────

export const BUILD_OUTPUT_SEGMENTS = [
  'bin', 'obj', 'Debug', 'Release', 'publish',
  'net5.0', 'net6.0', 'net7.0', 'net8.0', 'net9.0',
];

export const THIRD_PARTY_PATTERNS = [
  /\bjquery[-.]?\d/i,
  /\bjquery[-.]ui/i,
  /\bjquery\.booklet/i,
  /\bjquery\.ui\.touch/i,
  /\bbootstrap(?:\.min)?\.(?:js|css)/i,
  /\bpopper(?:\.min)?\.js/i,
  /\btippy[-.]bundle/i,
  /\bfont-awesome/i,
  /\bmathjax/i,
  /\bes[56]-shim/i,
  /\byett\.min/i,
  /\bwgxpath/i,
  /\bangular(?:\.min)?\.js/i,
  /\breact(?:\.min)?\.js/i,
  /\bvue(?:\.min)?\.js/i,
  /\blodash/i,
  /\bmoment(?:\.min)?\.js/i,
  /\bspectrum(?:\.min)?\.(?:js|css)/i,
];

export const THIRD_PARTY_PATH_PATTERNS = [
  /(?:^|\/)wwwroot\/lib\//i,
  /(?:^|\/)node_modules\//i,
  /(?:^|\/)vendor\//i,
  /(?:^|\/)vendors\//i,
  /(?:^|\/)plugins\/spectrum(?:\/|$)/i,
  /(?:^|\/)assets\/js\/plugins\/spectrum(?:\/|$)/i,
];

export const FIRST_PARTY_A11Y_FILE_PATTERNS = [
  /(?:^|\/)[^/]*a11y[^/]*\.(?:css|scss|sass|less|js|mjs|cjs|ts|tsx|jsx)$/i,
  /(?:^|\/)wwwroot\/assets\/(?:css|js)\/ed\//i,
];

export function isBuildOutputPath(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments.some(seg => BUILD_OUTPUT_SEGMENTS.includes(seg));
}

export function isThirdPartyFile(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  if (FIRST_PARTY_A11Y_FILE_PATTERNS.some(rx => rx.test(normalized))) return false;
  if (THIRD_PARTY_PATH_PATTERNS.some(rx => rx.test(normalized))) return true;
  const basename = path.basename(normalized);
  if (basename.endsWith('.min.js') || basename.endsWith('.min.css')) return true;
  return THIRD_PARTY_PATTERNS.some(rx => rx.test(basename));
}

function issueSearchText(issue) {
  return [
    issue?.nodes?.[0]?.target,
    issue?.nodes?.[0]?.html,
    issue?.selector,
    issue?.element,
    issue?.description,
    issue?.ruleId,
    issue?.id,
  ].filter(Boolean).join(' ');
}

function issueDomTokens(issue) {
  const text = issueSearchText(issue);
  const tokens = new Set();
  for (const m of text.matchAll(/\b(?:class|className|id)=["']([^"']+)["']/gi)) {
    for (const token of m[1].split(/\s+/).filter(Boolean)) tokens.add(token);
  }
  for (const m of text.matchAll(/[.#]([A-Za-z_][\w-]*)/g)) tokens.add(m[1]);
  return [...tokens];
}

export const RENDERER_GENERATED_NODE_SIGNATURES = [
  { owner: 'MathJax', pattern: /(?:^|[\s.#>])mjx-|mjx-container|mjx-assistive-mml|mathjax/i },
  { owner: 'WIRIS', pattern: /(?:^|[\s.#>])wrs[_-]|wiris/i },
  { owner: 'KaTeX', pattern: /(?:^|[\s.#>])katex(?:[\s.#>]|$)/i },
  { owner: 'MathQuill', pattern: /(?:^|[\s.#>])mq[A-Z_-]/ },
];

export const PLUGIN_GENERATED_NODE_SIGNATURES = [
  { owner: 'Spectrum', prefixes: ['sp-'], pattern: /(?:^|[\s"'.#:[>\]])sp-[A-Za-z0-9_-]+/i, minPrefixMatches: 2, characteristicTokens: ['sp-button', 'sp-action-button', 'sp-field-label', 'sp-textfield', 'sp-picker', 'sp-menu', 'sp-dialog'] },
  { owner: 'TinyMCE', prefixes: ['tox-'], pattern: /(?:^|[\s"'.#:[>\]])tox-[A-Za-z0-9_-]+/i, minPrefixMatches: 2, characteristicTokens: ['tox-tinymce', 'tox-editor-container', 'tox-toolbar', 'tox-statusbar', 'tox-dialog'] },
  { owner: 'CKEditor', prefixes: ['cke_'], pattern: /(?:^|[\s"'.#:[>\]])cke_[A-Za-z0-9_-]+/i, minPrefixMatches: 2, characteristicTokens: ['cke_editor', 'cke_contents', 'cke_top', 'cke_bottom', 'cke_dialog'] },
  { owner: 'jQuery UI', prefixes: ['ui-'], pattern: /(?:^|[\s"'.#:[>\]])ui-[A-Za-z0-9_-]+/i, minPrefixMatches: 2, characteristicTokens: ['ui-widget', 'ui-widget-content', 'ui-corner-all', 'ui-state-default', 'ui-helper-reset', 'ui-draggable', 'ui-resizable', 'ui-sortable', 'ui-accordion', 'ui-tabs', 'ui-dialog', 'ui-datepicker'] },
  { owner: 'Kendo UI', prefixes: ['k-'], pattern: /(?:^|[\s"'.#:[>\]])k-[A-Za-z0-9_-]+/i, minPrefixMatches: 2, characteristicTokens: ['k-widget', 'k-grid', 'k-animation-container', 'k-state-default', 'k-dropdown', 'k-textbox', 'k-button', 'k-tabstrip', 'k-calendar', 'k-scheduler'] },
  { owner: 'Select2', prefixes: ['select2'], pattern: /(?:^|[\s"'.#:[>\]])select2[A-Za-z0-9_-]*/i, minPrefixMatches: 2, characteristicTokens: ['select2-container', 'select2-selection', 'select2-dropdown', 'select2-results'] },
  { owner: 'Material UI', prefixes: ['Mui'], pattern: /(?:^|[\s"'.#:[>\]])Mui[A-Za-z0-9_-]+/, minPrefixMatches: 2, characteristicTokens: ['MuiButton-root', 'MuiTextField-root', 'MuiPaper-root', 'MuiDialog-root', 'MuiGrid-root'] },
  { owner: 'Ant Design', prefixes: ['ant-'], pattern: /(?:^|[\s"'.#:[>\]])ant-[A-Za-z0-9_-]+/i, minPrefixMatches: 2, characteristicTokens: ['ant-btn', 'ant-input', 'ant-form', 'ant-modal', 'ant-table', 'ant-select'] },
];

export const MANUAL_VERIFICATION_CODE_PATTERNS = [
  /BgImage/i,
  /BGColour/i,
  /ColourContrastWarning/i,
  /ColorContrastWarning/i,
  /G18\.Abs/i,
  /1_4_10|C32,C31,C33,C38,SCR34,G206/i,
];

export const MANUAL_VERIFICATION_TEXT_PATTERNS = [
  /\bcheck that\b/i,
  /\bcannot (?:be )?determin(?:e|ed)/i,
  /\bcan not be determined\b/i,
  /\bmay require\b/i,
  /\bensure\b.*\bcontrast ratio\b/i,
  /\bposition\s*:\s*fixed\b.*\bscrolling in two dimensions\b/i,
  /\bbackground colou?r\b.*\bnot be determined\b/i,
];

// Hard-blocked semantic transforms: multi-element or page-wide context required
export const UNSUPPORTED_SEMANTIC_RULE_PATTERNS = [
  /(?:^|\b)heading-order(?:\b|$)/i,
  /(?:^|\b)region(?:\b|$)/i,
  /(?:^|\b)bypass(?:\b|$)/i,
  /(?:^|\b)landmark-unique(?:\b|$)/i,
  /H85\.2/i,
  /1_3_2/i,
  /meaningful[-_. ]?sequence/i,
];

export const UNSUPPORTED_SEMANTIC_TEXT_PATTERNS = [
  /heading hierarchy/i,
  /meaningful sequence/i,
  /instructional text/i,
  /all page content should be contained by landmarks/i,
];

// Soft-blocked: fixable when a mapped source file + clear target element exist
export const ATTEMPTABLE_SEMANTIC_RULE_PATTERNS = [
  /(?:^|\b)page-has-heading-one(?:\b|$)/i,
  /(?:^|\b)landmark-one-main(?:\b|$)/i,
  /G141/i,
  /H42/i,
];

export const ATTEMPTABLE_SEMANTIC_TEXT_PATTERNS = [
  /heading structure.*not logically nested/i,
  /primary document heading/i,
  /heading markup should be used/i,
  /document should have one main landmark/i,
];

export function isAttemptableSemanticTransformIssue(issue) {
  const code = String(issue?.ruleId || issue?.code || issue?.id || '');
  const text = issueSearchText(issue);
  return ATTEMPTABLE_SEMANTIC_RULE_PATTERNS.some(rx => rx.test(code))
    || ATTEMPTABLE_SEMANTIC_TEXT_PATTERNS.some(rx => rx.test(text));
}

export function detectRendererGeneratedNode(issue) {
  const text = issueSearchText(issue);
  return RENDERER_GENERATED_NODE_SIGNATURES.find(signature => signature.pattern.test(text)) || null;
}

export function detectPluginGeneratedNode(issue) {
  const text = issueSearchText(issue);
  const tokens = issueDomTokens(issue);
  return PLUGIN_GENERATED_NODE_SIGNATURES.find(signature => {
    const minMatches = signature.minPrefixMatches || 1;
    if (minMatches <= 1) {
      if (signature.pattern.test(text)) return true;
      return tokens.some(token => signature.prefixes.some(prefix => token.startsWith(prefix)));
    }
    // Require multiple prefix matches or a characteristic token for broad prefixes
    if (signature.characteristicTokens?.some(ct => tokens.includes(ct) || text.includes(ct))) return true;
    const prefixMatchCount = tokens.filter(token => signature.prefixes.some(prefix => token.startsWith(prefix))).length;
    return prefixMatchCount >= minMatches;
  }) || null;
}

export function isRendererGeneratedNode(issue) {
  return Boolean(detectRendererGeneratedNode(issue));
}

export function isPluginGeneratedNode(issue) {
  return Boolean(detectPluginGeneratedNode(issue));
}

export function isManualVerificationScannerIssue(issue) {
  const code = String(issue?.ruleId || issue?.code || issue?.id || '');
  const text = issueSearchText(issue);
  return MANUAL_VERIFICATION_CODE_PATTERNS.some(rx => rx.test(code))
    || MANUAL_VERIFICATION_TEXT_PATTERNS.some(rx => rx.test(text));
}

export function isUnsupportedSemanticTransformIssue(issue) {
  const code = String(issue?.ruleId || issue?.code || issue?.id || '');
  const text = issueSearchText(issue);
  return UNSUPPORTED_SEMANTIC_RULE_PATTERNS.some(rx => rx.test(code))
    || UNSUPPORTED_SEMANTIC_TEXT_PATTERNS.some(rx => rx.test(text));
}

export const MANUAL_REVIEW_STOP_CONFIDENCE_THRESHOLD = 0.5;

export function manualReviewConfidenceScore(entry = {}) {
  if (typeof entry.confidence === 'number') return entry.confidence;
  if (entry.confidence === 'high') return 0.9;
  if (entry.confidence === 'medium') return 0.7;
  if (entry.confidence === 'low') return 0.4;
  return 0.4;
}

function normalizeManualReviewTag(value) {
  return String(value || '').trim().toLowerCase();
}

function hasManualReviewTag(value, tags) {
  const normalized = normalizeManualReviewTag(value);
  if (!normalized) return false;
  for (const tag of tags) {
    if (normalized === tag) return true;
    if (normalized.startsWith(`${tag} `)) return true;
    if (normalized.startsWith(`${tag}:`)) return true;
  }
  return false;
}

export const MANUAL_REVIEW_NON_BLOCKING_TAGS = Object.freeze([
  'mapping-not-strong-enough',
  'document-level-rule',
  'insufficient-mapping-evidence',
  'ambiguous-mapping',
  'unresolved-severe-violation',
]);

export const MANUAL_REVIEW_HARD_STOP_TAGS = Object.freeze([
  'unsupported-transform',
  'semantic-human-judgement-required',
  'semantic-transform-unmapped',
  'heading-rule-no-document-template-found',
  'no-candidate-files',
  'hard-stop',
]);

export function isManualReviewHardStop(entry = {}) {
  if (entry.override === true) return false;
  if (entry.hardStop === true) return true;
  if (entry.unsupportedTransform === true) return true;
  return hasManualReviewTag(entry.reason, MANUAL_REVIEW_HARD_STOP_TAGS)
    || hasManualReviewTag(entry.why, MANUAL_REVIEW_HARD_STOP_TAGS);
}

export function shouldStopForManualReviewEntry(entry = {}) {
  if (!entry?.violationId || entry.override === true) return false;
  if (isManualReviewHardStop(entry)) return true;
  if (hasManualReviewTag(entry.reason, MANUAL_REVIEW_NON_BLOCKING_TAGS)) return false;
  if (hasManualReviewTag(entry.why, MANUAL_REVIEW_NON_BLOCKING_TAGS)) return false;
  return manualReviewConfidenceScore(entry) >= MANUAL_REVIEW_STOP_CONFIDENCE_THRESHOLD;
}

export function buildIssueEligibility(solvability) {
  const eligible = solvability === Solvability.FIXABLE;
  return {
    fixerEligible: eligible,
    challengerEligible: eligible,
    verifierEligible: eligible,
    judgeEligible: eligible,
  };
}

export function classifyIssueSolvability(issue, context = {}) {
  if (context.alreadyFixed) {
    return { solvability: Solvability.ALREADY_FIXED, reason: 'already-fixed' };
  }
  if (context.rootCause) {
    return {
      solvability: Solvability.DUPLICATE_ROOT_CAUSE,
      rootCause: context.rootCause,
      rootCauseIssueId: context.rootCauseIssueId || null,
      evidence: context.evidence || null,
      reason: context.reason || 'resolved-by-root-cause',
    };
  }
  const thirdPartyFile = context.thirdPartyFile || context.mappedFile || null;
  if (thirdPartyFile && isThirdPartyFile(thirdPartyFile)) {
    return {
      solvability: Solvability.THIRD_PARTY_ASSET,
      owner: thirdPartyFile,
      evidence: context.thirdPartyEvidence || `third-party file: ${thirdPartyFile}`,
      reason: context.reason || 'third-party-asset',
    };
  }
  const renderer = detectRendererGeneratedNode(issue);
  if (renderer) {
    return { solvability: Solvability.PLUGIN_GENERATED_DOM, owner: renderer.owner, reason: 'third-party-renderer' };
  }
  const plugin = detectPluginGeneratedNode(issue);
  if (plugin) {
    return { solvability: Solvability.PLUGIN_GENERATED_DOM, owner: plugin.owner, reason: 'plugin-generated-dom' };
  }
  if (isManualVerificationScannerIssue(issue)) {
    return { solvability: Solvability.MANUAL_VERIFICATION, reason: 'scanner-cannot-prove-failure' };
  }
  if (context.unsupportedTransform || (!context.deferUnsupported && isUnsupportedSemanticTransformIssue(issue))) {
    return { solvability: Solvability.UNSUPPORTED_TRANSFORM, reason: context.reason || 'semantic-human-judgement-required' };
  }
  // ENH-01: unstable pa11y selectors cannot be reliably patched
  if (issue?.selectorStable === false) {
    return { solvability: Solvability.MANUAL_VERIFICATION, reason: 'selector-unstable' };
  }
  return { solvability: Solvability.FIXABLE, reason: 'fixable' };
}

export const BINARY_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.map',
];

export function isBinaryFile(relPath) {
  return BINARY_EXTS.includes(path.extname(relPath).toLowerCase());
}

export function shouldSkipFile(relPath) {
  return isBuildOutputPath(relPath) || isThirdPartyFile(relPath) || isBinaryFile(relPath);
}
