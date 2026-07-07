import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createServer } from 'net';
import { chromium } from 'playwright';
import simpleGit from 'simple-git';
import AdmZip from 'adm-zip';
import handler from 'serve-handler';
import chalk from 'chalk';
import ora from 'ora';
import { opts, resolveExtraUrls, NAV_WAIT_UNTIL, relaxTlsVerifyForUrl } from './core/cli.js';
import { waitForStablePage } from './scanning/browser.js';
import { buildRepoFileIndexes, resolveEditableFile, normalizeRelPath, getRouteTokens, tokenizeHtmlForMapping, classifyMappedEntry, appendMappedFile } from './repository/repo-index.js';
import { MARKUP_EXTS, SOURCE_EXTS, shouldSkipFile, isBinaryFile, isBuildOutputPath } from './core/constants.js';
import { resolveSlideContext } from './architecture/slide-resolver.js';

const execAsync = promisify(exec);

export async function phase1_ingest() {
  const spinner = ora('Phase 1 · Ingesting source...').start();
  const failAndThrow = (message) => {
    spinner.fail(message);
    const error = new Error(message);
    error.reportedToUser = true;
    throw error;
  };
  try {
    if (opts.url && opts.local) {
      let parsedHost;
      try { parsedHost = new URL(opts.url).hostname.toLowerCase(); }
      catch { failAndThrow(`Invalid --url value: ${opts.url}`); }
      const isLoopback = parsedHost === 'localhost' || parsedHost === '127.0.0.1' || parsedHost === '::1';
      if (!isLoopback) {
        failAndThrow(
          `--url + --local mode requires a localhost URL.\n  Got: ${opts.url}`
        );
      }
      const absPath = path.resolve(opts.local);
      await fs.access(absPath);
      spinner.succeed(`Combined mode · URL: ${chalk.cyan(opts.url)}  ·  Source: ${chalk.cyan(absPath)}`);
      return { type: 'url+local', url: opts.url, repoPath: absPath };
    }
    if (opts.url) {
      spinner.succeed(`Live URL: ${chalk.cyan(opts.url)}`);
      return { type: 'url', url: opts.url, repoPath: null };
    }
    if (opts.zip) {
      const extractTo = path.join('/tmp', `a11y-${Date.now()}`);
      new AdmZip(path.resolve(opts.zip)).extractAllTo(extractTo, true);
      spinner.succeed(`ZIP extracted → ${chalk.cyan(extractTo)}`);
      return { type: 'local', url: null, repoPath: extractTo };
    }
    if (opts.github) {
      const cloneTo = path.join('/tmp', `a11y-${Date.now()}`);
      spinner.text = 'Cloning GitHub repo (shallow)...';
      await simpleGit().clone(opts.github, cloneTo, ['--depth', '1']);
      spinner.succeed(`Cloned → ${chalk.cyan(cloneTo)}`);
      return { type: 'local', url: null, repoPath: cloneTo };
    }
    if (opts.local) {
      const absPath = path.resolve(opts.local);
      await fs.access(absPath);
      spinner.succeed(`Local path: ${chalk.cyan(absPath)}`);
      return { type: 'local', url: null, repoPath: absPath };
    }
    failAndThrow('No input provided. Use --url, --zip, --github, or --local');
  } catch (err) {
    if (err?.reportedToUser) throw err;
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(`Ingest failed: ${message}`);
    throw (err instanceof Error ? err : new Error(message));
  }
}

