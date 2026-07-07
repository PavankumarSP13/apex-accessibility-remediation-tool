import fs from 'fs';
import path from 'path';
import util from 'util';
import { setMaxListeners } from 'node:events';

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
function stripAnsi(value) {
  return String(value).replace(ANSI_RE, '');
}

/**
 * Single live run logger. Writes three plain-text files in a per-run report
 * directory under <output>/run_reports/YYYYMMDD-runN, each truncated (replaced)
 * at the start of that run and flushed continuously as events happen — never
 * buffered until the end:
 *
 *   - live.txt            everything, in order, with elapsed timestamps + heartbeat
 *   - scanner-issues.txt  every issue every scanner reported
 *   - remediation.txt     every agent remediation step (fix/patch/path/verdict)
 *
 * It also tees console.log/info/warn/error and process warnings into live.txt
 * so nothing printed to the terminal is lost, and records total end-to-end time.
 */
class RunLogger {
  constructor() {
    this.enabled = false;
    this.start = 0;
    this.baseDir = null;
    this.runReportsDir = null;
    this.dir = null;
    this.runLabel = null;
    this.phaseLabel = 'startup';
    this.liveStream = null;
    this.scanStream = null;
    this.remStream = null;
    this.heartbeat = null;
    this._console = null;
    this._warnHandler = null;
  }

  init(outDir, { heartbeatMs = 5000 } = {}) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      this.baseDir = outDir;
      const runInfo = createRunOutputDir(outDir);
      this.runReportsDir = runInfo.runReportsDir;
      this.dir = runInfo.runDir;
      this.runLabel = runInfo.runLabel;
      this.start = Date.now();
      const flags = { flags: 'w' };
      this.liveStream = fs.createWriteStream(path.join(this.dir, 'live.txt'), flags);
      this.scanStream = fs.createWriteStream(path.join(this.dir, 'scanner-issues.txt'), flags);
      this.remStream = fs.createWriteStream(path.join(this.dir, 'remediation.txt'), flags);
      this.enabled = true;

      const startedAt = new Date().toISOString();
      this.liveStream.write(`=== Accessibility Agent · live run log ===\nStarted: ${startedAt}\nOutput: ${this.dir}\nRun: ${this.runLabel}\n\n`);
      this.scanStream.write(`=== Scanner issues (live) ===\nStarted: ${startedAt}\n\n`);
      this.remStream.write(`=== Remediation (live) ===\nStarted: ${startedAt}\n\n`);

      // Repeated agent sessions attach abort listeners to shared AbortSignals;
      // raise the cap so Node stops printing MaxListenersExceededWarning.
      try { setMaxListeners(100); } catch { /* ignore */ }

      this._teeConsole();
      this._captureWarnings();

