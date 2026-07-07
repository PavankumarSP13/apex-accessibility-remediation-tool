# Accessibility Tool

AI-powered accessibility scanner and autofix CLI for live URLs and local projects.

The tool scans rendered pages with Axe, Lighthouse, pa11y, keyboard checks, interaction checks, and a focusable-action scan. When editable source is available, `--fix` runs a GitHub Copilot SDK remediation workflow and then verifies the result with a rebuild/rescan where possible.

## Prerequisites

- Node.js `>=22.5.0`
- npm
- Playwright Chromium
- GitHub Copilot authentication for `--fix` and `--judge`

## Install

```sh
npm install
npx playwright install chromium
```

Authenticate Copilot before running autofix:

```sh
npx copilot login
```

Create a local `.env` file only if you use the optional judge pass:


## Basic Commands

Show help:

```sh
node agent.js --help
```

Scan a live website URL without source-code fixes:

```sh
node agent.js --url https://example.com
```

Scan a local project. The CLI serves the project locally, scans it, and writes a report:

```sh
node agent.js --local ./path/to/site
```

Scan a running localhost app while mapping findings back to a local source folder:

```sh
node agent.js --url http://localhost:3000 --local ./path/to/repo
```

`--url + --local` is intentionally limited to localhost or loopback URLs. This mode is the best path when your app needs its own dev server, backend, login state, or build command outside this tool.

Scan multiple pages from the same site:

```sh
node agent.js --url http://localhost:3000 --local ./path/to/repo --pages /dashboard,/settings
```

Write reports to a custom directory:

```sh
node agent.js --url https://example.com --output ./analysis-audit
```

Package script shortcuts:

```sh
npm run scan:url -- https://example.com
npm run scan:local -- ./path/to/site
```

## Autofix

Autofix requires local source files and Copilot login.

Fix a local project that this tool can serve:

```sh
node agent.js --local ./path/to/site --fix
```

Fix source for an app you are already running locally:

```sh
node agent.js --url http://localhost:3000 --local ./path/to/repo --fix
```

Run the optional judge pass after fixes and rescan:

```sh
node agent.js --url http://localhost:3000 --local ./path/to/repo --fix --judge
```

The only supported remediation engine is Copilot, so this is equivalent to the default:

```sh
node agent.js --url http://localhost:3000 --local ./path/to/repo --fix --engine copilot
```

## Skip And Resume Rescan

Use `--skip-rescan` when fixes were written but the app needs a manual rebuild, restart, backend migration, or external deployment before verification.

```sh
node agent.js --url http://localhost:3000 --local ./path/to/repo --fix --skip-rescan
```

After rebuilding or restarting the app yourself, resume verification with `--rescan-only`. Pass the previous run folder that contains `report.json`:

```sh
node agent.js --url http://localhost:3000 --local ./path/to/repo --rescan-only ./a11y-report/run_reports/20260706-run1
```

With the judge pass:

```sh
node agent.js --url http://localhost:3000 --local ./path/to/repo --rescan-only ./a11y-report/run_reports/20260706-run1 --judge
```

Note: the current CLI flag names are `--skip-rescan` and `--rescan-only`. If you are thinking of `--no-rescan` or `--only-rescan`, use the names above.

## URL And Local Options

Use these when a page needs extra waiting or has local TLS issues:

```sh
node agent.js --url https://staging.example.com --nav-wait networkidle
node agent.js --url https://staging.example.com --ignore-https-errors
```

Localhost TLS errors are relaxed automatically. Use `--ignore-https-errors` only for non-localhost targets with invalid TLS.

Local scans can install dependencies and run builds in the target project. Use a disposable copy if you do not want the project touched.

## Outputs

By default, every run is written under `./a11y-report/run_reports/<date>-run<N>/`.

Important files:

- `index.html`: human-readable report
- `report.json`: structured scan, fix, and verification data
- `files-changed-report.xlsx`: Excel summary of mappings, violations, fixes, and verification
- `live.txt`, `scanner-issues.txt`, `remediation.txt`: live logs
- `screenshots/`: baseline and dialog screenshots captured by the focusable-action scan

Generated report and scratch folders are ignored by git:

- `a11y-report/`
- `analysis-audit/`
- `exports/`
- `.a11y-lighthouse-chrome/`
- `playwright-report/`
- `test-results/`
- `blob-report/`

## Screenshot Behavior

The focusable-action scan always captures one baseline screenshot before interaction. It captures additional screenshots only when activating a focusable element opens something detected as a dialog or modal.

If a button reveals inline content, changes text, expands a section, navigates, or opens UI that does not expose a detectable dialog/modal pattern, the scanner may record the interaction but will not add another screenshot. In that case a run can legitimately have only the single baseline screenshot.

## Pipeline

1. Ingest `--url`, `--local`, or localhost `--url + --local`.
2. Serve local input when needed.
3. Scan rendered pages with Axe, Lighthouse, pa11y, keyboard, interaction, missing-alt, and focusable-action checks.
4. Map findings to local source when source is available.
5. If `--fix` is set, run Copilot Fixer, Challenger, and Verifier roles against scoped candidate files.
6. Rebuild and rescan when possible, unless `--skip-rescan` is used.
7. Run `--judge` when requested.
8. Write HTML, JSON, Excel, logs, and screenshots.

## Validation

There is no test script in `package.json` currently. Basic checks:

```sh
node agent.js --help
npm run
```

Run a real scan against a site you control:

```sh
node agent.js --url https://example.com --output ./a11y-report
```
