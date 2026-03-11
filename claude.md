# Israeli Banks → Sure Finance Importer — Claude Code Instructions

## What this project does
Scrapes Israeli bank and credit card accounts using `israeli-bank-scrapers` (headless Chromium) (https://github.com/eshaham/israeli-bank-scrapers),
and imports the transactions into a self-hosted [Sure Finance](https://github.com/we-promise/sure)
instance via its REST API. Runs as a hardened Docker container on your Unraid homelab.

Important: The architecture need to be closely mirrors tomerh2001/israeli-banks-actual-budget-importer (https://github.com/tomerh2001/israeli-banks-actual-budget-importer)

---

## Architecture

```
src/
  index.ts        — Entry point, pre-flight check, cron scheduler
  config.ts       — Loads config.json (zero credentials) + resolves secrets into memory
  secrets.ts      — Reads credential files from secrets/ with strict path-traversal protection
  scraper.ts      — Wraps israeli-bank-scrapers, passes credentials without logging them
  mapper.ts       — Converts scraper output → Sure CSV format
  sure-client.ts  — HTTP client for Sure /api/v1/ (UUID-validated URLs, timeouts, safe errors)
  importer.ts     — Orchestrates scrape → map → upload per bank
  state.ts        — Persists last-sync timestamps to cache/sync-state.json
  logger.ts       — Winston logger with credential redaction + log level validation

secrets/          — One file per credential (gitignored, chmod 400)
config.json       — Structure only, zero credentials (safe to commit)
compose.yml       — Hardened Docker Compose (non-root, read-only FS, no ports)
setup.sh          — Interactive wizard that creates secrets/ files with silent input
```

---

## Critical security rules — READ BEFORE EDITING

1. **Never log credential values.** `readSecret()` return values must never be passed
   to `logger.*`, `console.*`, `JSON.stringify()`, or any error message.

2. **Never add credentials to config.json.** All credentials go in individual files
   under `secrets/`. The `credentialKeys` field in config.json holds only the filename,
   not the value.

3. **Never add credentials to environment variables** in compose.yml or Dockerfile.
   `docker inspect` exposes all env vars.

4. **Never change `VALID_SECRET_NAME` regex** in secrets.ts to be more permissive.
   The strict `[a-zA-Z0-9_-]` allowlist is the path-traversal guard.

5. **Never remove the UUID validation** in sure-client.ts `uploadCsv()`.
   It prevents SSRF via a malicious sureAccountId in config.json.

6. **Never add a `ports:` entry** to compose.yml. This container has no inbound surface.

7. **Never change `read_only: true`** in compose.yml without adding a specific tmpfs
   for the new writable path.

---

## Common tasks

### Add a new bank
1. Find the `companyId` in [israeli-bank-scrapers docs](https://github.com/eshaham/israeli-bank-scrapers)
2. Add an entry to `config.example.json` under `banks` with the correct `credentialKeys`
3. Add the bank to `setup.sh` in the `setup_bank` calls section
4. Add the bank to `secrets/README.md`
5. Add to the supported banks table in `README.md`
6. No code changes needed in `scraper.ts` — it reads `CompanyTypes` dynamically

### Change the sync schedule
Edit `SCHEDULE` in `compose.yml`. Cron is Asia/Jerusalem timezone.
Remove `SCHEDULE` entirely to run once and exit (good for testing).

### Debug a scrape failure
```bash
docker compose run --rm -e LOG_LEVEL=debug israeli-sure-importer
```
Credentials are never printed even at debug level (redaction is always on).

### Test without Docker (local dev)
```bash
npm install
export SECRETS_DIR=./secrets
export CONFIG_PATH=./config.json
export LOG_LEVEL=debug
npx ts-node src/index.ts
```

### Build and run
```bash
docker compose build
docker compose run --rm israeli-sure-importer    # one-shot test
docker compose up -d                             # start scheduled
docker compose logs -f                           # follow logs
```

### Connect to Sure's Docker network
If Sure runs in a separate compose stack:
```bash
docker network ls | grep sure
```
Then in compose.yml replace the `networks:` section:
```yaml
networks:
  sure-internal:
    external: true
    name: <actual-sure-network-name>
```

---

## Key types

```typescript
// config.json shape (no credentials)
AppConfig {
  sure: { baseUrl: string }
  banks: Record<companyId, {
    credentialKeys: Record<scraperFieldName, secretFileName>
    targets: Target[]
  }>
}

// In-memory only (never serialised)
ResolvedConfig {
  sure: { baseUrl, apiKey }
  banks: Record<companyId, {
    credentials: Record<scraperFieldName, value>  // ← from secret files
    targets: Target[]
  }>
}

Target {
  sureAccountId: string        // UUID from Sure URL
  sureAccountName?: string     // for logs only
  accounts?: 'all' | string[]  // filter by account number
  includePending?: boolean
}
```

---

## Dependencies worth knowing

- `israeli-bank-scrapers` — uses puppeteer + headless Chromium, requires Node ≥ 22.12, TZ=Asia/Jerusalem
- `node-fetch@2` — v2 for CommonJS compatibility (v3 is ESM-only)
- `ajv@8` — JSON schema validation for config.json
- `node-cron` — in-process scheduler (no external cron daemon needed)
- `winston` — structured logging with redaction format

---

## What NOT to do (for Claude Code specifically)

- Do not run `docker compose up` or `docker compose build` without being asked
- Do not read or print the contents of any file in `secrets/`
- Do not add any `console.log` calls — use `logger.*` only
- Do not suggest moving credentials to `.env` files or environment variables
- Do not modify `.gitignore` to unignore `secrets/` or `config.json`
