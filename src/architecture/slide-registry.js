import path from 'path';
import { JS_RENDERERS } from './app-architecture.js';

// Optional escape hatch for slide types whose filenames do not follow the
// convention. Keep this small; the registry is intentionally convention-derived.
const SLIDE_OVERRIDES = {
  // Example:
  // GraphicTally: {
  //   templateBasenames: ['graphic-tally.cshtml'],
  //   jsBasenames: ['ed.interaction.graphictally.js'],
  //   styleBasenames: ['interaction.graphictally.css'],
  // },
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function pascalToKebab(value = '') {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

export function compactName(value = '') {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function rendererClassToPascal(rendererClass = '') {
  return String(rendererClass).split('.').filter(Boolean).at(-1) || '';
}

export function conventionForRenderer(rendererClass) {
  const pascalName = rendererClassToPascal(rendererClass);
  if (!pascalName) return null;

  const kebabName = pascalToKebab(pascalName);
  const compact = compactName(pascalName);
  const override = SLIDE_OVERRIDES[pascalName] || {};

  return {
    pascalName,
    slideType: kebabName,
    compactName: compact,
    rendererClass,
    templateBasenames: unique([
      ...(override.templateBasenames || []),
      `${kebabName}.cshtml`,
      `${compact}.cshtml`,
    ]),
    jsBasenames: unique([
      ...(override.jsBasenames || []),
      `ed.interaction.${compact}.js`,
      `ed.interaction.${kebabName}.js`,
      `ed.${compact}.js`,
      `ed.${kebabName}.js`,
    ]),
    styleBasenames: unique([
      ...(override.styleBasenames || []),
      `interaction.${compact}.css`,
      `interaction.${kebabName}.css`,
      `${compact}.css`,
      `${kebabName}.css`,
      `interaction.${compact}.scss`,
      `interaction.${kebabName}.scss`,
      `${compact}.scss`,
      `${kebabName}.scss`,
    ]),
    domainBasenames: unique([
      ...(override.domainBasenames || []),
      `${pascalName}Interaction.cs`,
      `${pascalName}Response.cs`,
      `${pascalName}ServiceDelegate.cs`,
    ]),
  };
}

export function allRendererConventions() {
  return [...JS_RENDERERS].map(conventionForRenderer).filter(Boolean);
}

export function detectRendererClassesFromHtml(html = '') {
  const known = new Set(JS_RENDERERS);
  const found = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/\bnew\s+(Ed\.(?:Interaction\.)?[A-Za-z0-9_.]+)\s*\(/g)) {
    const rendererClass = match[1];
    if (!known.has(rendererClass) || seen.has(rendererClass)) continue;
    seen.add(rendererClass);
    found.push({
      rendererClass,
      evidence: `bootstrap:${rendererClass}`,
      confidence: 'high',
    });
  }
  return found;
}

export function detectRendererClassesFromAssets(assetRefs = []) {
  const basenameSet = new Set(assetRefs.map(ref => path.basename(String(ref).split('?')[0].split('#')[0]).toLowerCase()));
  const found = [];
  const seen = new Set();

  for (const convention of allRendererConventions()) {
    const jsHit = convention.jsBasenames.find(name => basenameSet.has(name.toLowerCase()));
    const styleHit = convention.styleBasenames.find(name => basenameSet.has(name.toLowerCase()));
    if (!jsHit && !styleHit) continue;
    if (seen.has(convention.rendererClass)) continue;
    seen.add(convention.rendererClass);
    found.push({
      rendererClass: convention.rendererClass,
      evidence: jsHit ? `asset:${jsHit}` : `asset:${styleHit}`,
      confidence: jsHit ? 'medium' : 'low',
    });
  }

  return found;
}
