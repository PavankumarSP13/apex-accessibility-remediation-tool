import fs from 'fs/promises';
import path from 'path';
import ExcelJS from 'exceljs';
import chalk from 'chalk';
import ora from 'ora';
import { opts } from '../core/cli.js';
import { Solvability } from '../core/constants.js';
import { buildRemediationTrace, renderTraceMarkdown } from './trace.js';
import { logger } from '../core/logger.js';

const VALID_SOLVABILITY = new Set(Object.values(Solvability));

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

export function syncReportBaseline(data = {}) {
  if (!data || typeof data !== 'object') return null;
  const canonical = cloneJson(data?.analysis?.baseline || null);
  data.baseline = canonical;
  return canonical;
}

export function buildReportConsistencyAssertion(data = {}) {
  const analysis = data?.analysis || {};
  const allIssues = Array.isArray(analysis.allIssues) ? analysis.allIssues : [];
  const unified = Array.isArray(analysis.unified) ? analysis.unified : [];
  const permanentlyManualViolations = Array.isArray(analysis.permanentlyManualViolations)
    ? analysis.permanentlyManualViolations
    : [];
  const closedIssues = Array.isArray(analysis.closedIssues) ? analysis.closedIssues : [];

  const invalidSolvabilityIssues = allIssues
    .filter(issue => !VALID_SOLVABILITY.has(issue?.solvability))
    .map(issue => ({
      issueId: issue?.id || null,
      solvability: issue?.solvability || null,
    }));

  const classIntegrity = {
    ok: invalidSolvabilityIssues.length === 0,
    totalIssues: allIssues.length,
    invalidIssueCount: invalidSolvabilityIssues.length,
    invalidIssueSample: invalidSolvabilityIssues.slice(0, 25),
    allowedSolvabilityEnums: [...VALID_SOLVABILITY],
  };

  // permanentlyManualViolations includes initiallyManualViolations that were caught
  // before the dedup pipeline — those are NOT in allIssues. Only count the ones
  // that overlap with allIssues to get a correct partition check.
  const manualInAllIssues = permanentlyManualViolations.filter(v =>
    allIssues.some(a => a.id === v.id)
  );
  const expectedCount = unified.length + manualInAllIssues.length + closedIssues.length;
  const countIntegrity = {
    ok: allIssues.length === expectedCount,
    allIssuesCount: allIssues.length,
    expectedAllIssuesCount: expectedCount,
    unifiedCount: unified.length,
    permanentlyManualCount: permanentlyManualViolations.length,
    closedCount: closedIssues.length,
    excludedFromAllIssues: permanentlyManualViolations.length - manualInAllIssues.length,
    excludedFromAllIssuesSample: permanentlyManualViolations
      .filter(v => !allIssues.some(a => a.id === v.id))
      .slice(0, 5)
      .map(v => ({ id: v.id, solvability: v.solvability, reason: v.reason || v.manualReason })),
  };

  const canonicalBaseline = analysis?.baseline || null;
  const reportBaseline = data?.baseline || null;
  const baselineIntegrity = {
    ok: stableJson(reportBaseline) === stableJson(canonicalBaseline),
    canonicalBaseline,
    reportBaseline,
  };

  const errors = [];
  if (!classIntegrity.ok) errors.push(`class integrity failed (${classIntegrity.invalidIssueCount} issue(s) with invalid solvability)`);
  if (!baselineIntegrity.ok) errors.push('baseline integrity failed (report.baseline does not match analysis.baseline)');

  // Count integrity is diagnostic-only — a misalignment can happen when initiallyManualViolations
  // overlap with other categories after post-processing. We record the delta but don't block the report.
  if (!countIntegrity.ok) {
    const delta = countIntegrity.expectedAllIssuesCount - countIntegrity.allIssuesCount;
    const excluded = countIntegrity.excludedFromAllIssues ?? 0;
    console.warn(chalk.yellow(`  ⚠ Report count integrity: allIssues=${countIntegrity.allIssuesCount} vs expected=${countIntegrity.expectedAllIssuesCount} (Δ=${delta}, excluded=${excluded})`));
  }

  return {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    checks: {
      classIntegrity,
      countIntegrity,
      baselineIntegrity,
    },
    errors,
    warnings: !countIntegrity.ok ? [`count integrity: allIssues=${countIntegrity.allIssuesCount} expected=${countIntegrity.expectedAllIssuesCount}`] : [],
  };
}

function attachConsistencyAssertion(data, consistency) {
  data.assertions = {
    ...(data.assertions || {}),
    consistency,
  };
}

export async function generateExcelReport(fixes, sourceFileMap, analysis, scanUrl, verification = null, goodToHave = null) {
  const outDir    = path.resolve(opts.output);
  await fs.mkdir(outDir, { recursive: true });
  const excelPath = path.join(outDir, 'files-changed-report.xlsx');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Accessibility Agent';
  workbook.created = new Date();

  const sheet1 = workbook.addWorksheet('Changed Files');
  sheet1.columns = [
    { header: 'File Changed', key: 'file', width: 45 },
    { header: 'Mapped URL / Reference', key: 'url', width: 55 },
    { header: 'Mapping Source', key: 'mappingSource', width: 20 },
    { header: 'Violations Addressed', key: 'violationsAddressed', width: 22 },
    { header: 'Impact Levels', key: 'impactLevels', width: 30 },
  ];
  sheet1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };

  const fileToUrlMap  = new Map();
  const fileToPageUrl = new Map();
  if (sourceFileMap) {
    for (const entry of [...sourceFileMap.htmlFiles, ...sourceFileMap.cssFiles, ...sourceFileMap.jsFiles, ...sourceFileMap.otherFiles]) {
      const existing = fileToUrlMap.get(entry.localFile) || [];
      existing.push(entry.reference);
      fileToUrlMap.set(entry.localFile, existing);
    }
  }
  if (analysis?.mapping) {
    for (const m of analysis.mapping) {
      const v = analysis.unified?.find(u => u.id === m.violationId);
      if (v?.page && !fileToPageUrl.has(m.file)) fileToPageUrl.set(m.file, v.page);
    }
  }

  for (const fix of (fixes || [])) {
    const urlRefs  = fileToUrlMap.get(fix.file) || [];
    const pageUrl  = fileToPageUrl.get(fix.file) || scanUrl || '';
    const mappedUrl    = urlRefs.length > 0 ? urlRefs.join('; ') : pageUrl;
    const mappingSource = urlRefs.length > 0 ? 'identifySourceFilesForUrl' : pageUrl ? 'phase4 mapping' : '';
    const fileViolations = analysis?.mapping?.filter(m => m.file === fix.file).map(m => analysis.unified?.find(v => v.id === m.violationId)).filter(Boolean) || [];
    sheet1.addRow({ file: fix.file, url: mappedUrl, mappingSource, violationsAddressed: fix.violationsAddressed, impactLevels: [...new Set(fileViolations.map(v => v.impact))].join(', ') || 'N/A' });
  }

  if (sourceFileMap) {
    const sheet2 = workbook.addWorksheet('All Source File Mappings');
    sheet2.columns = [
      { header: 'Local File', key: 'localFile', width: 45 },
      { header: 'URL Reference', key: 'reference', width: 55 },
      { header: 'File Type', key: 'fileType', width: 15 },
      { header: 'Was Modified', key: 'wasModified', width: 15 },
    ];
    sheet2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
    const changedFiles = new Set((fixes || []).map(f => f.file));
    for (const entry of [
      ...sourceFileMap.htmlFiles.map(e => ({ ...e, fileType: 'HTML/Razor' })),
      ...sourceFileMap.cssFiles.map(e => ({ ...e, fileType: 'CSS' })),
      ...sourceFileMap.jsFiles.map(e => ({ ...e, fileType: 'JS/TS' })),
      ...sourceFileMap.otherFiles.map(e => ({ ...e, fileType: 'Other' })),
    ]) {
      const row = sheet2.addRow({ localFile: entry.localFile, reference: entry.reference, fileType: entry.fileType, wasModified: changedFiles.has(entry.localFile) ? 'Yes' : 'No' });
      if (changedFiles.has(entry.localFile)) row.getCell('wasModified').font = { bold: true, color: { argb: 'FF16A34A' } };
    }
  }

  const sheet3 = workbook.addWorksheet('Violations Summary');
  sheet3.columns = [
    { header: 'Violation ID', key: 'id', width: 35 }, { header: 'Impact', key: 'impact', width: 12 },
    { header: 'Source', key: 'source', width: 20 },   { header: 'Description', key: 'description', width: 50 },
    { header: 'Mapped File', key: 'file', width: 40 }, { header: 'Page URL', key: 'page', width: 45 },
  ];
  sheet3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
  const IMPACT_FILL = {
    critical: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } },
    serious:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7ED' } },
    moderate: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } },
    minor:    { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } },
  };
  for (const v of (analysis?.unified || [])) {
    const mappedFile = analysis.mapping?.find(m => m.violationId === v.id)?.file || v.file || '';
    const row = sheet3.addRow({ id: v.id, impact: v.impact, source: v.source, description: (v.description || '').slice(0, 200), file: mappedFile, page: v.page || scanUrl || '' });
    if (IMPACT_FILL[v.impact]) row.fill = IMPACT_FILL[v.impact];
  }

  if (analysis?.baseline || verification) {
    const sheet4 = workbook.addWorksheet('Verification Summary');
    sheet4.columns = [
      { header: 'Metric', key: 'metric', width: 30 },
      { header: 'Value', key: 'value', width: 20 },
      { header: 'Notes', key: 'notes', width: 50 },
    ];
    sheet4.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet4.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    const summary = verification?.summary || null;
    const rows = [
      { metric: 'Baseline actionable issues', value: analysis?.baseline?.actionableCount ?? '', notes: 'Deterministic runtime baseline' },
      { metric: 'Baseline autofix eligible', value: analysis?.baseline?.autofixEligibleCount ?? '', notes: 'Transformation-supported issues only' },
      { metric: 'Baseline already fixed', value: analysis?.baseline?.closedCount ?? '', notes: 'Closed before remediation because source already satisfies the rule' },
      { metric: 'Baseline manual review', value: analysis?.baseline?.manualReviewCount ?? '', notes: 'Mapped but not safely autofixable' },
      { metric: 'Resolved issues', value: summary?.resolvedTotal ?? '', notes: 'Resolved after full rescan' },
      { metric: 'Resolved fixable issues', value: summary?.resolvedFixableTotal ?? '', notes: 'Resolved among autofix-eligible issues' },
      { metric: 'Source patched (pending verification)', value: summary?.sourcePatchedPendingVerification ?? '', notes: 'Source files patched correctly; awaiting live server restart to confirm' },
      { metric: 'Introduced issues', value: summary?.introducedTotal ?? '', notes: 'New issues detected after fixes' },
    ];
    rows.forEach(row => sheet4.addRow(row));
  }

  const gthSuggestions = goodToHave?.suggestions ?? [];
  if (gthSuggestions.length > 0) {
    const sheet5 = workbook.addWorksheet('Good-to-Have Suggestions');
    sheet5.columns = [
      { header: 'Rule ID',     key: 'ruleId',       width: 22 },
      { header: 'Category',    key: 'category',     width: 20 },
      { header: 'Description', key: 'description',  width: 60 },
      { header: 'Current Alt', key: 'currentAlt',   width: 40 },
      { header: 'Suggestion',  key: 'suggestion',   width: 55 },
      { header: 'Selector',    key: 'selector',     width: 40 },
      { header: 'Auto-fixed',  key: 'fixable',      width: 12 },
    ];
    sheet5.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet5.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
    const GTH_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF5FF' } };
    for (const s of gthSuggestions) {
      const row = sheet5.addRow({
        ruleId:      s.ruleId || '',
        category:    s.category || '',
        description: (s.description || '').slice(0, 200),
        currentAlt:  s.currentAlt != null ? String(s.currentAlt).slice(0, 200) : '',
        suggestion:  (s.suggestion || '').slice(0, 200),
        selector:    (s.selector || '').slice(0, 200),
        fixable:     s.fixable ? 'Yes' : 'No',
      });
      row.fill = GTH_FILL;
      if (s.fixable) row.getCell('fixable').font = { bold: true, color: { argb: 'FF16A34A' } };
    }
  }

  await workbook.xlsx.writeFile(excelPath);
  console.log(`\n  ${chalk.bold.green('✓')}  Excel report → ${chalk.cyan(excelPath)}`);
  return excelPath;
}

