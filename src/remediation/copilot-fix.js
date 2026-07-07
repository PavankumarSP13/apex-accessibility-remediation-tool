import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import { renderPrompt } from '../core/prompts.js';
import {
  COPILOT_MAX_CANDIDATE_FILES,
  COPILOT_MAX_FIX_ATTEMPTS_FALLBACK,
  COPILOT_MAX_FIX_ATTEMPTS_TEMPLATE,
  COPILOT_MAX_SNAPSHOT_FILE_BYTES,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import { createCopilotAgent, extractJsonFromText } from '../integrations/copilot.js';
import { collectSourceFiles, normalizeRelPath } from '../repository/repo-index.js';
import { NON_FIXABLE_SOLVABILITY, isBinaryFile, isThirdPartyFile, shouldSkipFile, shouldStopForManualReviewEntry } from '../core/constants.js';
import { getWcagCriteriaForRule } from '../core/wcag-criteria.js';
import { validatePatchedContent, toAxeRuleId } from './patch.js';
import { computeDiffSegments } from './fix.js';
import { summarizeSlideArchitecture } from '../architecture/slide-resolver.js';
import { resolveSlideTemplateFiles } from '../architecture/template-file-resolver.js';

const REMEDIATION_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'shell'];

// FIX-09: Group issues by their primary mapped file so related issues share one session
function groupIssuesByMappedFile(issues) {
  const groups = [];
  const fileMap = new Map();
  for (const issue of issues) {
    const file = issue.sourceMapping?.primaryFile || '__unmapped__';
    if (!fileMap.has(file)) {
      const group = { file, issues: [] };
      fileMap.set(file, group);
      groups.push(group);
    }
    fileMap.get(file).issues.push(issue);
  }
  return groups;
}

function emitProgressLine(message) {
  console.log(chalk.dim(message));
  logger.remediation(message);
}

export async function phase5_copilot_fix(analysis, repoPath, sourceFileMap = null, report = null, options = {}) {
  const spinner = ora('Phase 5 · Copilot agents are remediating accessibility issues...').start();
  const skipBatch1 = options?.skipBatch1 === true;
  const skipBatch2 = options?.skipBatch2 === true;
  const defaultBothBatchesMode = !skipBatch1 && !skipBatch2;
  const blockedByManualReview = getManualReviewStopIssueIds(analysis);
  const issues = (analysis.unified || []).filter(v => shouldAttemptIssue(v, blockedByManualReview));
  const deterministicAutofixCount = getDeterministicAutofixIssueIds(analysis).size;
  const classifiedFixable = (analysis.unified || []).filter(v => v.solvability === 'FIXABLE').length;
  const a11yTreeExtra = issues.length - classifiedFixable;
  const extraNote = a11yTreeExtra > 0 ? ` (${classifiedFixable} from scanners + ${a11yTreeExtra} from a11y-tree detection)` : '';
  console.log(chalk.dim(`  Copilot remediation: attempting ${issues.length} actionable issue(s)${extraNote}; ${deterministicAutofixCount} had deterministic autofix priors.`));
  logger.remediation(`Copilot remediation attempting ${issues.length} actionable issue(s)${extraNote}; ${deterministicAutofixCount} deterministic autofix prior(s).`);

  if (issues.length === 0) {
    spinner.warn('Phase 5 · No actionable runtime issues to fix.');
    return [];
  }

  spinner.text = 'Phase 5 · Snapshotting source files...';
  const originals = await snapshotSourceFiles(repoPath);
  logger.remediation(`Snapshotted ${originals.size} source file(s).`);

  const issueState = new Map();
  for (const issue of issues) {
    issueState.set(issue.id, {
      issue,
      attempted: false,
      resolved: false,
      pendingLiveVerification: false,
      status: null,
      file: null,
      files: [],
      trail: {},
    });
  }
  if (report) report.copilotRemediationTrace = report.copilotRemediationTrace || [];

  let templateBundle = {
    templateNames: [],
    bundles: [],
    flatFiles: [],
    via: skipBatch1 ? 'template-name-bundle-skipped' : 'template-name-bundle',
  };
  let needsFallback = true;
  let batch1FallbackFiles = [];

  if (skipBatch1) {
    emitProgressLine('batch 1 skipped (--skip-batch1): starting with deterministic fallback mapping (batch 2).');
    if (report) {
      report.templateBundleTrace = {
        ...templateBundle,
        skipped: true,
        reason: '--skip-batch1',
      };
    }
  } else {
    emitProgressLine('bundled deterministic source mapping');
    templateBundle = await buildTemplateBundle({ issues, repoPath, sourceFileMap, originals });
    if (report) report.templateBundleTrace = templateBundle;

      needsFallback = templateBundle.flatFiles.length === 0;
      if (!needsFallback) {
        const batch1Result = await runAttemptPhase({
          phaseName: 'template-bundle',
          phaseLabel: 'Template Bundle',
          maxAttempts: defaultBothBatchesMode ? 1 : COPILOT_MAX_FIX_ATTEMPTS_TEMPLATE,
          candidateFiles: templateBundle.flatFiles,
          mappingContext: buildMappingContext({ sourceFileMap, issues, templateBundle, mode: 'template-bundle' }),
          issueState,
        analysis,
        repoPath,
        originals,
        report,
        spinner,
      });
      needsFallback = batch1Result.needsFallback;
      batch1FallbackFiles = batch1Result.fallbackRequestedFiles || [];
    }
  }

  const unresolvedAfterTemplate = [...issueState.values()].filter(s => !s.resolved && !s.pendingLiveVerification);
  if (report && skipBatch2) {
    report.templateBundleTrace = {
      ...(report.templateBundleTrace || templateBundle),
      deterministicFallback: {
        skipped: true,
        reason: '--skip-batch2',
        unresolvedIssueCount: unresolvedAfterTemplate.length,
        unresolvedIssueIds: unresolvedAfterTemplate.map(s => s.issue.id),
      },
    };
  }

  if (unresolvedAfterTemplate.length > 0 && skipBatch2) {
    emitProgressLine('batch 2 skipped (--skip-batch2): deterministic fallback remediation disabled by flag.');
    emitProgressLine(`batch 2 skipped (--skip-batch2): ${unresolvedAfterTemplate.length} unresolved issue(s) continue as unresolved.`);
  } else if (unresolvedAfterTemplate.length > 0 && (skipBatch1 || needsFallback !== false)) {
    emitProgressLine('backup mapping transition: primary mapping exhausted or requested fallback');
    emitProgressLine('backup mapping uses deterministic fallback candidate file list derived from unresolved issue mappings/template priors.');
    const fallbackFiles = buildFallbackFileList({ sourceFileMap, originals, issues: unresolvedAfterTemplate.map(s => s.issue) });
    if (batch1FallbackFiles.length > 0) {
      for (const file of batch1FallbackFiles) {
        const rel = normalizeRelPath(file);
        if (rel && originals.has(rel) && !fallbackFiles.includes(rel)) fallbackFiles.push(rel);
      }
      logger.remediation(`Batch 2 augmented with ${batch1FallbackFiles.length} file(s) from batch 1 fallback requests: ${batch1FallbackFiles.join(', ')}`);
    }
    const fallbackAttempts = defaultBothBatchesMode
      ? 1
      : (skipBatch1
        ? Math.min(COPILOT_MAX_FIX_ATTEMPTS_FALLBACK, 2)
        : COPILOT_MAX_FIX_ATTEMPTS_FALLBACK);
    await runAttemptPhase({
      phaseName: 'deterministic-fallback',
      phaseLabel: 'Deterministic Fallback',
      maxAttempts: fallbackAttempts,
      candidateFiles: fallbackFiles,
      mappingContext: buildMappingContext({ sourceFileMap, issues, templateBundle, mode: 'deterministic-fallback' }),
      issueState,
      analysis,
      repoPath,
      originals,
      report,
      spinner,
    });
  }

  const fixes = await finalizeFixes({ repoPath, originals, issueState, spinner });
  rebuildAnalysisMapping(analysis, issueState);
  updateBaseline(analysis, issueState);
  if (report) report.agentTrail = buildAgentTrail(issueState);

  const totalResolved = [...issueState.values()].filter(s => s.resolved).length;
  const totalDeferred = [...issueState.values()].filter(s => s.pendingLiveVerification).length;
  const totalAttemptedUnresolved = [...issueState.values()].filter(s => s.status === 'attempted-unresolved').length;
  spinner.succeed(`Copilot remediation: ${chalk.green(fixes.length)} file(s) changed, ${chalk.green(totalResolved)}/${issues.length} live-confirmed, ${chalk.green(totalDeferred)} source-patched (pending live verification), ${chalk.red(totalAttemptedUnresolved)} attempted unresolved.`);
  logger.remediation(`Copilot remediation complete: ${fixes.length} file(s) changed, ${totalResolved}/${issues.length} live-confirmed, ${totalDeferred} source-patched (pending live verification), ${totalAttemptedUnresolved} attempted unresolved.`);
  return fixes;
}

