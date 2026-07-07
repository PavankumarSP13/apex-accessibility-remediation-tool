function oneLine(value, max = 300) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function jsonBlock(value) {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function issueSnippet(issue) {
  return issue?.nodes?.[0]?.html || issue?.element || issue?.context || '';
}

function issueTarget(issue) {
  return issue?.nodes?.[0]?.target || issue?.selector || '';
}

export function buildScannerLibraryTrace({ axeResults = [], lhResult = null, pa11yResult = null, keyboardResult = null }) {
  const axeIssues = axeResults.flatMap(page => (page.violations || []).map(violation => ({
    page: page.url,
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    description: violation.description,
    helpUrl: violation.helpUrl,
    tags: violation.tags || [],
    nodeCount: violation.nodes?.length || 0,
    nodes: (violation.nodes || []).map(node => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary,
      impact: node.impact,
      any: node.any,
      all: node.all,
      none: node.none,
    })),
  })));

  const lighthouseFailed = (lhResult?.failed || []).map(audit => ({
    page: audit.page,
    id: audit.id,
    title: audit.title,
    description: audit.description,
    score: audit.score,
    scoreDisplayMode: audit.scoreDisplayMode,
    details: audit.details,
  }));

  const pa11yIssues = (pa11yResult?.issues || []).map(issue => ({
    page: issue.page,
    code: issue.code,
    type: issue.type,
    typeCode: issue.typeCode,
    message: issue.message,
    selector: issue.selector,
    context: issue.context,
    runner: issue.runner,
  }));

  return {
    axeCore: {
      issueCount: axeIssues.length,
      pageCount: axeResults.length,
      pages: axeResults.map(page => ({
        url: page.url,
        violationCount: page.violations?.length || 0,
        passes: page.passes,
        inapplicable: page.inapplicable,
      })),
      issues: axeIssues,
    },
    lighthouse: {
      score: lhResult?.score ?? null,
      failedCount: lhResult?.failed?.length || 0,
      passedCount: lhResult?.passed?.length || 0,
      pages: lhResult?.pages || [],
      failedAudits: lighthouseFailed,
    },
    pa11y: {
      errorCount: pa11yResult?.errorCount ?? 0,
      warningCount: pa11yResult?.warningCount ?? 0,
      issueCount: pa11yIssues.length,
      scanFailed: pa11yResult?.scanFailed === true,
      partialScanFailed: pa11yResult?.partialScanFailed === true,
      unavailable: pa11yResult?.unavailable || [],
      issues: pa11yIssues,
    },
    keyboard: {
      issueCount: keyboardResult?.issues?.length ?? 0,
      scanFailed: keyboardResult?.scanFailed === true,
      failReason: keyboardResult?.failReason || null,
      issues: (keyboardResult?.issues || []).map(issue => ({
        page: issue.page,
        ruleId: issue.ruleId,
        impact: issue.impact,
        description: issue.description,
        element: issue.element,
        selector: issue.nodes?.[0]?.target || '',
      })),
    },
  };
}

