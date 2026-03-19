# PRD — israeli-banks-sure-importer

Product Requirements Document. Read alongside `CLAUDE.md` (technical spec) and
`README.md` (setup guide). This file defines *what* to build and *why* — CLAUDE.md
defines *how*.

---

## 1. Elevator Pitch

`israeli-banks-sure-importer` is a self-hosted Docker container that automatically
scrapes Israeli bank and credit card accounts and imports the transactions into a
self-hosted Sure Finance instance. It runs on a schedule, requires zero manual
intervention after setup, and gives the user full visibility and control through a
single log file and Telegram alerts — with no cloud dependency, no third-party data
sharing, and no exposed network surface.

---

## 2. User Persona

**The self-hosted homelab enthusiast who manages personal finances in Israel.**

Characteristics:
- Runs Unraid (or similar NAS/homelab) with Docker Compose stacks
- Already self-hosts Sure Finance for personal budgeting
- Has accounts at one or more Israeli banks and credit card companies
- Is comfortable editing a JSON config file and running shell commands
- Values data privacy — does not want financial data leaving their own server
- Wants automation, not a manual export/import workflow every week
- Expects failures to be loud (Telegram alerts) and debuggable (logs)
- Is security-conscious — understands the sensitivity of bank credentials and
  expects the tool to handle them properly

**Not the target user:**
- Someone who wants a hosted SaaS solution
- Someone unfamiliar with Docker or self-hosting
- Someone outside Israel using non-Israeli banks

---

## 3. Core Features

Most important first.

- **Automated scheduled scraping** — runs on a configurable cron schedule
  (`Asia/Jerusalem` timezone), fetches new transactions from all configured banks
  in a single run, requires no manual trigger under normal operation

- **Sure Finance import via official API** — uses `POST /api/v1/imports` with a
  generated CSV and full column/format configuration; never bypasses Sure's import
  pipeline or writes directly to its database

- **PUBLISH control** — `PUBLISH=false` sends the import to Sure's review queue
  (user confirms in the UI before transactions appear); `PUBLISH=true` auto-processes
  without review; designed for first-run validation before enabling automation

- **Robust deduplication** — SHA-256 keyed state database prevents any transaction
  from being imported twice across runs, with correct handling of installment
  payments (each installment number is a distinct key)

- **Zero-amount transaction filter** — unconditionally drops transactions with
  `chargedAmount === 0` before import; these carry no financial value and would
  only create noise in Sure

- **Installment-aware notes** — installment context (`תשלום 3 מתוך 12`) is
  preserved in the Sure `notes` field; the `name` field stays clean for Sure's
  Rules engine to match against

- **Merchant normalization** — `merchants.json` maps raw Hebrew/English bank
  descriptions to clean merchant names via fuzzy matching; raw description always
  preserved in `notes`

- **File-based secret management** — all credentials live in individual
  `chmod 400` files under `secrets/`; never in environment variables, config files,
  or image layers; created manually with one file per credential

- **Telegram failure alerts** — sends alerts on bank login failure, full sync
  failure, and when failed transaction count reaches a configurable threshold;
  success notifications are opt-in and off by default

- **Single unified log file** — all pipeline stages write to one chronological
  `logs/importer.log`; `LOG_LEVEL` controls verbosity from run summaries (`info`)
  to full browser and per-transaction detail (`debug`); rotated daily, 14 days
  retained; accessible via `tail -f` from the Unraid host

- **Dry run mode** — `--dry-run` flag (or `DRY_RUN=true`) runs the full pipeline
  including scraping, filtering, and CSV generation but skips all Sure API writes;
  used for testing configuration changes safely

- **Per-bank browser session persistence** — Chromium profiles stored per bank
  under `BROWSER_DATA_DIR`; banks remember the "device" and skip 2FA challenges
  on subsequent runs

- **Manual trigger via docker exec** — `--run-once` flag runs one sync cycle
  immediately without waiting for the next scheduled time; no HTTP server, no
  exposed ports

---

## 4. User Flows

### 4.1 First-Time Setup