function extractFilePathsFromReason(fallbackReason) {
  if (!fallbackReason) return [];
  const paths = [];
  const filePatterns = [
    /(?:file|path|in|edit|modify|change)\s*[:=]?\s*["'`]?([^\s"'`,;]+\.\w{1,6})["'`]?/gi,
    /\b([a-zA-Z]:\\[^\s"'`,;]+\.\w{1,6})\b/g,
    /\b((?:\.\.?\/|\/)[^\s"'`,;]+\.\w{1,6})\b/g,
    /\b([\w./-]+\.(?:js|ts|tsx|jsx|html|htm|css|scss|cshtml|razor|vue|svelte|mjs|cjs|less|sass))\b/gi,
  ];
  for (const rx of filePatterns) {
    for (const match of fallbackReason.matchAll(rx)) {
      const candidate = (match[1] || match[0]).trim();
      if (candidate && !paths.includes(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

function getManualReviewStopIssueIds(analysis = {}) {
  const blocked = new Set();
  for (const entry of analysis.manualReview || []) {
    if (shouldStopForManualReviewEntry(entry)) blocked.add(entry.violationId);
  }
  return blocked;
}

function shouldAttemptIssue(issue, blockedByManualReview) {
  if (!issue || issue.manualOnly) return false;
  if (issue.fixerEligible === false) return false;
  if (NON_FIXABLE_SOLVABILITY.has(issue.solvability)) return false;
  if (blockedByManualReview.has(issue.id)) return false;
  // FIX-02: Skip issues with explicitly empty mapping (confidence 'none' means
  // the mapper ran and found zero candidates).  'low' confidence still allows
  // attempts because the Copilot fixer has its own read/grep tools and can
  // discover the right file independently.
  if (issue.sourceMapping?.mappingConfidence === 'none') return false;
  // SCANNER-02: Skip false positives confirmed by accessibility tree
  if (issue.a11yTreeStatus === 'false-positive') return false;
  if (issue.a11yTreeStatus === 'not-exposed') return false;
  return true;
}

async function runAttemptPhase({ phaseName, phaseLabel, maxAttempts, candidateFiles, mappingContext, issueState, analysis, repoPath, originals, report, spinner }) {
  if (candidateFiles.length === 0 || maxAttempts <= 0) return { needsFallback: true, fallbackRequestedFiles: [] };
  let anyNeedsFallback = false;
  const fallbackRequestedFiles = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const unresolvedAtAttemptStart = [...issueState.values()].filter(s => !s.resolved && !s.pendingLiveVerification).map(s => s.issue);
    if (unresolvedAtAttemptStart.length === 0) return { needsFallback: false, fallbackRequestedFiles: [...new Set(fallbackRequestedFiles)] };

    if (phaseName === 'template-bundle' && attempt === 1) emitProgressLine('remediation start (batch 1)');
    if (phaseName === 'template-bundle' && attempt === 2) emitProgressLine('remediation start (batch 1) retry');
    if (phaseName === 'deterministic-fallback' && attempt === 1) emitProgressLine('remediation start (batch 2)');
    if (phaseName === 'deterministic-fallback' && attempt > 1 && attempt === maxAttempts) emitProgressLine('remediation start (batch 2) one-last-retry');

    console.log(chalk.dim(`\n  ── Copilot Fixer · ${phaseLabel} attempt ${attempt}/${maxAttempts} · ${unresolvedAtAttemptStart.length} open issue(s) ──`));
    logger.remediation(`── Copilot ${phaseName} attempt ${attempt}/${maxAttempts} · open issue(s): ${unresolvedAtAttemptStart.map(v => v.id).join(', ')}`);

    const beforeAttempt = await snapshotCurrentContents(repoPath, originals);

    // FIX-09: Group issues by mapped file for focused fixer sessions
    const fixerChangesForAttempt = [];
    const noChangeIssueIds = [];
    const issueGroups = groupIssuesByMappedFile(unresolvedAtAttemptStart);

    for (const group of issueGroups) {
      const fixer = await createCopilotAgent({
        role: `fixer-${phaseName}`,
        cwd: repoPath,
        tools: REMEDIATION_TOOLS,
        allowedWriteFiles: candidateFiles,
        quiet: true,
        systemPrompt: 'You are a meticulous accessibility remediation engineer. Read the real repository before editing and make the smallest correct semantic change.',
      });

      let sentAnyPrompt = false;
      try {
        for (const issue of group.issues) {
          const index = unresolvedAtAttemptStart.indexOf(issue);
          if (issueState.get(issue.id)?.resolved) continue;
          spinner.text = `Phase 5 · ${phaseLabel} attempt ${attempt}/${maxAttempts} · fixing issue ${issue.id}...`;
          emitProgressLine(`copilot-fixer working on issue #${index + 1}`);
          console.log(chalk.dim(`  → Copilot Fixer · ${phaseLabel} · ${issue.id}`));
          const beforeIssueTurn = await snapshotCandidateContents(repoPath, candidateFiles);

          try {
            const prompt = attempt === 1
              ? buildFixerPrompt({ repoPath, phaseName, candidateFiles, mappingContext, issues: [issue], issueState })
              : buildSingleIssueRetryPrompt(issue, issueState, candidateFiles);
            if (sentAnyPrompt) await fixer.followUp(prompt);
            else await fixer.run(prompt);
            sentAnyPrompt = true;
          } catch (err) {
            console.log(chalk.yellow(`\n  ⚠ Copilot Fixer failed for ${issue.id}: ${err.message}`));
            report?.copilotRemediationTrace?.push({ phaseName, attempt, stage: 'fixer', error: err.message, openIssueIds: [issue.id] });
            continue;
          }

          const parsed = extractJsonFromText(fixer.getFinalText());
          let fixerChanges = normalizeFixerChanges(parsed, [issue]);
          const needsFallback = parsed?.needsFallback === true;
          const fallbackReason = parsed?.fallbackReason || '';
          const afterIssueTurn = await snapshotCandidateContents(repoPath, candidateFiles);
          const editedInIssueTurn = diffSnapshotChangedFiles(beforeIssueTurn, afterIssueTurn);

          if (fixerChanges.length === 0 && editedInIssueTurn.length > 0) {
            fixerChanges = [buildInferredFixerChange(issue, editedInIssueTurn)];
            emitProgressLine(`inferred attribution from disk edits for ${issue.id}`);
            logger.remediation(`Inferred fixer attribution for ${issue.id} from issue-turn disk edits: ${editedInIssueTurn.join(', ')}`);
          }

          if (needsFallback) {
            anyNeedsFallback = true;
            const extractedPaths = extractFilePathsFromReason(fallbackReason);
            if (extractedPaths.length > 0) {
              fallbackRequestedFiles.push(...extractedPaths);
              logger.remediation(`Batch 1 fallback for ${issue.id}: file(s) requested outside scope: ${extractedPaths.join(', ')}`);
            }
            report?.copilotRemediationTrace?.push({ phaseName, attempt, stage: 'fixer', needsFallback, fallbackReason, fallbackRequestedFiles: extractedPaths, openIssueIds: [issue.id] });
            if (fixerChanges.length === 0) continue;
          }
          if (fixerChanges.length === 0) {
            // If fixer claims resolved but made no edits, source already satisfies the rule —
            // mark as resolved to prevent expensive fallback batch for this issue
            const claimsResolved = parsed?.changes?.some(c => c.resolved === true) || fixerChanges.some(c => c.resolved);
            if (claimsResolved && editedInIssueTurn.length === 0) {
              const state = issueState.get(issue.id);
              if (state) {
                state.attempted = true;
                state.resolved = true;
                state.pendingLiveVerification = false;
                state.status = 'resolved';
                state.trail.fixer = { file: null, files: [], changeSummary: 'source-already-satisfies-rule', rationale: 'Fixer confirmed source already has the fix; no edits needed.' };
                emitProgressLine(`source-already-fixed (fixer-confirmed, no edits): ${issue.id}`);
                logger.remediation(`Issue ${issue.id} resolved as source-already-fixed: fixer confirmed source satisfies rule without edits.`);
              }
            } else {
              noChangeIssueIds.push(issue.id);
              const state = issueState.get(issue.id);
              if (state) {
                const parsedResponseAbsent = parsed == null;
                const noEditReason = parsedResponseAbsent
                  ? 'Fixer returned no parseable response and made no file edits.'
                  : 'Fixer returned no applicable changes and made no file edits.';
                state.attempted = true;
                state.resolved = false;
                state.pendingLiveVerification = false;
                state.status = 'attempted-unresolved';
                state.trail.fixer = {
                  file: null,
                  files: [],
                  changeSummary: parsedResponseAbsent ? 'no-op-no-parseable-response' : 'no-op-no-change',
                  rationale: noEditReason,
                  reasoning: noEditReason,
                };
              }
            }
            continue;
          }

          fixerChangesForAttempt.push(...fixerChanges);
        }
      } finally {
        await fixer.dispose();
      }
    }

    const editedAfterFixer = await detectEditedFilesAgainst(repoPath, beforeAttempt);
    const outOfScopeEdits = await revertOutOfScopeEdits({ repoPath, baseline: beforeAttempt, editedFiles: editedAfterFixer, allowedFiles: candidateFiles });
    const inScopeEditedFiles = editedAfterFixer.filter(file => !outOfScopeEdits.includes(file));

    logger.remediation(`Copilot edited ${inScopeEditedFiles.length} in-scope file(s): ${inScopeEditedFiles.join(', ') || '(none)'}`);
    if (outOfScopeEdits.length) logger.remediation(`Reverted out-of-scope edits: ${outOfScopeEdits.join(', ')}`);

    if (inScopeEditedFiles.length === 0 && fixerChangesForAttempt.length === 0) {
      report?.copilotRemediationTrace?.push({
        phaseName,
        attempt,
        stage: 'fixer',
        noChanges: true,
        openIssueIds: unresolvedAtAttemptStart.map(issue => issue.id),
        noChangeIssueIds,
      });
      continue;
    }

    const issuesWithFixes = unresolvedAtAttemptStart.filter(issue =>
      fixerChangesForAttempt.some(change => change.issueId === issue.id)
    );
    spinner.text = `Phase 5 · ${phaseLabel} attempt ${attempt}/${maxAttempts} · challenging ${issuesWithFixes.length} fix(es)...`;
    for (const [index] of unresolvedAtAttemptStart.entries()) emitProgressLine(`copilot-challenger working on issue #${index + 1}`);
    const validationFindings = await validateEditedFiles(repoPath, originals, inScopeEditedFiles);
    const challengerResult = await runChallenger({ repoPath, issues: issuesWithFixes, fixerChanges: fixerChangesForAttempt, validationFindings, allowedWriteFiles: candidateFiles });
    const editedAfterChallenger = await detectEditedFilesAgainst(repoPath, beforeAttempt);
    const challengerOutOfScopeEdits = await revertOutOfScopeEdits({ repoPath, baseline: beforeAttempt, editedFiles: editedAfterChallenger, allowedFiles: candidateFiles });
    const challengerVerdicts = challengerResult.verdicts;
    const agentChangesAfterChallenger = mergeAgentChanges(fixerChangesForAttempt, challengerResult.revisions);
    await applyChallengerVerdicts({ repoPath, originals, challengerVerdicts, issueState });
    const survivingChanges = collectSurvivingChanges({ originals, fixerChanges: agentChangesAfterChallenger });
    spinner.text = `Phase 5 · ${phaseLabel} attempt ${attempt}/${maxAttempts} · verifying ${survivingChanges.length} surviving fix(es)...`;
    for (const [index] of unresolvedAtAttemptStart.entries()) emitProgressLine(`copilot-verifier working on issue #${index + 1}`);
    const verifierResult = await runVerifier({ repoPath, issues: issuesWithFixes, survivingChanges, allowedWriteFiles: candidateFiles });
    const editedAfterVerifier = await detectEditedFilesAgainst(repoPath, beforeAttempt);
    const verifierOutOfScopeEdits = await revertOutOfScopeEdits({ repoPath, baseline: beforeAttempt, editedFiles: editedAfterVerifier, allowedFiles: candidateFiles });
    const allOutOfScopeEdits = uniquePaths([...outOfScopeEdits, ...challengerOutOfScopeEdits, ...verifierOutOfScopeEdits]);
    const allInScopeEditedFiles = editedAfterVerifier.filter(file => !allOutOfScopeEdits.includes(file));
    const agentChanges = mergeAgentChanges(agentChangesAfterChallenger, verifierResult.revisions || []);
    applyVerifierResult({ verifierResult, fixerChanges: agentChanges, challengerVerdicts, issueState });
    spinner.text = `Phase 5 · ${phaseLabel} attempt ${attempt}/${maxAttempts} · live-verifying fixes...`;
    emitProgressLine('live verifier start');
    const liveVerificationResult = await runLiveVerifier({ issues: issuesWithFixes, fixerChanges: agentChanges, analysis, repoPath });
    applyLiveVerifierResult({ liveVerificationResult, fixerChanges: agentChanges, verifierResult, issueState });

    const solvedInAttempt = unresolvedAtAttemptStart.filter(issue => issueState.get(issue.id)?.resolved).length;
    const deferredInAttempt = unresolvedAtAttemptStart.filter(issue => issueState.get(issue.id)?.pendingLiveVerification).length;
    const remainingInAttempt = unresolvedAtAttemptStart.length - solvedInAttempt - deferredInAttempt;
    emitProgressLine(`attempt ${attempt} results: solved ${solvedInAttempt}, deferred ${deferredInAttempt}, remaining ${remainingInAttempt}`);
    if (phaseName === 'template-bundle' && attempt === 1 && remainingInAttempt === 0) {
      logFirstBatchResolutionDetails(unresolvedAtAttemptStart, issueState);
    }

    report?.copilotRemediationTrace?.push({
      phaseName,
      attempt,
      openIssueIds: unresolvedAtAttemptStart.map(issue => issue.id),
      editedFiles: inScopeEditedFiles,
      outOfScopeEdits: allOutOfScopeEdits,
      validationFindings,
      fixerChanges: agentChanges,
      challengerVerdicts,
      challengerEditedFiles: editedAfterChallenger,
      survivingChanges,
      verifierResult,
      verifierEditedFiles: allInScopeEditedFiles,
      liveVerificationResult,
      resolvedIssueIdsAfterAttempt: [...issueState.values()].filter(s => s.resolved).map(s => s.issue.id),
    });

    const nowResolved = [...issueState.values()].filter(s => s.resolved).length;
    console.log(chalk.dim(`  After ${phaseLabel} attempt ${attempt}: ${nowResolved}/${issueState.size} issue(s) resolved.`));
  }
  const stillUnresolved = [...issueState.values()].some(s => !s.resolved && !s.pendingLiveVerification);
  return { needsFallback: anyNeedsFallback || stillUnresolved, fallbackRequestedFiles: [...new Set(fallbackRequestedFiles)] };
}

async function runChallenger({ repoPath, issues, fixerChanges, validationFindings = [], allowedWriteFiles = [] }) {
  if (fixerChanges.length === 0) return { verdicts: [], revisions: [] };
  const challenger = await createCopilotAgent({
    role: 'challenger',
    cwd: repoPath,
    tools: REMEDIATION_TOOLS,
    allowedWriteFiles,
    systemPrompt: 'You are a strict, evidence-driven accessibility reviewer. You may revise scoped files when review evidence shows the current change is incomplete or broken.',
    quiet: true,
  });
  console.log(chalk.dim('  ── Copilot Challenger · reviewing and revising applied changes ──'));
  try {
    await challenger.run(renderPrompt('copilot_challenger.md', {
      repo_path: repoPath,
      allowed_edit_files: allowedWriteFiles.join('\n'),
      issues_json: JSON.stringify(issues.map(toPromptIssue), null, 2),
      fixer_changes_json: JSON.stringify(fixerChanges, null, 2),
      validation_findings: validationFindings.length ? JSON.stringify(validationFindings, null, 2) : 'None - all edited files parsed cleanly.',
    }));
    const parsed = extractJsonFromText(challenger.getFinalText());
    return {
      verdicts: Array.isArray(parsed) ? parsed : (parsed?.verdicts || []),
      revisions: normalizeAgentRevisions(parsed, issues),
    };
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ Challenger failed: ${err.message} — treating changes as unverified.`));
    return { verdicts: [], revisions: [] };
  } finally {
    await challenger.dispose();
  }
}

async function runVerifier({ repoPath, issues, survivingChanges, allowedWriteFiles = [] }) {
  if (survivingChanges.length === 0) return { issues: [], overall: 'fail', revisions: [] };
  const verifier = await createCopilotAgent({
    role: 'verifier',
    cwd: repoPath,
    tools: REMEDIATION_TOOLS,
    allowedWriteFiles,
    systemPrompt: 'You are the final source accessibility auditor. You may revise scoped files only when needed to make the claimed accessibility fix verifiably correct.',
    quiet: true,
  });
  console.log(chalk.dim('  ── Copilot Verifier · re-checking and revising survivors ──'));
  try {
    await verifier.run(renderPrompt('copilot_verifier.md', {
      repo_path: repoPath,
      allowed_edit_files: allowedWriteFiles.join('\n'),
      issues_json: JSON.stringify(issues.map(toPromptIssue), null, 2),
      accepted_changes_json: JSON.stringify(survivingChanges, null, 2),
    }));
    const parsed = extractJsonFromText(verifier.getFinalText());
    if (Array.isArray(parsed)) return { issues: parsed, overall: 'pass', revisions: [] };
    return {
      issues: parsed?.issues || [],
      overall: parsed?.overall || 'fail',
      revisions: normalizeAgentRevisions(parsed, issues),
    };
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ Verifier failed: ${err.message} — survivors left unconfirmed.`));
    return { issues: [], overall: 'fail', revisions: [] };
  } finally {
    await verifier.dispose();
  }
}

async function runLiveVerifier({ issues, fixerChanges, analysis, repoPath }) {
  if (fixerChanges.length === 0) return { issues: [], overall: 'fail' };
  const changeById = new Map((fixerChanges || []).map(c => [c.issueId, c]));
  const results = [];
  console.log(chalk.dim('  ── Live Verifier · running targeted Axe checks per issue ──'));

  let browser;
  try {
    const { chromium } = await import('playwright');
    const { AxeBuilder } = await import('@axe-core/playwright');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

    // Group issues by page to minimize navigation
    const byPage = new Map();
    for (const issue of issues) {
      const change = changeById.get(issue.id);
      if (!change) continue;
      const pageUrl = issue.page || analysis?.scanUrl || '';
      if (!pageUrl) continue;
      if (!byPage.has(pageUrl)) byPage.set(pageUrl, []);
      byPage.get(pageUrl).push({ issue, change });
    }

    for (const [pageUrl, entries] of byPage) {
      let page;
      try {
        page = await ctx.newPage();
        await page.goto(pageUrl, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(1000); // settle

        for (const { issue, change } of entries) {
          const axeRuleId = toAxeRuleId(issue.ruleId || issue.id, issue.source);
          if (!axeRuleId) {
            // Can't verify this rule with Axe — defer
            results.push({
              issueId: issue.id, file: change.file || '', resolved: false,
              verifiedBy: null, deferred: true,
              notes: 'no Axe rule equivalent — deferred to Phase 6',
            });
            continue;
          }

          try {
            const axeResult = await new AxeBuilder({ page })
              .withRules([axeRuleId])
              .analyze();
            const stillPresent = axeResult.violations.length > 0;
            results.push({
              issueId: issue.id, file: change.file || '',
              resolved: !stillPresent,
              verifiedBy: stillPresent ? null : 'targeted-axe-check',
              deferred: false,
              notes: stillPresent
                ? `Rule ${axeRuleId} still has ${axeResult.violations.length} violation(s) — issue persists`
                : `Rule ${axeRuleId} passes — fix confirmed`,
            });
          } catch (axeErr) {
            results.push({
              issueId: issue.id, file: change.file || '', resolved: false,
              verifiedBy: null, deferred: true,
              notes: `targeted check failed: ${axeErr.message} — deferred to Phase 6`,
            });
          }
        }
      } catch (pageErr) {
        // Page failed to load — defer all issues for this page
        for (const { issue, change } of entries) {
          results.push({
            issueId: issue.id, file: change.file || '', resolved: false,
            verifiedBy: null, deferred: true,
            notes: `page load failed: ${pageErr.message} — deferred to Phase 6`,
          });
        }
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    await ctx.close();
  } catch (err) {
    console.log(chalk.dim(`  Live verifier browser failed: ${err.message} — deferring all to Phase 6`));
    for (const issue of issues) {
      const change = changeById.get(issue.id);
      if (!change) continue;
      results.push({
        issueId: issue.id, file: change.file || '', resolved: false,
        verifiedBy: null, deferred: true,
        notes: `live verification unavailable: ${err.message}`,
      });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const confirmed = results.filter(r => r.resolved).length;
  const deferred = results.filter(r => r.deferred).length;
  const failed = results.filter(r => !r.resolved && !r.deferred).length;
  console.log(chalk.dim(`  Live verification: ${confirmed} confirmed, ${failed} failed, ${deferred} deferred`));
  return { issues: results, overall: confirmed > 0 ? 'partial' : 'deferred' };
}


async function applyChallengerVerdicts({ repoPath, originals, challengerVerdicts, issueState }) {
  for (const verdict of challengerVerdicts) {
    const state = issueState.get(verdict.issueId);
    if (state) state.trail.challenger = { verdict: verdict.verdict, reasoning: verdict.reasoning };
    if (verdict.verdict !== 'harmful') continue;
    const rel = normalizeRelPath(verdict.file || '');
    if (!rel || !originals.has(rel)) continue;
    try {
      await fs.writeFile(path.join(repoPath, rel), originals.get(rel), 'utf-8');
      console.log(chalk.yellow(`    ↺ Reverted harmful change in ${rel} (challenger verdict)`));
      logger.remediation(`↺ reverted harmful change in ${rel} (challenger verdict for ${verdict.issueId})`);
    } catch { /* ignore */ }
    for (const candidate of issueState.values()) {
      const fixerFile = candidate.trail?.fixer?.file ? normalizeRelPath(candidate.trail.fixer.file) : null;
      if (candidate.file === rel || fixerFile === rel || candidate.issue.id === verdict.issueId) {
        candidate.attempted = true;
        candidate.resolved = false;
        candidate.pendingLiveVerification = false;
        candidate.status = 'reverted-harmful';
        candidate.file = null;
        candidate.files = [];
      }
    }
  }
}

function collectSurvivingChanges({ originals, fixerChanges }) {
  return fixerChanges.filter(change => getChangeFiles(change).some(file => originals.has(file)));
}

function applyVerifierResult({ verifierResult, fixerChanges, challengerVerdicts, issueState }) {
  const verifiedById = new Map((verifierResult.issues || []).map(i => [i.issueId, i]));
  const challengerById = new Map((challengerVerdicts || []).map(c => [c.issueId, c]));
  const changeById = new Map((fixerChanges || []).map(c => [c.issueId, c]));
  const touchedIssueIds = new Set([...verifiedById.keys(), ...challengerById.keys(), ...changeById.keys()]);
  for (const [issueId, state] of issueState) {
    if (!touchedIssueIds.has(issueId)) continue;
    const verdict = verifiedById.get(issueId);
    const challenger = challengerById.get(issueId);
    const change = changeById.get(issueId);
    const changeFiles = getChangeFiles(change);
    const fallbackFile = changeFiles[0] || (verdict?.file ? normalizeRelPath(verdict.file) : null);
    state.attempted = true;
    if (verdict) state.trail.verifier = { resolved: verdict.resolved, confidence: verdict.confidence, notes: verdict.notes };
    if (change) state.trail.fixer = { file: change.file, files: change.files || [], changeSummary: change.changeSummary, rationale: change.rationale };
    const challengerOk = !challenger || challenger.verdict === 'helps';
    state.sourceResolved = Boolean(verdict?.resolved && challengerOk);
    state.sourceFile = fallbackFile;
    state.file = fallbackFile;
    state.files = changeFiles.length > 0 ? changeFiles : (fallbackFile ? [fallbackFile] : []);
    state.confidence = verdict?.confidence || state.confidence || 'medium';
    state.resolved = false;
    state.pendingLiveVerification = false;
    state.status = state.sourceResolved ? 'source-resolved-awaiting-live' : 'source-unresolved';
  }
}

function applyLiveVerifierResult({ liveVerificationResult, fixerChanges, verifierResult, issueState }) {
  const liveById = new Map((liveVerificationResult?.issues || []).map(i => [i.issueId, i]));
  const sourceById = new Map((verifierResult?.issues || []).map(i => [i.issueId, i]));
  const changeById = new Map((fixerChanges || []).map(c => [c.issueId, c]));
  for (const [issueId, live] of liveById) {
    const state = issueState.get(issueId);
    if (!state) continue;
    const change = changeById.get(issueId);
    const source = sourceById.get(issueId);
    const sourceFixConfirmed = state.sourceResolved === true || source?.resolved === true;
    state.attempted = true;
    state.trail.live = { resolved: live.resolved, verifiedBy: live.verifiedBy, deferred: live.deferred === true, notes: live.notes };
    const files = getChangeFiles(change);
    const fallbackFile = files[0]
      || state.sourceFile
      || (source?.file ? normalizeRelPath(source.file) : null)
      || state.file
      || null;
    const ownedFiles = files.length > 0
      ? files
      : (state.files?.length > 0
        ? state.files
        : (fallbackFile ? [fallbackFile] : []));

    if (live.resolved) {
      state.resolved = true;
      state.pendingLiveVerification = false;
      state.file = fallbackFile;
      state.files = ownedFiles;
      state.confidence = source?.confidence || state.confidence || 'medium';
      state.status = 'resolved';
    } else if (live.deferred === true) {
      state.resolved = false;
      if (sourceFixConfirmed) {
        state.pendingLiveVerification = true;
        state.file = fallbackFile;
        state.files = ownedFiles;
        state.status = 'pending-live-verification';
      } else {
        state.pendingLiveVerification = false;
        state.file = fallbackFile;
        state.files = ownedFiles;
        state.status = 'unresolved';
      }
    } else if (sourceFixConfirmed) {
      state.resolved = false;
      state.pendingLiveVerification = false;
      state.file = fallbackFile;
      state.files = ownedFiles;
      state.status = 'attempted-unresolved';
      logger.remediation(`Live verification unresolved after source-confirmed fix for ${issueId}; preserving ownership on ${state.file || '(none)'} with status attempted-unresolved.`);
    } else {
      state.resolved = false;
      state.pendingLiveVerification = false;
      state.file = fallbackFile;
      state.files = ownedFiles;
      state.status = 'unresolved';
    }

    if (state.trail?.live) state.trail.live.status = state.status;
  }
}

async function finalizeFixes({ repoPath, originals, issueState, spinner }) {
  const fileToIssues = new Map();
  for (const state of issueState.values()) {
    const keepOwnedEdits = state.resolved
      || state.pendingLiveVerification
      || state.attempted
      || state.status === 'attempted-unresolved'
      || state.status === 'pending-live-verification';
    if (!keepOwnedEdits) continue;
    const files = state.files?.length ? state.files : (state.file ? [state.file] : []);
    for (const file of files) {
      if (!file) continue;
      if (!fileToIssues.has(file)) fileToIssues.set(file, []);
      fileToIssues.get(file).push(state);
    }
  }

  const editedFiles = await detectEditedFiles(repoPath, originals);
  for (const rel of editedFiles) {
    if (fileToIssues.has(rel)) continue;
    spinner.warn(`Keeping ${chalk.dim(rel)} — in-scope edit had no retained ownership; preserving for audit and full verification.`);
    logger.remediation(`Retained in-scope edit ${rel} without issue ownership; no revert by ownership timing.`);
    fileToIssues.set(rel, []);
  }

  const fixes = [];
  for (const [rel, states] of fileToIssues) {
    const original = originals.get(rel);
    if (original == null) continue;
    let fixed;
    try { fixed = await fs.readFile(path.join(repoPath, rel), 'utf-8'); } catch { continue; }
    if (fixed === original) continue;
    if (isThirdPartyFile(rel)) {
      spinner.warn(`Reverting ${chalk.dim(rel)} — third-party/vendor assets are not auto-fix targets.`);
      try { await fs.writeFile(path.join(repoPath, rel), original, 'utf-8'); } catch { /* ignore */ }
      for (const s of states) {
        s.attempted = true;
        s.resolved = false;
        s.pendingLiveVerification = false;
        s.status = 'reverted-third-party';
        s.file = null;
        s.files = [];
      }
      continue;
    }
    const parse = validatePatchedContent(rel, original, fixed);
    if (!parse.ok) {
      spinner.warn(`Reverting ${chalk.dim(rel)} — Copilot's edit left the file unparseable (${parse.reason}).`);
      logger.remediation(`↺ reverted ${rel} — unparseable after edit (${parse.reason})`);
      try { await fs.writeFile(path.join(repoPath, rel), original, 'utf-8'); } catch { /* ignore */ }
      for (const s of states) {
        s.attempted = true;
        s.resolved = false;
        s.pendingLiveVerification = false;
        s.status = 'reverted-unparseable';
        s.file = null;
        s.files = [];
      }
      continue;
    }
    const targetedIssueIds = [...new Set(states.map(s => s.issue?.id).filter(Boolean))];
    const agentReasoning = buildFileReasoning(states, rel);
    const diffSegments = computeDiffSegments(original, fixed);
    fixes.push({
      file: rel,
      original,
      fixed,
      diffSegments,
      violationsAddressed: targetedIssueIds.length,
      targetedIssueIds,
      agentReasoning,
      transformTypes: [],
      engine: 'copilot',
    });
  }
  return fixes;
}

function buildFileReasoning(states, relFile = '') {
  if (!Array.isArray(states) || states.length === 0) {
    return `Copilot changed ${relFile || 'this file'} during remediation; ownership could not be retained at issue-level timing, so the in-scope edit is preserved for full verification and human review.`;
  }
  const lines = [];
  for (const state of states) {
    const issueId = state.issue?.id || '';
    const status = state.status || (state.pendingLiveVerification ? 'pending-live-verification' : state.resolved ? 'resolved' : 'attempted-unresolved');
    const summary = state.trail?.fixer?.changeSummary || '';
    const rationale = state.trail?.fixer?.rationale || '';
    const verifier = state.trail?.verifier?.notes || '';
    const live = state.trail?.live?.notes || '';
    const text = [summary, rationale, verifier, live].filter(Boolean).join(' ');
    if (text) lines.push(`${issueId} [${status}]: ${text}`);
  }
  return [...new Set(lines)].join('\n') || 'Copilot changed this file to address the mapped accessibility issue(s).';
}

async function validateEditedFiles(repoPath, originals, editedRels) {
  const findings = [];
  for (const rel of editedRels) {
    const original = originals.get(rel);
    if (original == null) continue;
    let fixed;
    try { fixed = await fs.readFile(path.join(repoPath, rel), 'utf-8'); } catch { continue; }
    const parse = validatePatchedContent(rel, original, fixed);
    if (!parse.ok) findings.push({ file: rel, problem: parse.reason });
  }
  return findings;
}

async function revertOutOfScopeEdits({ repoPath, baseline, editedFiles, allowedFiles }) {
  const allowed = new Set(allowedFiles.map(normalizeRelPath));
  const baselineContents = baseline?.contents instanceof Map ? baseline.contents : baseline;
  const reverted = [];
  for (const rel of editedFiles) {
    if (allowed.has(rel)) continue;
    const original = baselineContents?.get(rel);
    if (original == null) continue;
    try {
      await fs.writeFile(path.join(repoPath, rel), original, 'utf-8');
      reverted.push(rel);
    } catch { /* ignore */ }
  }
  return reverted;
}

function rebuildAnalysisMapping(analysis, issueState) {
  const originalMapping = analysis?.mapping || [];
  const originalMappingById = new Map(originalMapping.map(entry => [entry.violationId, entry]));
  const mappingById = new Map(originalMapping.map(entry => [entry.violationId, { ...entry }]));
  const manualReview = [];
  for (const state of issueState.values()) {
    const issue = state.issue;
    if (state.resolved && state.file) {
      const axeRule = toAxeRuleId(issue.ruleId || issue.id, issue.source);
      const existing = originalMappingById.get(issue.id) || {};
      const prior = issue.sourceMapping || {};
      mappingById.set(issue.id, {
        ...existing,
        violationId: issue.id,
        file: state.file,
        confidence: state.confidence || 'medium',
        ownership: existing.ownership || prior.primaryRole || 'unknown',
        fileRole: existing.fileRole || prior.primaryRole || null,
        slideType: prior.slideType || null,
        mappingConfidence: existing.mappingConfidence || prior.mappingConfidence || 'medium',
        mappingEvidence: existing.mappingEvidence || prior.rationale || null,
        reason: state.trail?.fixer?.changeSummary || 'copilot-agent fix',
        via: prior.primaryFile ? 'template-name-bundle+copilot-agent' : 'copilot-agent',
        mode: 'safe-autofix',
        autofixAllowed: true,
        transformType: existing.transformType || null,
        verificationRuleIds: existing.verificationRuleIds?.length ? existing.verificationRuleIds : (axeRule ? [axeRule] : []),
        agentTrail: state.trail,
      });
    } else {
      const unresolvedStatus = state.status || (state.pendingLiveVerification ? 'pending-live-verification' : 'unresolved');
      manualReview.push({
        violationId: issue.id,
        file: state.file || issue.sourceMapping?.primaryFile || null,
        files: state.files || [],
        status: unresolvedStatus,
        reason: state.trail?.verifier?.notes ? `copilot-${unresolvedStatus}: ${state.trail.verifier.notes}` : `copilot-${unresolvedStatus}`,
        page: issue.page || null,
        agentTrail: state.trail,
        sourceMapping: issue.sourceMapping || null,
      });
    }
  }
  analysis.mapping = [...mappingById.values()];
  analysis.manualReview = [...(analysis.manualReview || []), ...manualReview];
}

function updateBaseline(analysis, issueState) {
  const eligible = new Set((analysis.mapping || []).filter(m => m.autofixAllowed).map(m => m.violationId));
  const actionable = analysis.baseline?.actionableCount ?? issueState.size;
  analysis.baseline = {
    ...(analysis.baseline || {}),
    actionableCount: actionable,
    autofixEligibleCount: eligible.size,
    manualReviewCount: actionable - eligible.size,
  };
}

function buildAgentTrail(issueState) {
  return [...issueState.values()].map(s => ({
    issueId: s.issue.id,
    ruleId: s.issue.ruleId || s.issue.id,
    attempted: s.attempted === true || Boolean(s.trail?.fixer) || Boolean(s.trail?.challenger) || Boolean(s.trail?.verifier) || Boolean(s.trail?.live),
    status: s.status || (s.resolved ? 'resolved' : s.pendingLiveVerification ? 'pending-live-verification' : 'unattempted'),
    resolved: s.resolved,
    pendingLiveVerification: s.pendingLiveVerification === true,
    file: s.file || s.files?.[0] || null,
    files: s.files || (s.file ? [s.file] : []),
    fixer: s.trail?.fixer || null,
    challenger: s.trail?.challenger || null,
    verifier: s.trail?.verifier || null,
    live: s.trail?.live || null,
  }));
}

function getDeterministicAutofixIssueIds(analysis) {
  return new Set((analysis?.mapping || []).filter(m => m.autofixAllowed).map(m => m.violationId).filter(Boolean));
}

async function buildTemplateBundle({ issues, repoPath, sourceFileMap, originals }) {
  const names = inferTemplateNames({ issues, sourceFileMap });
  const bundles = [];
  const files = [];
  const add = (file) => {
    const rel = file ? normalizeRelPath(file) : '';
    if (rel && originals.has(rel) && !files.includes(rel)) files.push(rel);
  };
  for (const templateName of names) {
    const bundle = await resolveSlideTemplateFiles(templateName, repoPath);
    bundles.push(bundle);
    for (const file of bundle.flatFiles || []) add(file);
  }
  return {
    templateNames: names,
    bundles,
    flatFiles: limitCandidates(files),
    via: 'template-name-bundle',
  };
}

function inferTemplateNames({ issues, sourceFileMap }) {
  const names = [];
  const add = (value) => {
    const text = String(value || '').trim();
    if (text && !names.includes(text)) names.push(text);
  };
  for (const issue of issues) {
    add(issue.sourceMapping?.slideType);
    add(issue.sourceMapping?.rendererClass);
    add(lastRendererSegment(issue.sourceMapping?.rendererClass));
  }
  for (const ctx of sourceFileMap?.slideContexts || []) {
    add(ctx.slideType);
    add(ctx.rendererClass);
    add(lastRendererSegment(ctx.rendererClass));
  }
  return names.slice(0, 5);
}

function lastRendererSegment(rendererClass = '') {
  return String(rendererClass || '').split('.').filter(Boolean).at(-1) || '';
}

function buildMappingContext({ sourceFileMap, issues, templateBundle, mode }) {
  const perIssue = issues.map(issue => ({
    issueId: issue.id,
    deterministicPrior: issue.sourceMapping || null,
  }));
  return [
    `Mode: ${mode}`,
    '',
    'Detected template bundle:',
    JSON.stringify(templateBundle, null, 2),
    '',
    'Architecture context:',
    summarizeSlideArchitecture(sourceFileMap),
    '',
    'Per-issue deterministic mapping priors:',
    JSON.stringify(perIssue, null, 2),
  ].join('\n');
}

// Backup mapping widens the editable scope to a deterministic candidate list composed from
// unresolved issue priors (primary file, alternates, template candidates) and scoped repo files.
function buildFallbackFileList({ sourceFileMap, originals, issues = [] }) {
  const ordered = [];
  const add = (file) => {
    const rel = file ? normalizeRelPath(file) : '';
    if (rel && originals.has(rel) && !ordered.includes(rel)) ordered.push(rel);
  };
  for (const issue of issues) {
    add(issue.sourceMapping?.primaryFile);
    for (const file of issue.sourceMapping?.candidateFiles || []) add(file);
    for (const file of issue.sourceMapping?.alternates || []) add(file);
  }
  for (const candidate of sourceFileMap?.slideCandidateFiles || []) add(candidate.localFile);
  const scoped = sourceFileMap && [
    ...(sourceFileMap.htmlFiles || []),
    ...(sourceFileMap.cssFiles || []),
    ...(sourceFileMap.jsFiles || []),
    ...(sourceFileMap.otherFiles || []),
  ].map(entry => normalizeRelPath(entry.localFile)).filter(Boolean);
  if (scoped && scoped.length > 0) {
    for (const file of scoped) add(file);
  } else {
    for (const file of originals.keys()) add(file);
  }
  return limitCandidates(ordered);
}

function logFirstBatchResolutionDetails(issues, issueState) {
  for (const issue of issues) {
    const state = issueState.get(issue.id);
    if (!state?.resolved) continue;
    const files = state.files?.length ? state.files : (state.file ? [state.file] : []);
    const reason = [
      state.trail?.fixer?.changeSummary,
      state.trail?.fixer?.rationale,
      state.trail?.verifier?.notes,
      state.trail?.live?.notes,
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || 'resolved after targeted copilot remediation.';
    emitProgressLine(`batch 1 resolved ${issue.id} -> ${files.join(', ') || '(no-file)'}: ${reason}`);
  }
}

function limitCandidates(files) {
  if (COPILOT_MAX_CANDIDATE_FILES > 0 && files.length > COPILOT_MAX_CANDIDATE_FILES) {
    return files.slice(0, COPILOT_MAX_CANDIDATE_FILES);
  }
  return files;
}

function toPromptIssue(issue) {
  const prompt = {
    issueId: issue.id,
    ruleId: issue.ruleId || issue.id,
    source: issue.source,
    impact: issue.impact,
    description: issue.description,
    element: issue.nodes?.[0]?.html || issue.element || '',
    selector: issue.nodes?.[0]?.target || '',
    page: issue.page || '',
    failureSummary: issue.nodes?.[0]?.fix || issue.fix || '',
    wcagHelp: issue.helpUrl || '',
    sourceMapping: issue.sourceMapping || null,

    // ENH-06: DOM context enrichment for better fixer targeting
    domParentChain: issue.domContext?.parents?.map(p =>
      `${p.tag}${p.id ? '#'+p.id : ''}${p.classes?.length ? '.'+p.classes.join('.') : ''}` +
      `${Object.keys(p.dataAttrs||{}).length ? ' ['+Object.entries(p.dataAttrs).map(([k,v])=>`${k}="${v}"`).join(' ')+']' : ''}`
    ).join(' > ') || null,

    siblingsContext: issue.domContext?.siblings?.map(s =>
      `${s.tag}${s.forAttr ? `[for="${s.forAttr}"]` : ''}: "${s.text || ''}"`
    ).join(', ') || null,

    jsCreationSite: issue.jsCreationSite ? {
      file: issue.jsCreationSite.file,
      line: issue.jsCreationSite.line,
      via: issue.jsCreationSite.via,
      snippet: issue.jsCreationSite.snippet,
    } : null,

    isInteractionTriggered: issue.source === 'interaction',
    triggerSelector: issue.triggerSelector || null,
  };
  const wcag = getWcagCriteriaForRule(issue.ruleId || issue.id);
  if (wcag) {
    prompt.wcagCriterion = `${wcag.sc}: ${wcag.requirement}`;
    prompt.wcagTechnique = wcag.technique;
  }
  if (issue._dynamicClassification?.suggestedApproach) {
    prompt.suggestedApproach = issue._dynamicClassification.suggestedApproach;
  }
  return prompt;
}

function normalizeFixerChanges(parsed, unresolved) {
  let arr = [];
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed?.changes) arr = parsed.changes;
  else if (parsed?.fixes) arr = parsed.fixes;
  const validIds = new Set(unresolved.map(v => v.id));
  return arr
    .filter(change => change && change.issueId)
    .map(change => {
      const files = getChangeFiles(change);
      return {
        issueId: change.issueId,
        file: files[0] || '',
        files,
        ruleId: change.ruleId || '',
        changeSummary: change.changeSummary || '',
        rationale: change.rationale || '',
        resolved: change.resolved !== false,
      };
    })
    .filter(change => validIds.has(change.issueId));
}

function buildInferredFixerChange(issue, editedFiles) {
  const files = uniquePaths(editedFiles);
  return {
    issueId: issue.id,
    file: files[0] || '',
    files,
    ruleId: issue.ruleId || issue.id || '',
    changeSummary: 'Inferred from on-disk edits when fixer response omitted parseable change JSON.',
    rationale: 'Disk-truth attribution fallback preserves edited files for verifier and phase 5b/6 rebuild+rescan.',
    resolved: true,
    inferred: true,
  };
}

function normalizeAgentRevisions(parsed, issues) {
  if (!parsed || Array.isArray(parsed)) return [];
  const revisions = Array.isArray(parsed.revisions) ? parsed.revisions : [];
  if (revisions.length === 0) return [];
  const validIds = new Set(issues.map(v => v.id));
  return revisions
    .filter(change => change && change.issueId && validIds.has(change.issueId))
    .map(change => {
      const files = getChangeFiles(change);
      return {
        issueId: change.issueId,
        file: files[0] || '',
        files,
        ruleId: change.ruleId || '',
        changeSummary: change.changeSummary || change.summary || 'Agent reviewer revised the scoped accessibility fix.',
        rationale: change.rationale || change.notes || '',
        resolved: change.resolved !== false,
      };
    });
}

function mergeAgentChanges(baseChanges = [], revisions = []) {
  const byIssue = new Map();
  for (const change of baseChanges) byIssue.set(change.issueId, { ...change, files: getChangeFiles(change) });
  for (const revision of revisions) {
    const existing = byIssue.get(revision.issueId);
    if (!existing) {
      byIssue.set(revision.issueId, { ...revision, files: getChangeFiles(revision) });
      continue;
    }
    const files = uniquePaths([...getChangeFiles(existing), ...getChangeFiles(revision)]);
    byIssue.set(revision.issueId, {
      ...existing,
      ...revision,
      file: revision.file || existing.file || files[0] || '',
      files,
      changeSummary: revision.changeSummary || existing.changeSummary,
      rationale: revision.rationale || existing.rationale,
    });
  }
  return [...byIssue.values()];
}

function getChangeFiles(change = {}) {
  return uniquePaths([
    change.file,
    ...(Array.isArray(change.files) ? change.files : []),
    ...(Array.isArray(change.relatedFiles) ? change.relatedFiles : []),
  ]);
}

function uniquePaths(files = []) {
  return [...new Set(files.map(file => file ? normalizeRelPath(file) : '').filter(Boolean))];
}

function buildFixerPrompt({ repoPath, phaseName, candidateFiles, mappingContext, issues, issueState }) {
  const enrichedIssues = issues.map(issue => {
    const prompt = toPromptIssue(issue);
    const state = issueState?.get(issue.id);
    if (state?.trail?.live && !state.trail.live.resolved) {
      prompt.priorAttemptFailed = true;
      prompt.priorFailureContext = `This issue was previously attempted and the fix appeared correct in source, but FAILED live verification (the rendered page still has the violation). The source template/file may already contain the fix, but something at runtime (JS rendering, dynamic DOM manipulation, or a different code path) overrides it. You MUST look beyond the template — check JS files that create or manipulate this element at runtime. Do NOT report "already fixed" — the live page proves it is NOT fixed.`;
      if (state.trail.live.notes) prompt.priorFailureNotes = state.trail.live.notes;
    }
    return prompt;
  });
  return renderPrompt('copilot_fixer.md', {
    repo_path: repoPath,
    phase_context: phaseName === 'template-bundle'
      ? 'Phase A: template-name bundle remediation. Edit only the allowed template bundle files. If the bundle is wrong for this issue, return needsFallback instead of guessing.'
      : 'Phase B: deterministic fallback remediation. Edit only the broader deterministic mapping candidate files.',
    candidate_files: candidateFiles.join('\n'),
    mapping_context: mappingContext,
    issues_json: JSON.stringify(enrichedIssues, null, 2),
    constraints: buildConstraints(issues),
  });
}

function buildSingleIssueRetryPrompt(issue, issueState, candidateFiles) {
  const trail = issueState.get(issue.id)?.trail || {};
  const why = [trail.live?.notes, trail.verifier?.notes, trail.challenger?.reasoning].filter(Boolean).join(' | ') || 'still failing automated live checks';
  return [
    'This single accessibility issue is still unresolved after the previous attempt:',
    '',
    `- ${issue.id} (${issue.ruleId || issue.id}): ${why}`,
    '',
    'Allowed edit files remain:',
    candidateFiles.join('\n'),
    '',
    'Investigate only this issue. If these files are wrong, return the JSON object with needsFallback=true and explain why. Otherwise apply a correct minimal fix and return the same JSON shape as before.',
  ].join('\n');
}

function buildConstraints(issues = []) {
  const parts = [
    '- Treat each issue as a real defect on the live page; do not dismiss scanner findings as false positives.',
    '- Keep the page rendering and business logic intact.',
    '- Never introduce new accessibility violations or runtime errors.',
    '',
    '  === CRITICAL: Verify the composed page, not just the edited file ===',
    '',
    '  A single page is built from multiple files that compose at runtime:',
    '    - Document templates (outer html/body wrapper)',
    '    - Content templates (rendered inside the body)',
    '    - JavaScript files (create/modify DOM at runtime)',
    '    - CSS files (style existing elements, cannot create new ones)',
    '',
    '  BEFORE editing any file, you MUST:',
    '    1. Search the ENTIRE repository — not just the allowed edit scope — for every file that',
    '       contributes to, creates, or styles the element/pattern you are fixing.',
    '    2. Understand the composition chain: how do these files nest inside each other at runtime?',
    '    3. Identify ALL existing instances of the element/pattern across the full composition.',
    '',
    '  AFTER editing, you MUST verify your change does NOT create any of these regressions:',
    '    - ADDING a new instance? Another file in the chain may ALREADY create one → duplicate conflict.',
    '    - REMOVING or CONVERTING an instance? It may be the ONLY one in the chain → missing conflict.',
    '    - Adding CSS-only? The HTML element may not exist in ANY template or JS file → dead code.',
    '    - Adding HTML? May conflict with JS that dynamically creates the same element at runtime.',
    '    - Changing JS? May conflict with templates that already declare the same element statically.',
    '',
    '  If any file outside the allowed edit scope needs changes to prevent a regression,',
    '  return needsFallback=true and list the exact file paths that must be added to the scope.',
    '',
    '- Shell commands are allowed only for bounded validation: node --check, npm run lint/test/typecheck/build/check, npx tsc --noEmit, npx eslint, git status/diff, dotnet build, or make check/build/test/lint.',
  ];

  return parts.join('\n');
}

async function snapshotSourceFiles(repoPath) {
  const map = new Map();
  let absFiles = [];
  try { absFiles = await collectSourceFiles(repoPath); } catch { return map; }
  for (const abs of absFiles) {
    const rel = normalizeRelPath(path.relative(repoPath, abs));
    if (shouldSkipFile(rel) || isBinaryFile(rel)) continue;
    try {
      const stat = await fs.stat(abs);
      if (COPILOT_MAX_SNAPSHOT_FILE_BYTES > 0 && stat.size > COPILOT_MAX_SNAPSHOT_FILE_BYTES) continue;
      map.set(rel, await fs.readFile(abs, 'utf-8'));
    } catch { /* unreadable */ }
  }
  return map;
}

async function snapshotCurrentContents(repoPath, originals) {
  const contents = new Map();
  const metadata = new Map();
  const hashes = new Map();
  for (const rel of originals.keys()) {
    const abs = path.join(repoPath, rel);
    try {
      const stat = await fs.stat(abs);
      const content = await fs.readFile(abs, 'utf-8');
      contents.set(rel, content);
      metadata.set(rel, snapshotMetadataFromStat(stat));
      hashes.set(rel, hashTextContent(content));
    } catch { /* ignore */ }
  }
  return { contents, metadata, hashes };
}

async function snapshotCandidateContents(repoPath, candidateFiles = []) {
  const map = new Map();
  for (const rel of uniquePaths(candidateFiles)) {
    try { map.set(rel, await fs.readFile(path.join(repoPath, rel), 'utf-8')); } catch { map.set(rel, null); }
  }
  return map;
}

function diffSnapshotChangedFiles(beforeSnapshot = new Map(), afterSnapshot = new Map()) {
  const changed = [];
  const files = new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);
  for (const rel of files) {
    const before = beforeSnapshot.has(rel) ? beforeSnapshot.get(rel) : null;
    const after = afterSnapshot.has(rel) ? afterSnapshot.get(rel) : null;
    if (before !== after) changed.push(rel);
  }
  return changed;
}

async function detectEditedFilesAgainst(repoPath, baseline) {
  const baselineContents = baseline?.contents instanceof Map ? baseline.contents : baseline;
  const baselineMetadata = baseline?.metadata instanceof Map ? baseline.metadata : null;
  const baselineHashes = baseline?.hashes instanceof Map ? baseline.hashes : null;
  const edited = [];
  for (const [rel, before] of baselineContents || []) {
    const abs = path.join(repoPath, rel);
    let currentMetadata = null;
    try {
      currentMetadata = snapshotMetadataFromStat(await fs.stat(abs));
    } catch {
      continue;
    }

    const beforeMetadata = baselineMetadata?.get(rel);
    const beforeHash = baselineHashes?.get(rel);
    if (isSameSnapshotMetadata(beforeMetadata, currentMetadata) && beforeHash) {
      const currentHash = await hashFileContents(abs);
      if (currentHash && currentHash === beforeHash) continue;
    }

    let current;
    try { current = await fs.readFile(abs, 'utf-8'); } catch { continue; }
    if (current !== before) edited.push(rel);
  }
  return edited;
}

function snapshotMetadataFromStat(stat) {
  if (!stat) return null;
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function isSameSnapshotMetadata(before, current) {
  if (!before || !current) return false;
  return before.size === current.size && before.mtimeMs === current.mtimeMs && before.ctimeMs === current.ctimeMs;
}

function hashTextContent(content = '') {
  return createHash('sha256').update(String(content || ''), 'utf-8').digest('hex');
}

function hashBinaryContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function hashFileContents(absPath) {
  try {
    const content = await fs.readFile(absPath);
    return hashBinaryContent(content);
  } catch {
    return null;
  }
}

async function detectEditedFiles(repoPath, originals) {
  const edited = [];
  for (const [rel, original] of originals) {
    let current;
    try { current = await fs.readFile(path.join(repoPath, rel), 'utf-8'); } catch { continue; }
    if (current !== original) edited.push(rel);
  }
  return edited;
}
