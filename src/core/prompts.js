import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const promptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts');
const promptCache = new Map();

export function renderPrompt(name, values = {}) {
  if (!promptCache.has(name)) {
    promptCache.set(name, fs.readFileSync(path.join(promptRoot, name), 'utf-8'));
  }

  return promptCache.get(name).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing prompt value: ${name}:${key}`);
    return String(values[key]);
  });
}
