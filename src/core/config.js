import 'dotenv/config';

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
export const MODEL       = process.env.OPENAI_MODEL    || 'gpt-4o';
export const JUDGE_MODEL = process.env.JUDGE_MODEL     || 'claude-sonnet-4.6';

export function parseEnvNumber(name, fallback, { min = null, max = null } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (min != null && value < min) return fallback;
  if (max != null && value > max) return fallback;
  return value;
}

// ─── GitHub Copilot SDK remediation engine ───────────────────────────────────
export const COPILOT_MODEL = process.env.COPILOT_MODEL || 'claude-opus-4.6';
export const COPILOT_REASONING_EFFORT = process.env.COPILOT_REASONING_EFFORT || 'medium';
export const COPILOT_MAX_FIX_ATTEMPTS_TEMPLATE = parseEnvNumber('COPILOT_MAX_FIX_ATTEMPTS_TEMPLATE', 2, { min: 1, max: 10 });
export const COPILOT_MAX_FIX_ATTEMPTS_FALLBACK = parseEnvNumber('COPILOT_MAX_FIX_ATTEMPTS_FALLBACK', 2, { min: 1, max: 10 });
export const COPILOT_MAX_TEMPLATE_FILES = parseEnvNumber('COPILOT_MAX_TEMPLATE_FILES', 0, { min: 0 });
export const COPILOT_MAX_CANDIDATE_FILES = parseEnvNumber('COPILOT_MAX_CANDIDATE_FILES', 0, { min: 0 });
export const COPILOT_MAX_SNAPSHOT_FILE_BYTES = parseEnvNumber('COPILOT_MAX_SNAPSHOT_FILE_BYTES', 0, { min: 0 });
export const COPILOT_IDLE_TIMEOUT_MS = parseEnvNumber('COPILOT_IDLE_TIMEOUT_MS', 900000, { min: 10000, max: 3600000 });

// ─── Live logging ────────────────────────────────────────────────────────────
// How often the live log writes a "still working" heartbeat line (ms). 0 disables.
export const LOG_HEARTBEAT_MS = parseEnvNumber('LOG_HEARTBEAT_MS', 5000, { min: 0, max: 60000 });

export const OPENAI_TEMPERATURE = parseEnvNumber('OPENAI_TEMPERATURE', 0, { min: 0, max: 2 });
export const OPENAI_TOP_P = parseEnvNumber('OPENAI_TOP_P', 1, { min: 0, max: 1 });
export const SCAN_SETTLE_MS = parseEnvNumber('SCAN_SETTLE_MS', 600, { min: 0, max: 10000 });
export const SCAN_STABILITY_POLLS = parseEnvNumber('SCAN_STABILITY_POLLS', 3, { min: 1, max: 10 });
export const SCAN_STABILITY_INTERVAL_MS = parseEnvNumber('SCAN_STABILITY_INTERVAL_MS', 350, { min: 50, max: 5000 });
export const SCAN_STABILITY_TIMEOUT_MS = parseEnvNumber('SCAN_STABILITY_TIMEOUT_MS', 15000, { min: 1000, max: 120000 });
