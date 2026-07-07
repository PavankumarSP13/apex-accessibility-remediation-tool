import { program } from 'commander';

program
  .name('a11y-agent')
  .description('AI-powered accessibility analysis and auto-fix agent')
  .option('--url <url>',           'Live URL to scan (skips phases 1-2)')
  .option('--zip <path>',          'Path to a ZIP file of the repo')
  .option('--github <url>',        'GitHub repository URL to clone')
  .option('--local <path>',        'Local directory path')
  .option('--pages <paths>',       'Extra page paths to scan, comma-separated')
  .option('--fix',                 'Auto-fix violations using the remediation engine', false)
  .option('--skip-batch1',         'Skip batch 1 template-bundle remediation and start from deterministic fallback', false)
  .option('--skip-batch2',         'Skip batch 2 deterministic fallback remediation and run template-bundle batch only', false)
  .option('--engine <engine>',     'Fixing engine only: copilot', 'copilot')
  .option('--judge',               'Run a second Copilot pass to judge fix quality',  false)
  .option('--output <dir>',        'Output directory for report',                './a11y-report')
  .option('--rollback-policy <policy>', 'Rollback fixes after rescan: conservative|aggressive|none', 'conservative')
  .option('--ignore-https-errors', 'Allow invalid TLS on any host',              false)
  .option('--nav-wait <strategy>', 'Playwright waitUntil: load|domcontentloaded|networkidle', 'load')
  .option('--restart-command <cmd>', 'Command to restart the server after rebuild (e.g., "dotnet run")')
  .option('--skip-rescan', 'Stop after fix — skip Phase 6 rescan and Phase 7 judge (use with --rescan-only later)', false)
  .option('--rescan-only <run-dir>', 'Resume a previous --skip-rescan run: load its report.json, rescan, and judge')
  .parse();

export const opts       = program.opts();
if (opts.skipBatch1 && opts.skipBatch2) {
  program.error('Cannot use --skip-batch1 and --skip-batch2 together. Choose one remediation batch to skip.');
}
export const extraPaths = opts.pages ? opts.pages.split(',').map(p => p.trim()) : [];

export const ENGINE = (() => {
  const e = String(opts.engine ?? 'copilot').toLowerCase();
  if (e !== 'copilot') {
    program.error(`Unsupported --engine "${opts.engine}". The fixer engine is Copilot-only; deterministic mapping is used only as a Copilot fallback scope.`);
  }
  return 'copilot';
})();

export function resolveExtraUrls(baseUrl) {
  if (extraPaths.length === 0) return [baseUrl];
  const base = new URL(baseUrl);
  return [
    baseUrl,
    ...extraPaths.map(p => {
      if (p.startsWith('http://') || p.startsWith('https://')) return p;
      if (p.startsWith('/')) return `${base.origin}${p}`;
      const dir = base.pathname.replace(/\/[^/]*$/, '/');
      return `${base.origin}${dir}${p}`;
    }),
  ];
}

export const NAV_WAIT_UNTIL = (() => {
  const w = String(opts.navWait ?? 'load').toLowerCase();
  return ['load', 'domcontentloaded', 'networkidle'].includes(w) ? w : 'load';
})();

export function relaxTlsVerifyForUrl(urlString) {
  if (opts.ignoreHttpsErrors) return true;
  try {
    const h  = new URL(urlString).hostname.toLowerCase();
    const v6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
    return h === 'localhost' || h === '127.0.0.1' || v6 === '::1';
  } catch { return false; }
}