      if (heartbeatMs > 0) {
        this.heartbeat = setInterval(() => {
          this._line(this.liveStream, `... still working — ${this.phaseLabel}`);
        }, heartbeatMs);
        this.heartbeat.unref?.();
      }
    } catch {
      this.enabled = false;
    }
  }

  _elapsed() {
    const totalSec = Math.floor((Date.now() - this.start) / 1000);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
  }

  _line(stream, msg) {
    if (!this.enabled || !stream) return;
    try { stream.write(`[+${this._elapsed()}] ${stripAnsi(msg)}\n`); } catch { /* ignore */ }
  }

  _block(stream, text) {
    if (!this.enabled || !stream) return;
    try { stream.write(`${stripAnsi(text)}\n`); } catch { /* ignore */ }
  }

  /** General event — goes to the master live log only. */
  log(msg) {
    this._line(this.liveStream, msg);
  }

  /** Phase boundary; updates the heartbeat label. */
  phase(label) {
    this.phaseLabel = label;
    this._line(this.liveStream, `\n══════ ${label} ══════`);
  }

  /** A remediation step — mirrored into both the remediation log and live log. */
  remediation(msg) {
    this._line(this.remStream, msg);
    this._line(this.liveStream, `[remediation] ${msg}`);
  }

  /** Agent streamed text / thinking. */
  agent(role, kind, text) {
    const clean = stripAnsi(String(text || '')).trim();
    if (!clean) return;
    const header = `── copilot:${role} · ${kind} ──`;
    this._line(this.remStream, header);
    this._block(this.remStream, clean);
    this._line(this.liveStream, header);
    this._block(this.liveStream, clean);
  }

  /** Agent tool invocation (read/grep/edit/write/...). */
  tool(role, name, detail) {
    const suffix = detail ? ` ${detail}` : '';
    this._line(this.remStream, `copilot:${role} · tool ${name}${suffix}`);
    this._line(this.liveStream, `[copilot:${role}] tool ${name}${suffix}`);
  }

  warn(msg) {
    this._line(this.liveStream, `⚠ ${msg}`);
  }

  /** Dump the complete set of scanner findings to scanner-issues.txt. */
  dumpScannerIssues(scannerOutputs) {
    if (!this.enabled || !scannerOutputs) return;
    const out = [];
    const trunc = (v, n = 600) => {
      const t = String(v ?? '').replace(/\s+/g, ' ').trim();
      return t.length > n ? `${t.slice(0, n)}...` : t;
    };

    const axe = scannerOutputs.axeCore || {};
    out.push(`axe-core issues: ${axe.issueCount ?? 0} (pages: ${axe.pageCount ?? 0})`);
    for (const issue of axe.issues || []) {
      out.push(`- ${issue.id} (${issue.impact || 'unknown'}) on ${issue.page}`);
      out.push(`    help: ${trunc(issue.help)}`);
      for (const [i, node] of (issue.nodes || []).entries()) {
        const target = Array.isArray(node.target) ? node.target.join(', ') : node.target;
        out.push(`    node ${i + 1} target: ${trunc(target, 300)}`);
        out.push(`    node ${i + 1} html: ${trunc(node.html)}`);
        out.push(`    node ${i + 1} failure: ${trunc(node.failureSummary)}`);
      }
    }
    out.push('');

    const lh = scannerOutputs.lighthouse || {};
    out.push(`Lighthouse failed audits: ${lh.failedCount ?? 0} (score: ${lh.score ?? 'n/a'})`);
    for (const audit of lh.failedAudits || []) {
      out.push(`- ${audit.id} (score ${audit.score}) on ${audit.page}`);
      out.push(`    title: ${trunc(audit.title)}`);
    }
    out.push('');

    const pa11y = scannerOutputs.pa11y || {};
    out.push(`pa11y issues: ${pa11y.issueCount ?? 0} (errors: ${pa11y.errorCount ?? 0}, warnings: ${pa11y.warningCount ?? 0})`);
    for (const issue of pa11y.issues || []) {
      out.push(`- ${issue.code} (${issue.type}) on ${issue.page}`);
      out.push(`    message: ${trunc(issue.message)}`);
      out.push(`    selector: ${trunc(issue.selector, 300)}`);
    }
    out.push('');

    this._block(this.scanStream, out.join('\n'));
    const total = (axe.issueCount ?? 0) + (lh.failedCount ?? 0) + (pa11y.issueCount ?? 0);
    this._line(this.liveStream, `scanner issues written → scanner-issues.txt (axe ${axe.issueCount ?? 0}, lh ${lh.failedCount ?? 0}, pa11y ${pa11y.issueCount ?? 0}; total ${total})`);
  }

  finish(status = 'completed') {
    if (!this.enabled) return;
    const elapsed = this._elapsed();
    const footer = `\n=== Run ${status} ===\nTotal end-to-end time: ${elapsed} (${((Date.now() - this.start) / 1000).toFixed(1)}s)\nFinished: ${new Date().toISOString()}\n`;
    for (const stream of [this.liveStream, this.scanStream, this.remStream]) {
      try { stream?.write(footer); } catch { /* ignore */ }
    }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this._restoreConsole();
    if (this._warnHandler) { process.off('warning', this._warnHandler); this._warnHandler = null; }
    for (const stream of [this.liveStream, this.scanStream, this.remStream]) {
      try { stream?.end(); } catch { /* ignore */ }
    }
    this.enabled = false;
    return elapsed;
  }

  _teeConsole() {
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    this._console = original;
    const tee = (method) => (...args) => {
      original[method](...args);
      this._line(this.liveStream, util.format(...args));
    };
    console.log = tee('log');
    console.info = tee('info');
    console.warn = tee('warn');
    console.error = tee('error');
  }

  _restoreConsole() {
    if (!this._console) return;
    console.log = this._console.log;
    console.info = this._console.info;
    console.warn = this._console.warn;
    console.error = this._console.error;
    this._console = null;
  }

  _captureWarnings() {
    this._warnHandler = (warning) => {
      this._line(this.liveStream, `process-warning: ${warning.name}: ${warning.message}`);
    };
    process.on('warning', this._warnHandler);
  }
}

function formatRunDate(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function createRunOutputDir(baseDir) {
  const runReportsDir = path.join(baseDir, 'run_reports');
  fs.mkdirSync(runReportsDir, { recursive: true });
  const dateStamp = formatRunDate();
  let nextRun = 1;
  try {
    for (const entry of fs.readdirSync(runReportsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(new RegExp(`^${dateStamp}-run(\\d+)$`));
      if (match) nextRun = Math.max(nextRun, Number(match[1]) + 1);
    }
  } catch { /* ignore and start at run1 */ }

  while (true) {
    const runLabel = `${dateStamp}-run${nextRun}`;
    const runDir = path.join(runReportsDir, runLabel);
    try {
      fs.mkdirSync(runDir, { recursive: false });
      return { runReportsDir, runDir, runLabel };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      nextRun += 1;
    }
  }
}

export const logger = new RunLogger();
