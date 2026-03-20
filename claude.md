# CLAUDE.md — israeli-banks-sure-importer

You are working on `israeli-banks-sure-importer`, a self-hosted TypeScript/Node.js Docker
container that scrapes Israeli bank accounts using `israeli-bank-scrapers` (Puppeteer-based)
and imports transactions into a self-hosted Sure Finance instance via its official REST API.

This file is your primary context. Read it fully before making any changes.

---

## Project Purpose

Bridge between:
- **Source:** `israeli-bank-scrapers` (npm, v6.7.1) — scrapes Israeli banks via headless
  Chromium (Puppeteer). Package: `eshaham/israeli-bank-scrapers`. Used banks: Max (Leumi
  Card) and Mizrahi Bank. Both work reliably with the original package.
- **Destination:** Sure Finance (`we-promise/sure`) — self-hosted personal finance app
- **Transport:** Sure's `POST /api/v1/imports` CSV import API

Runs on Unraid homelab. No cloud. No third-party services except the banks themselves
and Telegram for alerts.

---

## Repository Layout

```
israeli-sure-importer/
├── src/
│   ├── index.ts          ← entry point, CLI flags, cron scheduler
│   ├── config.ts         ← loads and validates config.json + env vars
│   ├── secrets.ts        ← reads secret files from /run/secrets/
│   ├── scraper.ts        ← wraps israeli-bank-scrapers, per-bank timeout
│   ├── transformer.ts    ← normalizes transactions, builds CSV string
│   ├── merchants.ts      ← loads merchants.json, fuzzy match logic
│   ├── sure-client.ts    ← Sure API calls (accounts, imports, polling)
│   ├── state.ts          ← SQLite deduplication state (better-sqlite3)
│   ├── notifier.ts       ← Telegram alerts
│   └── logger.ts         ← Winston logger, redaction, rotation
├── config.example.json   ← template — safe to commit, zero credentials
├── merchants.json        ← merchant name overrides — safe to commit
├── secrets/
│   └── README.md         ← instructions for creating secret files
├── compose.yml           ← Docker Compose (single service, no ports)
├── Dockerfile            ← Node 22 + Chromium, non-root user 1000:1000
├── tsconfig.json
├── package.json
├── CLAUDE.md             ← this file
└── README.md             ← human-facing setup guide
```

---

## Architecture — Data Flow

```
1. STARTUP      Read SURE_API_KEY_FILE → /run/secrets/sure_api_key
                Validate all secret files exist and are non-empty
                GET /api/v1/accounts — verify configured Sure accounts exist

2. SCRAPE       israeli-bank-scrapers per target in config.json
                Timeout: TIMEOUT_MINUTES (sets both job timeout + defaultTimeout)
                Browser profile: BROWSER_DATA_DIR/<companyId>/
                Error types from scraper: INVALID_PASSWORD | CHANGE_PASSWORD |
                  ACCOUNT_BLOCKED | TIMEOUT | GENERIC

3. FILTER       Skip zero-amount transactions (chargedAmount === 0) — always, no config needed
                Skip future-dated transactions (date > today Asia/Jerusalem) — always, no config needed
                  Prevents credit card upcoming charges (e.g. Max returns charges dated next month)
                Skip pending tx if IMPORT_PENDING not set to "true"
                Skip tx IDs already in state.db (deduplication — see key design below)

4. TRANSFORM    Normalize amount/currency
                Date: ISO "2026-03-15" → "15/03/2026" (DD/MM/YYYY for CSV)
                merchants.json fuzzy lookup → clean name column (no installment info here)
                notes column — only content NOT already in name:
                  no installments, no merchant match  →  "" (empty)
                  no installments, merchant match      →  raw description (audit trail)
                  installments, no merchant match      →  "תשלום N מתוך M" (label only)
                  installments, merchant match         →  "תשלום N מתוך M | raw description"

5. CSV BUILD    Columns: date, amount, name, notes

6. IMPORT       POST /api/v1/imports (skip if DRY_RUN=true)
                publish: PUBLISH env var ("false" = review queue, "true" = auto)

7. POLL         PUBLISH=false → checkImport() — single GET, returns status unconditionally
                PUBLISH=true  → pollImport() — polls until status not pending/importing
                Statuses: pending | importing | complete | failed | revert_failed
                Note: when publish=false, Sure places the import in the review queue and the
                status stays "pending" permanently until the user confirms in the Sure UI.
                "pending" is the expected terminal state for review-queue imports.

8. STATE        On complete or pending (review queue) → write dedup keys to state.db

9. LOG          All steps → logs/importer.log (single file, Winston)

10. NOTIFY      Telegram if: login fail / sync fail / errors ≥ NOTIFY_ERROR_THRESHOLD
```

