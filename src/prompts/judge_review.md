Formal accessibility fix review:
{{lighthouse_invalid_note}}{{axe_scan_failed_note}}{{pa11y_scan_failed_note}}
BEFORE/AFTER METRICS:
Axe violations:    {{before_axe_count}} -> {{after_axe_count}}  (critical: {{before_critical_count}}->{{after_critical_count}}, serious: {{before_serious_count}}->{{after_serious_count}})
Lighthouse score:  {{before_lighthouse_score}} -> {{after_lighthouse_score}}
pa11y errors:      {{before_pa11y_errors}} -> {{after_pa11y_errors}}
Resolution rate (live-confirmed fixable-only, score driver): {{fixable_resolved_count}}/{{fixable_total}} fixable violations
Overall baseline context: {{resolved_total_count}}/{{total_baseline_entries}} total baseline violations resolved
Scored fixable violations: {{fixable_total}} (excludes {{non_fixable_total}} non-fixable/manual-only/closed or unavailable-to-verify entries: already-fixed source findings, third-party assets, plugin-generated DOM, duplicate root-cause findings, scanner audit/manual-verification warnings, unsupported transforms, scan-failed/static-unconfirmed)
NOTE: Non-fixable violations may be in plugin/third-party rendered DOM (WRS/Wiris equation editor, MathJax, Spectrum, TinyMCE, CKEditor, etc.) or duplicate symptoms of one root cause. Do NOT penalize for unresolved non-fixable classifications.
NOTE: Ledger statuses `scan-failed`, `verified-static-unconfirmed`, and `not-rescanned` mean automated live verification was unavailable. Do not count them as resolved. Do not punish them as confirmed persistent issues either; call them out as requiring follow-up verification.
Verification summary: {{verification_summary_json}}

UNRESOLVED OR UNCONFIRMED VIOLATIONS ({{unresolved_count}} - persistent still appeared; scan-failed/static-unconfirmed could not be verified):
{{unresolved_violations_json}}

NEWLY INTRODUCED RULE TYPES ({{newly_introduced_count}}): {{newly_introduced_rule_types}}
NEWLY INTRODUCED VIOLATIONS:
{{newly_introduced_violations_json}}
FILES CHANGED: {{files_changed_summary}}

DIFFS:
{{diff_samples}}

RESOLVED VIOLATIONS (confirmed by source-appropriate verification):
{{resolved_violations_json}}

PER-ISSUE VERIFICATION LEDGER SAMPLE:
{{verification_ledger_sample_json}}

Return ONLY JSON. Use verdict approved, needs-review, or rejected, and score 0-10:
{"verdict":"approved","score":0,"wcag_correctness":"...","completeness":"...","regressions":"...","resolution_rate":"{{fixable_resolved_count}}/{{fixable_total}} fixable","unresolved_critical":["..."],"human_review_needed":["..."],"summary":"3-4 sentence verdict"}
