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
reload, and a list left open by case 5 makes later checks report false failures.

## Expected dropdown keyboard results

A correct scan reports **8 issues and 1 good-to-have**, one per case, each on that case's trigger.

| Case | Element | Break | Expected rule |
|---|---|---|---|
| 1 | `#c01-toggle` | Trigger has no `tabindex` | `dropdown-trigger-not-reachable` |
| 2 | `#c02-toggle` | Enter does not open the list | `dropdown-enter-not-activating` |
| 3 | `#c03-toggle` | Space does not open the list | `dropdown-space-not-activating` |
| 4 | `#c04-toggle` | ArrowUp/ArrowDown ignored in the open list | `dropdown-arrow-keys-not-supported` |
| 5 | `#c05-toggle` | Escape ignored, list stays open | `dropdown-escape-not-closing` |
| 6 | `#c06-toggle` | Escape closes the list but blurs the trigger | `dropdown-focus-not-returned` |
| 7 | `#c07-toggle` | Every option has `tabindex="0"` and the list stays open on Tab | `dropdown-items-in-tab-order` |
| 8 | `#c08-toggle` | Home/End ignored in the open list (good-to-have) | `dropdown-home-end-missing` |
| 9 | `#c09-toggle` | Enter/Space/click selects an item but the list stays open; Tab also leaves it open | `dropdown-selection-not-closing` |

Case 8 is reported as "End does not jump" only: the scan presses Home while the first item is already
active, so a missing Home key is not detectable on this list.

All breaks are driven by the `breaks` flags passed to `setupDropdown()` in `index.html`, apart from case 1
and case 7 (markup).

The rest of the page keeps the original demo's deliberate issues (unnamed radio, empty button, missing
skip link, dialog focus), so other scanners report those as before.