export function buildRemediationTrace(report = {}) {
  const analysis = report.analysis || {};
  const mappingByIssue = new Map((analysis.mapping || []).map(m => [m.violationId, m]));
  const manualByIssue = new Map((analysis.manualReview || []).map(m => [m.violationId, m]));
  const trailByIssue = new Map((report.agentTrail || []).map(t => [t.issueId, t]));
  const verificationByIssue = new Map((report.verification?.issues || []).map(v => [v.issueId, v]));
  const fixesByIssue = new Map();
  for (const fix of (report.fixes || [])) {
    for (const issueId of (fix.targetedIssueIds || [])) fixesByIssue.set(issueId, fix);
  }

  const baselineIssues = analysis.allIssues || [
    ...(analysis.unified || []),
    ...(analysis.permanentlyManualViolations || []),
  ];
  const issues = baselineIssues.map(issue => {
    const mapping = mappingByIssue.get(issue.id) || null;
    const manual = manualByIssue.get(issue.id) || null;
    const trail = trailByIssue.get(issue.id) || null;
    const fix = fixesByIssue.get(issue.id) || null;
    const verification = verificationByIssue.get(issue.id) || null;
    return {
      issueId: issue.id,
      source: issue.source,
      ruleId: issue.ruleId || issue.id,
      impact: issue.impact,
      page: issue.page || '',
      description: issue.description || '',
      selector: issueTarget(issue),
      snippet: issueSnippet(issue),
      scannerFailureSummary: issue.nodes?.[0]?.fix || issue.fix || '',
      manualOnly: issue.manualOnly === true,
      manualReason: issue.manualReason || null,
      solvability: issue.solvability || null,
      solvabilityReason: issue.solvabilityReason || null,
      solvabilityEvidence: issue.solvabilityEvidence || null,
      rootCause: issue.rootCause || null,
      rootCauseIssueId: issue.rootCauseIssueId || null,
      owner: issue.owner || null,
      closed: issue.closed === true,
      fixerEligible: issue.fixerEligible !== false,
      challengerEligible: issue.challengerEligible !== false,
      verifierEligible: issue.verifierEligible !== false,
      judgeEligible: issue.judgeEligible !== false,
      sourceMapping: issue.sourceMapping || null,
      mapping,
      manualReview: manual,
      agentRemediation: trail,
      appliedFix: fix ? {
        file: fix.file,
        violationsAddressed: fix.violationsAddressed,
        targetedIssueIds: fix.targetedIssueIds || [],
        diffSegments: fix.diffSegments || [],
      } : null,
      verification,
    };
  });

  const firstIssue = issues[0] || null;
  const firstIssueWalkthrough = firstIssue ? buildIssueWalkthrough(firstIssue, report) : null;

  return {
    generatedAt: new Date().toISOString(),
    sourceMappingCurrentFlow: {
      summary: [
        'Phase 3 scanners return raw Axe, Lighthouse, and pa11y issue objects from the rendered page.',
        'Phase 4 merges Axe, Lighthouse, and pa11y findings into analysis.unified, deduplicates them, and separates permanently manual issues such as third-party rendered DOM.',
        'Phase 4 runs deterministic token/DOM source mapping and slide-aware/template-name bundle mapping evidence.',
        'Phase 5 runs Copilot Fixer, Challenger, and Verifier roles under host-owned allowed-file scopes, retries, and live verification.',
        'Phase 5b/Phase 6 verify the changes and Phase 7 judge reviews fixes against the verification ledger and diffs.',
      ],
      mode: 'template-name-bundle+deterministic',
    },
    scannerOutputs: report.trace?.scannerOutputs || null,
    unifiedIssueCount: analysis.unified?.length || 0,
    totalClassifiedIssueCount: issues.length,
    permanentlyManualCount: analysis.permanentlyManualViolations?.length || 0,
    issues,
    copilotRemediationAttempts: report.copilotRemediationTrace || [],
    firstIssueWalkthrough,
    verification: report.verification || null,
    judgment: report.judgment || null,
  };
}

function buildIssueWalkthrough(issue, report) {
  const judge = report.judgment || null;
  return {
    issueId: issue.issueId,
    rootCause: {
      rule: issue.rootCause || null,
      issueId: issue.rootCauseIssueId || null,
    },
    scannerFinding: {
      source: issue.source,
      ruleId: issue.ruleId,
      impact: issue.impact,
      page: issue.page,
      selector: issue.selector,
      snippet: issue.snippet,
      scannerFailureSummary: issue.scannerFailureSummary,
    },
    sourceMapping: issue.mapping ? {
      mappedFile: issue.mapping.file,
      via: issue.mapping.via,
      confidence: issue.mapping.confidence,
      reason: issue.mapping.reason,
      fileRole: issue.mapping.fileRole || null,
      slideType: issue.mapping.slideType || null,
      mappingConfidence: issue.mapping.mappingConfidence || null,
      mappingEvidence: issue.mapping.mappingEvidence || null,
      verificationRuleIds: issue.mapping.verificationRuleIds || [],
    } : {
      mappedFile: null,
      deterministicPrior: issue.sourceMapping || null,
      reason: issue.manualReview?.reason || 'not mapped',
    },
    templateBundle: report.templateBundleTrace || null,
    fixerSummary: issue.agentRemediation?.fixer || null,
    appliedFilePath: issue.appliedFix?.file || issue.mapping?.file || null,
    challengerReview: issue.agentRemediation?.challenger || null,
    verifierReview: issue.agentRemediation?.verifier || null,
    verification: issue.verification || null,
    judgeReview: judge ? {
      verdict: judge.verdict,
      score: judge.score,
      summary: judge.summary,
      humanReviewNeeded: judge.human_review_needed || [],
      unresolvedCritical: judge.unresolved_critical || [],
    } : null,
  };
}

