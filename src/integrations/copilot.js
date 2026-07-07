import chalk from 'chalk';
import path from 'path';
import { COPILOT_IDLE_TIMEOUT_MS, COPILOT_MODEL, COPILOT_REASONING_EFFORT } from '../core/config.js';
import { logger } from '../core/logger.js';

export const COPILOT_REMEDIATION_AGENT_MODEL = COPILOT_MODEL || 'claude-opus-4.6';

const TOOL_POLICY = Object.freeze({
  read: new Set([
    'read', 'read_file', 'readfile', 'grep', 'find', 'ls', 'list', 'list_directory', 'listdirectory',
    'search', 'file_search', 'filesearch', 'glob', 'cat', 'view', 'stat', 'inspect', 'query',
  ]),
  write: new Set([
    'edit', 'edit_file', 'editfile', 'write', 'write_file', 'writefile', 'patch', 'apply_patch', 'applypatch',
    'replace', 'insert', 'update', 'create', 'delete', 'remove', 'mutate', 'rewrite', 'modify',
  ]),
  shell: new Set([
    'shell', 'terminal', 'bash', 'powershell', 'cmd', 'run_command', 'runcommand',
    'command', 'exec', 'execute', 'run',
  ]),
  denied: new Set([
    'web', 'web_fetch', 'webfetch', 'fetch_url', 'fetchurl', 'url_fetch', 'urlfetch',
    'http_fetch', 'httpfetch', 'https_fetch', 'httpsfetch',
    'network_fetch', 'networkfetch', 'network_request', 'networkrequest',
    'http_request', 'httprequest', 'https_request', 'httpsrequest', 'web_request', 'webrequest',
    'web_search', 'websearch', 'open_url', 'openurl', 'browse', 'browser', 'browser_open', 'browseropen',
    'mcp', 'mcp_tool', 'mcptool', 'mcp_call', 'mcpcall',
    'memory', 'memory_read', 'memoryread', 'memory_write', 'memorywrite',
    'hook', 'hooks', 'pre_hook', 'prehook', 'post_hook', 'posthook',
  ]),
  unknownWriteishStrong: new Set([
    'edit', 'write', 'patch', 'replace', 'create', 'delete', 'remove',
    'apply', 'insert', 'update', 'mutate', 'rewrite', 'modify', 'save', 'append',
  ]),
  unknownWriteishWeak: new Set(['exec', 'execute', 'run', 'command', 'shell', 'terminal', 'bash', 'powershell', 'cmd']),
  unknownReadOnlyHints: new Set([
    'read', 'grep', 'find', 'ls', 'list', 'search', 'glob', 'cat', 'view', 'show', 'query', 'inspect', 'scan', 'stat',
  ]),
});

const READ_ALIASES_REQUIRING_PATH = new Set([
  'read', 'read_file', 'readfile', 'cat', 'view', 'stat', 'inspect',
]);

