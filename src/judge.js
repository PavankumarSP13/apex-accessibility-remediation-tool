import chalk from 'chalk';
import ora from 'ora';
import { JUDGE_MODEL } from './core/config.js';
import { copilotComplete } from './integrations/copilot.js';
import { renderPrompt } from './core/prompts.js';

export async function phase7_judge(before, after, fixes, analysis, verification = null) {
  const spinner = ora('Phase 7 · LLM Judge evaluating...').start();

  // `after` is null only when live verification was unavailable. Static fallback
  // ledger statuses are intentionally unconfirmed and must not count as resolved.
  const hasLiveAfter = Boolean(after);
  const axeScanFailed = hasLiveAfter && (after.axe?.scanFailed === true || after.axe?.some?.(page => page.scanFailed === true));
  const beforeCount = before.axe.reduce((s, r) => s + r.violations.length, 0);
  const afterCount  = !hasLiveAfter ? 'N/A (no live rescan — static verification)'
    : axeScanFailed ? 'N/A (scan failed)'
    : after.axe.reduce((s, r) => s + r.violations.length, 0);
  const beforeLH    = before.lh?.score ?? 'N/A';
  const lighthouseUnavailable = !hasLiveAfter || after.lh?.scanFailed === true || after.lh?.invalid === true;
  const afterLH     = !hasLiveAfter ? 'N/A (no live rescan)'
    : lighthouseUnavailable ? `N/A (${after.lh?.scanFailed ? 'scan failed' : 'rescan invalid'})`
    : (after.lh?.score ?? 'N/A');
  const beforePa    = before.pa11y?.errorCount ?? 0;
  const pa11yScanFailed = hasLiveAfter && after.pa11y?.scanFailed === true;
  const pa11yPartialScanFailed = hasLiveAfter && after.pa11y?.partialScanFailed === true;
  const afterPa     = !hasLiveAfter ? 'N/A (no live rescan)'
    : pa11yScanFailed ? 'N/A (scan failed)'
    : pa11yPartialScanFailed ? `N/A (partial scan failed; ${after.pa11y?.unavailableCount ?? after.pa11y?.unavailable?.length ?? 0} page(s) unavailable)`
    : (after.pa11y?.errorCount ?? 0);

  const severityBreakdown = (axeResults) => {
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const page of axeResults) for (const v of page.violations) if (counts[v.impact] !== undefined) counts[v.impact]++;
    return counts;
  };
  const beforeSev = severityBreakdown(before.axe);
  const afterSev  = (!hasLiveAfter || axeScanFailed) ? beforeSev : severityBreakdown(after.axe);

  const beforeIds       = new Set(before.axe.flatMap(p => p.violations.map(v => v.id)));
  const afterIds        = (!hasLiveAfter || axeScanFailed) ? beforeIds : new Set(after.axe.flatMap(p => p.violations.map(v => v.id)));
  const newlyIntroduced = [...afterIds].filter(id => !beforeIds.has(id));

  // ── Resolution facts: prefer the verification ledger (accurate for both live
  // rescans and static/Razor verification); fall back to raw Axe before/after. ──
  const verificationSummary = verification?.summary || null;
  const ledgerIssues = verification?.issues || [];
  const ledgerIntroduced = verification?.introduced || [];
  const RESOLVED_STATUSES = new Set(['resolved', 'verified-axe', 'verified-pa11y']);

  let resolvedCount;
  let totalViolationEntries;
  let unresolvedEntries;
  let resolvedFixableCount;
  let fixableTotal;
  if (ledgerIssues.length > 0) {
    const resolvedLedger = ledgerIssues.filter(i => RESOLVED_STATUSES.has(i.status));
    const unresolvedLedger = ledgerIssues.filter(i => !RESOLVED_STATUSES.has(i.status));
    resolvedCount = verificationSummary?.resolvedTotal ?? resolvedLedger.length;
    totalViolationEntries = verificationSummary?.baselineTotal ?? ledgerIssues.length;
    const fixableLedger = ledgerIssues.filter(i => i.autoFixEligible && i.judgeEligible !== false && !i.thirdParty && !i.rendererGenerated && !['scan-failed', 'verified-static-unconfirmed', 'not-rescanned'].includes(i.status));
    resolvedFixableCount = verificationSummary?.resolvedFixableTotal
      ?? fixableLedger.filter(i => RESOLVED_STATUSES.has(i.status)).length;
    fixableTotal = verificationSummary?.baselineFixableTotal ?? fixableLedger.length;
    unresolvedEntries = unresolvedLedger.map(i => ({
      ruleId: i.ruleId, impact: i.impact, target: i.target, html: i.element, status: i.status,
      thirdParty: i.thirdParty, rendererGenerated: i.rendererGenerated,
      solvability: i.solvability, rootCause: i.rootCause, owner: i.owner,
    }));
  } else {
    // Live Axe diff fallback (no ledger available).
    const beforeViolationMap = {};
    for (const page of before.axe) {
      for (const v of page.violations) {
        for (const node of (v.nodes || [{ html: '', target: [] }])) {
          const key = `${v.id}|${(node.target || []).join(',')}`;
          if (!beforeViolationMap[key]) {
            beforeViolationMap[key] = { ruleId: v.id, impact: v.impact, help: v.help, html: node.html?.slice(0, 200) || '', target: (node.target || []).join(', '), page: page.url, resolved: hasLiveAfter && !axeScanFailed };
          }
        }
      }
    }
    for (const page of (hasLiveAfter && !axeScanFailed) ? after.axe : []) {
      for (const v of page.violations) {
        for (const node of (v.nodes || [{ html: '', target: [] }])) {
          const key = `${v.id}|${(node.target || []).join(',')}`;
          if (beforeViolationMap[key]) beforeViolationMap[key].resolved = false;
        }
      }
    }
    const violationEntries = Object.values(beforeViolationMap);
    resolvedCount = violationEntries.filter(v => v.resolved).length;
    totalViolationEntries = violationEntries.length;
    resolvedFixableCount = resolvedCount;
    fixableTotal = totalViolationEntries;
    unresolvedEntries = violationEntries.filter(v => !v.resolved);
  }

  const resolvedEntries = ledgerIssues.length > 0
    ? ledgerIssues.filter(i => RESOLVED_STATUSES.has(i.status)).map(i => ({ ruleId: i.ruleId, impact: i.impact, target: i.target, verifiedBy: i.verifiedBy || i.source }))
    : [];

  // Calculate fixable-only resolution rate. This excludes manual-only/third-party
  // renderer issues from the denominator used by the judge score.
  const permanentlyManualCount = analysis?.permanentlyManualViolations?.length ?? 0;
  const nonFixableTotal = Math.max(0, totalViolationEntries - fixableTotal) + permanentlyManualCount;

  // Compact diffs — show more files but less per file
  const diffSamples = fixes.slice(0, 8).map(f => {
    if (f.diffSegments?.length > 0) {
      return `── ${f.file} (${f.violationsAddressed} issues) ──\n${f.diffSegments.slice(0,4).map(seg => `  [Line ${seg.lineNum}]\n  BEFORE:\n${seg.beforeLines.slice(0,400)}\n  AFTER:\n${seg.afterLines.slice(0,400)}`).join('\n\n')}`;
    }
    return `── ${f.file} (${f.violationsAddressed} issues) ──\nBEFORE:\n${f.original.slice(0,600)}\nAFTER:\n${f.fixed.slice(0,600)}`;
  }).join('\n\n');

  const msg = await copilotComplete({
    model: JUDGE_MODEL,
    system: renderPrompt('judge_system.md'),
    prompt: renderPrompt('judge_review.md', {
        lighthouse_invalid_note: lighthouseUnavailable ? '\nNOTE: Lighthouse data is UNAVAILABLE or intentionally skipped during fix verification. Do NOT give credit for Lighthouse improvement.\n' : '',
        axe_scan_failed_note: axeScanFailed ? '\nNOTE: Axe rescan FAILED (timeout/connection error) - Axe data is UNAVAILABLE, not improved. Do NOT mark Axe violations resolved or give credit for Axe improvement.\n' : '',
        pa11y_scan_failed_note: pa11yScanFailed ? '\nNOTE: pa11y rescan FAILED (timeout/connection error) - pa11y data is UNAVAILABLE, not improved. Do NOT give credit for pa11y improvement.\n' : pa11yPartialScanFailed ? '\nNOTE: pa11y rescan PARTIALLY FAILED - pa11y after counts are INCOMPLETE. Do NOT present lower pa11y counts as verified improvement, and treat baseline pa11y issues on unavailable pages as unverified/scan-failed.\n' : '',
        before_axe_count: beforeCount,
        after_axe_count: afterCount,
        before_critical_count: beforeSev.critical,
        after_critical_count: afterSev.critical,
        before_serious_count: beforeSev.serious,
        after_serious_count: afterSev.serious,
        before_lighthouse_score: beforeLH,
        after_lighthouse_score: afterLH,
        before_pa11y_errors: beforePa,
        after_pa11y_errors: afterPa,
        resolved_count: resolvedFixableCount,
        total_violation_entries: totalViolationEntries,
        total_baseline_entries: totalViolationEntries,
        resolved_total_count: resolvedCount,
        fixable_resolved_count: resolvedFixableCount,
        fixable_total: fixableTotal,
        non_fixable_total: nonFixableTotal,
        verification_summary_json: verificationSummary ? JSON.stringify(verificationSummary) : 'N/A',
        unresolved_count: unresolvedEntries.length,
        unresolved_violations_json: (() => {
          const fixable = unresolvedEntries.filter(v => !v.thirdParty && !v.rendererGenerated && v.solvability !== 'THIRD_PARTY_ASSET' && v.solvability !== 'PLUGIN_GENERATED_DOM' && v.solvability !== 'MANUAL_VERIFICATION' && v.solvability !== 'UNSUPPORTED_TRANSFORM');
          const nonFixable = unresolvedEntries.filter(v => v.thirdParty || v.rendererGenerated || v.solvability === 'THIRD_PARTY_ASSET' || v.solvability === 'PLUGIN_GENERATED_DOM' || v.solvability === 'MANUAL_VERIFICATION' || v.solvability === 'UNSUPPORTED_TRANSFORM');
          return JSON.stringify({ fixable: fixable.slice(0, 35).map(v => ({ ruleId: v.ruleId, impact: v.impact, target: v.target, html: (v.html || '').slice(0, 100) })), non_fixable_summary: { count: nonFixable.length, breakdown: Object.entries(nonFixable.reduce((acc, v) => { const key = v.solvability || (v.thirdParty ? 'THIRD_PARTY_ASSET' : 'PLUGIN_GENERATED_DOM'); acc[key] = (acc[key] || 0) + 1; return acc; }, {})) } }, null, 2);
        })(),
        newly_introduced_count: ledgerIntroduced.length || newlyIntroduced.length,
        newly_introduced_rule_types: ledgerIntroduced.length
          ? [...new Set(ledgerIntroduced.map(i => i.ruleId || i.source).filter(Boolean))].slice(0, 10).join(', ')
          : newlyIntroduced.slice(0,10).join(', ') || 'none',
        newly_introduced_violations_json: JSON.stringify(ledgerIntroduced.slice(0, 20).map(v => ({ ruleId: v.ruleId, impact: v.impact, target: v.target, html: (v.element || '').slice(0, 100) })), null, 2),
        files_changed_summary: fixes.map(f => `${f.file} (${f.violationsAddressed} violations)`).join(', '),
        diff_samples: diffSamples,
        resolved_violations_json: JSON.stringify(resolvedEntries.slice(0, 40), null, 2),
        verification_ledger_sample_json: JSON.stringify(ledgerIssues.slice(0, 30), null, 2),
      }),
    maxTokens: 3000,
  });

  let judgment = {};
  try { judgment = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?|```$/g, '')); }
  catch { judgment = { verdict: 'needs-review', score: null, summary: msg.content[0].text }; }

  const parseFiniteNumberOrNull = (value) => {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const introducedFromSummary = parseFiniteNumberOrNull(verificationSummary?.introducedTotal);
  const introducedFromLedger = Array.isArray(verification?.introduced)
    ? verification.introduced.length
    : null;
  const deterministicIntroducedCount = introducedFromSummary ?? introducedFromLedger ?? newlyIntroduced.length;
  const unresolvedFixableCriticalCount = ledgerIssues.length > 0
    ? ledgerIssues.filter(i =>
      i.autoFixEligible
        && i.judgeEligible !== false
        && !i.thirdParty
        && !i.rendererGenerated
        && i.impact === 'critical'
        && !RESOLVED_STATUSES.has(i.status)
    ).length
    : unresolvedEntries.filter(i => i.impact === 'critical').length;

  let deterministicCap = null;
  let deterministicReason = '';
  if (unresolvedFixableCriticalCount > 0) {
    deterministicCap = 3;
    deterministicReason = `unresolved fixable critical issues remain (${unresolvedFixableCriticalCount})`;
  } else if (deterministicIntroducedCount > 0) {
    deterministicCap = 5;
    deterministicReason = `regressions introduced (${deterministicIntroducedCount})`;
  }

  if (deterministicCap != null) {
    const numericScore = parseFiniteNumberOrNull(judgment.score);
    if (numericScore != null) judgment.score = Math.min(numericScore, deterministicCap);
    if (judgment.verdict !== 'rejected') judgment.verdict = 'needs-review';
    const guardNote = numericScore != null
      ? `Deterministic guard applied: ${deterministicReason}; score capped at ${deterministicCap}/10.`
      : `Deterministic guard applied: ${deterministicReason}; verdict constrained (${deterministicCap}/10 cap policy, score unavailable).`;
    judgment.summary = judgment.summary ? `${judgment.summary} ${guardNote}` : guardNote;
  }

  const color = judgment.verdict === 'approved' ? chalk.green : judgment.verdict === 'rejected' ? chalk.red : chalk.yellow;
  spinner.succeed(`Judge: ${color(String(judgment.verdict).toUpperCase())}${judgment.score != null ? ` · Score ${judgment.score}/10` : ''}`);
  if (judgment.unresolved_critical?.length) { console.log(chalk.red('\n  Unresolved:')); judgment.unresolved_critical.forEach(i => console.log(chalk.red(`    · ${i}`))); }
  if (judgment.human_review_needed?.length) { console.log(chalk.dim('\n  Needs human review:')); judgment.human_review_needed.forEach(i => console.log(chalk.dim(`    · ${i}`))); }
  if (judgment.summary) console.log(chalk.dim(`\n  ${judgment.summary}\n`));
  return judgment;
}
