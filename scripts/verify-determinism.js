import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const separator = process.argv.indexOf('--');
if (separator === -1 || separator === process.argv.length - 1) {
  console.error('Usage: node scripts/verify-determinism.js -- <scan command and args>');
  process.exit(2);
}

const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);
const outputDir = getOutputDir(args);
const snapshots = [];

for (let i = 1; i <= 3; i++) {
  console.log(`\n[determinism] Run ${i}/3: ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`[determinism] Run ${i} failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
  snapshots.push(readSnapshot(outputDir, i));
}

const [first, ...rest] = snapshots;
const failures = [];
for (const snapshot of rest) {
  if (snapshot.fixableTotal !== first.fixableTotal) {
    failures.push(`fixable denominator changed: ${first.fixableTotal} -> ${snapshot.fixableTotal} on run ${snapshot.run}`);
  }
  if (Math.abs(snapshot.score - first.score) > 1) {
    failures.push(`judge score drifted beyond ±1: ${first.score} -> ${snapshot.score} on run ${snapshot.run}`);
  }
  const resolvedDiff = symmetricDiff(first.resolvedFingerprints, snapshot.resolvedFingerprints);
  if (resolvedDiff.length > 0) {
    failures.push(`resolved fingerprint set changed on run ${snapshot.run}: ${resolvedDiff.slice(0, 10).join(', ')}`);
  }
}

if (failures.length > 0) {
  console.error('\n[determinism] FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\n[determinism] PASSED: denominator, resolved set, and score are stable across 3 runs.');

function getOutputDir(args) {
  const idx = args.indexOf('--output');
  if (idx !== -1 && args[idx + 1]) return path.resolve(args[idx + 1]);
  return path.resolve('a11y-report');
}

function readSnapshot(outputDir, run) {
  const reportPath = path.join(outputDir, 'report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const summary = report.verification?.summary || {};
  const resolvedFingerprints = (report.verification?.issues || [])
    .filter(issue => issue.status === 'resolved' && issue.autoFixEligible && !issue.thirdParty && !issue.rendererGenerated)
    .map(issue => issue.fingerprint)
    .sort();

  return {
    run,
    fixableTotal: summary.baselineFixableTotal ?? 0,
    score: report.judgment?.score ?? 0,
    resolvedFingerprints,
  };
}

function symmetricDiff(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  return [
    ...a.filter(item => !right.has(item)),
    ...b.filter(item => !left.has(item)),
  ];
}
