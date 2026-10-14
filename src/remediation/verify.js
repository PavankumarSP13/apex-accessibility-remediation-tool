import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { fixNeedsBuild } from './patch.js';
import { rebuildProject } from './rescan.js';
import { validatePageNotBlank, waitForServerReady } from '../scanning/browser.js';
import { NON_FIXABLE_SOLVABILITY, Solvability, isPluginGeneratedNode, isRendererGeneratedNode, isThirdPartyFile } from '../core/constants.js';
import {
  buildNonFixableFingerprints,
  computeIntroducedIssues,
  createIssueFingerprint,
  normalizeScanIssues,
} from './issue-fingerprints.js';

export async function preRescanValidation({ fixes, scanUrl, ingested, report }) {
  if (fixes.length === 0 || !scanUrl) return;

  console.log(chalk.bold.cyan('\n  Phase 5b · Pre-rescan validation\n'));

  const compiledFixes = fixes.filter(f => fixNeedsBuild(f.file));

  if (compiledFixes.length > 0) {
    const serverAlreadyLive = await waitForServerReady(scanUrl, 2, 1000);
    if (serverAlreadyLive) {
      console.log(chalk.dim('  Server already live — compiled fixes will be verified after manual reload in Phase 6.'));
    } else {
      const buildOk = await rebuildProject(ingested.repoPath, compiledFixes.map(f => f.file));
      if (!buildOk) {
        console.log(chalk.yellow('  ⚠ Build failed for compiled files — rolling back compiled fixes only'));
        for (const f of compiledFixes) await fs.writeFile(path.join(ingested.repoPath, f.file), f.original, 'utf-8');
        const rolledBack = new Set(compiledFixes.map(f => f.file));
        fixes.splice(0, fixes.length, ...fixes.filter(f => !rolledBack.has(f.file)));
        report.fixes = fixes;
        report.unverifiedFixes = [
          ...(report.unverifiedFixes || []),
          ...compiledFixes.map(f => ({ file: f.file, violationsAddressed: f.violationsAddressed, reason: 'build-failed-rolled-back' })),
        ];
      }
    }
  }

  if (fixes.length > 0) {
    let pageOk = false;
    for (let blankAttempt = 1; blankAttempt <= 3; blankAttempt++) {
      pageOk = await validatePageNotBlank(scanUrl);
      if (pageOk) break;
      if (blankAttempt < 3) {
        console.log(chalk.dim(`  Blank-page check attempt ${blankAttempt}/3 failed — retrying in 2s...`));
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!pageOk) {
      console.log(chalk.red('\n  ✗ Page appears blank after 3 checks. Rolling back ALL fixes.\n'));
      const rollbackFailed = [];
      for (const f of fixes) {
        try {
          await fs.writeFile(path.join(ingested.repoPath, f.file), f.original, 'utf-8');
        } catch (writeErr) {
          rollbackFailed.push(f.file);
          console.error(chalk.red(`  ✗ Rollback failed for ${f.file}: ${writeErr.message}`));
        }
      }
      if (rollbackFailed.length > 0) {
        console.error(chalk.red(`  ✗ ${rollbackFailed.length} file(s) could not be rolled back: ${rollbackFailed.join(', ')}`));
      }
      fixes.length = 0;
      report.fixes = [];
    }
  }

  const unsureChanges = [];
  const thirdPartyFiles = new Set();
  for (const fix of fixes) {
    if (isThirdPartyFile(fix.file)) {
      fix.verificationStatus = 'unsure-third-party';
      fix.unsure = true;
      thirdPartyFiles.add(fix.file);
      unsureChanges.push({ file: fix.file, status: 'unsure-third-party', reason: 'third-party-asset', humanAction: 'Review manually; keep only if this is intentionally first-party-owned code.', agentReasoning: fix.agentReasoning || '' });
      console.log(chalk.yellow(`    ? ${fix.file} — third-party-looking asset; flagged for human review`));
    }
  }
  if (unsureChanges.length > 0) {
    report.unsureChanges = [...(report.unsureChanges || []), ...unsureChanges];
    // Remove third-party files from the active fixes array so Phase 6 does not
    // count them as verified pipeline fixes. The on-disk edits are intentionally
    // left in place for the human reviewer to keep or revert.
    fixes.splice(0, fixes.length, ...fixes.filter(f => !thirdPartyFiles.has(f.file)));
    report.fixes = fixes;
  }

  console.log(chalk.green(`\n  ✓ ${fixes.length} fix(es) passed pre-rescan validation. Full verification in Phase 6.\n`));
}

function inferTrailAttempted(entry = {}) {
  return entry?.attempted === true
    || Boolean(entry?.fixer)
    || Boolean(entry?.challenger)
    || Boolean(entry?.verifier)
    || Boolean(entry?.live);
}

function normalizeTrailIssueStatus(entry = {}) {
  if (!entry) return null;
  const rawStatus = String(entry.status || '').trim();
  if (rawStatus === 'source-resolved-awaiting-live') return 'pending-live-verification';
  if (rawStatus === 'source-unresolved') return 'attempted-unresolved';
  if (rawStatus.startsWith('reverted-')) return 'attempted-unresolved';
  if (rawStatus) return rawStatus;
  if (entry.resolved === true) return 'resolved';
  if (entry.pendingLiveVerification === true) return 'pending-live-verification';
  return inferTrailAttempted(entry) ? 'attempted-unresolved' : 'not-attempted';
}

function buildAgentTrailIndex(agentTrail = []) {
  const byIssueId = new Map();
  for (const entry of agentTrail || []) {
    if (!entry?.issueId) continue;
    const files = Array.isArray(entry.files)
      ? entry.files.filter(Boolean)
      : (entry.file ? [entry.file] : []);
    const attempted = inferTrailAttempted(entry);
    const status = normalizeTrailIssueStatus(entry);
    const verifiedBy = entry?.live?.verifiedBy || null;
    const notes = entry?.live?.notes || entry?.verifier?.notes || entry?.challenger?.reasoning || entry?.fixer?.reasoning || null;
    byIssueId.set(entry.issueId, {
      attempted,
      status,
      file: entry.file || files[0] || null,
      files,
      verifiedBy,
      notes,
    });
  }
  return byIssueId;
}

export function buildStaticVerificationLedger(analysis, fixes, reason = 'static-verification-unconfirmed', agentTrail = []) {
  const fixedIssueIds = new Set(fixes.flatMap(f => f.targetedIssueIds || []));
  const trailByIssueId = buildAgentTrailIndex(agentTrail);
  const issues = (analysis?.unified || []).map(issue => {
    const mapped = analysis?.mapping?.find(m => m.violationId === issue.id);
    const flags = buildLedgerIssueFlags(issue, mapped);
    const trail = trailByIssueId.get(issue.id) || null;
    const wasAttempted = fixedIssueIds.has(issue.id) || trail?.attempted === true;
    const trailStatus = trail?.status || null;
    let status = wasAttempted ? 'verified-static-unconfirmed' : 'not-rescanned';
    if (trailStatus === 'resolved') status = 'resolved';
    else if (trailStatus === 'pending-live-verification') status = 'pending-live-verification';
    else if (trailStatus === 'attempted-unresolved') status = 'attempted-unresolved';
    else if (trailStatus === 'not-attempted') status = 'not-attempted';
    return {
      issueId: issue.id,
      fingerprint: createIssueFingerprint(issue).key,
      status,
      source: issue.source,
      page: issue.page || '',
      ruleId: issue.ruleId || issue.id,
      impact: issue.impact,
      mappedFile: flags.mappedFile || trail?.file || null,
      attemptedFix: wasAttempted,
      autoFixEligible: flags.autoFixEligible,
      fixerEligible: flags.fixerEligible,
      challengerEligible: flags.challengerEligible,
      verifierEligible: flags.verifierEligible,
      judgeEligible: flags.judgeEligible,
      thirdParty: flags.thirdParty,
      rendererGenerated: flags.rendererGenerated,
      solvability: flags.solvability,
      rootCause: issue.rootCause || null,
      owner: issue.owner || null,
      manualReason: issue.manualReason || null,
      verifiedBy: status === 'resolved' ? (trail?.verifiedBy || null) : null,
      transformType: mapped?.transformType || null,
      description: issue.description,
      target: issue.nodes?.[0]?.target || '',
      element: issue.nodes?.[0]?.html || issue.element || '',
      reason: trail?.notes || reason,
    };
  });
  const resolvedTotal = issues.filter(issue => issue.status === 'resolved').length;
  const fixableIssues = issues.filter(isFixableLedgerIssue);
  const scoredFixableIssues = fixableIssues.filter(isScoredFixableLedgerIssue);
  const resolvedFixableTotal = scoredFixableIssues.filter(issue => issue.status === 'resolved').length;
  const sourcePatchedPendingVerification = issues.filter(isPendingLiveVerificationIssue).length;
  return {
    issues,
    introduced: [],
    summary: {
      baselineTotal: issues.length,
      baselineFixableTotal: scoredFixableIssues.length,
      totalFixableBaseline: fixableIssues.length,
      unavailableFixableTotal: fixableIssues.length - scoredFixableIssues.length,
      fixableTotal: scoredFixableIssues.length,
      resolvedTotal,
      resolvedFixableTotal,
      sourcePatchedPendingVerification,
      introducedTotal: 0,
      rolledBackTotal: 0,
      thirdPartyExcluded: issues.filter(issue => issue.thirdParty).length,
      rendererExcluded: issues.filter(issue => issue.rendererGenerated).length,
      staticOnly: true,
      reason,
    },
  };
}

function buildLedgerIssueFlags(issue, mapped) {
  const mappedFile = mapped?.file || null;
  const solvability = issue?.solvability || Solvability.FIXABLE;
  const thirdParty = solvability === Solvability.THIRD_PARTY_ASSET
    || issue?._classifiedThirdParty === true
    || (mappedFile ? isThirdPartyFile(mappedFile) : false);
  // Use persisted classification flags from analysis time when available,
  // avoiding re-running detection which could diverge on mutated issue objects.
  const rendererGenerated = solvability === Solvability.PLUGIN_GENERATED_DOM
    || issue?._classifiedRendererGenerated === true
    || issue?._classifiedPluginGenerated === true
    || isRendererGeneratedNode(issue)
    || isPluginGeneratedNode(issue);
  const fixerEligible = issue?.fixerEligible !== false && !NON_FIXABLE_SOLVABILITY.has(solvability);
  const challengerEligible = issue?.challengerEligible !== false && fixerEligible;
  const verifierEligible = issue?.verifierEligible !== false && fixerEligible;
  const autoFixEligible = fixerEligible
    && !thirdParty
    && !rendererGenerated
    && solvability === Solvability.FIXABLE;
  const judgeEligible = issue?.judgeEligible !== false && autoFixEligible;
  return { mappedFile, thirdParty, rendererGenerated, autoFixEligible, solvability, fixerEligible, challengerEligible, verifierEligible, judgeEligible };
}

function isFixableLedgerIssue(issue) {
  return Boolean(issue.autoFixEligible) && issue.judgeEligible !== false && !issue.thirdParty && !issue.rendererGenerated;
}

const UNSCORED_FIXABLE_STATUSES = new Set([
  'scan-failed',
  'verified-static-unconfirmed',
  'not-rescanned',
  'pending-live-verification',
  'attempted-unresolved',
  'not-attempted',
]);

function isScoredFixableLedgerIssue(issue) {
  return isFixableLedgerIssue(issue) && !UNSCORED_FIXABLE_STATUSES.has(issue.status);
}

export function isPendingLiveVerificationIssue(issue) {
  return isFixableLedgerIssue(issue) && issue.status === 'pending-live-verification';
}

export const normalizeAfterRescanIssues = normalizeScanIssues;

function normalizeUnavailablePages(unavailable = []) {
  return new Set(unavailable.map(entry => typeof entry === 'string' ? entry : entry?.url).filter(Boolean));
}

export function buildIssueVerificationLedger(analysis, afterData, fixes, unverifiedFixes = [], beforeData = null) {
  const baselineIssues = analysis?.unified || [];
  const axeScanFailed = afterData?.axe?.scanFailed === true;
  const axeUnavailablePages = new Set((afterData?.axe || []).filter(page => page.scanFailed).map(page => page.url).filter(Boolean));
  const pa11yScanFailed = afterData?.pa11y?.scanFailed === true;
  const pa11yUnavailablePages = normalizeUnavailablePages(afterData?.pa11y?.unavailable);
  const lighthouseScanFailed = afterData?.lh?.scanFailed === true;
  const keyboardScanFailed = afterData?.keyboard?.scanFailed === true;
  // Older run reports have no dropdownKeyboard rescan; treat that as unverified, not resolved.
  const dropdownKeyboardScanFailed = !afterData?.dropdownKeyboard || afterData.dropdownKeyboard.scanFailed === true;
  const afterIssues = normalizeAfterRescanIssues(afterData);
  const afterExactCounts = new Map();
  const afterStructuralCounts = new Map();
  const afterLooseCounts = new Map();
  for (const issue of afterIssues) {
    const fp = createIssueFingerprint(issue);
    afterExactCounts.set(fp.key, (afterExactCounts.get(fp.key) || 0) + 1);
    afterStructuralCounts.set(fp.structuralKey, (afterStructuralCounts.get(fp.structuralKey) || 0) + 1);
    afterLooseCounts.set(fp.looseKey, (afterLooseCounts.get(fp.looseKey) || 0) + 1);
  }
  const rolledBackReasons = new Map((unverifiedFixes || []).map(f => [f.file, f.reason || f.verificationReason || 'rolled-back']));
  const rolledBack = new Set(rolledBackReasons.keys());
  // Sort deterministically so duplicate-fingerprint issues always resolve in the
  // same order regardless of insertion order from upstream scanners.
  const sortedBaselineIssues = [...baselineIssues].sort((a, b) => {
    const aKey = createIssueFingerprint(a).key;
    const bKey = createIssueFingerprint(b).key;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const issues = sortedBaselineIssues.map(issue => {
    const fp = createIssueFingerprint(issue);
    const exactRemaining = afterExactCounts.get(fp.key) || 0;
    const structuralRemaining = afterStructuralCounts.get(fp.structuralKey) || 0;
    const looseRemaining = afterLooseCounts.get(fp.looseKey) || 0;
    const mapped = analysis?.mapping?.find(m => m.violationId === issue.id);
    const flags = buildLedgerIssueFlags(issue, mapped);
    const changedFile = flags.mappedFile;
    const wasAttempted = fixes.some(f => f.targetedIssueIds?.includes(issue.id));
    const pa11yIssueScanFailed = pa11yScanFailed || (afterData?.pa11y?.partialScanFailed === true && pa11yUnavailablePages.has(issue.page || ''));
    const sourceScanFailed = (issue.source === 'axe' && (axeScanFailed || axeUnavailablePages.has(issue.page || '')))
      || (issue.source === 'pa11y' && pa11yIssueScanFailed)
      || (issue.source === 'lighthouse' && lighthouseScanFailed)
      || (issue.source === 'keyboard' && keyboardScanFailed)
      || (issue.source === 'dropdown-keyboard' && dropdownKeyboardScanFailed);
    let status = sourceScanFailed ? 'scan-failed' : 'resolved';
    if (!sourceScanFailed) {
      if (exactRemaining > 0) {
        status = 'persistent';
        afterExactCounts.set(fp.key, exactRemaining - 1);
        afterStructuralCounts.set(fp.structuralKey, Math.max(0, structuralRemaining - 1));
        afterLooseCounts.set(fp.looseKey, Math.max(0, looseRemaining - 1));
      } else if (structuralRemaining > 0) {
        status = 'persistent';
        afterStructuralCounts.set(fp.structuralKey, structuralRemaining - 1);
        afterLooseCounts.set(fp.looseKey, Math.max(0, looseRemaining - 1));
      } else if (looseRemaining > 0) {
        status = 'persistent';
        afterLooseCounts.set(fp.looseKey, looseRemaining - 1);
      }
    }
    return {
      issueId: issue.id,
      fingerprint: fp.key,
      status: rolledBack.has(changedFile) ? 'rolled-back' : status,
      source: issue.source,
      page: issue.page || '',
      ruleId: issue.ruleId || issue.id,
      impact: issue.impact,
      mappedFile: changedFile,
      attemptedFix: wasAttempted,
      autoFixEligible: flags.autoFixEligible,
      fixerEligible: flags.fixerEligible,
      challengerEligible: flags.challengerEligible,
      verifierEligible: flags.verifierEligible,
      judgeEligible: flags.judgeEligible,
      thirdParty: flags.thirdParty,
      rendererGenerated: flags.rendererGenerated,
      solvability: flags.solvability,
      rootCause: issue.rootCause || null,
      owner: issue.owner || null,
      manualReason: issue.manualReason || null,
      verifiedBy: status === 'resolved' ? issue.source : null,
      transformType: mapped?.transformType || null,
      description: issue.description,
      target: issue.nodes?.[0]?.target || '',
      element: issue.nodes?.[0]?.html || issue.element || '',
      reason: rolledBackReasons.get(changedFile) || mapped?.reason || null,
    };
  });

  const knownNonFixable = analysis ? buildNonFixableFingerprints(analysis) : null;
  const introduced = beforeData
    ? computeIntroducedIssues(beforeData, afterData, knownNonFixable)
    : computeIntroducedIssues({ axe: [], pa11y: { issues: [] } }, afterData, knownNonFixable);

  const fixableIssues = issues.filter(isFixableLedgerIssue);
  const scoredFixableIssues = issues.filter(isScoredFixableLedgerIssue);
  const resolvedIssues = issues.filter(issue => issue.status === 'resolved');
  const resolvedFixableIssues = scoredFixableIssues.filter(issue => issue.status === 'resolved');
  const sourcePatchedPendingVerification = issues.filter(isPendingLiveVerificationIssue).length;

  return {
    issues,
    introduced,
    summary: {
      baselineTotal: issues.length,
      baselineFixableTotal: scoredFixableIssues.length,
      totalFixableBaseline: fixableIssues.length,
      unavailableFixableTotal: fixableIssues.length - scoredFixableIssues.length,
      resolvedTotal: resolvedIssues.length,
      resolvedFixableTotal: resolvedFixableIssues.length,
      sourcePatchedPendingVerification,
      introducedTotal: introduced.length,
      rolledBackTotal: issues.filter(issue => issue.status === 'rolled-back').length,
      thirdPartyExcluded: issues.filter(issue => issue.thirdParty).length,
      rendererExcluded: issues.filter(issue => issue.rendererGenerated).length,
    },
  };
}