```
User clones repo
  → creates secret files manually (one file per credential, chmod 400)
      echo -n "value" > secrets/sure_api_key && chmod 400 secrets/sure_api_key
      (repeat for telegram_bot_token and each bank credential)
  → opens Sure UI → creates one account per bank target
      select correct type: Cash for bank accounts, Credit Card for cards
      copy the account UUID from Sure account settings
  → copies config.example.json → config.json
  → edits config.json: sets sure.baseUrl, adds bank targets with companyId,
    credentialSecrets references, and sureAccountId UUID for each target
  → edits compose.yml: sets TELEGRAM_CHAT_ID, adjusts SCHEDULE if needed
  → runs: mkdir -p .../cache .../browser-data .../logs && chown -R 1000:1000 ...
  → pulls image: docker pull dorko87/israeli-sure-importer:latest
  → dry run first — scrape only, no Sure API writes:
      docker compose run --rm israeli-sure-importer node dist/index.js --run-once --dry-run
  → reviews log output: checks dates, amounts, merchant names, CSV content
  → real run with PUBLISH=false:
      docker compose run --rm israeli-sure-importer node dist/index.js --run-once
    → container scrapes all configured banks
    → generates CSV per bank
    → posts CSV to Sure with PUBLISH=false
    → log shows: "[Mizrahi Bank] Import status: complete — review in Sure UI"
  → user opens Sure UI → Transactions → Imports
    → reviews pending import: checks dates, amounts, merchant names, notes
    → confirms import → transactions appear in Sure
  → satisfied with data quality
  → edits compose.yml: PUBLISH: "false" → PUBLISH: "true"
  → runs: docker compose up -d
  → automation runs on schedule from now on
```

### 4.2 Normal Scheduled Run (steady state)

```
Cron fires at configured time (e.g. 08:00 Asia/Jerusalem)
  → container wakes, reads config + secrets
  → validates all secret files exist and are non-empty
  → calls GET /api/v1/accounts → confirms Sure accounts exist
  → for each target in config.json (in sequence):
      → loads browser profile from BROWSER_DATA_DIR/<companyId>/
      → scrapes bank with per-bank TIMEOUT_MINUTES limit
      → filters: drops zero-amount tx, drops already-seen tx (state.db check)
      → transforms: formats dates, applies merchants.json, builds notes column
      → generates CSV string
      → posts to POST /api/v1/imports with publish=true
      → polls GET /api/v1/imports/:id until status = complete or failed
      → on complete: writes dedup keys to state.db, logs row counts
      → on failed: logs error field, sends Telegram alert
  → logs run summary: banks processed, success/fail counts, total rows
  → if any bank failed login: Telegram alert sent
  → container returns to idle, waits for next cron trigger
```

### 4.3 Manual Trigger (on-demand sync)

```
User wants to sync immediately without waiting for next scheduled run
  → opens Unraid terminal or SSH session
  → runs: docker exec israeli-sure-importer node dist/index.js --run-once
  → same flow as 4.2 runs synchronously
  → user tails log: tail -f .../logs/importer.log
  → sees per-bank progress and final summary
  → container returns to idle after run completes
```

### 4.4 Dry Run (testing changes)

```
User has modified merchants.json or config.json and wants to verify output
  → runs: docker exec israeli-sure-importer node dist/index.js --run-once --dry-run
  → full pipeline runs: scrape → filter → transform → CSV build
  → log shows "[DRY RUN] Would import N transactions" with full detail
  → log shows the CSV content that would be sent to Sure
  → NO calls made to Sure API
  → state.db is NOT updated
  → user inspects log, confirms output looks correct
  → removes --dry-run flag for real run
```

### 4.5 Failure — Bank Login

```
Scheduled run fires
  → scraper attempts login to bank
  → bank returns login error (wrong password, account blocked, 2FA required)
  → scraper reports errorType: INVALID_PASSWORD | ACCOUNT_BLOCKED | TIMEOUT
  → bridge logs: [ERROR] [leumi] Scraper failed | errorType=INVALID_PASSWORD
  → Telegram alert sent: "🔴 Login failed — leumi | INVALID_PASSWORD"
  → other banks in config continue processing (graceful partial failure)
  → run summary logs which banks succeeded and which failed
  → user receives Telegram alert
  → user checks log to identify the bank and error type
  → user fixes the secret file (rotates password if needed)
  → user manually triggers a re-run: docker exec ... --run-once
```

