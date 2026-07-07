import fs from 'fs/promises';
import chalk from 'chalk';
import path from 'path';
import { pathToFileURL } from 'url';
import { opts, ENGINE } from './src/core/cli.js';
import { DEBUG, OPENAI_API_KEY, LOG_HEARTBEAT_MS } from './src/core/config.js';
import { logger } from './src/core/logger.js';
import { phase1_ingest, phase2_serve, identifySourceFilesForUrl } from './src/ingest.js';
import { failedLighthouseResult, phase3a_axe, phase3b_lighthouse, phase3e_pa11y } from './src/scanning/scan.js';
import { phase3c_keyboard } from './src/scanning/keyboard-scan.js';
import { phase4_analyzeAndMap } from './src/analyze.js';
import { phase5_copilot_fix } from './src/remediation/copilot-fix.js';
import { fixNeedsBuild } from './src/remediation/patch.js';
import { buildIssueVerificationLedger, buildStaticVerificationLedger, preRescanValidation } from './src/remediation/verify.js';
import { phase6_rescan, rebuildProject } from './src/remediation/rescan.js';
import { phase7_judge } from './src/judge.js';
import { phase8_report, generateExcelReport, writeMinimalReport } from './src/reporting/report.js';
import { buildScannerLibraryTrace } from './src/reporting/trace.js';

function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: DEBUG ? err.stack || null : undefined,
  };
}

function hasAttemptedPhase5Issues(agentTrail = []) {
  return (agentTrail || []).some(issue => {
    if (!issue) return false;
    if (issue.attempted === true) return true;
    if (issue.resolved === true) return true;
    if (issue.pendingLiveVerification === true) return true;
    if (issue.status === 'attempted-unresolved' || issue.status === 'pending-live-verification') return true;
    return Boolean(issue.fixer || issue.challenger || issue.verifier || issue.live);
  });
}

async function writeRunStateArtifact(runState, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const runStatePath = path.join(outputDir, 'run-state.json');
  await fs.writeFile(runStatePath, JSON.stringify(runState, null, 2));
  return runStatePath;
}

