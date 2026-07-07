import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { TraceMap } from '@jridgewell/trace-mapping';
import { SOURCE_EXTS, STYLE_EXTS, SCRIPT_EXTS, MARKUP_EXTS, IGNORE_DIRS, shouldSkipFile } from '../core/constants.js';

export function normalizeRelPath(p) {
  return p.replace(/\\/g, '/');
}

export function getRouteTokens(pageUrl) {
  try {
    return decodeURIComponent(new URL(pageUrl).pathname)
      .split('/')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => s.length >= 3 && !/^[0-9a-f-]{8,}$/i.test(s));
  } catch {
    return [];
  }
}

export function tokenizeHtmlForMapping(html) {
  const tokens = [];
  const seen = new Set();
  const add = (token, weight) => {
    const t = String(token || '').trim();
    if (!t || t.length < 3) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    tokens.push({ token: t, weight });
  };

  for (const m of html.matchAll(/\bid="([^"]+)"/g)) add(m[1], 9);
  for (const m of html.matchAll(/\bdata-[\w-]+="([^"]{4,})"/g)) add(m[1], 7);
  for (const m of html.matchAll(/\bclass(?:Name)?="([^"]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls.length >= 4) add(cls, cls.includes('-') ? 5 : 2);
  }
  for (const m of html.matchAll(/>([^<]{5,40})</g)) {
    const text = m[1].trim().replace(/\s+/g, ' ');
    if (text.length >= 5 && text.length <= 40) add(text, 2);
  }
  return tokens;
}

export async function buildRepoFileIndexes(repoPath, codeExts = SOURCE_EXTS) {
  const allCodeFiles = [];
  const allSourceFiles = [];
  const suffixIndex = new Map();
  const basenameIndex = new Map();

  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (IGNORE_DIRS.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (codeExts.some(x => lower.endsWith(x))) allCodeFiles.push(full);
      if (SOURCE_EXTS.some(x => lower.endsWith(x))) allSourceFiles.push(full);
    }
  }

  await walk(repoPath);

  for (const absFile of allCodeFiles) {
    const relPath = normalizeRelPath(path.relative(repoPath, absFile));
    const segments = relPath.toLowerCase().split('/');
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      if (!suffixIndex.has(suffix)) suffixIndex.set(suffix, []);
      suffixIndex.get(suffix).push(relPath);
    }
    const basename = path.basename(relPath).toLowerCase();
    if (!basenameIndex.has(basename)) basenameIndex.set(basename, []);
    basenameIndex.get(basename).push(relPath);
  }

  return { allCodeFiles, allSourceFiles, suffixIndex, basenameIndex };
}

export async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

export async function loadSourceMapCandidates(absFile, repoPath) {
  const candidates = [];
  const relFile = normalizeRelPath(path.relative(repoPath, absFile));
  let content = '';
  try { content = await fs.readFile(absFile, 'utf-8'); } catch { return candidates; }

  const mapHints = [...content.matchAll(/sourceMappingURL\s*=\s*([^\s*]+)/gi)].map(m => m[1].trim());
  const mapPaths = new Set([
    ...mapHints.map(ref => path.resolve(path.dirname(absFile), ref)),
    `${absFile}.map`,
  ]);

  for (const mapPath of mapPaths) {
    if (!await pathExists(mapPath)) continue;
    try {
      const raw = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
      const traceMap = new TraceMap(raw, pathToFileURL(mapPath).href);
      const sourceList = traceMap.resolvedSources || raw.sources || [];
      for (const src of sourceList) {
        let absSource = src;
        try {
          if (src.startsWith('file://')) absSource = fileURLToPath(src);
          else if (!path.isAbsolute(src)) absSource = path.resolve(path.dirname(mapPath), src);
        } catch {
          absSource = path.resolve(path.dirname(mapPath), src);
        }
        if (!absSource.startsWith(repoPath)) continue;
        if (!await pathExists(absSource)) continue;
        const relSource = normalizeRelPath(path.relative(repoPath, absSource));
        if (shouldSkipFile(relSource)) continue;
        candidates.push({ generatedFile: relFile, originalFile: relSource, mapPath: normalizeRelPath(path.relative(repoPath, mapPath)), confidence: 'high', via: 'source-map' });
      }
    } catch { /* ignore bad maps */ }
  }

  return candidates;
}