export function renderTraceMarkdown(trace) {
  const lines = [];
  lines.push('# Accessibility Remediation Trace');
  lines.push('');
  lines.push(`Generated: ${trace.generatedAt}`);
  lines.push('');

  lines.push('## How Source Mapping Works In This Run');
  for (const step of trace.sourceMappingCurrentFlow.summary) lines.push(`- ${step}`);
  lines.push(`- Detected mapping mode: ${trace.sourceMappingCurrentFlow.mode}`);
  lines.push('');

  const scanner = trace.scannerOutputs || {};
  lines.push('## Scanner Library Outputs');
  lines.push('');
  lines.push(`### axe-core issues: ${scanner.axeCore?.issueCount ?? 0}`);
  for (const issue of (scanner.axeCore?.issues || [])) {
    lines.push(`- ${issue.id} (${issue.impact || 'unknown'}) on ${issue.page}`);
    lines.push(`  - Help: ${oneLine(issue.help)}`);
    for (const [idx, node] of (issue.nodes || []).entries()) {
      lines.push(`  - Node ${idx + 1} target: ${oneLine(Array.isArray(node.target) ? node.target.join(', ') : node.target)}`);
      lines.push(`  - Node ${idx + 1} snippet: ${oneLine(node.html, 500)}`);
      lines.push(`  - Node ${idx + 1} failure: ${oneLine(node.failureSummary, 500)}`);
    }
  }
  lines.push('');

  lines.push(`### Lighthouse failed audits: ${scanner.lighthouse?.failedCount ?? 0}`);
  for (const audit of (scanner.lighthouse?.failedAudits || [])) {
    lines.push(`- ${audit.id} (${audit.score}) on ${audit.page}`);
    lines.push(`  - Title: ${oneLine(audit.title)}`);
    const items = audit.details?.items || [];
    for (const [idx, item] of items.slice(0, 10).entries()) {
      lines.push(`  - Item ${idx + 1} selector: ${oneLine(item.node?.selector || item.selector || '')}`);
      lines.push(`  - Item ${idx + 1} snippet: ${oneLine(item.node?.snippet || item.snippet || '', 500)}`);
      lines.push(`  - Item ${idx + 1} explanation: ${oneLine(item.node?.explanation || item.explanation || '', 500)}`);
    }
  }
  lines.push('');

  lines.push(`### pa11y issues: ${scanner.pa11y?.issueCount ?? 0}`);
  for (const issue of (scanner.pa11y?.issues || [])) {
    lines.push(`- ${issue.code} (${issue.type}) on ${issue.page}`);
    lines.push(`  - Message: ${oneLine(issue.message)}`);
    lines.push(`  - Selector: ${oneLine(issue.selector)}`);
    lines.push(`  - Context: ${oneLine(issue.context, 500)}`);
  }
  lines.push('');

  lines.push(`### keyboard issues: ${scanner.keyboard?.issueCount ?? 0}`);
  if (scanner.keyboard?.scanFailed) {
    lines.push(`  (scan failed: ${scanner.keyboard.failReason || 'unknown'})`);
  }
  for (const issue of (scanner.keyboard?.issues || [])) {
    lines.push(`- ${issue.ruleId} (${issue.impact}) on ${issue.page}`);
    lines.push(`  - Description: ${oneLine(issue.description)}`);
    lines.push(`  - Element: ${oneLine(issue.element, 500)}`);
    lines.push(`  - Selector: ${oneLine(issue.selector)}`);
  }
  lines.push('');

  lines.push('## Unified Issues And Mapping');
  lines.push(`Unified actionable issues: ${trace.unifiedIssueCount}`);
  lines.push(`Total classified issues: ${trace.totalClassifiedIssueCount ?? trace.issues.length}`);
  lines.push(`Permanently/manual issues: ${trace.permanentlyManualCount}`);
  for (const issue of trace.issues) {
    lines.push(`- ${issue.issueId}`);
    lines.push(`  - Source/rule: ${issue.source} / ${issue.ruleId}`);
    lines.push(`  - Solvability: ${issue.solvability || 'n/a'}${issue.rootCause ? ` (root cause: ${issue.rootCause}${issue.rootCauseIssueId ? ` via ${issue.rootCauseIssueId}` : ''})` : ''}${issue.owner ? ` (owner: ${issue.owner})` : ''}${issue.solvabilityEvidence ? ` (${issue.solvabilityEvidence})` : ''}`);
    lines.push(`  - Eligible: fixer=${issue.fixerEligible} challenger=${issue.challengerEligible} verifier=${issue.verifierEligible} judge=${issue.judgeEligible}`);
    lines.push(`  - Target: ${oneLine(issue.selector)}`);
    lines.push(`  - Snippet: ${oneLine(issue.snippet, 500)}`);
    lines.push(`  - Slide-aware prior: ${oneLine(issue.sourceMapping?.primaryFile ? `${issue.sourceMapping.primaryFile} (${issue.sourceMapping.primaryRole}; ${issue.sourceMapping.rationale})` : 'none', 700)}`);
    lines.push(`  - Mapped file: ${issue.mapping?.file || 'not mapped'}`);
    lines.push(`  - Mapping via: ${issue.mapping?.via || issue.manualReview?.reason || 'none'}`);
    lines.push(`  - Copilot fixer: ${oneLine(issue.agentRemediation?.fixer?.changeSummary || issue.agentRemediation?.fixer?.rationale || 'not run')}`);
    lines.push(`  - Challenger: ${issue.agentRemediation?.challenger?.verdict || 'not run'} ${oneLine(issue.agentRemediation?.challenger?.reasoning || '')}`);
    lines.push(`  - Verifier: ${issue.agentRemediation?.verifier?.resolved ?? 'not run'} ${oneLine(issue.agentRemediation?.verifier?.notes || '')}`);
    lines.push(`  - Verification status: ${issue.verification?.status || 'not available'}`);
  }
  lines.push('');

  if (trace.firstIssueWalkthrough) {
    lines.push('## First Issue Walkthrough');
    lines.push(jsonBlock(trace.firstIssueWalkthrough));
  }

  lines.push('## Copilot Remediation Attempts');
  lines.push(jsonBlock(trace.copilotRemediationAttempts));

  lines.push('## Verification Ledger');
  lines.push(jsonBlock(trace.verification));

  lines.push('## Judge Review');
  lines.push(jsonBlock(trace.judgment));

  return `${lines.join('\n')}\n`;
}