export async function identifySourceFilesForUrl(url, repoPath) {
  const spinner = ora('Identifying local source files for URL...').start();
  try {
    // Include .cs in URL-source discovery so slide domain/model/delegate files can
    // be resolved as context without expanding the normal source-fix index.
    const repoIndexes = await buildRepoFileIndexes(repoPath, [...SOURCE_EXTS, '.cs']);
    const allPageUrls = resolveExtraUrls(url);
    const pageContexts = [];
    const fileMapping = {
      htmlFiles: [], cssFiles: [], jsFiles: [], otherFiles: [], unmapped: [],
      pages: pageContexts, pageToFiles: {}, assetResolutions: [], manualReviewRefs: [],
      slideContexts: [], slideCandidateFiles: [],
    };
    const mappedLocalPaths = new Set();
    const browser = await chromium.launch();

    for (const pageUrl of allPageUrls) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: relaxTlsVerifyForUrl(pageUrl) });
      const page = await ctx.newPage();
      try {
        await page.goto(pageUrl, { waitUntil: NAV_WAIT_UNTIL, timeout: 60_000 });
        await waitForStablePage(page, pageUrl);
        const pageHtml = await page.content();
        const domAssets = await page.evaluate(() => {
          const scripts = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src'));
          const links = Array.from(document.querySelectorAll('link[href]')).map(el => el.getAttribute('href'));
          const imgs = Array.from(document.querySelectorAll('img[src]')).map(el => el.getAttribute('src'));
          const iframes = Array.from(document.querySelectorAll('iframe[src]')).map(el => el.getAttribute('src'));
          return { scripts, links, imgs, iframes };
        });

        const refs = new Set();
        for (const src of domAssets.scripts) if (src) refs.add(src);
        for (const href of domAssets.links) if (href) refs.add(href);
        for (const src of domAssets.imgs) if (src && !src.startsWith('data:')) refs.add(src);
        for (const src of domAssets.iframes) if (src) refs.add(src);
        for (const m of pageHtml.matchAll(/(?:src|href|data-src|ng-include|th:replace|th:include)\s*=\s*["']([^"']+)["']/gi)) {
          if (m[1] && !m[1].startsWith('data:') && !m[1].startsWith('#')) refs.add(m[1]);
        }

        pageContexts.push({
          pageUrl,
          routeTokens: getRouteTokens(pageUrl),
          html: pageHtml,
          domTokens: tokenizeHtmlForMapping(pageHtml),
          assetRefs: [...refs],
        });
      } catch {
        fileMapping.manualReviewRefs.push({ pageUrl, reason: 'page-unreachable' });
      }
      await ctx.close();
    }
    await browser.close();

    const markupContentCache = new Map();
    const getMarkupContent = async (relFile) => {
      if (markupContentCache.has(relFile)) return markupContentCache.get(relFile);
      try {
        const content = await fs.readFile(path.join(repoPath, relFile), 'utf-8');
        markupContentCache.set(relFile, content);
        return content;
      } catch {
        markupContentCache.set(relFile, '');
        return '';
      }
    };

    const findBestRepoMatch = (refPath) => {
      const refSegments = refPath.toLowerCase().split('/').filter(Boolean);
      if (refSegments.length === 0) return null;
      let bestMatch = null;
      let bestSuffixLen = 0;
      for (let i = 0; i < refSegments.length; i++) {
        const suffix = refSegments.slice(i).join('/');
        const candidates = repoIndexes.suffixIndex.get(suffix);
        if (!candidates?.length) continue;
        const suffixLen = refSegments.length - i;
        if (suffixLen <= bestSuffixLen) continue;
        let picked = null;
        let pickedScore = -Infinity;
        for (const relPath of candidates) {
          if (isBuildOutputPath(relPath)) continue;
          const localSegments = relPath.toLowerCase().split('/');
          let consecutive = 0;
          for (let k = 0; k < suffixLen && k < localSegments.length; k++) {
            if (localSegments[localSegments.length - 1 - k] === refSegments[refSegments.length - 1 - k]) consecutive++;
            else break;
          }
          const score = suffixLen * suffixLen + consecutive * consecutive * 2;
          if (score > pickedScore) { picked = relPath; pickedScore = score; }
        }
        if (picked) { bestMatch = picked; bestSuffixLen = suffixLen; break; }
      }
      return bestMatch;
    };

    for (const pageContext of pageContexts) {
      const pageFiles = new Set();
      fileMapping.pageToFiles[pageContext.pageUrl] = [];

      const slideContext = await resolveSlideContext({ repoPath, repoIndexes, pageContext });
      fileMapping.slideContexts.push(slideContext);
      for (const file of slideContext.files || []) {
        if (!file.path || shouldSkipFile(file.path)) continue;
        pageFiles.add(file.path);
        fileMapping.slideCandidateFiles.push({
          pageUrl: pageContext.pageUrl,
          localFile: file.path,
          fileRole: file.fileRole,
          ownership: file.ownership,
          confidence: file.confidence,
          via: file.via,
          slideType: slideContext.slideType,
          rendererClass: slideContext.rendererClass,
          detectionEvidence: slideContext.detectionEvidence,
        });
        if (!mappedLocalPaths.has(file.path)) {
          mappedLocalPaths.add(file.path);
          appendMappedFile(fileMapping, classifyMappedEntry(
            file.path,
            `(slide-aware ${file.fileRole})`,
            {
              pageUrl: pageContext.pageUrl,
              confidence: file.confidence,
              via: file.via,
              fileRole: file.fileRole,
              ownership: file.ownership,
              slideType: slideContext.slideType,
              rendererClass: slideContext.rendererClass,
              mappingEvidence: {
                routeKind: slideContext.routeKind,
                slideSerial: slideContext.slideSerial,
                detectionConfidence: slideContext.detectionConfidence,
                detectionEvidence: slideContext.detectionEvidence,
              },
            }
          ));
        }
      }

      for (const ref of pageContext.assetRefs) {
        let resolvedUrl;
        let refPath;
        try {
          resolvedUrl = new URL(ref, pageContext.pageUrl);
          refPath = decodeURIComponent(resolvedUrl.pathname);
        } catch {
          refPath = ref;
        }
        refPath = refPath.split('?')[0].split('#')[0];
        if (isBinaryFile(refPath)) continue;

        const bestMatch = findBestRepoMatch(refPath);
        if (!bestMatch) {
          try {
            const parsed = new URL(ref, pageContext.pageUrl);
            if (parsed.hostname === new URL(pageContext.pageUrl).hostname) fileMapping.unmapped.push(ref);
          } catch { fileMapping.unmapped.push(ref); }
          continue;
        }
        if (shouldSkipFile(bestMatch)) continue;

        const editable = await resolveEditableFile(bestMatch, repoPath, repoIndexes);
        const chosen = editable.localFile;
        if (shouldSkipFile(chosen)) continue;

        const resolution = {
          pageUrl: pageContext.pageUrl,
          rawRef: ref,
          normalizedPath: refPath,
          localFile: chosen,
          generatedFile: editable.generatedFile,
          confidence: editable.confidence,
          via: editable.via,
        };
        fileMapping.assetResolutions.push(resolution);
        pageFiles.add(chosen);
        if (!mappedLocalPaths.has(chosen)) {
          mappedLocalPaths.add(chosen);
          appendMappedFile(fileMapping, classifyMappedEntry(chosen, ref, { pageUrl: pageContext.pageUrl, resolution }));
        }
      }

      const markupCandidates = [];
      for (const absPath of repoIndexes.allSourceFiles) {
        const rel = normalizeRelPath(path.relative(repoPath, absPath));
        if (!MARKUP_EXTS.some(x => rel.toLowerCase().endsWith(x)) || shouldSkipFile(rel)) continue;
        const content = await getMarkupContent(rel);
        if (!content) continue;
        let score = 0;
        for (const token of pageContext.routeTokens) if (content.toLowerCase().includes(token.toLowerCase())) score += 6;
        for (const { token, weight } of pageContext.domTokens.slice(0, 50)) if (content.includes(token)) score += weight;
        const base = path.basename(rel).toLowerCase();
        for (const token of pageContext.routeTokens) if (base.includes(token.toLowerCase())) score += 4;
        if (score >= 12) markupCandidates.push({ rel, score });
      }
      markupCandidates.sort((a, b) => b.score - a.score);
      for (const candidate of markupCandidates.slice(0, 3)) {
        pageFiles.add(candidate.rel);
        if (!mappedLocalPaths.has(candidate.rel)) {
          mappedLocalPaths.add(candidate.rel);
          appendMappedFile(fileMapping, classifyMappedEntry(candidate.rel, '(page template candidate)', { pageUrl: pageContext.pageUrl, confidence: candidate.score >= 20 ? 'high' : 'medium', via: 'page-dom-template-score' }));
        }
      }

      fileMapping.pageToFiles[pageContext.pageUrl] = [...pageFiles];
    }

    const totalMapped = fileMapping.htmlFiles.length + fileMapping.cssFiles.length +
                        fileMapping.jsFiles.length  + fileMapping.otherFiles.length;
    spinner.succeed(`Identified ${chalk.green(totalMapped)} local source file(s) for ${chalk.cyan(url)}`);

    for (const [label, files] of [['HTML / Razor Templates', fileMapping.htmlFiles], ['CSS / Styles', fileMapping.cssFiles],
        ['JavaScript / Components', fileMapping.jsFiles], ['Other Assets', fileMapping.otherFiles]]) {
      if (files.length > 0) {
        console.log(chalk.bold(`\n  ${label}:`));
        for (const f of files) console.log(chalk.white(`    · ${f.localFile}`) + chalk.dim(` ← ${f.reference}`));
      }
    }
    if (fileMapping.unmapped.length > 0) {
      console.log(chalk.dim(`\n  Unmapped refs (${fileMapping.unmapped.length}): ${fileMapping.unmapped.slice(0,5).join(', ')}${fileMapping.unmapped.length > 5 ? '...' : ''}`));
    }
    console.log('');
    return fileMapping;

  } catch (err) {
    spinner.warn(`Source file identification skipped: ${err.message}`);
    return {
      htmlFiles: [], cssFiles: [], jsFiles: [], otherFiles: [], unmapped: [],
      pages: [], pageToFiles: {}, assetResolutions: [], manualReviewRefs: [],
      slideContexts: [], slideCandidateFiles: [],
    };
  }
}

