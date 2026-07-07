# AGENTS.md

## Repo Shape
- Purpose: scan website pages for accessibility issues, write reports, and optionally patch mapped source files when `--fix` is used with source on disk.
- ESM Node CLI package (`"type": "module"`) with the executable at `agent.js` and pipeline orchestration in `main.js`.
- `src/core/cli.js` defines the real CLI options; package scripts are only wrappers for `--url`, `--local`, `--github`, and `--zip`.
- Main pipeline: ingest/serve in `src/ingest.js`, scan in `src/scanning/scan.js`, merge/map in `src/analyze.js`, fix/patch/verify/rescan in `src/remediation/`, report in `src/reporting/report.js`.

## Setup And Commands
- Use npm, not pnpm/yarn; `package-lock.json` is the lockfile.
- Install with `npm install`, then install the browser dependency with `npx playwright install chromium`.
- GitHub Copilot login is required for `--fix` and `--judge`; run `npx copilot login` before remediation or judge workflows.
- There are no `test`, `lint`, `typecheck`, or formatter scripts in `package.json`; basic local checks are `node agent.js --help` and `npm run`.
- Run wrapper scripts with the target after `--`: `npm run scan:url -- https://example.com`, `npm run scan:local -- ./path/to/repo`, `npm run scan:github -- https://github.com/org/repo.git`, `npm run scan:zip -- ./repo.zip`.

## CLI Gotchas
- `--url + --local` is allowed only when `--url` is localhost/loopback; non-localhost combined source mapping exits in ingest.
- `--pages` is comma-separated and is resolved relative to the base URL unless an entry is a full URL.
- `--nav-wait` accepts only `load`, `domcontentloaded`, or `networkidle`; invalid values silently fall back to `load`.
- Localhost TLS errors are relaxed automatically; use `--ignore-https-errors` only for invalid TLS on non-localhost targets.
- `--fix` writes source changes when source is on disk (`--local`, extracted `--zip`, cloned `--github`, or localhost `--url + --local`). For ZIP/GitHub inputs, writes happen in `/tmp/a11y-*`, not the archive or remote repo.

## Scans, Builds, And Mutation Risks
- Local scans can mutate target projects: `phase2_serve` may run `npm install --omit=dev --prefer-offline`, then `--legacy-peer-deps`, then `--force`, and may run `npm run build` if present.
- Local serving chooses the first directory containing `index.html` from `dist`, `build`, `out`, `.next`, `public`, then `.` and serves it with SPA fallback to `/index.html`.
- Post-fix rebuild tries .NET (`dotnet build`), npm `build`, then `make` depending on detected files; failed rebuilds may still produce reports with before data.
- `.cshtml`/Razor-only fixes skip network rescan because server-side templates may be cached in memory; verification is static and a server restart is needed for live confirmation.

## Outputs And Ignored Files
- Default output is `./a11y-report`; `--output <dir>` changes where `index.html`, `report.json`, and `files-changed-report.xlsx` are written.
- Do not commit generated scan artifacts unless explicitly requested: `a11y-report/`, `analysis-audit/`, `exports/`, `.a11y-lighthouse-chrome/`, `playwright-report/`, `test-results/`, and `blob-report/` are ignored.
- `.env` and `.env.*` are ignored; never commit API keys.

## Source Mapping / Patch Constraints
- Source indexing considers JS/TS, HTML, Vue/Svelte, styles, and Razor files; it skips build outputs, binary files, minified/known third-party assets, `node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `coverage`, `.cache`, `Properties`, `Migrations`, `TestResults`, and `packages`.
- Patch validation rejects whole-file rewrites, overlapping ranges, invalid line ranges, and patches touching more than `max(25 lines, 50% of file)`.
- Parsers validate patched JS/TS/JSX/TSX with Babel, HTML/Razor with parse5 plus Razor sanitization checks, and CSS/SCSS/Less with PostCSS parsers.
