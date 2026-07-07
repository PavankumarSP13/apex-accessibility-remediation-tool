export const WCAG_CRITERIA = new Map([
  ['image-alt', {
    sc: '1.1.1 Non-text Content (Level A)',
    requirement: 'All non-text content has a text alternative that serves the equivalent purpose.',
    technique: 'H37: Using alt attributes on img elements. Use alt="" for decorative images.',
  }],
  ['input-image-alt', {
    sc: '1.1.1 Non-text Content (Level A)',
    requirement: 'Image inputs must have accessible text describing their function.',
    technique: 'H36: Using alt attributes on image submit buttons.',
  }],
  ['image-redundant-alt', {
    sc: '1.1.1 Non-text Content (Level A)',
    requirement: 'Alt text should not duplicate adjacent text content.',
    technique: 'H2: Combining adjacent image and text links for the same resource.',
  }],
  ['button-name', {
    sc: '4.1.2 Name, Role, Value (Level A)',
    requirement: 'Every button must have an accessible name (visible text, aria-label, or aria-labelledby).',
    technique: 'ARIA14: Using aria-label. ARIA16: Using aria-labelledby.',
  }],
  ['link-name', {
    sc: '2.4.4 Link Purpose (Level A)',
    requirement: 'Every link must have text that describes its purpose.',
    technique: 'H30: Providing link text. ARIA7: Using aria-labelledby. ARIA8: Using aria-label.',
  }],
  ['input-button-name', {
    sc: '4.1.2 Name, Role, Value (Level A)',
    requirement: 'Input buttons must have accessible text.',
    technique: 'H91: Use value attribute on input type=submit/reset/button.',
  }],
  ['label', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'Form controls must have associated labels.',
    technique: 'H44: Using label elements. H65: Using title attribute. ARIA16: Using aria-labelledby.',
  }],
  ['aria-input-field-name', {
    sc: '4.1.2 Name, Role, Value (Level A)',
    requirement: 'ARIA input fields must have an accessible name.',
    technique: 'ARIA14: Using aria-label. ARIA16: Using aria-labelledby.',
  }],
  ['select-name', {
    sc: '4.1.2 Name, Role, Value (Level A)',
    requirement: 'Select elements must have an accessible name.',
    technique: 'H44: Using label elements. H65: Using title. ARIA14: Using aria-label.',
  }],
  ['fieldset', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'Related form controls grouped in fieldset must have a legend.',
    technique: 'H71: Providing a description for groups of form controls using fieldset and legend.',
  }],
  ['color-contrast', {
    sc: '1.4.3 Contrast (Minimum) (Level AA)',
    requirement: 'Text must have contrast ratio >= 4.5:1 (normal) or >= 3:1 (large text, 18pt+ or 14pt+ bold).',
    technique: 'G18: Ensuring minimum contrast ratio. G145: For large text.',
  }],
  ['html-has-lang', {
    sc: '3.1.1 Language of Page (Level A)',
    requirement: 'The html element must have a valid lang attribute.',
    technique: 'H57: Using the language attribute on the HTML element.',
  }],
  ['valid-lang', {
    sc: '3.1.2 Language of Parts (Level AA)',
    requirement: 'The lang attribute must use a valid BCP 47 language tag.',
    technique: 'H58: Using language attributes to identify changes in the human language.',
  }],
  ['page-has-heading-one', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'Pages should have a level-one heading that describes the page topic.',
    technique: 'G141: Organizing a page using headings. H42: Using h1-h6 to identify headings.',
  }],
  ['heading-order', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'Heading levels should not skip (e.g., h1 then h3 without h2).',
    technique: 'G141: Heading levels increase by one. Do not skip levels.',
  }],
  ['region', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'All page content should be contained by landmarks (main, nav, aside, header, footer).',
    technique: 'ARIA11: Using ARIA landmarks. Wrap main content in <main> element.',
  }],
  ['landmark-one-main', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'Page must have exactly one main landmark.',
    technique: 'ARIA11: Add <main> element or role="main" to the primary content area.',
  }],
  ['landmark-unique', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'Landmarks of the same type must have unique labels.',
    technique: 'ARIA6: Using aria-label to provide labels for landmarks.',
  }],
  ['bypass', {
    sc: '2.4.1 Bypass Blocks (Level A)',
    requirement: 'A mechanism must exist to skip repetitive navigation blocks.',
    technique: 'G1: Adding a skip navigation link at the top of each page. G124: Adding links to navigate to related content.',
  }],
  ['document-title', {
    sc: '2.4.2 Page Titled (Level A)',
    requirement: 'Web pages must have titles that describe topic or purpose.',
    technique: 'H25: Providing a title using the title element.',
  }],
  ['meta-viewport', {
    sc: '1.4.4 Resize Text (Level AA)',
    requirement: 'Content must be zoomable. Do not set maximum-scale=1.0 or user-scalable=no.',
    technique: 'G142: Using a technology that has commonly-available user agents that support zoom.',
  }],
  ['duplicate-id', {
    sc: '4.1.1 Parsing (Level A)',
    requirement: 'ID attributes must be unique within a page.',
    technique: 'H93: Ensuring id attributes are unique. F77: Failure due to duplicate id values.',
  }],
  ['frame-title', {
    sc: '2.4.1 Bypass Blocks (Level A)',
    requirement: 'Frames and iframes must have a descriptive title attribute.',
    technique: 'H64: Using the title attribute of the frame and iframe elements.',
  }],
  ['aria-required-parent', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'ARIA roles must be contained within required parent roles.',
    technique: 'Ensure elements with ARIA roles are nested inside their required context roles.',
  }],
  ['aria-required-children', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'ARIA roles that require child roles must contain them.',
    technique: 'Ensure parent ARIA roles contain their required child roles.',
  }],
  ['tabindex', {
    sc: '2.4.3 Focus Order (Level A)',
    requirement: 'Tabindex > 0 disrupts natural focus order and should be avoided.',
    technique: 'Use tabindex="0" for custom focusable elements. Never use positive tabindex values.',
  }],
  ['definition-list', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'dl elements must only contain dt and dd groups or script/template elements.',
    technique: 'H40: Using description lists. Ensure proper nesting.',
  }],
  ['listitem', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'li elements must be contained in ul or ol.',
    technique: 'H48: Using ol, ul, and li for lists.',
  }],
  ['list', {
    sc: '1.3.1 Info and Relationships (Level A)',
    requirement: 'ul and ol must only contain li, script, or template elements.',
    technique: 'H48: Ensure proper list structure.',
  }],
  ['nested-interactive', {
    sc: '4.1.2 Name, Role, Value (Level A)',
    requirement: 'Interactive elements must not be nested inside other interactive elements.',
    technique: 'Remove the nested interactive element or restructure as siblings.',
  }],
  ['svg-img-alt', {
    sc: '1.1.1 Non-text Content (Level A)',
    requirement: 'SVG elements with role="img" must have an accessible name.',
    technique: 'Add title element inside SVG, or use aria-label/aria-labelledby.',
  }],
  ['role-img-alt', {
    sc: '1.1.1 Non-text Content (Level A)',
    requirement: 'Elements with role="img" must have an accessible name.',
    technique: 'Use aria-label or aria-labelledby on the element with role="img".',
  }],
]);

export function getWcagCriteriaForRule(ruleId) {
  const normalized = String(ruleId || '').toLowerCase();
  return WCAG_CRITERIA.get(normalized) || null;
}