const ALLOWED_VALIDATION_COMMANDS = [
  /^node\s+--check\s+["']?[\w./\\: -]+\.(?:mjs|cjs|js|jsx|ts|tsx)["']?$/i,
  /^npm\s+(?:test|run\s+(?:lint|test|typecheck|build|check))(?:\s+--(?:\s+[\w./\\:=@'",-]+)*)?$/i,
  /^npx\s+tsc\s+--noEmit(?:\s+[\w./\\:=@'",-]+)*$/i,
  /^npx\s+eslint\s+[\w./\\:=@'",*-]+$/i,
  /^git\s+(?:status\s+--short|diff(?:\s+--\s+[\w./\\: -]+)?)$/i,
  /^dotnet\s+build(?:\s+[\w./\\:=@'",-]+)*$/i,
  /^make\s+(?:check|build|test|lint)(?:\s+[\w./\\:=@'",-]+)*$/i,
];

function normalizeToolName(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function collectToolSignals(values = []) {
  const fullAliases = new Set();
  const tokens = new Set();

  for (const value of values) {
    const normalized = normalizeToolName(value);
    if (!normalized) continue;
    fullAliases.add(normalized);

    const compact = normalized.replace(/[^a-z0-9]+/g, '');
    if (compact) fullAliases.add(compact);

    const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
    for (const part of parts) {
      tokens.add(part);
    }
  }

  return { fullAliases, tokens };
}

function findMatchingAlias(aliases, policySet) {
  for (const alias of aliases) {
    if (policySet.has(alias)) return alias;
  }
  return '';
}

function normalizeAllowedTools(tools = []) {
  const { fullAliases } = collectToolSignals(tools);
  return {
    canRead: Boolean(findMatchingAlias(fullAliases, TOOL_POLICY.read)),
    canWrite: Boolean(findMatchingAlias(fullAliases, TOOL_POLICY.write)),
    canShell: Boolean(findMatchingAlias(fullAliases, TOOL_POLICY.shell)),
  };
}

function normalizeRepoRelativePath(cwd, filePath) {
  if (!filePath) return '';
  const rawPath = String(filePath).trim().replace(/\\/g, '/');
  if (!rawPath) return '';
  const relative = path.isAbsolute(rawPath)
    ? path.relative(cwd, rawPath)
    : rawPath;
  const normalized = path.normalize(relative).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('../') || normalized === '..' || path.isAbsolute(normalized)) return '';
  return normalized;
}

function getPermissionToolCandidates(request) {
  return [
    request?.kind,
    request?.toolName,
    request?.name,
    request?.tool,
    request?.input?.toolName,
    request?.args?.toolName,
  ].filter(Boolean);
}

function getRequestedPath(request) {
  return request?.fileName
    || request?.filePath
    || request?.path
    || request?.relativePath
    || request?.input?.fileName
    || request?.input?.filePath
    || request?.input?.path
    || request?.args?.fileName
    || request?.args?.filePath
    || request?.args?.path
    || '';
}

function getRequestedCommand(request) {
  const command = request?.command
    || request?.cmd
    || request?.shellCommand
    || request?.input?.command
    || request?.input?.cmd
    || request?.input?.shellCommand
    || request?.args?.command
    || request?.args?.cmd
    || request?.args?.shellCommand
    || '';
  return Array.isArray(command) ? command.join(' ') : String(command || '');
}

function classifyPermission(request) {
  const candidates = getPermissionToolCandidates(request);

  const { fullAliases, tokens } = collectToolSignals(candidates);
  const deniedAlias = findMatchingAlias(fullAliases, TOOL_POLICY.denied);
  if (deniedAlias) return { category: 'denied', reasonCode: `known_denied_alias:${deniedAlias}` };

  const shellAlias = findMatchingAlias(fullAliases, TOOL_POLICY.shell);
  if (shellAlias) return { category: 'shell', reasonCode: `known_shell_alias:${shellAlias}` };

  const writeAlias = findMatchingAlias(fullAliases, TOOL_POLICY.write);
  if (writeAlias) return { category: 'write', reasonCode: `known_write_alias:${writeAlias}` };

  const strongMutationToken = [...tokens].find(token => TOOL_POLICY.unknownWriteishStrong.has(token));
  const weakMutationToken = [...tokens].find(token => TOOL_POLICY.unknownWriteishWeak.has(token));
  const hasReadOnlyHint = [...tokens].some(token => TOOL_POLICY.unknownReadOnlyHints.has(token));

  const readAlias = findMatchingAlias(fullAliases, TOOL_POLICY.read);
  if (readAlias) {
    const ambiguousWriteishToken = strongMutationToken || weakMutationToken;
    if (ambiguousWriteishToken) {
      return { category: 'unknown_writeish', reasonCode: `ambiguous_read_with_writeish:${ambiguousWriteishToken}` };
    }
    return { category: 'read', reasonCode: `known_read_alias:${readAlias}` };
  }

  if (strongMutationToken) {
    return { category: 'unknown_writeish', reasonCode: `unknown_writeish_strong:${strongMutationToken}` };
  }

  if (weakMutationToken && !hasReadOnlyHint) {
    return { category: 'unknown_writeish', reasonCode: `unknown_writeish_weak:${weakMutationToken}` };
  }

  return { category: 'unknown', reasonCode: 'unknown_tool_alias' };
}

function getMatchedReadAlias(request, classification) {
  const reasonCode = String(classification?.reasonCode || '');
  const reasonMatch = reasonCode.match(/^known_read_alias:(.+)$/);
  if (reasonMatch?.[1]) return reasonMatch[1];
  if (classification?.category !== 'read') return '';
  const { fullAliases } = collectToolSignals(getPermissionToolCandidates(request));
  return findMatchingAlias(fullAliases, TOOL_POLICY.read);
}

function isAllowedValidationCommand(command) {
  const normalized = String(command || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  if (/[;&|`$<>]/.test(normalized)) return false;
  return ALLOWED_VALIDATION_COMMANDS.some(pattern => pattern.test(normalized));
}

function createPermissionHandler({ role, cwd, tools, allowedWriteFiles = [] }) {
  const allowed = normalizeAllowedTools(tools);
  const allowedWriteSet = new Set(
    allowedWriteFiles
      .map(file => normalizeRepoRelativePath(cwd, file))
      .filter(Boolean)
  );

  return (request) => {
    const classification = classifyPermission(request);
    const category = classification.category;
    const kind = String(request?.kind || '').toLowerCase();
    const name = request?.toolName || request?.name || kind || 'unknown';
    const requestedPath = getRequestedPath(request);
    const hasRequestedPath = Boolean(String(requestedPath || '').trim());
    const file = normalizeRepoRelativePath(cwd, requestedPath);
    const command = getRequestedCommand(request);
    logger.tool(role, name, [file ? `path=${file}` : '', command ? `command=${command}` : ''].filter(Boolean).join(' '));

    const decide = (decisionKind, feedback, reasonCode) => {
      logger.remediation(`copilot:${role} permission tool=${name} category=${category} decision=${decisionKind} reason=${reasonCode}`);
      if (feedback) return { kind: decisionKind, feedback };
      return { kind: decisionKind };
    };

    if (category === 'read') {
      if (!allowed.canRead) return decide('reject', 'This role is not allowed to read repository files.', 'read_role_denied');
      const readAlias = getMatchedReadAlias(request, classification);
      if (READ_ALIASES_REQUIRING_PATH.has(readAlias) && !hasRequestedPath) {
        return decide('reject', 'Read requests for this tool must target a concrete repository file path.', 'read_missing_repo_file');
      }
      if (hasRequestedPath && !file) return decide('reject', 'Reading outside the repository is not allowed.', 'read_outside_repo');
      return decide('approve-once', undefined, classification.reasonCode || 'read_allowed');
    }
    if (category === 'write') {
      if (!allowed.canWrite) return decide('reject', 'This role is read-only and cannot write or edit files.', 'write_role_denied');
      if (!file) return decide('reject', 'Write requests must target a concrete repository file.', 'write_missing_repo_file');
      if (!allowedWriteSet.has(file)) {
        return decide(
          'reject',
          `Writes are limited to the current remediation candidate files. ${file} is not in scope.`,
          'write_out_of_scope'
        );
      }
      return decide('approve-once', undefined, classification.reasonCode || 'write_allowed');
    }
    if (category === 'shell') {
      if (!allowed.canShell) return decide('reject', 'This role is not allowed to run shell commands.', 'shell_role_denied');
      if (!isAllowedValidationCommand(command)) {
        return decide(
          'reject',
          'Only bounded validation commands are allowed: node --check, npm run lint/test/typecheck/build/check, npx tsc --noEmit, npx eslint, git status/diff, dotnet build, or make check/build/test/lint.',
          'shell_command_not_allowlisted'
        );
      }
      return decide('approve-once', undefined, 'shell_command_allowlisted');
    }
    if (category === 'denied') {
      return decide('reject', 'Network access, MCP, memory, and hooks are disabled in remediation v1.', classification.reasonCode || 'denied_category');
    }
    if (category === 'unknown_writeish') {
      return decide(
        'reject',
        `Tool permission "${name}" looks mutation-capable but is not allowlisted for remediation v1.`,
        classification.reasonCode || 'unknown_writeish_default_deny'
      );
    }
    return decide(
      'reject',
      `Tool permission "${name}" is not part of the remediation v1 allowlist.`,
      classification.reasonCode || 'unknown_default_deny'
    );
  };
}

/**
 * Create a GitHub Copilot SDK session scoped to a target repository.
 *
 * Uses the GA SDK API:
 *   new CopilotClient({ workingDirectory })
 *   client.start()
 *   client.createSession({ model, reasoningEffort, systemMessage, onPermissionRequest })
 *   session.send({ prompt }) and waits for session.idle with a timeout guard
 */
export async function createCopilotAgent({ role, cwd, tools = [], allowedWriteFiles = [], systemPrompt = '', quiet = false }) {
  const { CopilotClient } = await import('@github/copilot-sdk');
  const client = new CopilotClient({
    workingDirectory: cwd,
    logLevel: 'error',
    useLoggedInUser: true,
  });
  await client.start();

  const session = await client.createSession({
    model: COPILOT_REMEDIATION_AGENT_MODEL,
    ...(COPILOT_REASONING_EFFORT ? { reasoningEffort: COPILOT_REASONING_EFFORT } : {}),
    onPermissionRequest: createPermissionHandler({ role, cwd, tools, allowedWriteFiles }),
    systemMessage: systemPrompt ? { content: systemPrompt } : undefined,
  });

  let finalText = '';
  let streamingText = '';
  const unsubscribers = [];
  const on = (eventType, handler) => {
    try {
      const unsubscribe = session.on(eventType, handler);
      if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
    } catch { /* older SDK builds may not expose all event names */ }
  };

  on('assistant.message_delta', (event) => {
    const delta = event?.data?.deltaContent || '';
    if (!delta) return;
    streamingText += delta;
    if (!quiet) process.stdout.write(chalk.dim(delta));
  });
  on('assistant.message', (event) => {
    const content = event?.data?.content || '';
    if (content) finalText = content;
  });
  on('session.idle', () => {
    if (streamingText.trim()) {
      finalText = streamingText;
      logger.agent(role, 'message', streamingText);
    }
    streamingText = '';
  });

  async function send(promptText, mode = 'enqueue') {
    streamingText = '';
    logger.remediation(`▶ copilot:${role} run started (model ${COPILOT_REMEDIATION_AGENT_MODEL}, prompt ${promptText.length} chars)`);
    const response = await sendAndWaitForIdle({ prompt: promptText, mode });
    const content = response?.data?.content || response?.data?.message?.content || '';
    if (content) {
      finalText = content;
      logger.agent(role, 'message', content);
    } else if (streamingText.trim()) {
      finalText = streamingText;
    }
    return { text: finalText, touchedFiles: [] };
  }

  async function sendAndWaitForIdle(options) {
    let lastAssistantMessage;
    let unsubscribe = () => {};
    let listenerRemoved = false;
    let timeoutId;
    const removeListener = () => {
      if (listenerRemoved) return;
      listenerRemoved = true;
      try { unsubscribe(); } catch { /* ignore */ }
    };

    const idleOrErrorPromise = new Promise((resolve, reject) => {
      const onEvent = (event) => {
        if (event.type === 'assistant.message') {
          lastAssistantMessage = event;
        } else if (event.type === 'session.idle') {
          removeListener();
          resolve(lastAssistantMessage);
        } else if (event.type === 'session.error') {
          removeListener();
          const error = new Error(event.data?.message || 'Copilot session error');
          if (event.data?.stack) error.stack = event.data.stack;
          reject(error);
        }
      };

      try {
        const maybeUnsubscribe = session.on(onEvent);
        if (typeof maybeUnsubscribe === 'function') unsubscribe = maybeUnsubscribe;
      } catch (error) {
        reject(error);
      }
    });

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const timeoutSeconds = (COPILOT_IDLE_TIMEOUT_MS / 1000).toFixed(1);
        const timeoutError = new Error(
          `Timed out waiting for Copilot send/idle after ${COPILOT_IDLE_TIMEOUT_MS}ms (~${timeoutSeconds}s). `
          + `Increase COPILOT_IDLE_TIMEOUT_MS if this session needs more time.`
        );
        timeoutError.code = 'COPILOT_IDLE_TIMEOUT';
        reject(timeoutError);
      }, COPILOT_IDLE_TIMEOUT_MS);
    });

    const sendAndIdlePromise = (async () => {
      await session.send(options);
      return idleOrErrorPromise;
    })();

    try {
      return await Promise.race([sendAndIdlePromise, timeoutPromise]);
    } catch (error) {
      if (error?.code === 'COPILOT_IDLE_TIMEOUT') {
        try { await session.disconnect?.(); } catch { /* best-effort disconnect on timeout */ }
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      removeListener();
    }
  }

  return {
    role,
    session,
    async run(promptText) {
      return send(promptText);
    },
    async followUp(promptText) {
      return send(promptText, 'enqueue');
    },
    getFinalText() {
      return finalText || streamingText || '';
    },
    async dispose() {
      for (const unsubscribe of unsubscribers) {
        try { unsubscribe(); } catch { /* ignore */ }
      }
      try { await session.disconnect?.(); } catch { /* ignore */ }
      try { await client.stop?.(); } catch { /* ignore */ }
    },
  };
}

/**
 * Simple one-shot completion using Copilot SDK (no tools/agent session).
 * Used for the judge and other non-interactive LLM calls.
 */
export async function copilotComplete({ model, system, prompt, maxTokens = 3000 }) {
  const { CopilotClient } = await import('@github/copilot-sdk');
  const client = new CopilotClient({
    workingDirectory: process.cwd(),
    logLevel: 'error',
    useLoggedInUser: true,
  });
  await client.start();

  const session = await client.createSession({
    model: model || 'claude-sonnet-4.6',
    systemMessage: system ? { content: system } : undefined,
  });

  let finalText = '';
  let streamingText = '';
  const unsubscribers = [];
  const on = (eventType, handler) => {
    try {
      const unsubscribe = session.on(eventType, handler);
      if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
    } catch { /* older SDK builds may not expose all event names */ }
  };

  on('assistant.message_delta', (event) => {
    const delta = event?.data?.deltaContent || '';
    if (delta) streamingText += delta;
  });
  on('assistant.message', (event) => {
    const content = event?.data?.content || '';
    if (content) finalText = content;
  });
  on('session.idle', () => {
    if (streamingText.trim()) finalText = streamingText;
    streamingText = '';
  });

  // Send the prompt and wait for completion
  const idlePromise = new Promise((resolve) => {
    on('session.idle', () => resolve());
  });

  await session.send({ prompt });

  // Wait for idle with timeout
  await Promise.race([
    idlePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Copilot judge timeout after 120s')), 120000)),
  ]);

  for (const unsub of unsubscribers) {
    try { unsub(); } catch { /* ignore */ }
  }
  try { await session.disconnect?.(); } catch { /* ignore */ }
  try { await client.stop?.(); } catch { /* ignore */ }

  return {
    content: [{ type: 'text', text: finalText || streamingText }],
  };
}

/**
 * Extract the first JSON value (object or array) embedded in agent text.
 * Tolerates ```json fences and surrounding prose.
 */
export function extractJsonFromText(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const candidate of candidates) {
    const parsed = tryParseJsonSlice(candidate);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function tryParseJsonSlice(text) {
  try { return JSON.parse(text); } catch { /* keep trying */ }
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}