### 4.6 Credential Rotation

```
User's bank password changed
  → user retrieves new password from Vaultwarden
  → overwrites secret file:
      echo -n "new-password" > secrets/leumi_password && chmod 400 secrets/leumi_password
  → runs: docker compose restart
  → container reloads secrets at next startup
  → optionally triggers manual run to verify: docker exec ... --run-once
```

---

## 5. Data Model

### Entities

**Target** (defined in `config.json`)
- `name` — human label, used in logs
- `companyId` — `israeli-bank-scrapers` CompanyTypes key (e.g. `"leumi"`, `"max"`)
- `credentialSecrets` — map of credential field name → secret filename (e.g. `{ "username": "leumi_username" }`)
- `sureAccountId` — Sure account UUID (create account manually in Sure UI, then paste UUID here)

**Transaction** (scraped, in-memory only — never persisted raw)
- `accountNumber` — bank account number from scraper result
- `identifier` — bank-assigned transaction ID (may be absent)
- `date` — transaction date (ISO string from scraper)
- `processedDate` — bank posting date (ISO string, not used for import)
- `description` — raw bank description string (Hebrew/English)
- `chargedAmount` — ILS amount actually charged (negative = expense)
- `originalAmount` — original foreign currency amount if applicable
- `originalCurrency` — currency code if foreign transaction
- `installments.number` — current installment number (e.g. 3)
- `installments.total` — total installments in series (e.g. 12)
- `status` — `"completed"` or `"pending"` from bank

**DeduplicationRecord** (persisted in `cache/state.db` via SQLite)
- `key` — SHA-256 hash (primary or fallback key — see CLAUDE.md)
- `importedAt` — ISO timestamp when this transaction was successfully imported
- `bank` — companyId, for diagnostics
- `accountNumber` — for diagnostics

**ImportResult** (in-memory, from Sure API polling)
- `id` — Sure import UUID
- `status` — `pending | importing | complete | failed | reverting | revert_failed`
- `rows_count` — total rows in CSV
- `valid_rows_count` — rows Sure accepted
- `error` — error message string if status = failed

**MerchantOverride** (loaded from `merchants.json`)
- `pattern` — string to fuzzy-match against raw bank description
- `name` — clean merchant name to use in Sure `name` column

### Relationships

```
config.json
  └── targets[]
        └── credentialSecrets → secrets/ files (runtime read)
        └── sureAccountId → Sure account (GET /api/v1/accounts)

Scraper run
  └── produces Transaction[]
        └── filtered by: zero-amount check, state.db dedup check
        └── transformed into: CSV row (name, notes, date, amount)
              └── name ← MerchantOverride.name OR Transaction.description
              └── notes ← installment label (if any) + " | " + Transaction.description

CSV row[]
  └── posted as POST /api/v1/imports → ImportResult
        └── on complete → DeduplicationRecord[] written to state.db
```

---

## 6. Non-Goals

These are explicitly out of scope. Do not implement them.

- **No direct transaction API** — `POST /api/v1/transactions` is not used. All
  imports go through `POST /api/v1/imports`. This is a firm constraint.

- **No category mapping** — the bridge does not set category IDs on transactions.
  Sure's built-in Rules engine handles categorization after import. Adding category
  logic here would duplicate functionality, create maintenance burden, and require
  managing a separate category list.

- **No Merchants API calls** — `GET/POST /api/v1/merchants` are not used. Merchant
  normalization is handled entirely by `merchants.json` locally. Sure can pick up
  merchant associations through its own Rules engine after import.

- **No web UI or dashboard** — there is no browser-based interface for this tool.
  Observability is via `importer.log` and Telegram alerts. A dashboard would add
  complexity with no meaningful benefit over `tail -f`.

- **No HTTP server or exposed ports** — manual triggers use `docker exec`. There
  is no REST API, no webhook receiver, and no health-check endpoint exposed to the
  network.

- **No multi-user support** — this tool is designed for a single Sure Finance
  family/instance. It does not handle multiple users, multiple Sure instances, or
  tenant isolation.

