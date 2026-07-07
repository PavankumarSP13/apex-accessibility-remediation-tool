import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import ora from 'ora';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { failedLighthouseResult, phase3b_lighthouse, phase3e_pa11y } from '../scanning/scan.js';
import { phase3c_keyboard } from '../scanning/keyboard-scan.js';
import { phase3d_interaction } from '../scanning/interaction-scan.js';
import { fixNeedsBuild } from './patch.js';
import { hardReloadWithCacheBust, installNoCacheRoute, waitForServerReady, warmUpRuntimePage } from '../scanning/browser.js';
import { opts, relaxTlsVerifyForUrl, resolveExtraUrls } from '../core/cli.js';
import { computeIntroducedIssues, buildNonFixableFingerprints } from './issue-fingerprints.js';

const execAsync = promisify(exec);

export async function rebuildProject(repoPath, fixedFiles = []) {
  const spinner = ora('Rebuilding project after fixes...').start();

  const detectRoot = async (startDir) => {
    let dir = startDir;
    for (let i = 0; i < 5; i++) {
      try {
        const entries = await fs.readdir(dir);
        if (entries.some(e => e.endsWith('.sln') || e.endsWith('.csproj') || e.endsWith('.fsproj'))) return dir;
        if (entries.includes('package.json') || entries.includes('Makefile')) return dir;
      } catch { break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return startDir;
  };

  let projectRoot = repoPath;
  if (fixedFiles.length > 0) {
    const firstFixedDir = path.dirname(path.resolve(repoPath, fixedFiles[0]));
    const closestRoot   = path.resolve(await detectRoot(firstFixedDir));
    if (closestRoot.startsWith(path.resolve(repoPath)) || path.resolve(repoPath).startsWith(closestRoot)) {
      projectRoot = closestRoot;
    } else {
      projectRoot = path.resolve(await detectRoot(repoPath));
    }
  } else {
    projectRoot = path.resolve(await detectRoot(repoPath));
  }

  const buildStrategies = [];
  try {
    const entries   = await fs.readdir(projectRoot);
    const hasCsproj = entries.some(e => e.endsWith('.csproj') || e.endsWith('.fsproj'));
    const hasSln    = entries.some(e => e.endsWith('.sln'));
    const target    = entries.find(e => e.endsWith('.csproj') || e.endsWith('.fsproj') || e.endsWith('.sln'));
    if (hasCsproj || hasSln) {
      buildStrategies.push(
        { label: '.NET build', cmd: `dotnet build "${target}" --no-restore`, cwd: projectRoot, timeout: 180_000 },
        { label: '.NET build (with restore)', cmd: `dotnet build "${target}"`, cwd: projectRoot, timeout: 240_000 },
      );
    }
  } catch { /* skip */ }

  if (buildStrategies.length === 0) {
    try {
      const entries = await fs.readdir(repoPath);
      for (const entry of entries) {
        const subDir = path.join(repoPath, entry);
        try {
          if (!(await fs.stat(subDir)).isDirectory()) continue;
          const subEntries = await fs.readdir(subDir);
          const csproj     = subEntries.find(e => e.endsWith('.csproj') || e.endsWith('.fsproj'));
          if (csproj) {
            buildStrategies.push(
              { label: `.NET build (${entry})`, cmd: `dotnet build "${path.join(subDir, csproj)}" --no-restore`, cwd: subDir, timeout: 180_000 },
              { label: `.NET build (${entry}, restore)`, cmd: `dotnet build "${path.join(subDir, csproj)}"`, cwd: subDir, timeout: 240_000 },
            );
            break;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf-8'));
    if (pkg.scripts?.build) buildStrategies.push({ label: 'npm run build', cmd: 'npm run build', cwd: projectRoot, timeout: 240_000 });
  } catch { /* no package.json */ }

  try {
    await fs.access(path.join(projectRoot, 'Makefile'));
    buildStrategies.push({ label: 'make', cmd: 'make', cwd: projectRoot, timeout: 180_000 });
  } catch { /* no Makefile */ }

  if (buildStrategies.length === 0) { spinner.warn('Could not detect build system — skipping rebuild.'); return false; }

  let lastError = null;
  for (const strategy of buildStrategies) {
    spinner.text = `${strategy.label}...`;
    try {
      await execAsync(strategy.cmd, { cwd: strategy.cwd, timeout: strategy.timeout });
      spinner.succeed(`Rebuild succeeded: ${chalk.green(strategy.label)}`);
      return true;
    } catch (err) { lastError = err; }
  }

  spinner.fail('All rebuild attempts failed.');
  if (lastError) {
    const errMsg = (lastError.stderr || lastError.stdout || lastError.message || '').split('\n').filter(l => l.trim()).slice(-10);
    if (errMsg.length > 0) console.log(chalk.dim(`\n  Last build error:\n    ${errMsg.join('\n    ')}`));
  }
  return false;
}

export async function waitForUserPrompt(url, timeoutMs = 60_000) {
  console.log(chalk.cyan('\n  Fixes have been written to your local source files.'));
  console.log(chalk.white('    · In Visual Studio: Build → Rebuild Solution, then run the app'));
  console.log(chalk.dim(`\n  Will re-scan: ${url}`));
  console.log(chalk.bold(`\n  Press ENTER when ready (auto-continuing in ${timeoutMs / 1000}s)...\n`));
  await new Promise(resolve => {
    const rl    = readline.createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => { rl.close(); console.log(chalk.dim('  Timeout — auto-continuing...\n')); resolve(); }, timeoutMs);
    rl.question('', () => { clearTimeout(timer); rl.close(); resolve(); });
    rl.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

function failedAxeResult(url, reason) {
  const failed = [{ url, violations: [], passes: 0, inapplicable: 0, scanFailed: true, failReason: reason }];
  failed.scanFailed = true;
  failed.failReason = reason;
  return failed;
}

function failedPa11yResult(reason) {
  return { issues: [], errorCount: 0, warningCount: 0, scanFailed: true, failReason: reason };
}

function skippedLighthouseResult(reason = 'Lighthouse results unavailable for this verification context.') {
  return {
    ...failedLighthouseResult(reason),
    skipped: true,
  };
}

// FIX-12: Content-aware health check after rebuild
async function verifyContentChanged(url, timeout = 10000) {
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout });
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    await browser.close();
    return bodyText.length > 10; // Not blank
  } catch { return false; }
}

async function runReloadedAxeScan(urls) {
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: urls.some(relaxTlsVerifyForUrl) });
    await installNoCacheRoute(ctx);

    for (const pageUrl of urls) {
      const page = await ctx.newPage();
      try {
        await warmUpRuntimePage(page, pageUrl);
        await hardReloadWithCacheBust(page, pageUrl, { requireSelector: 'body', failOnTimeout: true });
        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
          .analyze();
        results.push({ url: pageUrl, violations: axe.violations, passes: axe.passes.length, inapplicable: axe.inapplicable.length });
      } catch (err) {
        results.push({ url: pageUrl, violations: [], passes: 0, inapplicable: 0, scanFailed: true, failReason: err.message });
      } finally {
        await page.close().catch(() => {});
      }
    }
    if (results.length > 0 && results.every(r => r.scanFailed)) {
      results.scanFailed = true;
      results.failReason = results.map(r => `${r.url}: ${r.failReason}`).join('; ');
    }
    return results;
  } catch (err) {
    return failedAxeResult(urls[0] || '', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function phase6_rescan(url, isUrlLocalMode = false, sourceFileMap = null, repoPath = null, fixes = [], beforeData = null, analysis = null, projectType = null) {
  const needsRebuild = fixes.some(f => fixNeedsBuild(f.file, projectType));
  const urls = resolveExtraUrls(url);

  if (isUrlLocalMode && repoPath) {
    if (!needsRebuild) {
      console.log(chalk.bold.cyan('\n  ──────────────────────────────────────────────────────────'));
      console.log(chalk.bold.cyan('  Phase 6 · Hot-served assets/templates — no rebuild needed'));
      console.log(chalk.bold.cyan('  ──────────────────────────────────────────────────────────\n'));
      console.log(chalk.green('  ✓ Fixes are to hot-served files and will be verified against the live page.'));
      console.log(chalk.green('    No rebuild required; verification will warm and hard-reload the page.\n'));
      const ready = await waitForServerReady(url, 10, 1500);
      if (!ready) {
        const reason = 'Server was not ready for hot-served verification';
        console.log(chalk.yellow(`\n  ⚠ ${reason}; marking live verification as unavailable.\n`));
        return { axe: failedAxeResult(url, reason), lh: skippedLighthouseResult(), pa11y: failedPa11yResult(reason), keyboard: { issues: [], scanFailed: true, failReason: reason }, interaction: { issues: [], scanFailed: true, failReason: reason } };
      }
    } else {
      // Check if server is already live (VS debug mode) — don't build into locked DLLs
      const alreadyLive = await waitForServerReady(url, 2, 1000);
      if (alreadyLive) {
        console.log(chalk.bold.cyan('\n  ──────────────────────────────────────────────────────────'));
        console.log(chalk.bold.cyan('  Phase 6 · External server already running — manual reload required'));
        console.log(chalk.bold.cyan('  ──────────────────────────────────────────────────────────\n'));
        await waitForUserPrompt(url, 120_000);
      } else {
        console.log(chalk.bold.cyan('\n  ──────────────────────────────────────────────────────────'));
        console.log(chalk.bold.cyan('  Phase 6 · Rebuilding project with applied fixes...'));
        console.log(chalk.bold.cyan('  ──────────────────────────────────────────────────────────\n'));
        const buildSuccess = await rebuildProject(repoPath, fixes.map(f => f.file));
        if (buildSuccess) {
          console.log(chalk.green('\n  ✓ Rebuild completed. Verifying server is ready...\n'));
          // FIX-12: Attempt server restart after rebuild if restart command provided
          if (opts.restartCommand) {
            console.log(chalk.dim(`  Restarting server: ${opts.restartCommand}`));
            try {
              // Kill existing process on the port if detectable
              const portMatch = url.match(/:(\d+)/);
              if (portMatch) {
                const port = portMatch[1];
                try {
                  await execAsync(`npx kill-port ${port}`, { timeout: 5000 });
                  await new Promise(r => setTimeout(r, 1000));
                } catch { /* port kill failed — server may not be running */ }
              }
              // Start new server in background
              const { spawn } = await import('child_process');
              const parts = opts.restartCommand.split(/\s+/);
              const proc = spawn(parts[0], parts.slice(1), {
                cwd: repoPath,
                detached: true,
                stdio: 'ignore',
              });
              proc.unref();
              console.log(chalk.dim(`  Server process started (PID: ${proc.pid})`));
              // Wait for server to become ready
              await new Promise(r => setTimeout(r, 5000)); // .NET cold start delay
              const ready = await waitForServerReady(url, 15, 3000);
              if (!ready) {
                console.log(chalk.yellow('  ⚠ Server did not become ready after restart'));
              } else {
                // FIX-12: Content-aware health check after restart
                const contentOk = await verifyContentChanged(url);
                if (!contentOk) {
                  console.log(chalk.yellow('  ⚠ Server responded but page content appears blank after restart'));
                }
              }
            } catch (err) {
              console.log(chalk.yellow(`  ⚠ Server restart failed: ${err.message}`));
            }
          } else {
            await new Promise(r => setTimeout(r, 3000));
          }
          const ready = await waitForServerReady(url, 10, 3000);
          if (!ready) {
            const reason = 'Server was not ready after rebuild';
            return { axe: failedAxeResult(url, reason), lh: skippedLighthouseResult(), pa11y: failedPa11yResult(reason), keyboard: { issues: [], scanFailed: true, failReason: reason }, interaction: { issues: [], scanFailed: true, failReason: reason } };
          }
        } else {
          console.log(chalk.bold.yellow('\n  ──────────────────────────────────────────────────────────'));
          console.log(chalk.bold.yellow('  Automated rebuild failed — manual action required'));
          console.log(chalk.bold.yellow('  ──────────────────────────────────────────────────────────'));
          const reason = 'Automated rebuild failed; skipping live re-scan to avoid stale binaries';
          return {
            axe: failedAxeResult(url, reason),
            lh: skippedLighthouseResult(),
            pa11y: failedPa11yResult(reason),
            keyboard: { issues: [], scanFailed: true, failReason: reason },
            interaction: { issues: [], scanFailed: true, failReason: reason },
          };
        }
      }
    }
  } else if (isUrlLocalMode) {
    console.log(chalk.bold.yellow('\n  ──────────────────────────────────────────────────────────'));
    console.log(chalk.bold.yellow('  Phase 6 · Re-scan requires your server to serve the fixes'));
    console.log(chalk.bold.yellow('  ──────────────────────────────────────────────────────────'));
    await waitForUserPrompt(url);
  }

  console.log(chalk.blue('\n  ↺  Phase 6 · Re-scanning after fixes (reload-first live verification)...\n'));

  // Show affected source files
  if (sourceFileMap) {
    const allMapped = [
      ...sourceFileMap.htmlFiles, ...sourceFileMap.cssFiles,
      ...sourceFileMap.jsFiles,   ...sourceFileMap.otherFiles,
    ];
    if (allMapped.length > 0) {
      console.log(chalk.dim('  Source files affected by fixes:'));
      for (const f of allMapped.slice(0, 15)) {
        const ext = path.extname(f.localFile).toLowerCase();
        const tag = ext === '.css' ? chalk.magenta('[CSS]')
                  : ext === '.html' || ext === '.htm' || ext === '.cshtml' || ext === '.razor' ? chalk.yellow('[HTML]')
                  : ['.js', '.ts', '.jsx', '.tsx'].includes(ext) ? chalk.cyan('[JS]')
                  : chalk.dim('[Asset]');
        console.log(chalk.dim(`    ${tag} ${f.localFile}`));
      }
      if (allMapped.length > 15) console.log(chalk.dim(`    ... and ${allMapped.length - 15} more file(s)`));
      console.log('');
    }
  }

  const [axe, pa11yResult, keyboardResult] = await Promise.all([
    runReloadedAxeScan(urls),
    phase3e_pa11y(url).catch(err => {
      console.log(chalk.yellow(`  ⚠ pa11y re-scan failed: ${err.message}`));
      return failedPa11yResult(err.message);
    }),
    phase3c_keyboard(url).catch(err => {
      console.log(chalk.yellow(`  ⚠ Keyboard re-scan failed: ${err.message}`));
      return { issues: [], scanFailed: true, failReason: err.message };
    }),
  ]);
  const lh = await phase3b_lighthouse(url).catch(err => {
    const failReason = err?.message || String(err);
    console.log(chalk.yellow(`  ⚠ Lighthouse re-scan failed: ${failReason}`));
    return failedLighthouseResult(failReason);
  });

  // Re-run interaction scan so modal/dropdown regressions introduced by fixes are caught.
  const interactionResult = await phase3d_interaction(url).catch(err => {
    console.log(chalk.yellow(`  ⚠ Interaction re-scan failed: ${err.message}`));
    return { issues: [], triggerCount: 0, scannedCount: 0, scanFailed: true, failReason: err.message };
  });
  if (!interactionResult.scanFailed) {
    console.log(chalk.dim(`  Interaction re-scan: ${interactionResult.triggerCount || 0} trigger(s), ${interactionResult.scannedCount || 0} scanned, ${interactionResult.issues.length} issue(s)`));
  }

  if (beforeData) {
    const bAxe = beforeData.axe?.reduce((s, r) => s + r.violations.length, 0) ?? 0;
    const axeScanFailed = axe.scanFailed === true || axe.some(r => r.scanFailed === true);
    const aAxe = axeScanFailed ? null : axe.reduce((s, r) => s + r.violations.length, 0);
    const bLH  = beforeData.lh?.score ?? '—';
    const lhStatusLabel = lh?.skipped
      ? 'skipped'
      : lh?.invalid
        ? 'invalid'
        : lh?.scanFailed
          ? 'scan failed'
          : null;
    const aLH  = lhStatusLabel ? chalk.yellow(lhStatusLabel) : (lh.score ?? '—');
    const bPa  = beforeData.pa11y?.errorCount ?? 0;
    const bPaWarnings = beforeData.pa11y?.warningCount ?? 0;
    const pa11yUnavailable = pa11yResult.scanFailed === true || pa11yResult.partialScanFailed === true;
    const pa11yUnavailableLabel = pa11yResult.skipped
      ? 'skipped'
      : pa11yResult.partialScanFailed ? `partial scan failed (${pa11yResult.unavailableCount ?? pa11yResult.unavailable?.length ?? 0} page(s))` : 'scan failed (timeout)';
    const aPa  = pa11yUnavailable ? null : (pa11yResult.errorCount ?? 0);
    const aPaWarnings = pa11yUnavailable ? null : (pa11yResult.warningCount ?? 0);

    console.log(chalk.bold.cyan('\n  ── Phase 6 · Re-scan Results ──\n'));
    console.log(`  Axe violations:   ${bAxe} → ${axeScanFailed ? chalk.yellow('scan failed') : aAxe}  ${axeScanFailed ? chalk.yellow('(data unavailable — not improvement)') : aAxe < bAxe ? chalk.green(`(↓ ${bAxe - aAxe} fixed)`) : aAxe > bAxe ? chalk.red(`(↑ ${aAxe - bAxe} new)`) : chalk.dim('(no change)')}`);
    console.log(`  Lighthouse:       ${bLH} → ${aLH}  ${chalk.dim('(not used for fix verification)')}`);
    console.log(`  pa11y errors:     ${bPa} → ${pa11yUnavailable ? chalk.yellow(pa11yUnavailableLabel) : aPa}  ${pa11yUnavailable ? chalk.yellow('(data incomplete — not verified improvement)') : aPa < bPa ? chalk.green(`(↓ ${bPa - aPa} fixed)`) : aPa > bPa ? chalk.red(`(↑ ${aPa - bPa} new)`) : chalk.dim('(no change)')}`);
    console.log(`  pa11y warnings:   ${bPaWarnings} → ${pa11yUnavailable ? chalk.yellow(pa11yUnavailableLabel) : aPaWarnings}  ${pa11yResult.skipped ? chalk.dim('(skipped — no pa11y-origin fixable issues)') : pa11yUnavailable ? chalk.yellow('(data incomplete — not verified improvement)') : aPaWarnings < bPaWarnings ? chalk.green(`(↓ ${bPaWarnings - aPaWarnings} fixed)`) : aPaWarnings > bPaWarnings ? chalk.red(`(↑ ${aPaWarnings - bPaWarnings} new)`) : chalk.dim('(no change)')}`);

    const knownNonFixable = analysis ? buildNonFixableFingerprints(analysis) : null;
    const introduced = axeScanFailed ? [] : computeIntroducedIssues(beforeData, { axe, lh, pa11y: pa11yResult, keyboard: keyboardResult }, knownNonFixable);
    const introducedRuleIds = [...new Set(introduced.map(issue => issue.ruleId).filter(Boolean))];
    if (introduced.length > 0) {
      console.log(chalk.red(`\n  ⚠ ${introduced.length} new violation instance(s) introduced:`));
      for (const id of introducedRuleIds.slice(0, 5)) console.log(chalk.red(`    · ${id}`));
      if (introduced._excludedNonFixable > 0) {
        console.log(chalk.dim(`  (${introduced._excludedNonFixable} known non-fixable issue(s) excluded from count: ${introduced._excludedNonFixableRuleIds?.join(', ')})`));
      }
    } else if (!axeScanFailed) {
      const excludedNote = introduced._excludedNonFixable > 0
        ? ` (${introduced._excludedNonFixable} known non-fixable excluded)`
        : '';
      console.log(chalk.green(`\n  ✓ No new violation instances introduced${excludedNote}`));
    }
    console.log('');
  }

  return { axe, lh, pa11y: pa11yResult, keyboard: keyboardResult, interaction: interactionResult };
}
