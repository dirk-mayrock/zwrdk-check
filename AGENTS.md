# AGENTS.md

## What this repo does
Monitors 9 ZWRD-K Wachplan URLs every 2 hours via GitHub Actions. Logs in with Playwright, checks for a red "Keine Saisondaten" error box, and sends an e-mail via Resend when a plan becomes newly available (status change only, no repeat spam).

## Key files
- `check-wachplan.ts` — single entrypoint: login + scrape + e-mail
- `state.json` — persisted between CI runs via GitHub Actions cache (`wachplan-state-v1`); never commit this file
- `status.py` — local CLI to inspect the last GitHub Actions run log

## Running locally

```bash
npm install
npx playwright install chromium   # one-time, ~300 MB
npm run check                      # real run, sends e-mail if plan found
npm run check:dry                  # DRY_RUN=true, no e-mail sent
python3 status.py                  # show last CI run result
```

## Environment variables

Copy `.env.example` → `.env`. The script loads `.env` itself at startup (no `dotenv` package needed) — **do not rely on `export $(... xargs)`** to inject vars; passwords with special characters will break shell parsing and create stray files.

| Variable | Purpose |
|---|---|
| `ZWRD_EMAIL` | Login e-mail for zwrd-k.dlrg.de |
| `ZWRD_PASSWORD` | Login password |
| `RESEND_API_KEY` | Resend.com API key (`re_...`) |
| `MAIL_TO` | Notification recipient |
| `MAIL_FROM` | Sender — use `onboarding@resend.dev` without a verified domain |
| `DRY_RUN` | Set `true` to skip e-mail send |

## GitHub Actions secrets
All 5 variables above must be set as repository secrets at `Settings → Secrets → Actions`. The workflow reads nothing else from the environment.

## Monitored URLs
`/calendar/show/9990 9991 9992 9994 9995 9996 9997 9998 9999` — note: **9993 is intentionally skipped**.

## Detection logic
- Red `.alert-danger` box containing "Keine Saisondaten" → `unavailable`
- No such box → `available` → triggers e-mail on first occurrence
- `error` status (timeout etc.) does **not** overwrite the previous known state in `state.json`

## ESM quirk
`package.json` has `"type": "module"`. All `.ts` files use top-level `await`. Run with `npx tsx` — never with plain `node` or `ts-node`. Scripts in `/tmp` won't work because tsx picks up `package.json` from cwd.

## Login selector
`#email` / `#password` / `button[type="submit"]` — confirmed working as of Nov 2026. Use `Promise.all([waitForNavigation, click])` pattern; `waitForURL` with a predicate times out on this site.

## CI cron
Runs every 2 hours: `0 */2 * * *` UTC. Manual trigger available via `workflow_dispatch` with `dry_run` input. Free GitHub tier covers this comfortably (~360 min/month used).