async function rescanOnlyMode(runDir) {
  const reportPath = path.join(runDir, 'report.json');
  console.log(chalk.bold.cyan(`\n  ── Rescan-only mode: loading ${reportPath} ──\n`));
  
  let prevReport;
  try {
    prevReport = JSON.parse(await fs.readFile(reportPath, 'utf-8'));
  } catch (err) {
    console.error(chalk.red(`  ✗ Cannot load previous report: ${err.message}`));
    console.error(chalk.dim(`  Expected: ${reportPath}`));
    process.exit(1);
  }

  const fixes = prevReport.fixes || [];
  const analysis = prevReport.analysis || {};
  const scanUrl = opts.url;
  
  if (!scanUrl) {
    console.error(chalk.red('  ✗ --url is required with --rescan-only (the live URL to re-scan)'));
    process.exit(1);
  }
  if (fixes.length === 0) {
    console.error(chalk.yellow('  ⚠ No fixes found in previous report — nothing to verify.'));
    process.exit(0);
  }

  console.log(chalk.dim(`  Previous run: ${fixes.length} fix(es) across ${[...new Set(fixes.map(f => f.file))].length} file(s)`));
  console.log(chalk.dim(`  Scan URL: ${scanUrl}\n`));

  // Phase 6: Rescan
  console.log(chalk.bold.cyan('  Phase 6 · Re-scanning after manual rebuild...\n'));
  let afterData;
  try {
    afterData = await phase6_rescan(scanUrl, true, null, opts.local || null, fixes, prevReport.before, analysis);
    afterData.scanUrl = scanUrl;
  } catch (err) {
    console.error(chalk.red(`  ✗ Rescan failed: ${err.message}`));
    process.exit(1);
  }

  // Build verification ledger
  const verification = buildIssueVerificationLedger(analysis, afterData, fixes, prevReport.unverifiedFixes || [], prevReport.before);
  
  // Summary
  const resolved = verification.summary?.resolvedTotal || 0;
  const total = verification.summary?.baselineTotal || 0;
  const introduced = verification.summary?.introducedTotal || 0;
  console.log(chalk.bold.cyan('\n  ── Rescan Verification Summary ──'));
  console.log(chalk.green(`  Resolved: ${resolved}/${total}`));
  const excludedNonFixable = verification.introduced?._excludedNonFixable || 0;
  if (introduced > 0) console.log(chalk.red(`  Introduced: ${introduced} new issue(s)`));
  else if (excludedNonFixable > 0) console.log(chalk.dim(`  No new issues introduced (${excludedNonFixable} known non-fixable excluded)`));
  if (excludedNonFixable > 0 && introduced > 0) {
    console.log(chalk.dim(`  (${excludedNonFixable} known non-fixable issue(s) excluded from introduced count)`));
  }
  console.log('');

  // Phase 7: Judge (if --judge)
  let judgment = null;
  if (opts.judge) {
    console.log(chalk.bold.cyan('  Phase 7 · Judge evaluation...\n'));
    try {
      judgment = await phase7_judge(prevReport.before, afterData, fixes, analysis, verification);
    } catch (err) {
      console.error(chalk.yellow(`  ⚠ Judge failed: ${err.message}`));
    }
  }

  // Merge previous report data with new rescan results, ensuring every field
  // that buildHTML expects is present (with safe defaults for optional ones).
  const updatedReport = {
    ...prevReport,
    before: prevReport.before || null,
    analysis: prevReport.analysis || {},
    fixes: prevReport.fixes || [],
    fixVerification: prevReport.fixVerification || [],
    unsureChanges: prevReport.unsureChanges || [],
    agentTrail: prevReport.agentTrail || [],
    copilotRemediationTrace: prevReport.copilotRemediationTrace || null,
    after: afterData,
    verification,
    judgment,
    meta: {
      ...(prevReport.meta || {}),
      rescanTimestamp: new Date().toISOString(),
      rescanMode: true,
    },
  };

  // Write report.json back to the same run dir
  await fs.writeFile(reportPath, JSON.stringify(updatedReport, null, 2), 'utf-8');
  console.log(chalk.green(`  ✓ Updated report written to ${reportPath}`));
  
  // Also generate the HTML report
  try {
    await phase8_report(updatedReport, { strictConsistency: false });
    console.log(chalk.green(`  ✓ HTML report regenerated`));
  } catch (err) {
    console.error(chalk.yellow(`  ⚠ HTML report generation failed: ${err.message}`));
  }

  // Generate Excel
  try {
    await generateExcelReport(fixes, null, analysis, scanUrl, verification);
  } catch (err) {
    console.error(chalk.yellow(`  ⚠ Excel report generation failed: ${err.message}`));
  }

  console.log(chalk.bold.green(`\n  ✓ Rescan-only mode complete.\n`));
}

