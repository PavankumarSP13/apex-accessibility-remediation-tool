# Accessibility Tool — Unified Fix & Enhancement Plan

**Date:** June 16, 2026
**Status:** Verified — Ready for implementation
**Scope:** 20 items across 6 execution phases (~8 weeks)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State & Root Cause Analysis](#2-current-state--root-cause-analysis)
3. [Unified Fix Plan — All 20 Items](#3-unified-fix-plan--all-20-items)
4. [Phase-by-Phase Execution Schedule](#4-phase-by-phase-execution-schedule)
5. [Dependency Graph](#5-dependency-graph)
6. [Expected Impact Projections](#6-expected-impact-projections)
7. [Verification Checklist](#7-verification-checklist)

---

## 1. Executive Summary

The accessibility tool has a solid pipeline architecture (ingest → scan → analyze → remediate → verify → report) but suffers from two compounding failure modes:

1. **Classification leakage:** Issues that cannot realistically be auto-fixed still reach Copilot (wasted attempts), while some genuinely fixable issues get prematurely closed or blocked.
2. **Low fix success rate:** A combination of poor source mapping (fixer edits wrong file), insufficient context in prompts (fixer doesn't know what creates the element), limited retry budget, and .NET runtime coupling (fix lands in source but rescan hits stale compiled views).

Additionally, the scanning phase has significant **coverage gaps**: interaction-triggered DOM (modals, dropdowns, tabs), hidden-but-reachable elements, and Pa11y's fragile selectors all contribute noise and missing findings.

This plan merges **14 codebase fixes** (from pipeline audit) with **6 new enhancements** (scanning quality, source mapping, fixer context) into a single prioritized execution plan.

---

## 2. Current State & Root Cause Analysis

### 2.1 Current Pipeline Phases

| Phase | Module | Purpose |
|-------|--------|---------|
| 3a | `src/scanning/scan.js` → `phase3a_axe` | Axe-core DOM scan |
| 3b | `src/scanning/scan.js` → `phase3b_lighthouse` | Lighthouse audit |
| 3c | `src/scanning/keyboard-scan.js` → `phase3c_keyboard` | Keyboard/focus scan |
| 3e | `src/scanning/scan.js` → `phase3e_pa11y` | Pa11y HTML_CodeSniffer scan |
| 4 | `src/analyze.js` → `phase4_analyzeAndMap` | Merge, classify, map to source |
| 5 | `src/remediation/copilot-fix.js` → `phase5_copilot_fix` | Copilot fixer + challenger + verifier |
| 5b | `src/remediation/verify.js` → `preRescanValidation` | Pre-rescan build/blank-page checks |
| 6 | `src/remediation/rescan.js` → `phase6_rescan` | Full rescan + fingerprint diff |
| 7 | `src/judge.js` → `phase7_judge` | Judge evaluation |
| 8 | `src/reporting/report.js` | Final HTML/JSON/Excel report |

### 2.2 Root Causes — Classification Failures

| # | Root Cause | Location | Impact |
|---|-----------|----------|--------|
| C1 | Unsupported semantic stop is a no-op | `src/analyze.js:747-752` | Hard structural rules sent to Copilot; fail ~95% |
| C2 | Low-confidence mapping doesn't block attempts | `src/core/constants.js:282-288` | Fixer targets wrong file |
| C3 | "Already fixed" detector fires on partial evidence | `src/analyze.js:806-857` | Live failures prematurely closed |
| C4 | Pa11y fragile `nth-child` selectors → false positives | `src/scanning/scan.js:130+` | Noise reaches fixer |
| C5 | Third-party issues mis-categorized as UNSUPPORTED | `src/analyze.js:686-698` | Wrong reason codes, confuses triage |
| C6 | Plugin-generated-DOM over-fires on broad prefixes | `src/core/constants.js:144-153` | First-party elements blocked |
| C7 | Razor template discovery is hardcoded | `src/architecture/app-architecture.js:17-22` | .NET heading fixes hard-stopped |

### 2.3 Root Causes — Low Fix Success Rate

| # | Root Cause | Location | Impact |
|---|-----------|----------|--------|
| R1 | Default retry budget = 1 per batch | `src/remediation/copilot-fix.js:93,135` | Single miss = permanent failure |
| R2 | Shared fixer session drifts across issues | `src/remediation/copilot-fix.js:220-247` | Context bleed degrades late fixes |
| R3 | Live verifier is a stub (all deferred) | `src/remediation/copilot-fix.js:465-484` | No Phase 5 confirmation at all |
| R4 | `fixNeedsBuild` is extension-only | `src/remediation/patch.js:169-174` | .cshtml treated as hot-served |
| R5 | Blank-page rollback is single-shot | `src/remediation/verify.js:41-48` | Transient blank → all fixes lost |
| R6 | Report mixes deferred with true failures | `src/remediation/verify.js:206-217` | Perceived success lower than actual |
| R7 | Server lifecycle not managed after rebuild | `src/remediation/rescan.js:200-232` | Rescan hits stale runtime |
| R8 | Fingerprint matching too loose | `src/remediation/issue-fingerprints.js` | Ledger miscounts |

### 2.4 Root Causes — Scan Coverage Gaps

| # | Root Cause | Impact |
|---|-----------|--------|
| S1 | No scanning of interaction-triggered DOM | Dropdowns, modals, tabs = false negatives |
| S2 | No scanning of hidden-but-reachable elements | aria-hidden + tabindex elements missed |
| S3 | Fixer prompt only gets element HTML | Missing parent chain that identifies creation file |
| S4 | JS-generated elements have no source mapping | Fixer has zero context for dynamic DOM |

---

## 3. Unified Fix Plan — All 20 Items

### Legend

- **Type `FIX`** = Modify existing code
- **Type `NEW`** = Create new file/module
- **Effort** = estimated working days
- **Impact** = expected improvement on overall tool effectiveness

---

### FIX-01: Activate Unsupported Semantic Stop Gate

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | C1 |
| **Files** | `src/analyze.js:747-752` |
| **Effort** | 0.5 day |
| **Impact** | HIGH — stops ~15-30% of doomed attempts |

**Problem:** `applyUnsupportedSemanticStops()` is a no-op comment block. Complex structural rules (`heading-order`, `region`, `bypass`, `landmark-unique`) that require multi-element page-wide context are still classified `FIXABLE` and sent to Copilot, where they almost always fail.

**Fix:** Re-enable the function body. For each `FIXABLE` issue, check `isUnsupportedSemanticTransformIssue(issue)` (already defined at `src/core/constants.js:250-254` with `UNSUPPORTED_SEMANTIC_RULE_PATTERNS` at lines 175-183). Reclassify matching issues as `UNSUPPORTED_TRANSFORM`.

**Important nuance:** Preserve the existing `ATTEMPTABLE_SEMANTIC_RULE_PATTERNS` (lines 193-198) carve-out for `page-has-heading-one` and `landmark-one-main`, which ARE fixable when a mapped document template exists. The gate should only fire for the truly unsupported set:
- `heading-order`, `region`, `bypass`, `landmark-unique`, `H85.2`, `1_3_2`, `meaningful-sequence`

**Implementation:**
```js
// src/analyze.js:747-752 — Replace no-op with:
function applyUnsupportedSemanticStops(issues, mapping = []) {
  for (const issue of issues) {
    if (issue.solvability !== Solvability.FIXABLE) continue;
    if (isAttemptableSemanticTransformIssue(issue)) continue; // page-has-heading-one etc. stay fixable
    if (!isUnsupportedSemanticTransformIssue(issue)) continue;
    applySolvability(issue, {
      solvability: Solvability.UNSUPPORTED_TRANSFORM,
      reason: 'semantic-human-judgement-required',
    });
  }
}
```

---

### FIX-02: Block Low-Confidence Mapping from Fix Attempts

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | C2 |
| **Files** | `src/remediation/copilot-fix.js:194-200`, `src/core/constants.js:282-288` |
| **Effort** | 0.5 day |
| **Impact** | MEDIUM-HIGH — prevents blind edits on poorly-mapped issues |

**Problem:** Non-blocking manual-review tags (`insufficient-mapping-evidence`, `ambiguous-mapping`) are recorded but never prevent the issue from being attempted. Issues with no confident file mapping still enter Copilot.

**Fix:** In `shouldAttemptIssue()`, add a mapping-confidence check:

```js
// src/remediation/copilot-fix.js — add to shouldAttemptIssue():
function shouldAttemptIssue(issue, blockedByManualReview) {
  if (!issue || issue.manualOnly) return false;
  if (issue.fixerEligible === false) return false;
  if (NON_FIXABLE_SOLVABILITY.has(issue.solvability)) return false;
  if (blockedByManualReview.has(issue.id)) return false;
  // NEW: block issues with no mapping confidence
  const mc = issue.sourceMapping?.mappingConfidence;
  if (mc === 'none' || (mc === 'low' && !issue.sourceMapping?.primaryFile)) return false;
  return true;
}
```

---

### FIX-03: Increase Default Retry Budget (1 → 2 per batch)

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | R1 |
| **Files** | `src/remediation/copilot-fix.js:93, 135-139` |
| **Effort** | 0.25 day |
| **Impact** | MEDIUM — +10-20% resolution on "almost right" fixes |

**Problem:** When both batches are enabled (`defaultBothBatchesMode = true`), each batch gets exactly 1 attempt. A single transient LLM miss means the issue is permanently unresolved.

**Fix:** Change both `defaultBothBatchesMode ? 1 :` to `defaultBothBatchesMode ? 2 :`:

```js
// Line 93:
maxAttempts: defaultBothBatchesMode ? 2 : COPILOT_MAX_FIX_ATTEMPTS_TEMPLATE,

// Lines 135-139:
const fallbackAttempts = defaultBothBatchesMode
  ? 2
  : (skipBatch1
    ? Math.min(COPILOT_MAX_FIX_ATTEMPTS_FALLBACK, 2)
    : COPILOT_MAX_FIX_ATTEMPTS_FALLBACK);
```

---

### FIX-04: Harden Blank-Page Rollback with Retry

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | R5 |
| **Files** | `src/remediation/verify.js:41-48` |
| **Effort** | 0.5 day |
| **Impact** | MEDIUM — prevents false catastrophic rollbacks |

**Problem:** `preRescanValidation()` calls `validatePageNotBlank()` once. A transient skeleton/loading state triggers nuclear rollback of ALL fixes.

**Fix:** Retry blank-page check 3 times with 2-second delays and hard-reload between retries:

```js
// src/remediation/verify.js:41-48 — Replace single check with:
if (fixes.length > 0) {
  let pageOk = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    pageOk = await validatePageNotBlank(scanUrl);
    if (pageOk) break;
    if (attempt < 2) {
      console.log(chalk.dim(`  Page blank check attempt ${attempt + 1}/3 — retrying in 2s...`));
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!pageOk) {
    console.log(chalk.red('\n  Page appears blank after 3 checks. Rolling back ALL fixes.\n'));
    for (const f of fixes) await fs.writeFile(path.join(ingested.repoPath, f.file), f.original, 'utf-8');
    fixes.length = 0;
    report.fixes = [];
  }
}
```

---

### FIX-05: Separate "Source-Resolved" from Failures in Reporting

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | R6 |
| **Files** | `src/remediation/verify.js:206-217`, `src/reporting/report.js` |
| **Effort** | 1 day |
| **Impact** | HIGH — immediately improves perceived + actual success reporting |

**Problem:** The live verifier (`copilot-fix.js:465-484`) marks every fix as `deferred: true, resolved: false`. In the ledger, `UNSCORED_FIXABLE_STATUSES` (verify.js:206-213) excludes `pending-live-verification` from the success denominator entirely, making successful source patches invisible.

**Fix:**
1. Add a `sourcePatchedAwaitingVerification` counter to the verification summary object
2. In `isScoredFixableLedgerIssue()`, create a separate scoring path: `pending-live-verification` should count as "soft success" in a distinct metric
3. In the HTML report template, show a 3-tier result: confirmed resolved | source-patched (pending verification) | failed
4. Update the console summary line in `copilot-fix.js:163` to emphasize that deferred ≠ failed

---

### FIX-06: Fix "Already Fixed" Detector False Positives

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | C3 |
| **Files** | `src/analyze.js:806-857` |
| **Effort** | 1 day |
| **Impact** | MEDIUM-HIGH — stops premature closure of live-broken issues |

**Problem:** `detectAlreadyFixedInContent()` has overly broad heuristics:
- Line 819: `/<h1\b/i.test(content)` — marks `page-has-heading-one` as `ALREADY_FIXED` if ANY `<h1>` exists in ANY candidate file, even a partial template that doesn't render on the failing page
- Lines 822-836: button-name check accepts any `aria-label` in a 1100-char window (300 before + 800 after) around a class match, even if it's on a different element

**Fix:**
1. For `page-has-heading-one`: require the `<h1>` to be in a file classified as `document-template` by `classifyFileOwnership()`, not just any candidate
2. For `button-name`/`link-name`: require the `aria-label`/`aria-labelledby` to be on an element that matches at least one token from the violation's target selector (not just "nearby in source")
3. For all rules: only check the PRIMARY mapped file, not all candidates — reduces cross-file false matches

---

### FIX-07: Make `fixNeedsBuild` Path-Aware for .NET

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | R4 |
| **Files** | `src/remediation/patch.js:168-174`, `src/remediation/rescan.js:182-199`, `main.js:184-193` |
| **Effort** | 1.5 days |
| **Impact** | HIGH for .NET — fixes #1 false-negative source |

**Problem:** `STATIC_SERVE_EXTS` at `patch.js:169` includes `.cshtml` and `.razor` as "hot-served" (no build needed). In precompiled .NET apps with IIS/Kestrel, Razor views require `dotnet build` + app restart to take effect. The rescan hits stale compiled views.

**Fix:**
1. Add project-type detection: if `.csproj`/`.sln` was found during ingest (already checked in `rescan.js:27,53-54`), store a `projectType: 'dotnet'` flag on the ingested context
2. When `projectType === 'dotnet'`, override `STATIC_SERVE_EXTS` to exclude `.cshtml` and `.razor` — these always need build
3. Add a `--dotnet-precompiled` CLI flag for explicit override
4. After `rebuildProject()` succeeds, add an explicit wait + health check before rescan

**Call sites that need `projectType` propagation:**
- `src/remediation/verify.js:19` — `fixNeedsBuild(f.file)`
- `src/remediation/rescan.js:183` — `fixNeedsBuild(f.file)`
- `main.js:184` — `fixNeedsBuild(f.file)`

The default parameter `null` makes this backward-compatible, but all 3 call sites should be updated for full .NET coverage.

```js
// src/remediation/patch.js — modify fixNeedsBuild:
export function fixNeedsBuild(relFile, projectType = null) {
  const ext = path.extname(relFile).toLowerCase();
  // .NET projects: Razor views require rebuild even though they look like templates
  if (projectType === 'dotnet' && (ext === '.cshtml' || ext === '.razor')) return true;
  return !STATIC_SERVE_EXTS.has(ext);
}
```

---

### FIX-08: Broaden Razor Document-Template Discovery

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | C7 |
| **Files** | `src/architecture/app-architecture.js:17-25, 76-105`, `src/analyze.js:1096-1120` |
| **Effort** | 2 days |
| **Impact** | HIGH for .NET — unblocks heading/page-level fixes |

**Problem:** `DOCUMENT_TEMPLATES` is a hardcoded set of 14 specific filenames. `classifyFileOwnership()` requires exact basename match + content signature (`<!doctype html` or `deliverymodel`). The analysis heading-search only looks in two specific directories for `.cshtml`. Any .NET app with different naming/folder structure gets `heading-rule-no-document-template-found` → hard-stop `UNSUPPORTED_TRANSFORM`.

**Fix:**
1. Add a dynamic discovery pass: scan all `.cshtml`/`.razor` files for `<!doctype html` or `<html` tag to auto-identify document templates
2. Keep hardcoded sets as high-priority hints (they're correct for the known target app)
3. If dynamic discovery finds document templates that aren't in the hardcoded set, use them as fallback candidates instead of hard-stopping
4. Change `heading-rule-no-document-template-found` from a hard-stop to a soft-stop when dynamic candidates exist

---

### FIX-09: Scope Copilot Fixer Sessions Per-Issue

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | R2 |
| **Files** | `src/remediation/copilot-fix.js:219-320` |
| **Effort** | 2 days |
| **Impact** | MEDIUM-HIGH — significant quality improvement for runs with >5 issues |

**Problem:** A single `fixer` agent session is created and reused via `followUp()` across all unresolved issues (line 245). As issues accumulate, the context window fills with prior fix attempts, JSON output becomes inconsistent, and later issues get degraded quality.

**Fix:** Create a fresh `createCopilotAgent()` for each issue (or small batches of 3-5 related issues grouped by mapped file). Dispose after each batch. This isolates context and prevents cross-contamination.

**Tradeoff:** More API calls per run. Mitigate by grouping issues that target the same file into a single session. Note: isolated sessions lose cross-issue repo context; file-based grouping is essential to preserve quality for related issues.

**Risk note:** The current shared-session model lets the fixer build up repo understanding across issues. The grouping-by-file strategy must preserve this benefit for co-located issues.

---

### FIX-10: Add Targeted Live Verification in Phase 5

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | R3 |
| **Files** | `src/remediation/copilot-fix.js:465-484` |
| **Effort** | 3 days |
| **Impact** | HIGH — converts "deferred" to "confirmed/failed" immediately |

**Problem:** `runLiveVerifier()` is a stub that marks everything as `deferred: true`. No actual DOM check happens in Phase 5. All real verification is deferred to Phase 6 full rescan.

**Fix:** For each fixed issue with a stable selector:
1. Load the target page in a lightweight Playwright context
2. Run a scoped Axe check for just the specific rule ID: `new AxeBuilder({ page }).include(selector).withRules([ruleId]).analyze()`
3. If violation is absent → `resolved: true`
4. If violation persists → `resolved: false` (give challenger/retry another shot)

**Dependency:** Benefits from ENH-01 (selector validation) for stable selectors.

---

### FIX-11: Improve Third-Party Classification Path

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | C5 |
| **Files** | `src/analyze.js:686-698`, `src/core/constants.js` |
| **Effort** | 1 day |
| **Impact** | MEDIUM — more accurate reason codes |

**Problem:** Third-party files are filtered from mapping candidates early. Issues caused by third-party code end up as `UNSUPPORTED_TRANSFORM (no-candidate-files)` instead of `THIRD_PARTY_ASSET`, inflating the "unsupported" bucket.

**Fix:** Before applying `no-candidate-files`, check if the filtered-out candidates were all third-party. If so, classify as `THIRD_PARTY_ASSET` with evidence showing which third-party file(s) were the only candidates.

---

### FIX-12: Server Lifecycle Management for .NET Rescan

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | R7 |
| **Files** | `src/remediation/rescan.js:115-126, 200-232`, `src/core/cli.js` |
| **Effort** | 5 days |
| **Impact** | HIGH for .NET — eliminates "stale runtime" class of false negatives |

**Problem:** After patching Razor/CS files, `rebuildProject()` does `dotnet build` but doesn't restart the server process. `waitForUserPrompt()` with 60-second timeout is the only fallback. For non-interactive CI runs, this means rescan always hits stale binary.

**Fix:**
1. Add `--restart-command "dotnet run"` CLI option
2. If the tool launched the server (trackable via `devServer`), kill + relaunch after rebuild
3. For external servers (`--url+--local`), detect process ID by port, attempt graceful restart
4. Add content-aware health check: verify response body changed (not just HTTP 200)
5. Increase wait-after-rebuild to 5s+ for .NET cold start

---

### FIX-13: Richer Issue Fingerprinting for Ledger Accuracy

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | R8 |
| **Files** | `src/remediation/issue-fingerprints.js` |
| **Effort** | 3 days |
| **Impact** | MEDIUM — more accurate before/after comparison |

**Problem:** Issue fingerprints use loose text-based matching. Dynamic IDs, reordered DOM, and volatile selectors cause phantom "introduced" issues and failure to match "persistent" ones.

**Fix:** Multi-key matching strategy:
1. **Exact key**: rule + page + normalized selector + normalized element text
2. **Structural key**: rule + page + tag + role + ARIA attributes (ignoring volatile IDs)
3. **Loose key**: rule + page + normalized description text
4. Match in priority order with confidence weighting. Only report "introduced" when no structural match exists.

---

### FIX-14: Refine Plugin-Generated-DOM Detection

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | C6 |
| **Files** | `src/core/constants.js:144-153, 219-233` |
| **Effort** | 1 day |
| **Impact** | MEDIUM — reduces false blocking of first-party elements |

**Problem:** Prefix-based signatures (`sp-`, `Mui`, `ant-`, `ui-`, `k-`) can match first-party DOM. jQuery UI's `ui-` prefix already has `minPrefixMatches: 2` but others don't.

**Fix:** Require 2+ signals before classifying as `PLUGIN_GENERATED_DOM`:
1. Prefix match in DOM tokens
2. Absence from source index (no candidate file contains these tokens)
3. No source mapping candidate exists

Add an `override` mechanism in mapping entries for known first-party elements that happen to use plugin-like prefixes.

---

### ENH-01: Pa11y Selector Validation (False Positive Filter)

| Field | Value |
|-------|-------|
| **Type** | NEW |
| **Addresses** | C4, S3 |
| **New File** | `src/scanning/selector-validator.js` |
| **Modifies** | `src/scanning/scan.js` (phase3e_pa11y), `src/core/constants.js` (classifyIssueSolvability) |
| **Effort** | 2 days |
| **Impact** | HIGH — immediately cuts Pa11y false positives |

**Problem:** Pa11y reports issues with fragile `html > body > div:nth-child(39) > ...` selectors that shift between renders.

**Solution:** After Pa11y completes, validate every issue by building a semantic selector from `issue.context` HTML and probing the live DOM.

**Semantic selector builder priority:**
1. Element has `id` → `#myId`
2. `data-*` attributes → `button[data-toolname="line"]`
3. ARIA attributes → `[role="menuitem"][aria-label="Save"]`
4. Unique class combination (>=2) → `button.sadtTool.active`
5. Single specific class → `.sadtTool`
6. Fallback → mark `selectorStable: false`, keep issue for report but exclude from fixer

**Integration:** Called inside `phase3e_pa11y` in `scan.js` after Pa11y completes, using the same Playwright page. Issues with `selectorStable === false` are classified as `MANUAL_VERIFICATION` with reason `selector-unstable` in `classifyIssueSolvability`.

**Key rule:** Never drop an issue solely on selector failure — flag it, keep it in the HTML report for human review, but exclude from Copilot.

---

### ENH-02: Hidden Element Scan

| Field | Value |
|-------|-------|
| **Type** | NEW |
| **Addresses** | S2 |
| **Modifies** | `src/scanning/scan.js` (add phase3f_hiddenElements) |
| **Effort** | 1 day |
| **Impact** | MEDIUM — catches reachable-but-hidden a11y violations |

**Problem:** Elements with `aria-hidden="true"` that have `tabindex >= 0` are keyboard-reachable but not consistently scanned.

**Solution:** After static scan, explicitly find and flag:
1. `[aria-hidden="true"]` elements that also have `tabindex >= 0` or contain `[tabindex]` descendants
2. `[aria-expanded]` controls whose `aria-controls` target has `display: none` (will become visible on interaction)

Tag results with `source: 'hidden-scan'`. Drop issues inside permanently-hidden elements (no path to becoming visible).

---

### ENH-03: Interaction Scan (Phase 3d)

| Field | Value |
|-------|-------|
| **Type** | NEW |
| **Addresses** | S1 |
| **New File** | `src/scanning/interaction-scan.js` |
| **Modifies** | `main.js` (add to Phase 3 orchestration) |
| **Effort** | 4 days |
| **Impact** | VERY HIGH — finds the hardest, currently-invisible issues |

**Problem:** Dropdown menus, modals, dialogs, tab panels, tooltips contain accessibility issues but are not in the DOM during static scan.

**Solution:** New `phase3d_interaction` that:

1. **Enumerates triggers:** `[aria-expanded]`, `[aria-haspopup]`, `[role="tab"]`, `[aria-describedby]`
2. **Determines trigger key by role:** tabs → ArrowRight, listbox → ArrowDown, default → Enter
3. **Fires trigger with MutationObserver:** captures added nodes, waits 500ms for DOM settle
4. **Runs scoped Axe on new content:** `new AxeBuilder({ page }).include(scanTarget).analyze()`
5. **Closes interaction state:** Escape → fallback click toggle → wait 200ms
6. **Deduplicates against static issues:** using `domTokenFingerprint()` (tag + class + data-attrs)

All issues tagged `source: 'interaction'` with `triggerSelector` and `triggerType` metadata.

---

### ENH-04: DOM Context Enrichment (Parent Chain + Siblings)

| Field | Value |
|-------|-------|
| **Type** | NEW |
| **Addresses** | S3 |
| **New File** | `src/scanning/dom-enricher.js` |
| **Modifies** | `src/analyze.js` (phase4 integration) |
| **Effort** | 2 days |
| **Impact** | HIGH — foundation for accurate source mapping and fixer context |

**Problem:** Flagged elements are often generic (`<button>`, `<div>`). Their ancestors carry the identity tokens (IDs, data attributes, specific class names) needed to grep the repo and find the creation site.

**Solution:** For every issue with a stable selector, extract:
1. **Parent chain** (up to 5 levels): tag, id, classes, data-attrs, role, aria-label
2. **Siblings** (up to 6): tag, text content, `for` attribute, classes — for label association context
3. **Children** (up to 5): tag, classes, text, src — for structural identity

**Token extraction for source grep** (`extractGrepTokens()`):
- Priority 1: IDs in parent chain
- Priority 2: `data-*` attributes (element + parents)
- Priority 3: Specific parent class names (>4 chars, not generic utility classes)
- Priority 4: Sibling label text (for form elements)

Stored as `issue.domContext` for downstream use by ENH-05 and ENH-06.

---

### ENH-05: DOM Source Tracer (Repo Grep)

| Field | Value |
|-------|-------|
| **Type** | NEW |
| **Addresses** | S4 |
| **New File** | `src/scanning/dom-source-tracer.js` |
| **Depends On** | ENH-04 |
| **Modifies** | `src/analyze.js` (phase4 integration) |
| **Effort** | 2 days |
| **Impact** | HIGH — unlocks JS-generated element fixes |

**Problem:** JS-generated elements have no template file. The fixer has no idea which `.js`/`.ts` file creates the DOM element.

**Solution:** Systematic repo grep using tokens from ENH-04:
1. For each token (sorted by priority), grep the repo (`*.js`, `*.ts`, `*.cshtml`, `*.razor`, `*.html`)
2. Score matches: JS/TS files creating DOM score highest (+10), `.cshtml`/`.razor` +8, createElement/innerHTML patterns +5, test/vendor files -10
3. Return best match with file, line number, 25-line snippet, and all top-3 candidates

Stored as `issue.jsCreationSite` for use by ENH-06.

**Performance guard:** 5-second timeout per grep, skip tokens <4 chars, cap at first successful match per issue.

---

### ENH-06: Enriched Fixer Prompt

| Field | Value |
|-------|-------|
| **Type** | FIX |
| **Addresses** | S3, S4 |
| **Depends On** | ENH-04, ENH-05 |
| **Files** | `src/remediation/copilot-fix.js:924-947` (`toPromptIssue`) |
| **Effort** | 1 day |
| **Impact** | HIGH — directly improves fix accuracy |

**Problem:** Current `toPromptIssue()` sends: `element HTML`, `selector`, `failureSummary`, `sourceMapping`, `wcag`. The fixer often edits the wrong file or gives up because it can't locate the creation site.

**Fix:** Extend `toPromptIssue()` with data from ENH-04 and ENH-05:

```js
function toPromptIssue(issue) {
  const prompt = {
    // ... existing fields (issueId, ruleId, source, impact, etc.) ...

    // NEW: Parent chain for creation-site identification
    domParentChain: issue.domContext?.parents?.map(p =>
      `${p.tag}${p.id ? '#'+p.id : ''}${p.classes?.length ? '.'+p.classes.join('.') : ''}` +
      `${Object.keys(p.dataAttrs||{}).length ? ' ['+Object.entries(p.dataAttrs).map(([k,v])=>`${k}="${v}"`).join(' ')+']' : ''}`
    ).join(' > ') || null,

    // NEW: Sibling context for label/association
    siblingsContext: issue.domContext?.siblings?.map(s =>
      `${s.tag}${s.forAttr ? `[for="${s.forAttr}"]` : ''}: "${s.text}"`
    ).join(', ') || null,

    // NEW: JS creation site from DOM source trace
    jsCreationSite: issue.jsCreationSite ? {
      file: issue.jsCreationSite.file,
      line: issue.jsCreationSite.line,
      via: issue.jsCreationSite.via,
      snippet: issue.jsCreationSite.snippet,
    } : null,

    // NEW: Interaction trigger context
    isInteractionTriggered: issue.source === 'interaction',
    triggerSelector: issue.triggerSelector || null,
  };
  // ... existing WCAG enrichment ...
  return prompt;
}
```

---

## 4. Phase-by-Phase Execution Schedule

### Phase 1 — Quick Classification Wins (Week 1)

| Item | Days | Files Modified |
|------|------|---------------|
| FIX-01: Activate unsupported semantic stop | 0.5 | `src/analyze.js` |
| FIX-02: Block low-confidence mapping | 0.5 | `src/remediation/copilot-fix.js`, `src/core/constants.js` |
| FIX-03: Increase retry budget (1→2) | 0.25 | `src/remediation/copilot-fix.js` |
| FIX-05: Separate source-resolved in reporting | 1.0 | `src/remediation/verify.js`, `src/reporting/report.js`, `src/remediation/copilot-fix.js` |
| **Phase 1 Total** | **~2.5 days** | |

**Verification:** Run `node agent.js --help` to confirm no crashes. Run a scan against the target app with `--fix` and compare classification breakdown + reported success counts vs. a baseline run.

### Phase 2 — Scan Quality & Safety (Week 2)

| Item | Days | Files Modified / Created |
|------|------|--------------------------|
| ENH-01: Pa11y selector validation | 2.0 | NEW `src/scanning/selector-validator.js`, MOD `src/scanning/scan.js`, `src/core/constants.js` |
| FIX-06: Fix already-fixed detector | 1.0 | `src/analyze.js` |
| FIX-04: Harden blank-page rollback | 0.5 | `src/remediation/verify.js` |
| **Phase 2 Total** | **~3.5 days** | |

**Verification:** Run Pa11y scan, check that issues now have `selectorStable` flags. Verify no legitimate issues were dropped. Trigger blank-page scenario to confirm retry behavior.

### Phase 3 — Source Mapping Foundation (Week 3)

| Item | Days | Files Modified / Created |
|------|------|--------------------------|
| ENH-04: DOM context enrichment | 2.0 | NEW `src/scanning/dom-enricher.js`, MOD `src/analyze.js` |
| ENH-05: DOM source tracer | 2.0 | NEW `src/scanning/dom-source-tracer.js`, MOD `src/analyze.js` |
| **Phase 3 Total** | **~4 days** | |

**Verification:** Run scan, inspect `issue.domContext` and `issue.jsCreationSite` in `report.json`. Verify parent chains are populated and source traces point to plausible creation files.

### Phase 4 — Fixer Improvements (Week 4)

| Item | Days | Files Modified / Created |
|------|------|--------------------------|
| ENH-06: Enriched fixer prompt | 1.0 | `src/remediation/copilot-fix.js` |
| FIX-09: Per-issue fixer sessions | 2.0 | `src/remediation/copilot-fix.js` |
| FIX-07: fixNeedsBuild path-aware | 1.5 | `src/remediation/patch.js`, `src/remediation/rescan.js`, `main.js` |
| **Phase 4 Total** | **~4.5 days** | |

**Verification:** Run `--fix` scan. Confirm each issue gets isolated fixer context (check agent trail). Verify .NET Razor files trigger rebuild.

### Phase 5 — Coverage Expansion + .NET (Weeks 5-6)

| Item | Days | Files Modified / Created |
|------|------|--------------------------|
| ENH-03: Interaction scan | 4.0 | NEW `src/scanning/interaction-scan.js`, MOD `main.js` |
| ENH-02: Hidden element scan | 1.0 | MOD `src/scanning/scan.js` |
| FIX-08: Broaden Razor template discovery | 2.0 | `src/architecture/app-architecture.js`, `src/analyze.js` |
| FIX-10: Targeted live verification | 3.0 | `src/remediation/copilot-fix.js` |
| **Phase 5 Total** | **~10 days** | |

**Verification:** Run interaction scan, verify triggers are enumerated and new issues found. Confirm .NET template discovery works for non-hardcoded layouts. Verify Phase 5 live checks produce confirmed/failed status.

### Phase 6 — Architectural Hardening (Month 2)

| Item | Days | Files Modified / Created |
|------|------|--------------------------|
| FIX-11: Third-party classification path | 1.0 | `src/analyze.js`, `src/core/constants.js` |
| FIX-14: Plugin-generated-DOM refinement | 1.0 | `src/core/constants.js` |
| FIX-12: Server lifecycle management | 5.0 | `src/remediation/rescan.js`, `src/core/cli.js` |
| FIX-13: Richer issue fingerprinting | 3.0 | `src/remediation/issue-fingerprints.js` |
| **Phase 6 Total** | **~10 days** | |

**Verification:** End-to-end .NET scan with `--fix` in CI mode. Verify server restarts automatically, fingerprint matching is accurate, and classification reason codes are correct.

---

## 5. Dependency Graph

```
Phase 1 (standalone, no deps)
├── FIX-01  ─────────────────────────────────────────────────┐
├── FIX-02                                                    │
├── FIX-03                                                    │
└── FIX-05                                                    │
                                                              │
Phase 2 (standalone, no deps)                                 │
├── ENH-01 ──────────────────────────────────┐                │
├── FIX-06                                   │                │
└── FIX-04                                   │                │
                                             │                │
Phase 3 (standalone)                         │                │
├── ENH-04 ──────────┐                       │                │
└── ENH-05 ──────────┤ (depends on ENH-04)   │                │
                     │                       │                │
Phase 4              │                       │                │
├── ENH-06 ──────────┘ (depends on ENH-04+05)│                │
├── FIX-09                                   │                │
└── FIX-07                                   │                │
                                             │                │
Phase 5                                      │                │
├── ENH-03                                   │                │
├── ENH-02                                   │                │
├── FIX-08                                   │                │
└── FIX-10 ──────────────────────────────────┘ (benefits from ENH-01)
                                                              │
Phase 6                                                       │
├── FIX-11 ──────────────────────────────────────────────────┘ (benefits from FIX-01)
├── FIX-14
├── FIX-12
└── FIX-13
```

**Critical path:** ENH-04 → ENH-05 → ENH-06 (source mapping chain)
**Parallel safe:** Phases 1 + 2 can run concurrently. FIX-11/14 are independent of ENH-* chain.

---

## 6. Expected Impact Projections

### After Phase 1 Only (~1 week)

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Issues incorrectly sent to Copilot | ~30-40% | ~10-15% | -20-25% |
| Reported success rate (includes deferred) | ~15-25% | ~35-45% | +15-25% (mostly reporting fix) |
| API cost per run | baseline | ~85% of baseline | -15% (fewer doomed attempts) |

### After Phases 1-2 (~2 weeks)

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Pa11y false positive rate | ~20-30% | ~5-10% | -15-20% |
| False "already fixed" closures | ~5-10% of issues | ~1-2% | -5-8% |
| False catastrophic rollbacks | occasional | rare | significant improvement |

### After Phases 1-4 (~4 weeks)

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| True fix success rate (source patches that work) | ~20-30% | ~50-65% | +25-35% |
| Source mapping accuracy | ~40-60% | ~70-85% | +25-30% |
| Fixer "wrong file" rate | ~25-35% | ~10-15% | -15-20% |

### After All Phases (~8 weeks)

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| True fix success rate | ~20-30% | ~60-75% | +35-45% |
| Issue coverage (incl. interaction DOM) | ~60-70% | ~85-95% | +20-25% |
| Classification accuracy | ~60-70% | ~85-90% | +20-25% |
| .NET rescan accuracy | ~40-50% | ~80-90% | +35-45% |
| End-to-end report trustworthiness | Low-Medium | High | qualitative leap |

---

## 7. Verification Checklist

Before marking each phase complete, verify:

### Per-Phase Gates

- [ ] **Phase 1:** Classification breakdown shows fewer FIXABLE issues (doomed ones moved to UNSUPPORTED/MANUAL). Report shows source-patched count separately from failures. `node agent.js --help` works.
- [ ] **Phase 2:** Pa11y issues have `selectorStable` field. No legitimate issues dropped. Already-fixed detector doesn't close issues that fail in live scan. Blank-page rollback requires 3 failures.
- [ ] **Phase 3:** `report.json` contains `domContext` and `jsCreationSite` for most fixable issues. Parent chains have meaningful tokens (IDs, data-attrs, specific classes).
- [ ] **Phase 4:** Agent trail shows each issue got fresh fixer context. Prompt includes parent chain and JS creation site. .NET Razor files trigger rebuild.
- [ ] **Phase 5:** Interaction scan finds issues in at least 1 dropdown/modal/tab if present. Hidden element scan catches `aria-hidden` + `tabindex` cases. Phase 5 live verification produces confirmed/failed (not all deferred).
- [ ] **Phase 6:** Third-party issues show correct reason code. Server restarts after rebuild in CI mode. Fingerprint matching produces fewer phantom "introduced" issues.

### End-to-End Validation

- [ ] Run full `--fix` scan against target .NET app
- [ ] Compare classification breakdown with pre-fix baseline
- [ ] Verify success rate improved (true positives)
- [ ] Verify no regression in false positives
- [ ] Check HTML report for clear 3-tier results (confirmed | pending | failed)
- [ ] Verify interaction-triggered issues appear in report
- [ ] Confirm .NET rebuild + restart cycle works end-to-end

---

## 8. Risk Assessment

| Item | Risk Level | Risk Description | Mitigation |
|------|-----------|------------------|------------|
| FIX-01 | LOW | May block issues the fixer could now handle | `isAttemptableSemanticTransformIssue()` carve-out preserves `page-has-heading-one`/`landmark-one-main`. Monitor classification breakdown for over-blocking. |
| FIX-02 | MEDIUM | May prevent attempts where fixer would self-discover the target file via repo tools | Start with `mappingConfidence === 'none'` only; expand to `'low'` after observing impact. |
| FIX-03 | LOW | Doubles API cost for both-batches path | No functional risk. Cost increase is bounded and justified by +10-20% resolution. |
| FIX-06 | LOW (soft dep on FIX-08) | Before FIX-08 lands, non-standard .NET layouts still get false "already fixed" | Acceptable phasing — FIX-06 is still a net improvement for the known target app. |
| FIX-07 | LOW | Signature change to `fixNeedsBuild(relFile, projectType)` | Default `null` preserves backward compatibility. All 3 call sites continue working. |
| FIX-09 | MEDIUM | Isolated sessions lose cross-issue repo context | Group by mapped file. Monitor for quality regression on multi-issue runs. |
| FIX-12 | LOW (soft dep on FIX-07) | Needs `projectType: 'dotnet'` flag from FIX-07 to know when to restart | Correctly phased (FIX-07 in Phase 4, FIX-12 in Phase 6). |
| ENH-03 | MEDIUM | Interaction triggers may alter page state, affecting subsequent scans | Run interaction scan LAST in Phase 3. Reset page state after each trigger. Consider running in isolated browser context. |

---

## Summary — What Each Item Solves

| Item | Solves | Category |
|------|--------|----------|
| FIX-01 | Doomed structural issues reaching Copilot | Classification precision |
| FIX-02 | Blind edits on poorly-mapped issues | Classification precision |
| FIX-03 | Single-miss permanent failure | Remediation mechanics |
| FIX-04 | False catastrophic rollbacks | Verification safety |
| FIX-05 | Source-patched = reported as failure | Reporting accuracy |
| FIX-06 | Live failures prematurely closed | Classification precision |
| FIX-07 | .NET Razor treated as hot-served | .NET runtime coupling |
| FIX-08 | Non-standard .NET layouts hard-stopped | .NET compatibility |
| FIX-09 | Context bleed across issues | Remediation quality |
| FIX-10 | No Phase 5 confirmation at all | Verification completeness |
| FIX-11 | Third-party mis-categorized as unsupported | Classification accuracy |
| FIX-12 | Rescan hits stale .NET runtime | .NET runtime coupling |
| FIX-13 | Phantom introduced issues in ledger | Verification accuracy |
| FIX-14 | First-party elements blocked as plugin DOM | Classification accuracy |
| ENH-01 | Pa11y nth-child false positives | Scan precision |
| ENH-02 | Hidden-but-reachable elements missed | Scan recall |
| ENH-03 | Interaction DOM (modals, dropdowns, tabs) | Scan recall |
| ENH-04 | Generic elements with no identity context | Source mapping accuracy |
| ENH-05 | JS-generated DOM has no template mapping | Fixer context |
| ENH-06 | Copilot editing wrong file or giving up | Fix success rate |