export async function phase8_report(data, options = {}) {
  const strictConsistency = options?.strictConsistency !== false;
  const outDir = logger.dir || path.resolve(opts.output);
  await fs.mkdir(outDir, { recursive: true });

  syncReportBaseline(data);
  const consistency = buildReportConsistencyAssertion(data);
  attachConsistencyAssertion(data, consistency);
  if (strictConsistency && !consistency.ok) {
    const err = new Error(`Report consistency assertion failed: ${consistency.errors.join('; ')}`);
    err.consistency = consistency;
    throw err;
  }

  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(data, null, 2));
  const trace = buildRemediationTrace(data);
  const traceMdPath = path.join(outDir, 'remediation-trace.md');
  await fs.writeFile(traceMdPath, renderTraceMarkdown(trace));
  const htmlPath = path.join(outDir, 'index.html');
  await fs.writeFile(htmlPath, buildHTML({ ...data, goodToHave: data.goodToHave ?? null }));
  console.log(`\n  ${chalk.bold.green('✓')}  Report → ${chalk.cyan(outDir)}`);
  console.log(`      Open: ${chalk.underline(htmlPath)}\n`);
  console.log(`      Trace: ${chalk.underline(traceMdPath)}\n`);
  console.log(`      Live logs: ${chalk.underline(path.join(outDir, 'live.txt'))}, ${chalk.underline(path.join(outDir, 'scanner-issues.txt'))}, ${chalk.underline(path.join(outDir, 'remediation.txt'))}\n`);
  if (logger.runLabel) console.log(`      Run folder: ${chalk.underline(outDir)}\n`);
  writeRemediationSummary(data);
}

export async function writeMinimalReport(data = {}, context = {}) {
  const outDir = logger.dir || path.resolve(opts.output);
  await fs.mkdir(outDir, { recursive: true });

  data.incomplete = true;
  data.incompleteReason = context.reason || data.incompleteReason || 'run-incomplete';
  data.failure = {
    ...(data.failure || {}),
    phase: context.phase || data?.failure?.phase || null,
    reason: context.reason || data?.failure?.reason || data.incompleteReason,
    error: context.error || data?.failure?.error || null,
    timestamp: new Date().toISOString(),
  };

  syncReportBaseline(data);
  const consistency = buildReportConsistencyAssertion(data);
  attachConsistencyAssertion(data, consistency);

  const reportPath = path.join(outDir, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(data, null, 2));
  console.log(`\n  ${chalk.bold.yellow('!')}  Minimal report → ${chalk.cyan(reportPath)} (incomplete run)`);
  return reportPath;
}

