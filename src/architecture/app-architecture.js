import fs from 'fs/promises';
import path from 'path';

export const DOCUMENT_LEVEL_RULES = new Set(['document-title','html-has-lang','html-lang-valid','bypass','landmark-one-main','landmark-unique','region','meta-viewport','meta-refresh']);
// These are document-level but have clear mechanical fixes in markup files
export const HEADING_STRUCTURE_RULES = new Set(['page-has-heading-one', 'heading-order']);

// ═══════════════════════════════════════════════════════════════════════════════
//  ED.CONTENTDELIVERY.APP — HARDCODED ARCHITECTURE KNOWLEDGE
//  The rendering pipeline: DocumentTemplate wraps slide Template as Body.
//  DocumentTemplates are full HTML pages; Templates are partial content.
//  For page-has-heading-one: the fix goes in the DocumentTemplate, not the slide Template.
// ═══════════════════════════════════════════════════════════════════════════════

// DocumentTemplates that produce full <!doctype html> pages.
// These are the ONLY files where page-level heading (<h1>) should be added.
// The heading already has access to deliveryModel.Title via Razor.
export const DOCUMENT_TEMPLATES = new Set([
  'default.cshtml', 'interaction.cshtml', 'item.cshtml', 'fullScreen.cshtml',
  'gradedActivity.cshtml', 'lessonActivity.cshtml', 'FullActivityPreview.cshtml',
  'bookend.cshtml', 'resource.cshtml', 'glossaryterm.cshtml', 'quickinfo.cshtml',
  'exception.cshtml', 'video.cshtml', 'timeline.cshtml', 'transcript.cshtml',
]);

// DocumentTemplates that ALREADY have an <h1> — do not add another.
export const DOC_TEMPLATES_WITH_H1 = new Set(['resource.cshtml', 'exception.cshtml']);

// Slide Templates that are "shells" — mostly empty containers that boot a JS renderer.
// These NEVER own heading structure. The JS renderer or DocumentTemplate does.
export const SHELL_SLIDE_TEMPLATES = new Set([
  'paged-passage.cshtml', 'comparative-paged-passage.cshtml',
  'comparative-passage.cshtml', 'passage.cshtml',
  'adobe-animate-animation-slide.cshtml', 'adobe-animate-objective-animation-slide.cshtml',
  'click-to-see.cshtml', 'step-by-step.cshtml',
  'table-of-contents-one.cshtml', 'table-of-contents-two.cshtml',
  'ordered-problem.cshtml', 'one-column.cshtml', 'one-column-video-completion.cshtml',
  'one-third-two-thirds.cshtml', 'two-column.cshtml', 'two-third-one-third.cshtml',
  'three-column.cshtml', 'timeline.cshtml', 'resource.cshtml',
  'url-slide.cshtml', 'html-package-slide.cshtml',
]);

// Slide Templates that are "true templates" — have real HTML structure with <h2>s, panels.
// These contain interaction UI but still don't own page-level <h1>.
export const TRUE_SLIDE_TEMPLATES = new Set([
  'cloze.cshtml', 'fill-in-the-blank.cshtml', 'hot-text.cshtml', 'hot-spot.cshtml',
  'matched-pair.cshtml', 'multiple-choice.cshtml', 'multiple-choice-prompt-on-left.cshtml',
  'graphic-tally.cshtml', 'graphic-gap-match.cshtml', 'graph.cshtml',
  'non-judged-graph.cshtml', 'non-judged-graph-interaction.cshtml',
  'number-line.cshtml', 'freehand-drawing.cshtml', 'sequencing.cshtml',
  'equation.cshtml', 'constructed-response.cshtml',
]);

// JS renderer classes that build DOM at runtime. None create <h1>.
export const JS_RENDERERS = new Set([
  'Ed.Storybook', 'Ed.Passage', 'Ed.ComparativePagedPassage',
  'Ed.Interaction.Cloze', 'Ed.Interaction.ConstructedResponse',
  'Ed.Interaction.Equation', 'Ed.Interaction.FillInTheBlank',
  'Ed.Interaction.FreehandDrawing', 'Ed.Interaction.Graph',
  'Ed.Interaction.GraphicGapMatch', 'Ed.Interaction.GraphicTally',
  'Ed.Interaction.HotSpot', 'Ed.Interaction.HotText',
  'Ed.Interaction.MatchedPair', 'Ed.Interaction.MultipleChoice',
  'Ed.Interaction.NonJudgedGraph', 'Ed.Interaction.NonJudgedGraphInteraction',
  'Ed.Interaction.NumberLine', 'Ed.Interaction.Sequencing',
  'Ed.CreateJSTextBlockAnimationSlide', 'Ed.CreateJSObjectiveAnimation',
  'Ed.Slide.MCQ', 'Ed.Slide.Timeline',
  'Ed.ScreenBuilder',
]);