export async function resolveEditableFile(relFile, repoPath, repoIndexes) {
  const normalized = normalizeRelPath(relFile);
  const absFile = path.resolve(repoPath, normalized);
  const ext = path.extname(normalized).toLowerCase();
  const sourceMapLinks = await loadSourceMapCandidates(absFile, repoPath);
  const preferredSource = sourceMapLinks.find(link => SOURCE_EXTS.includes(path.extname(link.originalFile).toLowerCase()));
  if (preferredSource) return { localFile: preferredSource.originalFile, confidence: 'high', via: preferredSource.via, generatedFile: normalized };

  const basename = path.basename(normalized, ext).toLowerCase();
  const dir = path.dirname(normalized).toLowerCase();
  const alternates = [];
  if (STYLE_EXTS.includes(ext)) alternates.push('.scss', '.sass', '.less');
  if (SCRIPT_EXTS.includes(ext)) alternates.push('.ts', '.tsx', '.jsx', '.js');

  for (const altExt of alternates) {
    const sibling = normalizeRelPath(path.join(path.dirname(normalized), `${basename}${altExt}`));
    if (sibling !== normalized && repoIndexes.allSourceFiles.some(f => normalizeRelPath(path.relative(repoPath, f)).toLowerCase() === sibling.toLowerCase())) {
      return { localFile: sibling, confidence: 'medium', via: 'same-dir-editable-peer', generatedFile: normalized };
    }
  }

  const basenameMatches = [];
  for (const altExt of alternates) {
    const hits = repoIndexes.basenameIndex.get(`${basename}${altExt}`) || [];
    basenameMatches.push(...hits);
  }
  if (basenameMatches.length > 0) {
    basenameMatches.sort((a, b) => {
      const aDir = path.dirname(a).toLowerCase();
      const bDir = path.dirname(b).toLowerCase();
      const aScore = aDir.includes(dir) ? 2 : 0;
      const bScore = bDir.includes(dir) ? 2 : 0;
      return bScore - aScore;
    });
    return { localFile: basenameMatches[0], confidence: 'low', via: 'basename-editable-peer', generatedFile: normalized };
  }

  return { localFile: normalized, confidence: 'high', via: 'direct', generatedFile: null };
}

export function classifyMappedEntry(relFile, reference, extra = {}) {
  const ext = path.extname(relFile).toLowerCase();
  return {
    reference,
    localFile: relFile,
    ...extra,
    fileType: ['.html', '.htm', '.cshtml', '.razor'].includes(ext) ? 'html'
      : STYLE_EXTS.includes(ext) ? 'css'
      : ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.svelte'].includes(ext) ? 'js'
      : 'other',
  };
}

export function appendMappedFile(fileMapping, entry) {
  if (entry.fileType === 'html') fileMapping.htmlFiles.push(entry);
  else if (entry.fileType === 'css') fileMapping.cssFiles.push(entry);
  else if (entry.fileType === 'js') fileMapping.jsFiles.push(entry);
  else fileMapping.otherFiles.push(entry);
}

export async function collectSourceFiles(root) {
  const results = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE_DIRS.includes(e.name)) continue;
      const full  = path.join(dir, e.name);
      const lower = e.name.toLowerCase();
      if (e.isDirectory())                                         { await walk(full); }
      else if (SOURCE_EXTS.some(x => lower.endsWith(x)))          { results.push(full); }
    }
  }
  await walk(root);
  return results;
}
