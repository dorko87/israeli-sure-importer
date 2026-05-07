## What's new in v1.4.0

### New features
- **`--target <name>` flag** — Run only specific targets instead of all (repeatable: `--target A --target B`). `--all` or omitting the flag runs everything.
- **Env overrides for local dev** — `CONFIG_PATH`, `SECRETS_BASE`, `LOG_DIR`, `SURE_BASE_URL` allow running `npx ts-node src/index.ts` directly without Docker.
- **Max bank loan transactions** — Unknown Hebrew loan transaction types (`הלוואה ברגע למולטי`, `הלוואה בהטבה`) are now treated as Normal instead of throwing. Uses `patch-package` against `israeli-bank-scrapers@6.7.4`.

### Improvements
- **Faster Dockerfile chown** — `chown` now targets only newly created empty dirs instead of recursively traversing all of `/app` including `node_modules`.
- **Library warnings routed through logger** — `console.warn` from scrapers now flows through the structured logger with rotation instead of unstructured stdout.

---

## What's new in v1.3.0

### Bug fixes
- **Fixed missing recurring transactions (dedup false positive)** — Banks that reuse the same transaction identifier for recurring monthly payments (e.g. Mizrahi Bank salary, standing orders) caused every occurrence after the first to be silently skipped. The sourceId format now includes the transaction date, making each monthly occurrence unique. Existing imported transactions are not affected — backward compatibility is handled via a date-aware legacy check.

---

## What's new in v1.2.0

### Improvements
- **`LOG_MAX_FILES` env var** — Log retention window is now configurable via `LOG_MAX_FILES` in `compose.yml` (e.g. `"7d"`, `"14d"`). Defaults to `7d`. Previously hardcoded to 14 days.