export async function phase2_serve(repoPath, { skipInstallBuild = false } = {}) {
  const spinner = ora(skipInstallBuild ? 'Phase 2 · Serving locally...' : 'Phase 2 · Building & serving locally...').start();
  const port    = await findFreePort(3399);
  try {
    let pkg = {};
    try { pkg = JSON.parse(await fs.readFile(path.join(repoPath, 'package.json'), 'utf-8')); }
    catch { /* no package.json */ }

    if (!skipInstallBuild && pkg.name) {
      const attempts = [
        { cmd: 'npm install --omit=dev --prefer-offline' },
        { cmd: 'npm install --legacy-peer-deps --prefer-offline' },
        { cmd: 'npm install --force' },
      ];
      let installed = false;
      for (const { cmd } of attempts) {
        spinner.text = cmd;
        try { await execAsync(cmd, { cwd: repoPath, timeout: 180_000 }); installed = true; break; }
        catch { /* try next */ }
      }
      if (!installed) spinner.warn('npm install failed — attempting with existing files…');
    }

    if (!skipInstallBuild && pkg.scripts?.build) {
      spinner.text = 'npm run build…';
      try { await execAsync('npm run build', { cwd: repoPath, timeout: 240_000 }); }
      catch { spinner.warn('Build step failed — continuing with source files…'); }
    }

    const serveDir = await detectServeDir(repoPath);
    const server   = http.createServer((req, res) =>
      handler(req, res, { public: serveDir, rewrites: [{ source: '**', destination: '/index.html' }] })
    );
    await new Promise(resolve => server.listen(port, resolve));
    const url = `http://localhost:${port}`;
    spinner.succeed(`Serving at ${chalk.green(url)}  (${path.relative(repoPath, serveDir) || '.'})`);
    return { url, server };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(`Serve failed: ${message}`);
    throw (err instanceof Error ? err : new Error(message));
  }
}

export async function detectServeDir(root) {
  for (const candidate of ['dist', 'build', 'out', '.next', 'public', '.']) {
    try { await fs.access(path.join(root, candidate, 'index.html')); return path.join(root, candidate); }
    catch {}
  }
  return root;
}

export async function findFreePort(start) {
  return new Promise(resolve => {
    const s = createServer();
    s.listen(start, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', () => resolve(findFreePort(start + 1)));
  });
}
