## What's new in v1.1.0

### Bug fixes
- **Sure API envelope** — All POST payloads now correctly wrapped in the resource key (`{ transaction: {...} }`, `{ valuation: {...} }`, `{ tag: {...} }`). Fixes HTTP 500 on every transaction import.
- **Tag loading** — `GET /api/v1/tags` returns a plain array; replaced `listPaginatedCollection` with a direct GET. Fixes "Failed to create tag: TypeError" and 422 errors when tags already exist in Sure.
- **Transaction response** — Response is flat (`res.data.id`), not nested. Fixes "Cannot read properties of undefined (reading 'id')".
- **Valuation NaN guard** — Reconciliation now uses `Number.isFinite(balance)` instead of `!= null`. Prevents 422 when the scraper returns `NaN` for balance (serialises to `null` in JSON, failing Sure's presence validation).
- **Valuation non-fatal** — Reconciliation failure no longer crashes the pipeline; logs a warning with the response body and continues.

### New features
- **`IMPORT_FUTURE` env var** — Future-dated transactions are dropped by default (prevents credit card scheduled charges). Set `IMPORT_FUTURE=true` in `compose.yml` to opt in and import them.
- **Per-target `accounts` filter** — Add `"accounts": ["8538", "7697"]` to any target in `config.json` to import only specific bank account numbers. Defaults to `"all"`.

### Improvements
- `README.md` and `compose.yml` fully synced with current implementation.
- `compose.yml` env vars table completed — added `IMPORT_FUTURE`, `SURE_API_KEY_FILE`, `TELEGRAM_*`, and Puppeteer vars.