---

## Transaction Filtering Rules

### Zero-amount transactions — always skipped

Transactions where `chargedAmount === 0` are **always dropped** before deduplication
and CSV generation. They are never written to `state.db`.

These are bank-internal entries (authorization holds, fee reversals, reconciliation
artifacts) that carry no financial value and would only pollute Sure's transaction
list, reports, and Rules engine.

Log at `debug` level only — expected and routine:
```
[DEBUG] [leumi] Skipped 2 zero-amount transactions
```

No config flag — this filter is unconditional.

---

## Deduplication Key Design

Keys are stored in `state.db` as SHA-256 hashes. Two-tier strategy:

### Primary key — when `identifier` exists

```
SHA256( accountNumber + "|" + identifier )
```

`identifier` is the bank's own transaction ID returned by `israeli-bank-scrapers`.
When present it is the most reliable signal. Use this tier first.

### Fallback key — when `identifier` is absent or zero

```
SHA256(
  accountNumber + "|" +
  date          + "|" +
  chargedAmount + "|" +
  description   + "|" +
  (installments?.number ?? 0)
)
```

**Why `installments?.number` is in the key:**
Installment transactions from Israeli banks repeat the same merchant name and amount
every month for N months. Without the installment number they would look identical
and all but the first would be incorrectly deduplicated as duplicates.

Example — these are three distinct transactions, not duplicates:
```
קאנטרי קריית טבעון | -418 ILS | 2026-01-15 | installment 1 of 12  → unique key
קאנטרי קריית טבעון | -418 ILS | 2026-02-15 | installment 2 of 12  → unique key
קאנטרי קריית טבעון | -418 ILS | 2026-03-15 | installment 3 of 12  → unique key
```

For non-installment transactions `installments?.number` is `undefined` → coerced to `0`.

---

## name and notes Column Mapping

These are the two text columns in the generated CSV, and map directly to the
`name` (transaction title) and `notes` fields visible in the Sure UI.

### `name` column — clean merchant name only

```
merchants.json match found  →  clean mapped name         e.g. "Rami Levy"
no match                    →  raw bank description       e.g. "קאנטרי קריית טבעון"
```

**Never include installment info in `name`.** The `name` column is what Sure's
built-in Rules engine matches against for auto-categorization. Installment suffixes
would break rule matching across the series.

### `notes` column — additional context only

`notes` must only contain information that is **not already present in `name`**.
If it would just repeat `name`, it is left empty.

| Scenario | `name` | `notes` |
|----------|--------|---------|
| No installments, no merchant match | raw description | `""` (empty) |
| No installments, merchant match found | clean name e.g. `"Rami Levy"` | raw description (audit trail) |
| Installments, no merchant match | raw description | `"תשלום N מתוך M"` (label only) |
| Installments, merchant match found | clean name | `"תשלום N מתוך M \| raw description"` |

### Real examples from Sure UI

```
Regular transaction (no merchant match):
  name:   עמלי
  notes:  (empty)

Installment, no merchant match:
  name:   קאנטרי קריית טבעון
  notes:  תשלום 3 מתוך 12

Installment with merchant match (once merchants.json is populated):
  name:   Country Club
  notes:  תשלום 3 מתוך 12 | קאנטרי קריית טבעון
```

---

## Sure Finance API — Confirmed Endpoints

Base URL from `config.json → sure.baseUrl`. Auth: `X-Api-Key` header (value from secret file).