function writeRemediationSummary(data) {
  const fixes = data?.fixes || [];
  const verificationByFile = new Map((data?.fixVerification || []).map(v => [v.file, v]));
  const unsureByFile = new Map((data?.unsureChanges || []).map(v => [v.file, v]));
  if (fixes.length > 0) {
    logger.remediation('');
    logger.remediation('=== File Change Reasoning Summary ===');
    logger.remediation('| Status | File | Issues | Agent reasoning |');
    logger.remediation('| --- | --- | ---: | --- |');
    for (const fix of fixes) {
      const verification = verificationByFile.get(fix.file);
      const unsure = unsureByFile.get(fix.file);
      const status = fix.verificationStatus || unsure?.status || verification?.status || 'changed';
      const reason = (fix.agentReasoning || unsure?.agentReasoning || 'No agent reasoning captured.')
        .replace(/\s+/g, ' ')
        .slice(0, 700);
      logger.remediation(`| ${status} | ${fix.file} | ${fix.violationsAddressed || 0} | ${reason} |`);
    }
    if ((data?.unsureChanges || []).length > 0) {
      logger.remediation('');
      logger.remediation('Unsure changes: targeted verification could not prove these file-level changes. They were kept intentionally for full-page rescan and human keep/remove review.');
    }
  }

  const toSnippet = (value, max = 180) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
  };
  const hasVerificationIssues = Array.isArray(data?.verification?.issues);
  const unresolved = hasVerificationIssues
    ? (data.verification.issues || [])
      .filter(issue => issue?.status !== 'resolved')
      .map(issue => ({
        status: issue?.status || 'unresolved',
        issueId: issue?.issueId || 'unknown-issue',
        ruleId: issue?.ruleId || '',
        file: issue?.mappedFile || '',
        reason: toSnippet(issue?.description || issue?.reason || issue?.target || issue?.element),
      }))
    : (data?.agentTrail || [])
      .filter(issue => issue && !issue.resolved)
      .map(issue => ({
        status: issue?.status || (issue?.pendingLiveVerification ? 'pending-live-verification' : 'unresolved'),
        issueId: issue?.issueId || 'unknown-issue',
        ruleId: issue?.ruleId || '',
        file: issue?.file || issue?.files?.[0] || '',
        reason: toSnippet(issue?.verifier?.notes || issue?.live?.notes || issue?.challenger?.reasoning || issue?.fixer?.reasoning || issue?.reason),
      }));

  logger.remediation('');
  logger.remediation(`=== Unresolved Issues (${unresolved.length}) ===`);
  for (const issue of unresolved) {
    const details = [];
    if (issue.ruleId) details.push(`rule=${issue.ruleId}`);
    if (issue.file) details.push(`file=${issue.file}`);
    if (issue.reason) details.push(`reason=${issue.reason}`);
    logger.remediation(`- [${issue.status}] ${issue.issueId}${details.length > 0 ? ` | ${details.join(' | ')}` : ''}`);
  }
}

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/`/g,'&#96;').replace(/\$/g,'&#36;');
}

export function buildHTML({ before, after, analysis, fixes, judgment, verification, fixVerification = [], unsureChanges = [], incomplete = false, incompleteReason = '', goodToHave = null }) {
  const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];
  const impactRank = (impact) => { const i = IMPACT_ORDER.indexOf(impact); return i === -1 ? IMPACT_ORDER.length : i; };
  const sorted = [...(analysis?.unified ?? [])].sort(
    (a, b) => impactRank(a.impact) - impactRank(b.impact)
  );
  const IMPACT_COLOR  = { critical:'#dc2626', serious:'#ea580c', moderate:'#d97706', minor:'#16a34a' };
  const SOURCE_COLOR  = { 'axe':'#2563eb', 'lighthouse':'#7c3aed', 'pa11y':'#d97706', 'keyboard':'#059669', 'image-alt':'#dc2626', 'focusable-action':'#0891b2' };
  const badge  = (impact) =>
    `<span style="background:${IMPACT_COLOR[impact]??'#6b7280'};color:#fff;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">${impact}</span>`;
  const srcBadge = (src) =>
    `<span style="background:${SOURCE_COLOR[src]??'#6b7280'}22;color:${SOURCE_COLOR[src]??'#6b7280'};border:1px solid ${SOURCE_COLOR[src]??'#6b7280'}44;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:600;white-space:nowrap">${src}</span>`;

  const beforeAxe     = before?.axe?.reduce((s,r)=>s+r.violations.length,0) ?? 0;
  const afterAxeFailed = after?.axe?.scanFailed === true || after?.axe?.some?.(r => r.scanFailed === true);
  const afterAxe      = afterAxeFailed ? null : (after?.axe?.reduce((s,r)=>s+r.violations.length,0)  ?? null);
  const afterLhUnavailable = after?.lh?.scanFailed === true || after?.lh?.invalid === true;
  const afterLhUnavailableLabel = after?.lh?.scanFailed === true ? 'scan failed' : 'rescan invalid';
  const beforePa11yE  = before?.pa11y?.errorCount   ?? 0;
  const beforePa11yW  = before?.pa11y?.warningCount ?? 0;
  const afterPa11yUnavailable = after?.pa11y?.scanFailed === true || after?.pa11y?.partialScanFailed === true;
  const afterPa11yUnavailableLabel = after?.pa11y?.partialScanFailed === true ? `partial scan failed (${after.pa11y.unavailableCount ?? after.pa11y.unavailable?.length ?? 0} page(s))` : 'scan failed';
  const afterPa11yE   = afterPa11yUnavailable ? null : (after?.pa11y?.errorCount ?? null);
  const afterPa11yW   = afterPa11yUnavailable ? null : (after?.pa11y?.warningCount ?? null);
  const verificationSummary = verification?.summary || null;

  // ── Outcome counts (single source of truth so the report never contradicts itself) ──
  const manualList       = analysis?.permanentlyManualViolations ?? [];
  const closedList       = analysis?.closedIssues ?? [];
  const alreadyFixedCount = closedList.filter(v => v.solvability === Solvability.ALREADY_FIXED).length;
  const thirdPartyCount  = manualList.filter(v => v.solvability === Solvability.THIRD_PARTY_ASSET).length;
  const pluginGeneratedCount = manualList.filter(v => v.solvability === Solvability.PLUGIN_GENERATED_DOM || (v.manualReason || '') === 'third-party-renderer').length;
  const duplicateRootCauseCount = manualList.filter(v => v.solvability === Solvability.DUPLICATE_ROOT_CAUSE).length;
  const unsupportedTransformCount = manualList.filter(v => v.solvability === Solvability.UNSUPPORTED_TRANSFORM).length;
  const manualVerificationCount = manualList.filter(v => v.solvability === Solvability.MANUAL_VERIFICATION).length;
  const classifiedManualCount = thirdPartyCount + pluginGeneratedCount + duplicateRootCauseCount + unsupportedTransformCount + manualVerificationCount;
  const otherManualCount = Math.max(0, manualList.length - classifiedManualCount);
  const actionableCount  = sorted.length;
  const totalFoundCount  = actionableCount + manualList.length + closedList.length;

  // Map each baseline issue to its verified status for ledger-driven rendering.
  const issueStatusById = new Map((Array.isArray(verification?.issues) ? verification.issues : []).map(i => [i.issueId, i.status]));
  const verificationIssues = verification?.issues ?? [];
  const hasIssueLedger = verificationIssues.length > 0;
  const RESOLVED = new Set(['resolved']);
  const countIssueStatuses = (statuses) => verificationIssues.filter(issue => statuses.includes(issue.status)).length;
  const verificationByFile = new Map((fixVerification || []).map(v => [v.file, v]));
  const unsureByFile = new Map((unsureChanges || []).map(v => [v.file, v]));
  const fixedCount = hasIssueLedger
    ? countIssueStatuses(['resolved'])
    : verificationSummary
    ? (verificationSummary.resolvedTotal ?? 0)
    : (analysis?.mapping?.filter(m => m.autofixAllowed).length ?? (fixes?.length ?? 0));
  const fixedIsVerified  = Boolean(verificationSummary);
  const fixedIsStatic    = Boolean(verificationSummary?.staticOnly);
  const sourcePatchedPendingCount = verificationSummary?.sourcePatchedPendingVerification ?? (hasIssueLedger ? countIssueStatuses(['pending-live-verification']) : 0);
  const notFixedCount    = hasIssueLedger ? countIssueStatuses(['persistent', 'attempted-unresolved', 'not-attempted']) : Math.max(0, actionableCount - fixedCount - sourcePatchedPendingCount);
  const couldNotVerifyCount = hasIssueLedger ? countIssueStatuses(['scan-failed', 'verified-static-unconfirmed', 'not-rescanned', 'attempted-unresolved']) : 0;
  const introducedCount  = verificationSummary?.introducedTotal ?? 0;
  const rolledBackCount  = hasIssueLedger ? countIssueStatuses(['rolled-back']) : (verificationSummary?.rolledBackTotal ?? 0);
  const unsureCount      = unsureChanges?.length ?? 0;
  const filesChangedCount = fixes?.length ?? 0;
  const fixedSourceLabel = !fixedIsVerified ? 'agent-applied (unverified)' : fixedIsStatic ? 'static fallback (unconfirmed)' : 'verified by live re-scan';
  const SOLVABILITY_COLOR = {
    FIXABLE: '#16a34a',
    MANUAL_VERIFICATION: '#d97706',
    THIRD_PARTY_ASSET: '#6b7280',
    PLUGIN_GENERATED_DOM: '#6b7280',
    DUPLICATE_ROOT_CAUSE: '#6b7280',
    ALREADY_FIXED: '#6b7280',
    UNSUPPORTED_TRANSFORM: '#6b7280',
  };
  const solvabilityBadge = (solv) => {
    if (!solv) return '<span style="color:#94a3b8;font-size:.72rem">—</span>';
    const color = SOLVABILITY_COLOR[solv] || '#6b7280';
    return `<span style="background:${color}1a;color:${color};border:1px solid ${color}55;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap">${escapeHtml(solv)}</span>`;
  };

  const statusBadge = (status) => {
    if (!status) return '';
    const color = RESOLVED.has(status)
      ? '#16a34a'
      : status === 'persistent' || status === 'attempted-unresolved'
        ? '#dc2626'
        : ['rolled-back', 'scan-failed', 'verified-static-unconfirmed', 'not-rescanned', 'pending-live-verification'].includes(status)
          ? '#d97706'
          : '#64748b';
    const label = status === 'verified-static-unconfirmed'
      ? 'needs live verification'
      : status === 'scan-failed'
        ? 'could not verify'
        : status === 'attempted-unresolved'
          ? 'attempted unresolved'
          : status === 'pending-live-verification'
            ? 'pending live verification'
            : RESOLVED.has(status)
              ? 'fixed'
              : status;
    return `<span style="background:${color}1a;color:${color};border:1px solid ${color}55;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap">${escapeHtml(label)}</span>`;
  };

  const lhColor = (s) => s >= 90 ? '#16a34a' : s >= 70 ? '#d97706' : '#dc2626';
  const delta   = (before, after, lowerIsBetter = true) => {
    if (after === null || after === undefined) return '';
    const better = lowerIsBetter ? after < before : after > before;
    const same   = after === before;
    const arrow  = better ? '▼' : same ? '=' : '▲';
    const color  = better ? '#16a34a' : same ? '#64748b' : '#dc2626';
    return `<span style="color:${color};font-weight:700">${arrow} ${after}</span>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Accessibility Report</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html{overflow-x:hidden}
    body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;padding:2rem;max-width:1200px;margin:0 auto;line-height:1.6;overflow-x:hidden}
    h1{font-size:1.75rem;font-weight:700;margin-bottom:.25rem}
    h2{font-size:.85rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin:2.5rem 0 .75rem}
    .meta{color:#64748b;font-size:.85rem;margin-bottom:2rem}
    .score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:2rem}
    .score-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1.25rem}
    .score-card-head{font-size:.7rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.75rem;display:flex;align-items:center;gap:.4rem}
    .score-row{display:flex;justify-content:space-between;align-items:center;font-size:.85rem;padding:.2rem 0;border-bottom:1px solid #f1f5f9}
    .score-row:last-child{border-bottom:none}
    .score-val{font-weight:700;font-size:1.1rem}
    .score-after{font-size:.8rem;margin-left:.5rem}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:1.5rem;table-layout:fixed}
    th{background:#f1f5f9;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:.6rem 1rem;text-align:left;color:#475569;overflow:hidden;text-overflow:ellipsis}
    td{padding:.65rem 1rem;border-top:1px solid #f1f5f9;font-size:.85rem;vertical-align:top;overflow:hidden;word-wrap:break-word}
    tr:hover td{background:#f8fafc}
    code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:.78rem;font-family:monospace;word-break:break-all;overflow-wrap:break-word}
    .fix{color:#16a34a;font-size:.82rem}
    .evidence{color:#64748b;font-size:.78rem;font-style:italic}
    .file-loc{font-size:.78rem;color:#2563eb;font-family:monospace}
    a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
    .verdict{display:inline-block;padding:4px 16px;border-radius:999px;font-weight:700;font-size:.9rem}
    .approved{background:#dcfce7;color:#15803d}
    .rejected{background:#fee2e2;color:#b91c1c}
    .needs-review{background:#fef9c3;color:#92400e}
    .judge{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1.5rem}
    .judge-grid{display:grid;grid-template-columns:1fr;gap:1rem;margin-top:1rem}
    .label{font-size:.72rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.3rem}
    ul.review-list{margin:.5rem 0 0 1.25rem;font-size:.875rem}
    .ss-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;margin-bottom:2rem}
    .ss-card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
    .ss-card img{width:100%;display:block;max-height:200px;object-fit:cover;object-position:top}
    .ss-label{padding:.5rem .75rem;font-size:.75rem;color:#475569;background:#f8fafc;border-top:1px solid #e2e8f0}
    details{margin-bottom:.5rem}
    details summary{cursor:pointer;font-size:.82rem;color:#2563eb;user-select:none}
    .element-html{background:#f1f5f9;padding:.4rem .6rem;border-radius:4px;font-size:.75rem;font-family:monospace;margin-top:.3rem;white-space:pre-wrap;word-break:break-all;max-height:80px;overflow:auto}
    .dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
  </style>
</head>
<body>
  <h1>♿ Accessibility Report</h1>
  <p class="meta">Generated ${new Date().toLocaleString()}${after ? ' &nbsp;·&nbsp; <strong>Includes post-fix rescan</strong>' : ''}${incomplete ? ` &nbsp;·&nbsp; <strong style="color:#b91c1c">Incomplete run: ${escapeHtml(incompleteReason || 'see report.json failure details')}</strong>` : ''}</p>

  <h2>Scanner Scores ${after ? '— Before &amp; After' : ''}</h2>
  <div class="score-grid">
    <div class="score-card">
      <div class="score-card-head"><span class="dot" style="background:#7c3aed"></span>Lighthouse</div>
      <div class="score-row">
        <span>Score</span>
        <span>
          <span class="score-val" style="color:${lhColor(before?.lh?.score??0)}">${before?.lh?.score??'—'}/100</span>
          ${after && !afterLhUnavailable ? `<span class="score-after">${delta(before?.lh?.score??0, after?.lh?.score, false)}/100</span>` : ''}
          ${afterLhUnavailable ? `<span class="score-after" style="color:#d97706;font-size:.7rem">(${afterLhUnavailableLabel})</span>` : ''}
        </span>
      </div>
      <div class="score-row">
        <span>Failed audits</span>
        <span>
          <span class="score-val" style="color:${(before?.lh?.failed?.length??0)>0?'#dc2626':'#16a34a'}">${before?.lh?.failed?.length??0}</span>
          ${after && !afterLhUnavailable ? `<span class="score-after">${delta(before?.lh?.failed?.length??0, after?.lh?.failed?.length)}</span>` : ''}
        </span>
      </div>
      <div class="score-row"><span>Passed audits</span><span class="score-val" style="color:#16a34a">${before?.lh?.passed?.length??0}</span></div>
    </div>
    <div class="score-card">
      <div class="score-card-head"><span class="dot" style="background:#2563eb"></span>Axe-core</div>
      <div class="score-row">
        <span>Violations</span>
        <span>
          <span class="score-val" style="color:${beforeAxe>0?'#dc2626':'#16a34a'}">${beforeAxe}</span>
          ${afterAxeFailed ? `<span class="score-after" style="color:#d97706;font-size:.7rem">(rescan failed)</span>` : after ? `<span class="score-after">${delta(beforeAxe, afterAxe)}</span>` : ''}
        </span>
      </div>
      ${['critical','serious','moderate','minor'].map(imp => {
        const n = before?.axe?.reduce((s,r)=>s+r.violations.filter(v=>v.impact===imp).length,0)??0;
        return n>0 ? `<div class="score-row"><span style="text-transform:capitalize">${imp}</span><span class="score-val" style="font-size:.9rem;color:${IMPACT_ORDER.indexOf(imp)<2?'#dc2626':'#d97706'}">${n}</span></div>` : '';
      }).join('')}
    </div>
    <div class="score-card">
      <div class="score-card-head"><span class="dot" style="background:#d97706"></span>pa11y (HTML_CodeSniffer)</div>
      <div class="score-row">
        <span>Errors</span>
        <span>
          <span class="score-val" style="color:${beforePa11yE>0?'#dc2626':'#16a34a'}">${beforePa11yE}</span>
          ${afterPa11yUnavailable ? `<span class="score-after" style="color:#d97706;font-size:.7rem">(${afterPa11yUnavailableLabel})</span>` : afterPa11yE !== null ? `<span class="score-after">${delta(beforePa11yE, afterPa11yE)}</span>` : ''}
        </span>
      </div>
      <div class="score-row">
        <span>Warnings</span>
        <span>
          <span class="score-val" style="color:${beforePa11yW>0?'#ea580c':'#16a34a'}">${beforePa11yW}</span>
          ${afterPa11yUnavailable ? `<span class="score-after" style="color:#d97706;font-size:.7rem">(${afterPa11yUnavailableLabel})</span>` : afterPa11yW !== null ? `<span class="score-after">${delta(beforePa11yW, afterPa11yW)}</span>` : ''}
        </span>
      </div>
    </div>
    <div class="score-card">
      <div class="score-card-head"><span class="dot" style="background:#0f172a"></span>Overall</div>
      <div class="score-row"><span>Actionable</span><span class="score-val" style="color:${sorted.length>0?'#dc2626':'#16a34a'}">${sorted.length}</span></div>
      ${IMPACT_ORDER.map(imp => `<div class="score-row"><span>${imp}</span><span class="score-val" style="color:${IMPACT_COLOR[imp]}">${sorted.filter(v=>v.impact===imp).length}</span></div>`).join('')}
      ${(analysis?.permanentlyManualViolations?.length??0)>0?`<div class="score-row"><span>Manual only</span><span class="score-val" style="color:#64748b">${analysis.permanentlyManualViolations.length}</span></div>`:''}
      ${verificationSummary?`<div class="score-row"><span>Resolved</span><span class="score-val" style="color:#16a34a">${verificationSummary.resolvedTotal}/${verificationSummary.baselineTotal}</span></div>`:''}
      ${verificationSummary?`<div class="score-row"><span>Fixable resolved</span><span class="score-val" style="color:#16a34a">${verificationSummary.resolvedFixableTotal}/${verificationSummary.baselineFixableTotal}</span></div>`:''}
      ${verificationSummary?.sourcePatchedPendingVerification>0?`<div class="score-row"><span>Source patched (pending)</span><span class="score-val" style="color:#16a34a">${verificationSummary.sourcePatchedPendingVerification}</span></div>`:''}
      ${verificationSummary?`<div class="score-row"><span>New issues</span><span class="score-val" style="color:${verificationSummary.introducedTotal>0?'#dc2626':'#16a34a'}">${verificationSummary.introducedTotal}</span></div>`:''}
      ${unsureCount>0?`<div class="score-row"><span>Unsure changes</span><span class="score-val" style="color:#d97706">${unsureCount}</span></div>`:''}
      ${fixes?`<div class="score-row"><span>Files fixed</span><span class="score-val" style="color:#16a34a">${fixes.length}</span></div>`:''}
      ${judgment?.score!=null?`<div class="score-row"><span>Judge score</span><span class="score-val" style="color:#7c3aed">${judgment.score}/10</span></div>`:''}
    </div>
  </div>

  ${after?`
  <h2>Re-scan Results — Before vs After Fix</h2>
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:2rem">
    <table style="margin:0;border:none">
      <thead>
        <tr>
          <th style="width:200px">Scanner / Metric</th>
          <th style="width:120px;text-align:center">Before</th>
          <th style="width:120px;text-align:center">After</th>
          <th style="width:120px;text-align:center">Change</th>
        </tr>
      </thead>
      <tbody>
        <tr style="background:#f8fafc">
          <td style="font-weight:700;color:#7c3aed">Lighthouse Score</td>
          <td style="text-align:center;font-weight:700">${before?.lh?.score??'—'}/100</td>
          <td style="text-align:center;font-weight:700">${afterLhUnavailable ? `<span style="color:#d97706">${afterLhUnavailableLabel}</span>` : `${after?.lh?.score??'—'}/100`}</td>
          <td style="text-align:center">${(()=>{if(afterLhUnavailable)return'<span style="color:#d97706;font-size:.75rem">data unavailable — not improvement</span>';const b=before?.lh?.score,a=after?.lh?.score;if(a==null||b==null)return'—';const d=a-b;return d>0?`<span style="color:#16a34a;font-weight:700">+${d}</span>`:d<0?`<span style="color:#dc2626;font-weight:700">${d}</span>`:`<span style="color:#64748b">0</span>`;})()}</td>
        </tr>
        <tr>
          <td style="font-weight:700;color:#7c3aed">Lighthouse Failed Audits</td>
          <td style="text-align:center">${before?.lh?.failed?.length??0}</td>
          <td style="text-align:center">${afterLhUnavailable ? `<span style="color:#d97706">${afterLhUnavailableLabel}</span>` : (after?.lh?.failed?.length??0)}</td>
          <td style="text-align:center">${(()=>{if(afterLhUnavailable)return'<span style="color:#d97706;font-size:.75rem">data unavailable — not improvement</span>';const b=before?.lh?.failed?.length??0,a=after?.lh?.failed?.length??0,d=b-a;return d>0?`<span style="color:#16a34a;font-weight:700">-${d} fixed</span>`:d<0?`<span style="color:#dc2626;font-weight:700">+${Math.abs(d)} new</span>`:`<span style="color:#64748b">no change</span>`;})()}</td>
        </tr>
        <tr style="background:#f8fafc">
          <td style="font-weight:700;color:#2563eb">Axe-core Total Violations</td>
          <td style="text-align:center;font-weight:700">${beforeAxe}</td>
          <td style="text-align:center;font-weight:700">${afterAxeFailed ? '<span style="color:#d97706">scan failed</span>' : (afterAxe??'—')}</td>
          <td style="text-align:center">${(()=>{if(afterAxeFailed)return'<span style="color:#d97706;font-size:.75rem">data unavailable — not improvement</span>';if(afterAxe==null)return'—';const d=beforeAxe-afterAxe;return d>0?`<span style="color:#16a34a;font-weight:700">-${d} fixed</span>`:d<0?`<span style="color:#dc2626;font-weight:700">+${Math.abs(d)} new</span>`:`<span style="color:#64748b">no change</span>`;})()}</td>
        </tr>
        ${['critical','serious','moderate','minor'].map(imp => {
          const bCount = before?.axe?.reduce((s,r)=>s+r.violations.filter(v=>v.impact===imp).length,0)??0;
          const aCount = afterAxeFailed ? null : (after?.axe?.reduce((s,r)=>s+r.violations.filter(v=>v.impact===imp).length,0)??0);
          if(bCount===0&&aCount===0)return'';
          const d=afterAxeFailed?null:bCount-aCount;
          const changeHtml=afterAxeFailed?'<span style="color:#d97706;font-size:.75rem">scan failed</span>':d>0?`<span style="color:#16a34a;font-weight:700">-${d}</span>`:d<0?`<span style="color:#dc2626;font-weight:700">+${Math.abs(d)}</span>`:`<span style="color:#64748b">0</span>`;
          return `<tr><td style="padding-left:2rem;color:#64748b">Axe · ${imp}</td><td style="text-align:center">${bCount}</td><td style="text-align:center">${afterAxeFailed?'—':aCount}</td><td style="text-align:center">${changeHtml}</td></tr>`;
        }).join('')}
        <tr style="background:#f8fafc">
          <td style="font-weight:700;color:#d97706">pa11y Errors</td>
          <td style="text-align:center;font-weight:700">${beforePa11yE}</td>
          <td style="text-align:center;font-weight:700">${afterPa11yUnavailable ? `<span style="color:#d97706">${afterPa11yUnavailableLabel}</span>` : (afterPa11yE??'—')}</td>
          <td style="text-align:center">${(()=>{if(afterPa11yUnavailable)return'<span style="color:#d97706;font-size:.75rem">data incomplete — not verified improvement</span>';if(afterPa11yE==null)return'—';const d=beforePa11yE-afterPa11yE;return d>0?`<span style="color:#16a34a;font-weight:700">-${d} fixed</span>`:d<0?`<span style="color:#dc2626;font-weight:700">+${Math.abs(d)} new</span>`:`<span style="color:#64748b">no change</span>`;})()}</td>
        </tr>
        <tr>
          <td style="font-weight:700;color:#d97706">pa11y Warnings</td>
          <td style="text-align:center">${beforePa11yW}</td>
          <td style="text-align:center">${afterPa11yUnavailable ? `<span style="color:#d97706">${afterPa11yUnavailableLabel}</span>` : (afterPa11yW??'—')}</td>
          <td style="text-align:center">${(()=>{if(afterPa11yUnavailable)return'<span style="color:#d97706;font-size:.75rem">data incomplete — not verified improvement</span>';if(afterPa11yW==null)return'—';const d=beforePa11yW-afterPa11yW;return d>0?`<span style="color:#16a34a;font-weight:700">-${d}</span>`:d<0?`<span style="color:#dc2626;font-weight:700">+${Math.abs(d)}</span>`:`<span style="color:#64748b">0</span>`;})()}</td>
        </tr>
      </tbody>
    </table>
  </div>`:''}

  ${(verification?.issues?.length??0)>0?`
  <h2>Per-Issue Verification</h2>
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:2rem">
    <table style="margin:0;border:none">
      <thead>
        <tr>
          <th style="width:110px">Status</th>
          <th style="width:110px">Impact</th>
          <th style="width:140px">Rule</th>
          <th style="width:180px">Mapped File</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        ${verification.issues.map(issue => `<tr>
          <td><span style="font-weight:700;color:${issue.status==='resolved'?'#16a34a':(issue.status==='persistent'||issue.status==='attempted-unresolved')?'#dc2626':['rolled-back','pending-live-verification','scan-failed','verified-static-unconfirmed','not-rescanned'].includes(issue.status)?'#d97706':'#64748b'}">${escapeHtml(issue.status)}</span></td>
          <td>${badge(issue.impact)}</td>
          <td><code>${escapeHtml(issue.ruleId)}</code></td>
          <td>${issue.mappedFile ? `<span class="file-loc">${escapeHtml(issue.mappedFile)}</span>` : '—'}</td>
          <td>${escapeHtml(issue.description || '')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`:''}


  <h2>Outcome Summary</h2>
  <div class="score-grid">
    <div class="score-card">
      <div class="score-card-head"><span class="dot" style="background:#0f172a"></span>Issues Found</div>
      <div class="score-row"><span>Total found</span><span class="score-val">${totalFoundCount}</span></div>
      <div class="score-row"><span>Actionable (runtime)</span><span class="score-val" style="color:${actionableCount>0?'#dc2626':'#16a34a'}">${actionableCount}</span></div>
      <div class="score-row"><span>Already fixed</span><span class="score-val" style="color:#16a34a">${alreadyFixedCount}</span></div>
      <div class="score-row"><span>Third-party (not fixable)</span><span class="score-val" style="color:#64748b">${thirdPartyCount}</span></div>
      <div class="score-row"><span>Plugin DOM</span><span class="score-val" style="color:#64748b">${pluginGeneratedCount}</span></div>
      <div class="score-row"><span>Duplicate root cause</span><span class="score-val" style="color:#64748b">${duplicateRootCauseCount}</span></div>
      <div class="score-row"><span>Unsupported transform</span><span class="score-val" style="color:#64748b">${unsupportedTransformCount}</span></div>
      <div class="score-row"><span>Other manual review</span><span class="score-val" style="color:#64748b">${otherManualCount}</span></div>
    </div>
    <div class="score-card">
      <div class="score-card-head"><span class="dot" style="background:#16a34a"></span>Fixed</div>
      <div class="score-row"><span>Fixed</span><span class="score-val" style="color:#16a34a">${fixedCount}/${actionableCount}</span></div>
      ${sourcePatchedPendingCount>0?`<div class="score-row"><span>Source patched (pending verification)</span><span class="score-val" style="color:#16a34a">${sourcePatchedPendingCount}</span></div>`:''}
      <div class="score-row"><span>Still present</span><span class="score-val" style="color:${notFixedCount>0?'#dc2626':'#16a34a'}">${notFixedCount}</span></div>
      ${hasIssueLedger ? `<div class="score-row"><span>Could not verify</span><span class="score-val" style="color:${couldNotVerifyCount>0?'#d97706':'#16a34a'}">${couldNotVerifyCount}</span></div>` : ''}
      <div class="score-row"><span>Files changed</span><span class="score-val">${filesChangedCount}</span></div>
      <div class="score-row"><span style="font-size:.72rem;color:#94a3b8">${escapeHtml(fixedSourceLabel)}</span><span></span></div>
    </div>
    <div class="score-card">
      <div class="score-card-head"><span class="dot" style="background:#d97706"></span>Regressions</div>
      <div class="score-row"><span>New issues introduced</span><span class="score-val" style="color:${introducedCount>0?'#dc2626':'#16a34a'}">${introducedCount}</span></div>
      <div class="score-row"><span>Rolled back (unverified)</span><span class="score-val" style="color:${rolledBackCount>0?'#d97706':'#16a34a'}">${rolledBackCount}</span></div>
      <div class="score-row"><span>Unsure changes kept</span><span class="score-val" style="color:${unsureCount>0?'#d97706':'#16a34a'}">${unsureCount}</span></div>
      ${after ? '' : '<div class="score-row"><span style="font-size:.72rem;color:#94a3b8">no live re-scan — static verification</span><span></span></div>'}
    </div>
  </div>

  ${unsureCount>0?`
  <h2>Unsure Changes Kept For Human Review (${unsureCount})</h2>
  <p style="font-size:.82rem;color:#64748b;margin-bottom:.75rem">These files were preserved intentionally. The targeted per-file verifier could not conclusively prove the change, so the tool did not roll it back. A human can keep or remove each change after reviewing the full-page rescan and diff.</p>
  <table>
    <thead>
      <tr><th style="width:220px">File</th><th style="width:150px">Status</th><th style="width:170px">Reason</th><th>Agent reasoning / human action</th></tr>
    </thead>
    <tbody>
      ${unsureChanges.map(item => `<tr>
        <td><span class="file-loc">${escapeHtml(item.file)}</span></td>
        <td><span style="font-weight:700;color:#d97706">${escapeHtml(item.status || 'unsure')}</span></td>
        <td>${escapeHtml(item.reason || '')}</td>
        <td>${escapeHtml(item.agentReasoning || item.humanAction || 'Review manually.')}${item.humanAction ? `<div class="evidence">${escapeHtml(item.humanAction)}</div>` : ''}</td>
      </tr>`).join('')}
    </tbody>
  </table>`:''}

  ${(() => {
    const focusTrace = before?.keyboard?.focusTrace || [];
    if (focusTrace.length === 0) return '';
    return `
  <h2>Keyboard Focus Order (${focusTrace.length} tab stops)</h2>
  <p style="font-size:.8rem;color:#64748b;margin-bottom:.75rem">Each row represents one Tab keypress. This shows the order a keyboard user navigates the page.</p>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:.8rem">
      <thead>
        <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0">
          <th style="padding:6px 10px;text-align:left;width:40px">#</th>
          <th style="padding:6px 10px;text-align:left">Element</th>
          <th style="padding:6px 10px;text-align:left">Role</th>
          <th style="padding:6px 10px;text-align:left">Accessible Name</th>
          <th style="padding:6px 10px;text-align:left">Selector</th>
          <th style="padding:6px 10px;text-align:center;width:60px">Visible</th>
        </tr>
      </thead>
      <tbody>
        ${focusTrace.map((item, i) => `
          <tr style="border-bottom:1px solid #f1f5f9${!item.visible ? ';background:#fef2f2' : ''}">
            <td style="padding:4px 10px;color:#64748b;font-weight:600">${i + 1}</td>
            <td style="padding:4px 10px"><code style="font-size:.75rem;background:#f1f5f9;padding:2px 6px;border-radius:3px">&lt;${escapeHtml(item.tag)}&gt;</code></td>
            <td style="padding:4px 10px">${escapeHtml(item.role || item.tag)}</td>
            <td style="padding:4px 10px;font-weight:600">${item.accessibleName ? escapeHtml(item.accessibleName) : '<span style="color:#dc2626;font-style:italic">none</span>'}</td>
            <td style="padding:4px 10px;font-family:monospace;font-size:.72rem;color:#475569;word-break:break-all">${escapeHtml(item.selector)}</td>
            <td style="padding:4px 10px;text-align:center">${item.visible ? '✅' : '❌'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>`;
  })()}

  ${(() => {
    const screenshots = before?.focusableAction?.screenshots || [];
    if (screenshots.length === 0) return '';

    const getBasename = (p) => String(p).replace(/\\/g, '/').split('/').pop();
    const isDialog = (name) => name.startsWith('dialog_');
    const isBaseline = (name) => name.startsWith('baseline_');

    const baseline = screenshots.filter(p => isBaseline(getBasename(p)));
    const dialogs = screenshots.filter(p => isDialog(getBasename(p)));

    const card = (p, label) => {
      const name = getBasename(p);
      const src = `screenshots/${encodeURIComponent(name)}`;
      return `<div class="ss-card">
        <a href="${src}" target="_blank" rel="noopener">
          <img src="${src}" alt="${escapeHtml(label)}" loading="lazy">
        </a>
        <div class="ss-label">${escapeHtml(label)}</div>
      </div>`;
    };

    const baselineCards = baseline.map(p => card(p, 'Baseline — before any interaction')).join('');
    const dialogCards = dialogs.map(p => {
      const name = getBasename(p);
      const match = name.match(/^dialog_(.+?)_\d+\.png$/);
      const sel = match ? decodeURIComponent(match[1]).replace(/_/g, ' ') : name;
      return card(p, `Dialog opened by: ${sel}`);
    }).join('');

    return `
  <h2>Scan Screenshots (${screenshots.length})</h2>
  <p style="font-size:.82rem;color:#64748b;margin-bottom:.75rem">Baseline screenshot taken before any interaction, plus a screenshot for each dialog or modal that opened during the focusable-action scan (Phase 3g). Click any image to open full size.</p>
  ${baseline.length > 0 ? `<p style="font-size:.78rem;font-weight:700;color:#475569;margin:.75rem 0 .4rem">Baseline (${baseline.length})</p><div class="ss-grid">${baselineCards}</div>` : ''}
  ${dialogs.length > 0 ? `<p style="font-size:.78rem;font-weight:700;color:#475569;margin:.75rem 0 .4rem">Dialogs / Modals opened (${dialogs.length})</p><div class="ss-grid">${dialogCards}</div>` : ''}`;
  })()}

  ${(() => {
    // ── Classification Breakdown (Change C) ──
    // Gather all classified issues from unified, manual, and closed lists
    const allClassified = [
      ...(analysis?.unified || []),
      ...(analysis?.permanentlyManualViolations || []),
      ...(analysis?.closedIssues || []),
    ];

    // Deduplicate by id
    const seenIds = new Set();
    const uniqueClassified = [];
    for (const issue of allClassified) {
      const key = issue.id || issue.ruleId + '-' + (issue.nodes?.[0]?.target || '');
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      uniqueClassified.push(issue);
    }

    const fixableIssues = uniqueClassified.filter(i => i.solvability === 'FIXABLE');
    const nonFixableIssues = uniqueClassified.filter(i => i.solvability !== 'FIXABLE');

    // Order non-fixable categories
    const CAT_ORDER = ['PLUGIN_GENERATED_DOM', 'THIRD_PARTY_ASSET', 'MANUAL_VERIFICATION', 'DUPLICATE_ROOT_CAUSE', 'UNSUPPORTED_TRANSFORM', 'ALREADY_FIXED'];
    const grouped = {};
    for (const issue of nonFixableIssues) {
      const s = issue.solvability || 'OTHER';
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(issue);
    }
    const CAT_LABELS = {
      PLUGIN_GENERATED_DOM: 'Plugin-Generated DOM',
      THIRD_PARTY_ASSET: 'Third-Party Asset',
      MANUAL_VERIFICATION: 'Manual Verification Required',
      DUPLICATE_ROOT_CAUSE: 'Duplicate Root Cause',
      UNSUPPORTED_TRANSFORM: 'Unsupported Transform',
      ALREADY_FIXED: 'Already Fixed in Source',
      OTHER: 'Other',
    };

    const SOLV_COLORS = {
      FIXABLE: '#16a34a',
      PLUGIN_GENERATED_DOM: '#6b7280',
      THIRD_PARTY_ASSET: '#6b7280',
      MANUAL_VERIFICATION: '#d97706',
      DUPLICATE_ROOT_CAUSE: '#6b7280',
      UNSUPPORTED_TRANSFORM: '#6b7280',
      ALREADY_FIXED: '#64748b',
    };

    const issueRow = (issue) => {
      const cat = issue.solvability || 'OTHER';
      const catLabel = CAT_LABELS[cat] || cat;
      const catColor = SOLV_COLORS[cat] || '#6b7280';
      const ownerHtml = issue.owner ? `<div style="font-size:.72rem;color:#64748b">owner: ${escapeHtml(issue.owner)}</div>` : '';
      return `<tr>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;font-size:.82rem;vertical-align:top;word-break:break-word">${escapeHtml(String(issue.description || '').slice(0,120))}</td>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;font-size:.78rem;font-family:monospace;vertical-align:top;white-space:nowrap">${escapeHtml(issue.ruleId || issue.id || '—')}</td>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;vertical-align:top">${srcBadge(issue.source || '?')}</td>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;vertical-align:top"><span style="background:${catColor}1a;color:${catColor};border:1px solid ${catColor}55;padding:0 6px;border-radius:4px;font-size:10px;font-weight:600;white-space:nowrap">${escapeHtml(catLabel)}</span>${ownerHtml}</td>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;vertical-align:top">${solvabilityBadge(cat)}</td>
      </tr>`;
    };

    return `
  <h2>Issue Classification Breakdown</h2>
  <p style="font-size:.82rem;color:#64748b;margin-bottom:.75rem">All issues grouped by solvability classification. <strong style="color:#16a34a">Green = FIXABLE</strong> (sent to Copilot), <strong style="color:#d97706">Yellow = MANUAL_VERIFICATION</strong>, <strong style="color:#6b7280">Gray</strong> = excluded from automated fix pipeline.</p>

  <h3 style="font-size:.95rem;font-weight:700;margin:0 0 .5rem;color:#16a34a">✅ Sent to Copilot (Fixable) · ${fixableIssues.length} issue(s)</h3>
  ${fixableIssues.length > 0 ? `
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:1.5rem">
    <table style="margin:0;border:none;width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#f0fdf4">
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#166534">Description</th>
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#166534">Rule ID</th>
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#166534">Source</th>
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#166534">Category</th>
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#166534">Status</th>
        </tr>
      </thead>
      <tbody>
        ${fixableIssues.map(issueRow).join('')}
      </tbody>
    </table>
  </div>` : '<p style="color:#64748b;font-size:.85rem">No fixable issues found.</p>'}

  <h3 style="font-size:.95rem;font-weight:700;margin:1.5rem 0 .5rem;color:#6b7280">⛔ Not Fixable / Manual Review Required · ${nonFixableIssues.length} issue(s)</h3>
  ${nonFixableIssues.length > 0 ? `
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:1.5rem">
    <table style="margin:0;border:none;width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#475569">Description</th>
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#475569">Rule ID</th>
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#475569">Source</th>
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#475569">Category</th>
          <th style="padding:.5rem .75rem;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:#475569">Status</th>
        </tr>
      </thead>
      <tbody>
        ${CAT_ORDER.map(cat => {
          const issues = grouped[cat];
          if (!issues || issues.length === 0) return '';
          return issues.map(issueRow).join('');
        }).join('')}
        ${grouped['OTHER'] ? grouped['OTHER'].map(issueRow).join('') : ''}
      </tbody>
    </table>
  </div>` : '<p style="color:#64748b;font-size:.85rem">All issues are fixable — no manual review needed.</p>'}`;
  })()}

  <h2>All Violations (${sorted.length})</h2>
  <table>
    <thead>
      <tr>
        <th style="width:90px">Impact</th>
        <th style="width:100px">Classification</th>
        <th style="width:95px">Source</th>
        <th>File / Location</th>
        <th>Element</th>
        <th>Description</th>
        <th>Fix</th>
      </tr>
    </thead>
    <tbody>
      ${sorted.map(v => {
        const fileCol = v.file
          ? `<span class="file-loc">${escapeHtml(v.file)}${v.line ? `:${v.line}` : ''}</span>`
          : (v.page ? `<span style="font-size:.75rem;color:#94a3b8">${escapeHtml(v.page)}</span>` : '—');
        const elementCol = v.element
          ? `<details><summary>${escapeHtml(String(v.element).slice(0,60))}</summary><div class="element-html">${escapeHtml(v.element)}</div></details>`
          : (v.nodes?.[0]?.html ? `<details><summary>${escapeHtml(String(v.nodes[0].html).slice(0,60))}</summary><div class="element-html">${escapeHtml(v.nodes[0].html)}</div></details>` : '—');
        const fixCol = v.fix ?? v.nodes?.[0]?.fix ?? '—';
        const evidenceRow = v.evidence ? `<div class="evidence">Evidence: ${escapeHtml(v.evidence)}</div>` : '';
        const htmlSnippet = v.source === 'keyboard' && (v.element || v.nodes?.[0]?.html) ? `<div class="element-html" style="margin-top:.3rem">${escapeHtml(v.element || v.nodes[0].html)}</div>` : '';
        const classBadge = solvabilityBadge(v.solvability || 'FIXABLE');
        const verifyStatus = issueStatusById.get(v.id);
        const verifyHint = verifyStatus ? `<div style="font-size:.65rem;color:#94a3b8;margin-top:2px">verification: ${escapeHtml(verifyStatus)}</div>` : '';
        return `<tr>
          <td>${badge(v.impact)}</td>
          <td>${classBadge}${verifyHint}</td>
          <td>${srcBadge(v.source)}</td>
          <td>${fileCol}</td>
          <td>${elementCol}</td>
          <td>${escapeHtml(v.description??'')}${evidenceRow}${htmlSnippet}${v.helpUrl?`<br><a href="${escapeHtml(v.helpUrl)}" target="_blank" rel="noopener">WCAG docs →</a>`:''}</td>
          <td class="fix">${escapeHtml(String(fixCol).slice(0,200))}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>

  ${(() => {
    const suggestions = goodToHave?.suggestions ?? [];
    if (suggestions.length === 0) return '';

    const GTHCOL = '#7c3aed';

    // Group by ruleId — whatever came back from the scanner at runtime
    const groups = new Map();
    for (const s of suggestions) {
      const key = s.ruleId || s.category || 'suggestion';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const suggRow = (s) => {
      const elementHtml = s.element
        ? `<details><summary style="font-size:.75rem;color:${GTHCOL};cursor:pointer">${escapeHtml(String(s.element).slice(0, 55))}</summary><div class="element-html">${escapeHtml(s.element)}</div></details>`
        : '—';
      const currentAltHtml = s.currentAlt != null
        ? `<div style="margin-top:.25rem;font-size:.72rem;color:#64748b">Current alt: <em>"${escapeHtml(String(s.currentAlt).slice(0, 120))}"</em></div>`
        : '';
      const parentCtxHtml = s.parentContext
        ? `<div style="margin-top:.2rem;font-size:.7rem;color:#94a3b8">Page context: "${escapeHtml(String(s.parentContext).slice(0, 100))}"</div>`
        : '';
      return `<tr>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;vertical-align:top;font-size:.82rem;word-break:break-word">${escapeHtml(s.description ?? '')}${currentAltHtml}${parentCtxHtml}</td>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;font-size:.78rem;vertical-align:top">${elementHtml}</td>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;font-size:.78rem;color:#475569;vertical-align:top">${escapeHtml(s.suggestion ?? '')}</td>
        <td style="padding:.5rem .75rem;border-top:1px solid #f1f5f9;vertical-align:top;text-align:center;font-size:.75rem">${s.fixable ? '<span style="color:#16a34a;font-weight:700">auto-fix</span>' : '<span style="color:#94a3b8">manual</span>'}</td>
      </tr>`;
    };

    const groupBlocks = [...groups.entries()].map(([ruleId, items]) => `
  <h3 style="font-size:.88rem;font-weight:700;margin:1.25rem 0 .4rem;color:${GTHCOL}">
    <span style="background:${GTHCOL}1a;color:${GTHCOL};border:1px solid ${GTHCOL}44;padding:2px 10px;border-radius:4px;font-size:.78rem;font-weight:700">${escapeHtml(ruleId)}</span>
    <span style="color:#64748b;font-weight:400;font-size:.82rem;margin-left:.5rem">${items.length} issue${items.length !== 1 ? 's' : ''}</span>
  </h3>
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:1rem">
    <table style="margin:0;border:none;width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#faf5ff">
          <th style="padding:.45rem .75rem;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:${GTHCOL}">Description</th>
          <th style="padding:.45rem .75rem;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:${GTHCOL};width:200px">Element</th>
          <th style="padding:.45rem .75rem;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:left;color:${GTHCOL};width:220px">Suggestion</th>
          <th style="padding:.45rem .75rem;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;text-align:center;color:${GTHCOL};width:80px">Fix</th>
        </tr>
      </thead>
      <tbody>${items.map(suggRow).join('')}</tbody>
    </table>
  </div>`).join('');

    return `
  <h2>Good-to-Have Suggestions (${suggestions.length})</h2>
  <p style="font-size:.82rem;color:#64748b;margin-bottom:1rem">Quality improvements beyond strict WCAG compliance. Issues marked <strong style="color:#16a34a">auto-fix</strong> are sent to Copilot when running with <code>--fix</code>.</p>
  ${groupBlocks}`;
  })()}

  ${(closedList.length??0)>0?`
  <h2>Already Fixed / Closed (${closedList.length})</h2>
  <p style="font-size:.82rem;color:#64748b;margin-bottom:.75rem">These scanner findings match source that already satisfies the rule, so they are closed before remediation and excluded from Copilot attempts.</p>
  <table>
    <thead><tr><th style="width:90px">Impact</th><th style="width:110px">Source</th><th style="width:170px">Solvability</th><th>Element</th><th>Evidence</th></tr></thead>
    <tbody>
      ${closedList.map(v => `<tr>
        <td>${badge(v.impact)}</td>
        <td>${srcBadge(v.source)}</td>
        <td><code>${escapeHtml(v.solvability || 'ALREADY_FIXED')}</code></td>
        <td>${v.nodes?.[0]?.html ? `<details><summary>${escapeHtml(String(v.nodes[0].html).slice(0,60))}</summary><div class="element-html">${escapeHtml(v.nodes[0].html)}</div></details>` : '—'}</td>
        <td>${escapeHtml(v.solvabilityEvidence || v.solvabilityReason || '')}</td>
      </tr>`).join('')}
    </tbody>
  </table>`:''}

  ${(analysis?.permanentlyManualViolations?.length??0)>0?`
  <h2>Requires Human Review (${analysis.permanentlyManualViolations.length}${pluginGeneratedCount>0?` · ${pluginGeneratedCount} plugin DOM`:''})</h2>
  <p style="font-size:.82rem;color:#64748b;margin-bottom:.75rem">These are intentionally stopped before remediation: plugin-generated DOM, third-party assets, duplicate root-cause findings, unsupported transforms, or scanner audit warnings that require human verification.</p>
  <table>
    <thead><tr><th style="width:90px">Impact</th><th style="width:110px">Source</th><th style="width:170px">Solvability</th><th>Element</th><th>Description</th></tr></thead>
    <tbody>
      ${analysis.permanentlyManualViolations.map(v => `<tr>
        <td>${badge(v.impact)}</td>
        <td>${srcBadge(v.source)}</td>
        <td><code>${escapeHtml(v.solvability || v.manualReason || 'MANUAL_VERIFICATION')}</code>${v.rootCause?`<div class="evidence">root cause: ${escapeHtml(v.rootCause)}</div>`:''}${v.owner?`<div class="evidence">owner: ${escapeHtml(v.owner)}</div>`:''}</td>
        <td>${v.nodes?.[0]?.html ? `<details><summary>${escapeHtml(String(v.nodes[0].html).slice(0,60))}</summary><div class="element-html">${escapeHtml(v.nodes[0].html)}</div></details>` : '—'}</td>
        <td>${escapeHtml(v.description??'')}</td>
      </tr>`).join('')}
    </tbody>
  </table>`:''}

  ${(fixes?.length??0)>0?`
  <h2>Files Fixed (${fixes.length})</h2>
  ${fixes.map(f=>`
  ${(() => {
    const verification = verificationByFile.get(f.file);
    const unsure = unsureByFile.get(f.file);
    const status = f.verificationStatus || unsure?.status || verification?.status || '';
    const statusHtml = status ? `<span style="font-size:.72rem;font-weight:700;color:${unsure?'#d97706':'#16a34a'}">${escapeHtml(status)}</span>` : '';
    return `<div style="margin:-.25rem 0 .5rem .25rem;color:#64748b;font-size:.78rem">${statusHtml}</div>`;
  })()}
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:1.25rem;overflow:hidden">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:.75rem 1rem;background:#f1f5f9;border-bottom:1px solid #e2e8f0">
      <code style="font-size:.85rem;font-weight:700">${escapeHtml(f.file)}</code>
      <span style="font-size:.78rem;color:#64748b">${f.violationsAddressed} violation(s) addressed</span>
    </div>
    ${f.agentReasoning ? `<div style="padding:.65rem 1rem;background:#fffbeb;border-bottom:1px solid #fde68a;color:#78350f;font-size:.82rem"><strong>Agent reasoning:</strong> ${escapeHtml(f.agentReasoning)}</div>` : ''}
    ${(f.diffSegments?.length > 0) ? f.diffSegments.map(seg => `
    <div style="border-top:1px solid #e2e8f0">
      <div style="padding:.3rem .75rem;font-size:.68rem;font-weight:600;color:#475569;background:#f8fafc">Line ${seg.lineNum}</div>
      <div style="display:grid;grid-template-columns:1fr;gap:0">
        <div style="border-bottom:1px solid #e2e8f0">
          <div style="padding:.3rem .75rem;font-size:.65rem;font-weight:700;color:#b91c1c;background:#fef2f2;text-transform:uppercase;letter-spacing:.05em">Before</div>
          <pre style="margin:0;padding:.5rem .75rem;font-size:.72rem;font-family:monospace;overflow-x:auto;max-height:200px;max-width:100%;background:#fffafa;white-space:pre-wrap;word-break:break-all">${escapeHtml(seg.beforeLines.slice(0,1200))}</pre>
        </div>
        <div>
          <div style="padding:.3rem .75rem;font-size:.65rem;font-weight:700;color:#15803d;background:#f0fdf4;text-transform:uppercase;letter-spacing:.05em">After</div>
          <pre style="margin:0;padding:.5rem .75rem;font-size:.72rem;font-family:monospace;overflow-x:auto;max-height:200px;max-width:100%;background:#fafffe;white-space:pre-wrap;word-break:break-all">${escapeHtml(seg.afterLines.slice(0,1200))}</pre>
        </div>
      </div>
    </div>`).join('') : `
    <div style="display:grid;grid-template-columns:1fr;gap:0">
      <div style="border-bottom:1px solid #e2e8f0">
        <div style="padding:.4rem .75rem;font-size:.7rem;font-weight:700;color:#b91c1c;background:#fef2f2;text-transform:uppercase;letter-spacing:.05em">Before</div>
        <pre style="margin:0;padding:.75rem;font-size:.72rem;font-family:monospace;overflow-x:auto;max-height:300px;max-width:100%;background:#fffafa;white-space:pre-wrap;word-break:break-all">${escapeHtml(f.original.slice(0,2000))}${f.original.length>2000?'\\n… (truncated)':''}</pre>
      </div>
      <div>
        <div style="padding:.4rem .75rem;font-size:.7rem;font-weight:700;color:#15803d;background:#f0fdf4;text-transform:uppercase;letter-spacing:.05em">After</div>
        <pre style="margin:0;padding:.75rem;font-size:.72rem;font-family:monospace;overflow-x:auto;max-height:300px;max-width:100%;background:#fafffe;white-space:pre-wrap;word-break:break-all">${escapeHtml(f.fixed.slice(0,2000))}${f.fixed.length>2000?'\\n… (truncated)':''}</pre>
      </div>
    </div>`}
  </div>`).join('')}`:''}

  ${judgment?`
  <h2>LLM Judge Evaluation</h2>
  <div class="judge">
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
      <span class="verdict ${judgment.verdict??'needs-review'}">${String(judgment.verdict??'').toUpperCase()}</span>
      ${judgment.score!=null?`<span>Score <strong>${judgment.score}/10</strong></span>`:''}
    </div>
    <p>${escapeHtml(judgment.summary??'')}</p>
    <div class="judge-grid">
      ${judgment.wcag_correctness?`<div><div class="label">WCAG correctness</div>${escapeHtml(judgment.wcag_correctness)}</div>`:''}
      ${judgment.completeness?`<div><div class="label">Completeness</div>${escapeHtml(judgment.completeness)}</div>`:''}
      ${judgment.regressions?`<div><div class="label">Regressions</div>${escapeHtml(judgment.regressions)}</div>`:''}
    </div>
    ${(judgment.unresolved_critical?.length??0)>0?`<div style="margin-top:1rem"><div class="label" style="color:#b91c1c">Unresolved critical / serious</div><ul class="review-list" style="color:#b91c1c">${judgment.unresolved_critical.map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`:''}
    ${(judgment.human_review_needed?.length??0)>0?`<div style="margin-top:1rem"><div class="label">Needs human review</div><ul class="review-list">${judgment.human_review_needed.map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`:''}
  </div>`:''}
</body>
</html>`;
}