export async function main() {
  console.log(chalk.bold.cyan('\n  ♿  ACCESSIBILITY AGENT  (Copilot-powered)\n'));

  logger.init(path.resolve(opts.output), { heartbeatMs: LOG_HEARTBEAT_MS });
  logger.log(`Engine: ${ENGINE} · options: ${JSON.stringify(opts)}`);

  const startedAt = new Date().toISOString();
  const report = {
    meta: {
      timestamp: startedAt,
      runLabel: logger.runLabel || null,
      runOutputDir: logger.dir || null,
    },
  };
  let devServer = null;
  let sourceFileMap = null;
  let scanUrl = null;
  let currentPhase = 'startup';
  let pipelineError = null;
  let reportGenerationError = null;
  let minimalReportError = null;
  let runStateError = null;
  let failurePhase = null;
  let runReason = null;
  let runError = null;
  let runStatus = 'completed';
  let reportWritten = false;
  let reportWriteMode = 'none';

  const enterPhase = (label) => {
    currentPhase = label;
    logger.phase(label);
  };

  try {
    if (opts.rescanOnly) {
      return await rescanOnlyMode(opts.rescanOnly);
    }

    enterPhase('Phase 1 · ingest');
    const ingested    = await phase1_ingest();
    report.meta.source = ingested;
    report.meta.timestamp = report.meta.timestamp || startedAt;
    report.meta.runLabel = logger.runLabel || report.meta.runLabel || null;
    report.meta.runOutputDir = logger.dir || report.meta.runOutputDir || null;

    if (ingested.type === 'url+local') {
      sourceFileMap        = await identifySourceFilesForUrl(ingested.url, ingested.repoPath);
      report.sourceFileMap = sourceFileMap;
    }

    // FIX-07: detect .NET project type for build decisions
    let projectType = null;
    if (ingested.repoPath) {
      try {
        const entries = await fs.readdir(ingested.repoPath);
        if (entries.some(e => e.endsWith('.sln') || e.endsWith('.csproj') || e.endsWith('.fsproj'))) {
          projectType = 'dotnet';
        }
      } catch { /* ignore */ }
    }

    scanUrl = ingested.url;
    if (ingested.type === 'local') {
      enterPhase('Phase 2 · serve');
      const served  = await phase2_serve(ingested.repoPath);
      scanUrl       = served.url;
      devServer     = served.server;
    }

    enterPhase('Phase 3 · scan');
    console.log(chalk.dim('\n  Running scanners...\n'));

    // Snapshot the URL for all Phase 3-4 scanning so a Phase 6 re-serve that
    // reassigns `scanUrl` cannot affect any in-progress scanner closure reads.
    const phase3ScanUrl = scanUrl;

    // Each scanner has an internal catch that returns {scanFailed:true}.
    // The outer .catch() here guards against any unhandled throw escaping that
    // internal catch so that one scanner crashing cannot abort the other two.
    const [axeResults, pa11yResult, keyboardResult] = await Promise.all([
      phase3a_axe(phase3ScanUrl).catch(err => ({ violations: [], scanFailed: true, failReason: err.message })),
      phase3e_pa11y(phase3ScanUrl).catch(err => ({ issues: [], errorCount: 0, warningCount: 0, scanFailed: true, failReason: err.message })),
      phase3c_keyboard(phase3ScanUrl).catch(err => ({ issues: [], scanFailed: true, failReason: err.message })),
    ]);
    let lhResult;
    try {
      lhResult = await phase3b_lighthouse(scanUrl);
    } catch (err) {
      const failReason = err?.message || String(err);
      console.warn(chalk.yellow(`  ⚠ Lighthouse scan failed: ${failReason}. Continuing with Axe and pa11y.`));
      logger.warn(`Lighthouse scan failed; continuing with Axe and pa11y. Reason: ${failReason}`);
      lhResult = failedLighthouseResult(failReason);
    }
    // ENH-03: Interaction scan for hidden DOM (dropdowns, modals, tabs)
    let interactionResult = { issues: [], triggerCount: 0, scannedCount: 0 };
    try {
      const { phase3d_interaction } = await import('./src/scanning/interaction-scan.js');
      interactionResult = await phase3d_interaction(phase3ScanUrl);
      console.log(chalk.dim(`  Interaction scan: ${interactionResult.triggerCount || 0} trigger(s) found, ${interactionResult.scannedCount || 0} scanned, ${interactionResult.issues.length} issue(s)`));
    } catch (err) {
      console.log(chalk.dim(`  Interaction scan skipped: ${err.message}`));
    }

    // Phase 3g: Focusable-action scan — activates every focusable element with APG-correct keys,
    // flags elements that do nothing, screenshots + scans any opened dialogs/modals.
    let focusableActionResult = { issues: [], screenshots: [], scannedCount: 0 };
    try {
      const { phase3g_focusableAction } = await import('./src/scanning/focusable-action-scan.js');
      const phase3gOutputDir = logger.dir || path.resolve(opts.output);
      focusableActionResult = await phase3g_focusableAction(phase3ScanUrl, phase3gOutputDir);
      console.log(chalk.dim(`  Focusable-action scan: ${focusableActionResult.scannedCount || 0} element(s) checked, ${focusableActionResult.issues.length} issue(s), ${focusableActionResult.screenshots?.length || 0} screenshot(s)`));
    } catch (err) {
      console.log(chalk.dim(`  Focusable-action scan skipped: ${err.message}`));
    }

    // Phase 3h: Missing alt attribute scan — WCAG 1.1.1 Level A, not a good-to-have suggestion
    let missingAltIssues = [];
    try {
      const { chromium: chromiumInner } = await import('playwright');
      const { detectMissingAltIssues } = await import('./src/scanning/good-to-have-scanner.js');
      let altBrowser;
      try {
        altBrowser = await chromiumInner.launch({ headless: true });
        const altCtx = await altBrowser.newContext({ ignoreHTTPSErrors: true });
        const altPage = await altCtx.newPage();
        await altPage.goto(phase3ScanUrl, { waitUntil: 'load', timeout: 30000 });
        missingAltIssues = await detectMissingAltIssues(altPage, phase3ScanUrl);
        if (missingAltIssues.length > 0) {
          console.log(chalk.dim(`  Missing alt scan: ${missingAltIssues.length} image(s) missing alt attribute`));
        }
      } finally {
        if (altBrowser) await altBrowser.close().catch(() => {});
      }
    } catch (err) {
      console.log(chalk.dim(`  Missing alt scan skipped: ${err.message}`));
    }

    report.trace = {
      scannerOutputs: buildScannerLibraryTrace({
        axeResults,
        lhResult,
        pa11yResult,
        keyboardResult,
      }),
    };
    logger.dumpScannerIssues(report.trace.scannerOutputs);

    report.before = {
      axe: axeResults.map(r => ({
        url: r.url,
        violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes?.map(n => ({ target: n.target })) })),
        passes: r.passes, inapplicable: r.inapplicable,
      })),
      lh: { score: lhResult.score, failed: lhResult.failed.map(a => ({ id: a.id, title: a.title, score: a.score })), passed: lhResult.passed.map(a => ({ id: a.id })) },
      pa11y: { ...pa11yResult },
      keyboard: keyboardResult,
      interaction: interactionResult,
      focusableAction: focusableActionResult,
      missingAlt: { issues: missingAltIssues },
    };

    // SCANNER-01: Capture Accessibility Tree snapshot for false-positive filtering
    let a11yTreeData = null;
    {
      let a11yBrowser = null;
      try {
        const { captureAccessibilitySnapshot } = await import('./src/scanning/a11y-tree-scanner.js');
        a11yBrowser = await (await import('playwright')).chromium.launch({ headless: true });
        const a11yCtx = await a11yBrowser.newContext({ ignoreHTTPSErrors: true });
        const a11yPage = await a11yCtx.newPage();
        await a11yPage.goto(phase3ScanUrl, { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000)); // let dynamic content settle
        a11yTreeData = await captureAccessibilitySnapshot(a11yPage);
        console.log(chalk.dim(`  Accessibility tree: captured ${a11yTreeData.elements?.length || 0} interactive elements`));
      } catch (err) {
        console.log(chalk.dim(`  Accessibility tree capture skipped: ${err.message}`));
      } finally {
        if (a11yBrowser) await a11yBrowser.close().catch(() => {});
      }
    }

    enterPhase('Phase 4 · analyze & map');
    const analysis   = await phase4_analyzeAndMap(axeResults, lhResult, pa11yResult, ingested.repoPath, sourceFileMap, keyboardResult, interactionResult, focusableActionResult, missingAltIssues);
    report.analysis  = analysis;
    report.baseline  = analysis.baseline;

    // ENH-04/05: Enrich unified issues with DOM context and source traces
    if (ingested.repoPath && analysis.unified?.length > 0) {
      let domBrowser = null;
      try {
        const { chromium } = await import('playwright');
        const { enrichIssuesWithDomContext } = await import('./src/scanning/dom-enricher.js');
        const { traceIssuesToSource } = await import('./src/scanning/dom-source-tracer.js');
        domBrowser = await chromium.launch({ headless: true });
        const ctx = await domBrowser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await page.goto(phase3ScanUrl, { waitUntil: 'load', timeout: 30000 });
        await enrichIssuesWithDomContext(analysis.unified, page);
        await traceIssuesToSource(analysis.unified, ingested.repoPath);
      } catch (err) {
        console.log(chalk.dim(`  DOM enrichment skipped: ${err.message}`));
      } finally {
        if (domBrowser) await domBrowser.close().catch(() => {});
      }
    }

    // SCANNER-02/03/04: Validate issues against Accessibility Tree
    if (a11yTreeData && analysis.unified?.length > 0) {
      try {
        const { validateIssuesAgainstA11yTree, detectMissedIssues, filterHiddenFromIssues, enrichIssueIdentification } = await import('./src/scanning/a11y-tree-scanner.js');
        
        // Validate existing issues against a11y tree (filter false positives).
        // Run false-positive detection first, snapshot those IDs, then run
        // hidden-element filtering — and restore 'false-positive' status so the
        // second pass cannot silently overwrite it with 'not-exposed'.
        validateIssuesAgainstA11yTree(analysis.unified, a11yTreeData);
        const falsePositiveIds = new Set(
          analysis.unified.filter(i => i.a11yTreeStatus === 'false-positive').map(i => i.id)
        );
        if (falsePositiveIds.size > 0) {
          console.log(chalk.dim(`  A11y tree validation: ${falsePositiveIds.size} false positive(s) filtered`));
        }

        // Filter hidden elements — then re-apply false-positive precedence.
        filterHiddenFromIssues(analysis.unified, a11yTreeData);
        for (const issue of analysis.unified) {
          if (falsePositiveIds.has(issue.id)) issue.a11yTreeStatus = 'false-positive';
        }
        const notExposed = analysis.unified.filter(i => i.a11yTreeStatus === 'not-exposed');
        if (notExposed.length > 0) {
          console.log(chalk.dim(`  A11y tree: ${notExposed.length} issue(s) on hidden elements filtered`));
        }
        
        // Detect missed issues
        const missedIssues = detectMissedIssues(a11yTreeData, analysis.unified);
        if (missedIssues.length > 0) {
          console.log(chalk.dim(`  A11y tree: ${missedIssues.length} additional issue(s) detected`));
          // Add missed issues to unified list with unique IDs
          const baseIndex = analysis.unified.length;
          for (let i = 0; i < missedIssues.length; i++) {
            const missed = missedIssues[i];
            missed.id = `a11y-tree-${missed.ruleId}-${(missed.selector || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 30)}-${baseIndex + i}`;
            missed.page = phase3ScanUrl;
            analysis.unified.push(missed);
          }
        }
        
        // Enrich issue identification with stable selectors
        enrichIssueIdentification(analysis.unified, a11yTreeData);
      } catch (err) {
        console.log(chalk.dim(`  A11y tree validation skipped: ${err.message}`));
      }
    }

    if (opts.fix && ingested.repoPath) {
      enterPhase('Phase 5 · remediate');
      let fixes = [];
      try {
        fixes = await phase5_copilot_fix(analysis, ingested.repoPath, sourceFileMap, report, {
          skipBatch1: opts.skipBatch1,
          skipBatch2: opts.skipBatch2,
        });
      } catch (err) {
        console.error(chalk.red(`\n  ✗ Copilot engine failed. No non-Copilot fixer fallback is allowed.\n`));
        if (String(err?.message || '').includes('node:sqlite')) {
          console.error(chalk.yellow('  The installed Copilot SDK requires a Node runtime with node:sqlite support. Upgrade Node, then rerun the scan.\n'));
        }
        if (DEBUG) console.error(err.stack);
        throw err;
      }
      report.fixes = fixes;

      enterPhase('Phase 5b · pre-rescan validation');
      await preRescanValidation({ fixes, scanUrl, ingested, report });
      const attemptedPhase5Issues = hasAttemptedPhase5Issues(report.agentTrail || []);

      if (fixes.length > 0) {
        console.log(chalk.green(`\n  ✓ ${fixes.length} file(s) were modified.`));
        console.log(chalk.dim('  Files changed:'));
        for (const f of fixes) {
          console.log(chalk.dim(`    · ${f.file} (${f.violationsAddressed} violations addressed)`));
        }
        console.log('');

        // --skip-rescan stops here
        if (opts.skipRescan) {
          console.log(chalk.bold.cyan('\n  ──────────────────────────────────────────────────────────'));
          console.log(chalk.bold.cyan('  Fixes written. Skipping rescan (--skip-rescan).'));
          console.log(chalk.bold.cyan('  Rebuild your app, then run with --rescan-only to verify.'));
          console.log(chalk.bold.cyan('  ──────────────────────────────────────────────────────────\n'));
          report.verification = buildStaticVerificationLedger(analysis, fixes, 'skip-rescan-awaiting-manual-rebuild', report.agentTrail || []);
          // Don't enter Phase 6/7 — fall through to Phase 8 report
        } else {
          enterPhase('Phase 6 · re-scan');
          try {
            if (ingested.type === 'url+local') {
              report.after = await phase6_rescan(scanUrl, true, sourceFileMap, ingested.repoPath, fixes, report.before, analysis, projectType);
            } else {
              const buildDependentFixes = fixes.filter(f => fixNeedsBuild(f.file, projectType));
              if (buildDependentFixes.length > 0) {
                const buildOk = await rebuildProject(ingested.repoPath, buildDependentFixes.map(f => f.file));
                if (!buildOk) throw new Error('Build failed before re-scan; build-dependent fixes left unverified');
              } else {
                console.log(chalk.green('  ✓ Hot-served fixes do not require rebuild before local re-scan.'));
              }
              if (devServer) { devServer.close(); devServer = null; }
              const reServed = await phase2_serve(ingested.repoPath, { skipInstallBuild: buildDependentFixes.length === 0 });
              scanUrl   = reServed.url;
              devServer = reServed.server;
              report.after = await phase6_rescan(scanUrl, false, sourceFileMap, ingested.repoPath, fixes, report.before, analysis);
            }
            report.after.scanUrl = scanUrl;
            report.verification = buildIssueVerificationLedger(analysis, report.after, fixes, report.unverifiedFixes || [], report.before);

            // Rollback fixes that introduced regressions or failed to resolve
            if (opts.rollbackPolicy !== 'none' && report.verification) {
              const introduced = report.verification.introduced || [];
              const ledgerIssues = report.verification.issues || [];
              if (opts.rollbackPolicy === 'aggressive') {
                // Revert files whose targeted issues are still persistent
                const persistentFiles = new Set(
                  ledgerIssues.filter(i => i.status === 'persistent' && i.attemptedFix && i.mappedFile).map(i => i.mappedFile)
                );
                for (const file of persistentFiles) {
                  const fix = fixes.find(f => f.file === file);
                  if (fix?.original) {
                    await fs.writeFile(path.join(ingested.repoPath, file), fix.original, 'utf-8');
                    console.log(chalk.yellow(`    ↺ Rolled back ${file} (aggressive: fix did not resolve targeted issues)`));
                  }
                }
              } else if (introduced.length > 0) {
                // Conservative: only revert files that introduced new violations
                const fixFilesByPage = new Map();
                for (const fix of fixes) {
                  for (const issueId of fix.targetedIssueIds || []) {
                    const issue = analysis.unified?.find(v => v.id === issueId);
                    if (issue?.page) fixFilesByPage.set(issue.page, [...(fixFilesByPage.get(issue.page) || []), fix.file]);
                  }
                }
                const regressedFiles = new Set();
                for (const intro of introduced) {
                  const candidates = fixFilesByPage.get(intro.page) || [];
                  for (const f of candidates) regressedFiles.add(f);
                }
                for (const file of regressedFiles) {
                  const fix = fixes.find(f => f.file === file);
                  if (fix?.original) {
                    await fs.writeFile(path.join(ingested.repoPath, file), fix.original, 'utf-8');
                    console.log(chalk.yellow(`    ↺ Rolled back ${file} (conservative: fix introduced regressions)`));
                  }
                }
              }
            }
          } catch (err) {
            console.error(chalk.yellow(`\n  ⚠ Re-scan failed (${err.message}) — live verification unavailable.\n`));
            report.after = null;
            report.verification = buildStaticVerificationLedger(analysis, fixes, 'live-rescan-failed-static-unconfirmed', report.agentTrail || []);
          }

          if (opts.judge) {
            // Always run the real judge against the agent's actual fixes + the
            // verification ledger — never a hardcoded score. Static verification is
            // only a no-server fallback and is marked unconfirmed, not resolved.
            enterPhase('Phase 7 · judge');
            try {
              report.judgment = await phase7_judge(report.before, report.after, fixes, analysis, report.verification);
            } catch (err) {
              console.error(chalk.yellow(`\n  ⚠ Judge failed (${err.message})\n`));
              report.judgment = null;
            }
          }
        }
      } else {
        if (attemptedPhase5Issues) {
          report.verification = buildStaticVerificationLedger(
            analysis,
            fixes,
            'phase5-attempted-no-surviving-fixes',
            report.agentTrail || [],
          );
          logger.remediation('Persisted verification ledger for attempted issues even though no file edits survived phase 5.');
        }
        console.log(chalk.yellow('\n  ⚠ No files were modified — skipping re-scan.\n'));
      }
    } else if (opts.fix) {
      console.log(chalk.yellow('  Note: --fix needs source on disk. Use --local, --zip, --github, or --url + --local.\n'));
    }

    // SCANNER-05/06/07: Good-to-have scans
    let goodToHaveResults = null;
    {
      let gthBrowser = null;
      try {
        const { runGoodToHaveScans, promptGoodToHaveActions } = await import('./src/scanning/good-to-have-scanner.js');
        gthBrowser = await (await import('playwright')).chromium.launch({ headless: true });
        const gthCtx = await gthBrowser.newContext({ ignoreHTTPSErrors: true });
        const gthPage = await gthCtx.newPage();
        await gthPage.goto(phase3ScanUrl, { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        goodToHaveResults = await runGoodToHaveScans(gthPage);

        if (goodToHaveResults.totalSuggestions > 0) {
          const { items } = await promptGoodToHaveActions(goodToHaveResults);
          report.goodToHave = { suggestions: items, totalSuggestions: goodToHaveResults.totalSuggestions };
        }
      } catch (err) {
        console.log(chalk.dim(`  Good-to-have scans skipped: ${err.message}`));
      } finally {
        if (gthBrowser) await gthBrowser.close().catch(() => {});
      }
    }

  } catch (err) {
    pipelineError = err;
    failurePhase = currentPhase;
    runReason = 'pipeline-failed';
    runError = serializeError(err);
    report.incomplete = true;
    report.incompleteReason = `Pipeline failed during ${failurePhase}: ${err.message}`;
    report.failure = {
      phase: failurePhase,
      reason: runReason,
      error: runError,
      timestamp: new Date().toISOString(),
    };
    console.error(chalk.red(`\n  ✗ Pipeline failed during ${failurePhase}: ${err.message}\n`));
    logger.warn(`Pipeline failed during ${failurePhase}: ${err.message}`);
    if (DEBUG && err?.stack) console.error(err.stack);

  } finally {
    enterPhase('Phase 8 · report');
    report.meta = {
      ...(report.meta || {}),
      timestamp: report.meta?.timestamp || startedAt,
      runLabel: logger.runLabel || report.meta?.runLabel || null,
      runOutputDir: logger.dir || report.meta?.runOutputDir || null,
    };

    // rescanOnlyMode already generated its own report + Excel; skip here to
    // avoid overwriting with the bare `report` object.
    if (opts.rescanOnly) {
      reportWritten = true;
      reportWriteMode = 'full';
    } else {
      try {
        if (pipelineError) {
          await writeMinimalReport(report, {
            phase: failurePhase || currentPhase,
            reason: report.incompleteReason || 'pipeline-failed',
            error: runError,
          });
          reportWritten = true;
          reportWriteMode = 'minimal';
        } else {
          await phase8_report(report, { strictConsistency: true });
          reportWritten = true;
          reportWriteMode = 'full';
        }
      } catch (err) {
        reportGenerationError = err;
        runReason = runReason || 'report-generation-failed';
        runError = runError || serializeError(err);
        report.incomplete = true;
        report.incompleteReason = `Report generation failed during ${currentPhase}: ${err.message}`;
        report.failure = {
          ...(report.failure || {}),
          phase: failurePhase || currentPhase,
          reason: runReason,
          error: runError,
          timestamp: new Date().toISOString(),
        };
        console.error(chalk.red(`\n  ⚠ Report generation failed: ${err.message}\n`));
        logger.warn(`Report generation failed during ${currentPhase}: ${err.message}`);
        try {
          await writeMinimalReport(report, {
            phase: failurePhase || currentPhase,
            reason: report.incompleteReason,
            error: runError,
          });
          reportWritten = true;
          reportWriteMode = 'minimal';
        } catch (minimalErr) {
          minimalReportError = minimalErr;
          console.error(chalk.red(`\n  ✗ Minimal report write failed: ${minimalErr.message}\n`));
          logger.warn(`Minimal report write failed: ${minimalErr.message}`);
        }
      }

      if (!pipelineError && reportWriteMode === 'full') {
        try {
          await generateExcelReport(report.fixes || [], sourceFileMap, report.analysis, scanUrl, report.verification || null, report.goodToHave ?? null);
        } catch (err) {
          console.error(chalk.red(`\n  ⚠ Excel report generation failed: ${err.message}\n`));
          logger.warn(`Excel report generation failed: ${err.message}`);
        }
      }
    }

    if (pipelineError || reportGenerationError) {
      runStatus = reportWritten ? 'partial' : 'failed';
    } else {
      runStatus = 'completed';
      runReason = null;
      runError = null;
    }
    if (minimalReportError) {
      runStatus = 'failed';
      runReason = 'minimal-report-write-failed';
      runError = serializeError(minimalReportError);
    }

    const runOutputDir = logger.dir || path.resolve(opts.output);
    const runState = {
      status: runStatus,
      reason: runReason,
      phase: failurePhase || currentPhase,
      startedAt,
      finishedAt: new Date().toISOString(),
      runLabel: logger.runLabel || null,
      runOutputDir,
      incomplete: report.incomplete === true,
      incompleteReason: report.incompleteReason || null,
      reportWritten,
      reportWriteMode,
      error: runError,
    };

    try {
      await writeRunStateArtifact(runState, runOutputDir);
    } catch (err) {
      runStateError = err;
      runStatus = reportWritten ? 'partial' : 'failed';
      console.error(chalk.red(`\n  ✗ Failed to write run-state.json: ${err.message}\n`));
      logger.warn(`Failed to write run-state.json: ${err.message}`);
    }

    if (devServer) devServer.close();
    const total = logger.finish(runStatus);
    if (total) console.log(chalk.dim(`\n  Total end-to-end time: ${total}\n`));
  }

  if (pipelineError) throw pipelineError;
  if (minimalReportError) throw minimalReportError;
  if (runStateError) throw runStateError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('\n  Fatal: ' + err.message);
    if (DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