const DISCOVERY_IGNORE = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.next', 'out', 'coverage']);

export async function discoverDocumentTemplates(repoPath) {
  const discovered = new Set(DOCUMENT_TEMPLATES); // start with known templates
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (DISCOVERY_IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      const lower = e.name.toLowerCase();
      if (!lower.endsWith('.cshtml') && !lower.endsWith('.razor')) continue;
      try {
        const content = await fs.readFile(full, 'utf-8');
        const lc = content.toLowerCase();
        if (lc.includes('<!doctype html') || /<html[\s>]/i.test(content)) {
          discovered.add(e.name.toLowerCase());
        }
      } catch { /* skip unreadable files */ }
    }
  }
  await walk(repoPath);
  return discovered;
}

// Patterns that identify a file as a "shell" (boots JS renderer, doesn't own DOM structure)
export const SHELL_BOOT_PATTERNS = [
  /new\s+Ed\.(Storybook|Passage|ComparativePagedPassage)\s*\(/,
  /new\s+Ed\.Interaction\.\w+\s*\(/,
  /new\s+Ed\.CreateJS\w+\s*\(/,
  /new\s+Ed\.Slide\.\w+\s*\(/,
];

// Classify a file's role in the render chain
export function classifyFileOwnership(relFile, content, dynamicTemplates = null) {
  const basename = path.basename(relFile).toLowerCase();
  const lc = content.toLowerCase();
  const templates = dynamicTemplates || DOCUMENT_TEMPLATES;

  // DocumentTemplate — produces full HTML page, owns page-level structure
  if (templates.has(basename) && (lc.includes('<!doctype html') || lc.includes('deliverymodel'))) {
    return { ownership: 'document-template', canOwnH1: !DOC_TEMPLATES_WITH_H1.has(basename) };
  }

  // Shell slide template — just boots JS, never owns headings
  if (SHELL_SLIDE_TEMPLATES.has(basename)) return { ownership: 'shell-template', canOwnH1: false };
  if (SHELL_BOOT_PATTERNS.some(rx => rx.test(content)) && !lc.includes('<!doctype html')) {
    return { ownership: 'shell-template', canOwnH1: false };
  }

  // True slide template — has panels/buttons but doesn't own page <h1>
  if (TRUE_SLIDE_TEMPLATES.has(basename)) return { ownership: 'interaction-template', canOwnH1: false };

  // JS renderer file — builds DOM dynamically, no <h1> creation
  if (/^ed\.(interaction|storybook|passage|comparative|clicktosee|orderedproblem|screenbuilder|stepbystep|timeline)/i.test(basename) && basename.endsWith('.js')) {
    return { ownership: 'js-renderer', canOwnH1: false };
  }

  // Generic .cshtml in Templates/ path — check if it's a partial (no <!doctype>)
  if (basename.endsWith('.cshtml') && !lc.includes('<!doctype html')) {
    return { ownership: 'partial-template', canOwnH1: false };
  }

  return { ownership: 'unknown', canOwnH1: null };
}

export const TRANSFORMATION_CATALOG = {
  'image-alt': { transformType: 'set-alt-text', fileGroups: ['markup', 'script'], verificationRules: ['image-alt'] },
  'image-redundant-alt': { transformType: 'set-alt-text', fileGroups: ['markup', 'script'], verificationRules: ['image-alt'] },
  'input-image-alt': { transformType: 'set-alt-text', fileGroups: ['markup', 'script'], verificationRules: ['input-image-alt', 'image-alt'] },
  'button-name': { transformType: 'set-accessible-name', fileGroups: ['markup', 'script'], verificationRules: ['button-name'] },
  'link-name': { transformType: 'set-accessible-name', fileGroups: ['markup', 'script'], verificationRules: ['link-name'] },
  'input-button-name': { transformType: 'set-accessible-name', fileGroups: ['markup', 'script'], verificationRules: ['input-button-name', 'button-name'] },
  'aria-input-field-name': { transformType: 'associate-accessible-label', fileGroups: ['markup', 'script'], verificationRules: ['aria-input-field-name', 'label'] },
  'select-name': { transformType: 'associate-accessible-label', fileGroups: ['markup', 'script'], verificationRules: ['select-name', 'label'] },
  'label': { transformType: 'associate-accessible-label', fileGroups: ['markup', 'script'], verificationRules: ['label'] },
  'fieldset': { transformType: 'add-fieldset-legend', fileGroups: ['markup'], verificationRules: ['fieldset'] },
  'color-contrast': { transformType: 'adjust-contrast-token', fileGroups: ['style'], verificationRules: ['color-contrast'] },
  'html-has-lang': { transformType: 'set-document-lang', fileGroups: ['markup'], verificationRules: ['html-has-lang'] },
  'valid-lang': { transformType: 'set-document-lang', fileGroups: ['markup'], verificationRules: ['valid-lang', 'html-has-lang'] },
  'page-has-heading-one': { transformType: 'add-primary-heading', fileGroups: ['markup'], verificationRules: ['page-has-heading-one'] },
  'heading-order': { transformType: 'fix-heading-order', fileGroups: ['markup'], verificationRules: ['heading-order'] },
};
// Pa11y warnings that cannot be fixed automatically (background images, etc.)
export const PERMANENTLY_MANUAL_PA11Y_CODES = new Set([
  'WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.BgImage',
  'WCAG2AA.Principle1.Guideline1_4.1_4_3.G145.BgImage',
  'WCAG2AA.Principle1.Guideline1_4.1_4_6.G17.BgImage',
]);

export const TRANSFORM_INSTRUCTIONS = {
  'set-alt-text': '- Only add or correct an existing alt attribute on the exact image or image-input element. Do not rewrite surrounding markup.',
  'set-accessible-name': '- Only add or correct aria-label / aria-labelledby / visible text on the exact interactive element. Do not rename classes or restructure containers.',
  'associate-accessible-label': '- Only add or connect an explicit label, aria-label, or aria-labelledby for the exact form control. Do not move fields or change business logic.',
  'add-fieldset-legend': '- Only add a minimal <legend> to the exact fieldset group. Do not change form layout.',
  'adjust-contrast-token': '- Only change foreground/background color tokens needed to satisfy contrast. Do not touch layout, spacing, or unrelated selectors.',
  'set-document-lang': '- Only add or correct the lang attribute on the root html element.',
  'add-primary-heading': `- This file is a DocumentTemplate (full HTML page wrapper) in an ASP.NET Razor app.
- The page title is available as @(deliveryModel.Title) — it's already used in <title> but not rendered as a visible heading.
- Add an <h1> element using @(deliveryModel.Title) as the content. Place it as the first element inside <body> (before @(deliveryModel.Body) or the content).
- Use a visually-hidden class if no visible heading is desired: <h1 class="sr-only">@(deliveryModel.Title)</h1>
- Do NOT add a hardcoded string. Do NOT add the heading inside a <script> block or after the body content.
- The sr-only class is already defined in the app's base styles (position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)).`,
  'fix-heading-order': '- Only adjust heading tags or levels needed to remove an invalid heading skip. Do not rewrite surrounding content.',
};

// JS-specific supplemental instructions when the target is a script file
export const JS_TRANSFORM_SUPPLEMENTS = {
  'set-alt-text': `- This is a JavaScript file that creates/manipulates DOM elements.
- Find the jQuery chain or DOM API call that creates or selects the <img> element.
- Add .attr('alt', '') for decorative images, or .attr('alt', 'descriptive text') for meaningful ones.
- Insert the .attr() call WITHIN an existing jQuery chain (before the semicolon), NOT after it.
- NEVER add .attr() after a line that ends with semicolon — that creates a syntax error.`,
  'set-accessible-name': `- This is a JavaScript file that creates/manipulates DOM elements.
- Find the jQuery chain or DOM API call that creates the interactive element (button, link, input).
- Add .attr('aria-label', '...') WITHIN the existing jQuery chain (before the semicolon).
- NEVER add .attr() after a semicolon-terminated statement.`,
  'associate-accessible-label': `- This is a JavaScript file that creates/manipulates form controls.
- Find where the input/textarea/select is created or modified.
- Add .attr('aria-label', '...') or wrap with a <label> via jQuery.
- Insert WITHIN the existing chain. Do NOT append method calls after a semicolon.`,
};

export function describeTransformInstructions(transformTypes, relFile = '') {
  const unique = [...new Set(transformTypes)].filter(Boolean);
  if (unique.length === 0) return '- No supported deterministic transform found.';
  const isJsFile = /\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(relFile);
  return unique.map(type => {
    let instruction = TRANSFORM_INSTRUCTIONS[type] || `- Apply only the deterministic transform: ${type}.`;
    if (isJsFile && JS_TRANSFORM_SUPPLEMENTS[type]) {
      instruction += '\n' + JS_TRANSFORM_SUPPLEMENTS[type];
    }
    return instruction;
  }).join('\n');
}