export function renderIssuesText(trace) {
  const scanner = trace.scannerOutputs || {};
  const lines = [];
  lines.push('ACCESSIBILITY ISSUES BY SCANNER');
  lines.push(`Generated: ${trace.generatedAt}`);
  lines.push('');

  lines.push(`axe-core issues: ${scanner.axeCore?.issueCount ?? 0}`);
  for (const issue of (scanner.axeCore?.issues || [])) {
    lines.push(`- Rule: ${issue.id}`);
    lines.push(`  Impact: ${issue.impact || ''}`);
    lines.push(`  Page: ${issue.page || ''}`);
    lines.push(`  Help: ${oneLine(issue.help, 800)}`);
    for (const [idx, node] of (issue.nodes || []).entries()) {
      lines.push(`  Node ${idx + 1} target: ${oneLine(Array.isArray(node.target) ? node.target.join(', ') : node.target, 800)}`);
      lines.push(`  Node ${idx + 1} snippet: ${oneLine(node.html, 1200)}`);
      lines.push(`  Node ${idx + 1} failure: ${oneLine(node.failureSummary, 1200)}`);
    }
  }
  lines.push('');

  lines.push(`Lighthouse issues: ${scanner.lighthouse?.failedCount ?? 0}`);
  for (const audit of (scanner.lighthouse?.failedAudits || [])) {
    lines.push(`- Audit: ${audit.id}`);
    lines.push(`  Score: ${audit.score}`);
    lines.push(`  Page: ${audit.page || ''}`);
    lines.push(`  Title: ${oneLine(audit.title, 800)}`);
    lines.push(`  Description: ${oneLine(audit.description, 1200)}`);
    const items = audit.details?.items || [];
    for (const [idx, item] of items.slice(0, 20).entries()) {
      lines.push(`  Item ${idx + 1} selector: ${oneLine(item.node?.selector || item.selector || '', 800)}`);
      lines.push(`  Item ${idx + 1} snippet: ${oneLine(item.node?.snippet || item.snippet || '', 1200)}`);
      lines.push(`  Item ${idx + 1} explanation: ${oneLine(item.node?.explanation || item.explanation || '', 1200)}`);
    }
  }
  lines.push('');

  lines.push(`pa11y issues: ${scanner.pa11y?.issueCount ?? 0}`);
  for (const issue of (scanner.pa11y?.issues || [])) {
    lines.push(`- Code: ${issue.code}`);
    lines.push(`  Type: ${issue.type || ''}`);
    lines.push(`  Page: ${issue.page || ''}`);
    lines.push(`  Message: ${oneLine(issue.message, 1200)}`);
    lines.push(`  Selector: ${oneLine(issue.selector, 800)}`);
    lines.push(`  Context: ${oneLine(issue.context, 1200)}`);
  }
  lines.push('');

  lines.push(`keyboard issues: ${scanner.keyboard?.issueCount ?? 0}`);
  if (scanner.keyboard?.scanFailed) {
    lines.push(`  (scan failed: ${scanner.keyboard.failReason || 'unknown'})`);
  }
  for (const issue of (scanner.keyboard?.issues || [])) {
    lines.push(`- Rule: ${issue.ruleId}`);
    lines.push(`  Impact: ${issue.impact || ''}`);
    lines.push(`  Page: ${issue.page || ''}`);
    lines.push(`  Description: ${oneLine(issue.description, 1200)}`);
    lines.push(`  Element: ${oneLine(issue.element, 1200)}`);
    lines.push(`  Selector: ${oneLine(issue.selector, 800)}`);
  }
  lines.push('');

  lines.push(`Unified actionable issues after merge/dedupe: ${trace.unifiedIssueCount}`);
  lines.push(`Total classified issues after merge/dedupe: ${trace.totalClassifiedIssueCount ?? trace.issues.length}`);
  lines.push(`Permanently manual issues: ${trace.permanentlyManualCount}`);
  for (const issue of trace.issues) {
    lines.push(`- ${issue.issueId}`);
    lines.push(`  Source: ${issue.source}`);
    lines.push(`  Rule: ${issue.ruleId}`);
    lines.push(`  Solvability: ${issue.solvability || 'n/a'}${issue.rootCause ? ` (root cause: ${issue.rootCause}${issue.rootCauseIssueId ? ` via ${issue.rootCauseIssueId}` : ''})` : ''}${issue.owner ? ` (owner: ${issue.owner})` : ''}${issue.solvabilityEvidence ? ` (${issue.solvabilityEvidence})` : ''}`);
    lines.push(`  Eligible: fixer=${issue.fixerEligible} challenger=${issue.challengerEligible} verifier=${issue.verifierEligible} judge=${issue.judgeEligible}`);
    lines.push(`  Impact: ${issue.impact || ''}`);
    lines.push(`  Page: ${issue.page || ''}`);
    lines.push(`  Selector: ${oneLine(issue.selector, 800)}`);
    lines.push(`  Snippet: ${oneLine(issue.snippet, 1200)}`);
    lines.push(`  Description: ${oneLine(issue.description, 1200)}`);
    lines.push(`  Slide-aware prior: ${oneLine(issue.sourceMapping?.primaryFile ? `${issue.sourceMapping.primaryFile} (${issue.sourceMapping.primaryRole}; ${issue.sourceMapping.rationale})` : 'none', 1200)}`);
  }

  return `${lines.join('\n')}\n`;
}