### Used in this project

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/accounts` | List accounts, verify UUID mapping |
| `POST` | `/api/v1/imports` | Submit CSV import |
| `GET` | `/api/v1/imports/:id` | Poll import status |

### POST /api/v1/imports — exact body

```json
{
  "raw_file_content": "date,amount,name,notes\n15/03/2026,-142.50,Rami Levy,רמי לוי שיווק השקמה\n",
  "type": "TransactionImport",
  "account_id": "<uuid>",
  "publish": "false",
  "date_col_label": "date",
  "amount_col_label": "amount",
  "name_col_label": "name",
  "notes_col_label": "notes",
  "date_format": "%d/%m/%Y",
  "number_format": "1,234.56",
  "signage_convention": "inflows_positive",
  "col_sep": ","
}
```

**Important:** `date_format` uses Ruby strftime notation (`%d/%m/%Y`), not UI display format (`DD/MM/YYYY`).

### Import status values
`pending` | `importing` | `complete` | `failed` | `reverting` | `revert_failed`

### NOT used — do not add
- `POST /api/v1/accounts` — accounts are created manually in the Sure UI, not by the importer
- `POST /api/v1/transactions` — direct transaction creation is not used
- `GET/POST /api/v1/merchants` — merchant handling is done locally via merchants.json
- Categories API — categorization is handled by Sure's built-in Rules engine after import

---

## config.json Structure

**Only two top-level keys: `sure` and `targets`. Nothing else.**

```jsonc
{
  "sure": {
    "baseUrl": "http://sure:3000"    // Sure container hostname/port
  },
  "targets": [
    {
      "name": "Leumi Checking",       // human label, used in logs
      "companyId": "leumi",           // israeli-bank-scrapers CompanyTypes key
      "credentialSecrets": {          // maps credential field → secret filename
        "username": "leumi_username", // reads /run/secrets/leumi_username
        "password": "leumi_password"
      },
      "sureAccountId": "paste-uuid-from-sure-ui"  // UUID from Sure account settings
    }
  ]
}
```

**Create Sure accounts manually in the Sure UI before first run.**
Select the correct account type (Cash for bank accounts, Credit Card for cards).
Get the UUID from the Sure account settings and paste it here.

**Never add credentials, API keys, or tokens to config.json.**

---

## Environment Variables

All set in `compose.yml`. Never in `config.json`.

| Variable | Type | Description |
|----------|------|-------------|
| `TZ` | string | Must be `Asia/Jerusalem` |
| `NODE_ENV` | string | `production` |
| `LOG_LEVEL` | string | `error` / `warn` / `info` / `debug` |
| `SCHEDULE` | string | Cron expression. Omit to run once and exit. |
| `DAYS_BACK` | number | Days to fetch on first run (default: 30) |
| `TIMEOUT_MINUTES` | number | Per-bank timeout + Puppeteer defaultTimeout |
| `PUBLISH` | string | `"false"` = review queue, `"true"` = auto-process |
| `DRY_RUN` | string | `"true"` = skip all Sure API writes |
| `IMPORT_PENDING` | string | `"true"` = include bank-pending transactions |
| `PUPPETEER_EXECUTABLE_PATH` | string | `/usr/bin/chromium` |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | string | `"true"` |
| `BROWSER_DATA_DIR` | string | `/app/browser-data` — per-bank profile dir |
| `SURE_API_KEY_FILE` | string | Path to Sure API key secret file |
| `TELEGRAM_BOT_TOKEN_FILE` | string | Path to Telegram bot token secret file |
| `TELEGRAM_CHAT_ID` | string | Telegram chat ID (not sensitive) |
| `NOTIFY_ON_LOGIN_FAIL` | string | `"true"` / `"false"` |
| `NOTIFY_ON_SYNC_FAIL` | string | `"true"` / `"false"` |
| `NOTIFY_ERROR_THRESHOLD` | number | Alert if failed tx count ≥ this value |
| `NOTIFY_ON_SUCCESS` | string | `"true"` / `"false"` (default false) |

---

## Secret Management

### Rule: one file = one value

Every credential is a separate file under `secrets/`. File contains the raw value only —
no key name, no quotes, no trailing newline.

### Where secrets live at runtime

All files are mounted read-only at `/run/secrets/` inside the container.

### How the app reads them

`src/secrets.ts` reads each file using `fs.readFileSync`, trims whitespace, and returns
the string. It validates the file exists and is non-empty at startup.

### Secret file → env var → config.json mapping

```
secrets/sure_api_key         ←→  SURE_API_KEY_FILE=/run/secrets/sure_api_key
secrets/telegram_bot_token   ←→  TELEGRAM_BOT_TOKEN_FILE=/run/secrets/telegram_bot_token
secrets/leumi_username       ←→  config.json credentialSecrets.username = "leumi_username"
secrets/leumi_password       ←→  config.json credentialSecrets.password = "leumi_password"
```

### Never do this
- Do not log secret values, even at debug level
- Do not add secrets to config.json
- Do not pass secrets as environment variable values in compose.yml
- Logger must redact any string matching password/token/key patterns

---

## Logging Rules

- Single file: `/app/logs/importer.log`
- Winston with daily rotation, 14 days retention
- All log sources (scraper, transformer, Sure client, notifier) write to same logger
- Credentials are never logged — logger has redact patterns for common secret shapes
- `LOG_LEVEL=info` is the default — shows summaries only
- `LOG_LEVEL=debug` shows browser navigation events and per-transaction detail

### Log format
```
[2026-03-17 08:00:14] [INFO]  [leumi] Scraped 28 tx → 9 new | CSV posted → import_id=xyz
[2026-03-17 08:00:15] [INFO]  [leumi] Import status: pending — review in Sure UI
[2026-03-17 08:00:44] [ERROR] [hapoalim] Scraper failed | errorType=TIMEOUT
```

---

## CLI Flags

`src/index.ts` handles two flags parsed from `process.argv`:

| Flag | Behaviour |
|------|-----------|
| `--run-once` | Run the full pipeline once and exit (ignores SCHEDULE) |
| `--dry-run` | Full pipeline but skip all Sure API writes (overrides DRY_RUN env var) |

Used via docker exec:
```bash
docker exec israeli-sure-importer node dist/index.js --run-once
docker exec israeli-sure-importer node dist/index.js --run-once --dry-run
```

---

## Docker & Build

- Base: `node:22-slim` + Chromium installed via apt
- Multi-stage build: `builder` stage compiles TypeScript, `runtime` stage is lean
- Non-root user: `1000:1000` (created in Dockerfile)
- `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` — use system Chromium, not the bundled one
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` — point Puppeteer at system Chromium
- `TZ=Asia/Jerusalem` baked into image as default
- `shm_size: 256mb` in compose.yml — required by Chromium