- **No real-time / webhook-triggered sync** — the tool is schedule-driven (cron)
  or manually triggered. It does not listen for bank events or webhooks and does
  not attempt to sync immediately when a transaction occurs.

- **No screenshot capture** — no Chromium screenshots are saved on failure or
  success. Debugging is done via the unified log file at `debug` level.

- **No CSV file output** — the generated CSV is built in memory and posted directly
  to Sure's API. It is not written to disk for manual inspection (use `--dry-run`
  to see the content in the log instead).

- **No balance reconciliation** — the bridge imports transactions only. It does not
  read or update account balances, create reconciliation entries, or adjust Sure's
  calculated balance to match the bank's reported balance.

- **No notification channels beyond Telegram** — email, Slack, ntfy, and other
  notification targets are out of scope. Telegram is the only supported channel.

- **No automatic secret rotation** — the bridge reads secrets at startup. Rotating
  a credential requires manually overwriting the secret file and restarting the
  container. Integration with Vault, external secret managers, or auto-rotation
  workflows is out of scope.

---

## 7. Tech Preferences

### Language & Runtime
- **TypeScript** — strict mode, no `any` unless unavoidable
- **Node.js 22** — LTS, matches `israeli-bank-scrapers` minimum requirement

### Package Manager
- **npm** — not yarn, not pnpm; keeps things simple for the homelab context

### Key Libraries — use these, do not substitute

| Library | Purpose | Why this one |
|---------|---------|--------------|
| `israeli-bank-scrapers` (v6.7.1) | Bank scraping | Official package by eshaham. Uses Puppeteer + Chromium. Works reliably for Max and Mizrahi. Actively maintained, published with every merged commit. |
| `better-sqlite3` | Deduplication state | Synchronous API, no extra process, file-based |
| `node-cron` | Scheduling | Lightweight, supports timezone-aware cron |
| `winston` | Logging | Mature, supports custom transports and redaction |
| `winston-daily-rotate-file` | Log rotation | Integrates directly with Winston |
| `axios` | Sure API HTTP calls | Familiar, good error handling, interceptor support |
| `ajv` | Config schema validation | Fast, TypeScript-friendly JSON schema validation |

### Patterns
- **`*_FILE` env var pattern** for all secrets — env var holds the file path,
  not the value; `src/secrets.ts` reads the file at runtime
- **Graceful partial failure** — each target runs in a try/catch; one bank
  failing does not throw the entire run
- **Single logger instance** — instantiated in `src/logger.ts`, imported
  everywhere; all modules write to the same Winston instance
- **Config validated at startup** — AJV schema validation runs before any
  scraping begins; startup fails fast with a clear error if config is malformed
- **No ORM** — `better-sqlite3` used directly with prepared statements; the
  schema is simple enough that an ORM adds no value

### Docker
- **Multi-stage Dockerfile** — `builder` stage (TypeScript compile), `runtime`
  stage (lean, no dev deps, no build tools)
- **Base image** — `node:22-slim` + Chromium installed via apt
- **Non-root user** — `1000:1000` created in Dockerfile, all app files owned by it
- **No `read_only: true`** — breaks Chromium; do not add it
- **`shm_size: 256mb`** — required for Chromium; must be in compose.yml
- **`cap_drop: ALL` is not used** — breaks Chromium's zygote subprocess forking;
  `no-new-privileges:true` is the only security_opt needed

### File Structure Constraints
- `src/` — all TypeScript source, one file per module (no barrel `index.ts` re-exports)
- `dist/` — compiled output, gitignored
- `secrets/` — gitignored, `chmod 400` per file
- `cache/` — gitignored
- `browser-data/` — gitignored
- `logs/` — gitignored

### Testing
- Test changes with `docker compose run --rm israeli-sure-importer` (single run, exits)
- Always use `--dry-run` first when modifying transformer, merchants, or CSV output
- `LOG_LEVEL=debug` for full visibility during development

### What to avoid
- Do not use `console.log` — use the Winston logger
- Do not hardcode any path — use env vars (`BROWSER_DATA_DIR`, `SURE_API_KEY_FILE`, etc.)
- Do not catch-and-silently-swallow errors — log them and let the per-bank failure
  handling decide whether to continue or abort
- Do not add dependencies without a clear reason — keep the image small
