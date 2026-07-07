#!/usr/bin/env node
import path from 'path';
import { resolveTemplateNamedSourceFiles } from '../src/architecture/template-file-resolver.js';

const [, , templateName, repoPathArg, ...rest] = process.argv;

if (!templateName) {
  console.error('Usage: node scripts/resolve-template-files.js <template-name> [repo-path] [--json]');
  process.exit(1);
}

const repoPath = path.resolve(repoPathArg && !repoPathArg.startsWith('--') ? repoPathArg : process.cwd());
const json = rest.includes('--json') || repoPathArg === '--json';

const result = await resolveTemplateNamedSourceFiles(templateName, repoPath, { maxFiles: 0 });

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Template: ${result.templateName}`);
  console.log(`Variants: ${result.normalizedKeys.join(', ') || '(none)'}`);
  console.log(`Repo: ${repoPath}`);
  console.log('');
  for (const [group, files] of Object.entries(result.files)) {
    if (!files.length) continue;
    console.log(`${group}:`);
    for (const file of files) console.log(`  - ${file}`);
  }
  if (result.flatFiles.length === 0) console.log('No matching template bundle files found.');
}