### Volumes (all absolute Unraid paths)
```
/mnt/user/appdata/sure/israeli-sure-importer/config.json  → /app/config.json   (ro)
/mnt/user/appdata/sure/israeli-sure-importer/secrets/     → /run/secrets/      (ro)
/mnt/user/appdata/sure/israeli-sure-importer/cache/       → /app/cache/
/mnt/user/appdata/sure/israeli-sure-importer/browser-data/→ /app/browser-data/
/mnt/user/appdata/sure/israeli-sure-importer/logs/        → /app/logs/
```

---

## Supported Banks (israeli-bank-scrapers companyId values)

| companyId | Bank / Card | Credential fields |
|-----------|-------------|-------------------|
| `hapoalim` | Bank Hapoalim | `userCode`, `password` |
| `leumi` | Bank Leumi | `username`, `password` |
| `discount` | Discount Bank | `id`, `password`, `num` |
| `mercantile` | Mercantile Bank | `id`, `password`, `num` |
| `mizrahi` | Mizrahi Bank | `username`, `password` |
| `otsarHahayal` | Otsar Hahayal | `username`, `password` |
| `beinleumi` | Beinleumi | `username`, `password` |
| `massad` | Massad | `username`, `password` |
| `union` | Union Bank | `username`, `password` |
| `yahav` | Yahav | `username`, `password`, `nationalId` |
| `visaCal` | Visa Cal | `username`, `password` |
| `max` | Max (Leumi Card) | `username`, `password` |
| `isracard` | Isracard | `id`, `card6Digits`, `password` |
| `amex` | Amex | `username`, `card6Digits`, `password` |
| `oneZero` | OneZero (experimental) | `email`, `password` |

---

## Key Constraints — Do Not Violate

1. **No credentials in config.json** — ever. Structural config only.
2. **No credentials in environment variables** — use secret files via `*_FILE` pattern.
3. **No credentials in logs** — redact at the logger level.
4. **No inbound ports** — compose.yml has no `ports:` entry.
5. **Single log file** — `logs/importer.log` only. No per-bank files, no screenshots.
6. **Import API only** — use `POST /api/v1/imports`, not `POST /api/v1/transactions`.
7. **date_format is Ruby strftime** — `%d/%m/%Y`, not `DD/MM/YYYY`.
8. **Timezone** — always `Asia/Jerusalem`. The scraper library requires this.
9. **Non-root** — container runs as `1000:1000`. Dockerfile must create this user.
10. **Graceful partial failure** — one bank failing must not stop other banks.
11. **Zero-amount filter is unconditional** — never import transactions where `chargedAmount === 0`.
12. **Installment number in dedup key** — required to distinguish monthly installment payments.
13. **name column has no installment info** — installment label belongs in `notes` only.

---

## Development Notes

- Language: TypeScript, strict mode
- Runtime: Node.js 22
- Package manager: npm
- Key dependencies:
  - `israeli-bank-scrapers` (v6.7.1) — scraping via Puppeteer + Chromium
  - `better-sqlite3` — deduplication state
  - `node-cron` — scheduling
  - `winston` + `winston-daily-rotate-file` — logging
  - `axios` — Sure API calls
  - `ajv` — config.json schema validation