export function renderAgentRemediationText(trace) {
  const lines = [];
  lines.push('AGENT REMEDIATION FIX MAP');
  lines.push(`Generated: ${trace.generatedAt}`);
  lines.push('');
  lines.push('This file records the Copilot agent output that is safe to expose: issue id, mapped/applied file path, Fixer summary, Challenger verdict, Verifier status, and final verification. It does not include hidden model thinking.');
  lines.push('');

  const agentIssues = trace.issues.filter(issue => issue.agentRemediation || issue.appliedFix || issue.mapping?.via === 'copilot-agent');
  lines.push(`Issues handled by Copilot: ${agentIssues.length}`);
  lines.push('');

  for (const issue of agentIssues) {
    lines.push(`Issue: ${issue.issueId}`);
    lines.push(`  Source/rule: ${issue.source} / ${issue.ruleId}`);
    lines.push(`  Impact: ${issue.impact || ''}`);
    lines.push(`  Page: ${issue.page || ''}`);
    lines.push(`  Selector: ${oneLine(issue.selector, 800)}`);
    lines.push(`  Scanner snippet: ${oneLine(issue.snippet, 1200)}`);
    lines.push(`  Slide-aware prior: ${oneLine(issue.sourceMapping?.primaryFile ? `${issue.sourceMapping.primaryFile} (${issue.sourceMapping.primaryRole}; ${issue.sourceMapping.rationale})` : 'none', 1200)}`);
    lines.push(`  Mapped file: ${issue.mapping?.file || 'not mapped'}`);
    lines.push(`  Applied fix file path: ${issue.appliedFix?.file || issue.mapping?.file || 'none'}`);
    lines.push(`  Mapping reason: ${oneLine(issue.mapping?.reason || '', 1200)}`);
    lines.push(`  Fixer change summary: ${oneLine(issue.agentRemediation?.fixer?.changeSummary || '', 1200)}`);
    lines.push(`  Fixer rationale: ${oneLine(issue.agentRemediation?.fixer?.rationale || '', 1200)}`);
    lines.push(`  Challenger verdict: ${issue.agentRemediation?.challenger?.verdict || 'not available'}`);
    lines.push(`  Challenger reasoning: ${oneLine(issue.agentRemediation?.challenger?.reasoning || '', 1200)}`);
    lines.push(`  Verifier resolved: ${issue.agentRemediation?.verifier?.resolved ?? 'not available'}`);
    lines.push(`  Verifier confidence: ${issue.agentRemediation?.verifier?.confidence || 'not available'}`);
    lines.push(`  Verifier notes: ${oneLine(issue.agentRemediation?.verifier?.notes || '', 1200)}`);
    lines.push(`  Final verification status: ${issue.verification?.status || 'not available'}`);
    lines.push('');
  }

  lines.push('Copilot remediation attempts');
  for (const attempt of trace.copilotRemediationAttempts || []) {
    lines.push(`- Attempt ${attempt.attempt}`);
    lines.push(`  Open issues: ${(attempt.openIssueIds || []).join(', ')}`);
    lines.push(`  Edited files: ${(attempt.editedFiles || []).join(', ')}`);
    for (const change of (attempt.fixerChanges || [])) {
      lines.push(`  Fixer: ${change.issueId} -> ${change.file || 'no file'} :: ${oneLine(change.changeSummary || change.rationale, 1200)}`);
    }
    for (const verdict of (attempt.challengerVerdicts || [])) {
      lines.push(`  Challenger: ${verdict.issueId} -> ${verdict.verdict} :: ${oneLine(verdict.reasoning, 1200)}`);
    }
    for (const result of (attempt.verifierResult?.issues || [])) {
      lines.push(`  Verifier: ${result.issueId} -> resolved=${result.resolved} confidence=${result.confidence || ''} :: ${oneLine(result.notes, 1200)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
