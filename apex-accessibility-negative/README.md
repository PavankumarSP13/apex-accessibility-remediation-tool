# TextStack negative dropdown cases

Replica of `../apex-accessibility` for testing the dropdown keyboard scan (Phase 3i) against known failures.
The page, form, dialog and styles match the original; the single working priority dropdown is replaced by
eleven dropdowns, each broken in exactly one keyboard behaviour.

## Run

```
npm start        # serves http://localhost:4174 (PORT env var overrides)
npm run scan     # full scan, report in ./a11y-report
```

Scan `http://localhost:4174/` without a trailing `#`: with a hash URL the scanner's page reset does not
reload, and a list left open by case 7 makes later checks report false failures.

## Expected dropdown keyboard results

A correct scan reports **9 issues and 2 good-to-have**, one per case, each on that case's trigger.

| Case | Element | Break | Expected rule |
|---|---|---|---|
| 1 | `#c01-toggle` | Trigger has no `tabindex` | `dropdown-trigger-not-reachable` |
| 2 | `#c02-toggle` | Shift+Tab from "Reference number" jumps to "Customer name" | `dropdown-trigger-shift-tab-unreachable` |
| 3 | `#c03-toggle` | Enter does not open the list | `dropdown-enter-not-activating` |
| 4 | `#c04-toggle` | Space does not open the list | `dropdown-space-not-activating` |
| 5 | `#c05-input` | Editable combobox opens only on typing, not ArrowDown | `combobox-arrow-down-not-opening` |
| 6 | `#c06-toggle` | ArrowUp/ArrowDown ignored in the open list | `dropdown-arrow-keys-not-supported` |
| 7 | `#c07-toggle` | Escape ignored, list stays open | `dropdown-escape-not-closing` |
| 8 | `#c08-toggle` | Escape closes the list but blurs the trigger | `dropdown-focus-not-returned` |
| 9 | `#c09-toggle` | Every option has `tabindex="0"` | `dropdown-items-in-tab-order` |
| 10 | `#c10-toggle` | Home/End ignored in the open list (good-to-have) | `dropdown-home-end-missing` |
| 11 | `#c11-toggle` | Type-ahead ignored in the open list (good-to-have) | `dropdown-type-ahead-missing` |
| 12 | `#c12-toggle` | Enter/Space/click selects an item but the list stays open; Tab also leaves it open | `dropdown-selection-not-closing` |

Case 10 is reported as "End does not jump" only: the scan presses Home while the first item is already
active, so a missing Home key is not detectable on this list.

All breaks are driven by the `breaks` flags passed to `setupDropdown()` in `index.html`, apart from case 1
and case 9 (markup) and cases 2 and 5 (their own small scripts at the end of the page).

The rest of the page keeps the original demo's deliberate issues (unnamed radio, empty button, missing
skip link, dialog focus), so other scanners report those as before.