- Test with `docker compose run --rm israeli-sure-importer` before enabling schedule
- Always run `--dry-run` first when testing changes to transformer or CSV output

---

## Current Status

*Last updated: 2026-03-19*

### Live and verified

All source files implemented, tested end-to-end against real banks (Mizrahi Bank + Max):

| File | Status |
|------|--------|
| `src/index.ts` | ✅ Complete |
| `src/config.ts` | ✅ Complete |
| `src/secrets.ts` | ✅ Complete |
| `src/scraper.ts` | ✅ Complete |
| `src/transformer.ts` | ✅ Complete |
| `src/merchants.ts` | ✅ Complete |
| `src/sure-client.ts` | ✅ Complete |
| `src/state.ts` | ✅ Complete |
| `src/notifier.ts` | ✅ Complete |
| `src/logger.ts` | ✅ Complete |
| `Dockerfile` | ✅ Complete |
| `compose.yml` | ✅ Complete |
| `config.example.json` | ✅ Complete |
| `merchants.json` | ✅ Empty array — ready to populate |
| `secrets/README.md` | ✅ Complete |
| `README.md` | ✅ Complete |

### All fixes applied and verified

| ID | Fix |
|----|-----|
| C1 | Added `@types/node-cron` to `devDependencies` |
| C2 | Fixed 5 `createScraper` option errors: `CompanyTypes` cast, `--user-data-dir` in args, `showBrowser`, `defaultTimeout`, removed non-existent fields |
| C3 | Dockerfile: `npm ci` → `npm install` |
| I1 | Wired `notifyErrorThreshold()` call in `index.ts` |
| I2 | `process.exitCode = 0` + `setTimeout(...).unref()` instead of `process.exit(0)` — fixes log file truncation |
| I3 | `notifySuccess` gate: added `logger.debug('Skipping success notification — dry run')` |
| N1 | Removed double `format: logFormat` on Console transport in `logger.ts` |
| N3 | Added `type?: string` to `Transaction` interface in `types.ts` |
| S1 | `sure-client.ts`: `getAccounts()` now returns `res.data.accounts` — Sure API wraps array in `{ accounts: [], pagination: {} }` |
| S2 | Removed auto account creation — accounts must be created manually in Sure UI with correct type (Cash / Credit Card); UUID pasted into `config.json` |
| L1 | `notifier.ts`: added `logger.info('Telegram notification sent')` and `logger.debug('skipped — no token or chat_id')` |
| L2 | Log files use dated filename `importer-YYYY-MM-DD.log` with `importer.log` symlink to current day |
| P1 | `postImport()`: import ID was nested — fixed `res.data.id` → `res.data.data.id` |
| P2 | `pollImport()`: poll response was nested — added `SureImportResponse` interface, read `res.data.data` |
| P3 | `pollImport()` + `index.ts`: when `PUBLISH=false`, `pending` IS the terminal state (review queue). Fixed: single status check instead of 3-min poll; `pending` treated as success when publish≠true |
| F1 | `transformer.ts`: added future-date filter — drops transactions where `date > today (Asia/Jerusalem)`; prevents credit card upcoming charges from being imported |
| F2 | `transformer.ts`: `buildNotes()` now only emits content not already in `name`; non-installment transactions without merchant match get empty notes instead of a duplicate of the description |
| F3 | `sure-client.ts` + `index.ts`: replaced broken `pollImport(id, { maxAttempts: 1 })` with new `checkImport()` function — single GET, returns result unconditionally, never throws; pipeline no longer fails on every run |

### Known gaps

- **`merchants.json` is empty** — functional but no merchant normalization until entries are added
- **Browser 2FA sessions** — `browser-data/` holds Chromium profiles; if a bank forces 2FA, log in manually via the real browser first
- **Stale Chromium lock** — if a run is killed mid-scrape, `browser-data/<companyId>/SingletonLock` may remain; delete it before next run: `find .../browser-data/ -name "SingletonLock" -delete`

### Normal operation

```bash
# Dry run (scrape only, no Sure writes)
docker compose run --rm israeli-sure-importer node dist/index.js --run-once --dry-run

# Real run (imports to Sure review queue)
docker compose run --rm israeli-sure-importer node dist/index.js --run-once

# Start on schedule
docker compose up -d

# Tail live log
tail -f /mnt/user/appdata/sure/israeli-sure-importer/logs/importer.log
```
