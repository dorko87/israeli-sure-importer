## What's new in v1.5.0

### New features
- **Per-target `richDetails: true` config flag** — When set, passes `additionalTransactionInformation: true` to the scraper. For **Mizrahi** and **Hapoalim** this fetches sender/recipient/purpose details for each transaction (so transfers like `העברת יומן` now show who sent the money in notes). No-op for all other supported scrapers. Per-target opt-in because the extra HTTP call per transaction increases scrape time.
- **Auto-categorization for Max and Visa Cal** — `categoryMap` in config now matches the bank-provided category (`tx.category`) instead of the useless `tx.type` ("normal"/"installments"). Example: `"categoryMap": { "Restaurants": "Dining Out", "Gas Stations": "Transportation" }` now actually does something for Max. Backward compatible — falls back to `tx.type` when the bank doesn't provide a category.

### Bug fixes
- **`Charge date:` in notes shows the real card settlement date** — For credit cards (Max, Visa Cal), `tx.date` is the purchase date and `tx.processedDate` is the actual charge/settlement date (often a month later). A new `Charge date:` metadata line now appears in notes when the two dates differ, showing when the card actually charges. The existing `Processed date:` line is preserved as the dedup anchor (still `tx.date`) so existing imported transactions are unaffected.
- **Enriched memo preserved for Mizrahi installment-type transactions** — Previously, `tx.memo` was suppressed for any transaction with installments, regardless of bank. This was needed because Max populates memo with a redundant installment label — but it also silently dropped the sender/purpose info fetched by `richDetails: true` on Mizrahi. The suppression now applies only to Max.

---

## What's new in v1.4.0

### New features
- **`--target <name>` flag** — Run only specific targets instead of all (repeatable: `--target A --target B`). `--all` or omitting the flag runs everything.
- **Env overrides for local dev** — `CONFIG_PATH`, `SECRETS_BASE`, `LOG_DIR`, `SURE_BASE_URL` allow running `npx ts-node src/index.ts` directly without Docker.
- **Max bank loan transactions** — Unknown Hebrew loan transaction types (`הלוואה ברגע למולטי`, `הלוואה בהטבה`) are now treated as Normal instead of throwing. Uses `patch-package` against `israeli-bank-scrapers@6.7.4`.

### Improvements
- **Faster Dockerfile chown** — `chown` now targets only newly created empty dirs instead of recursively traversing all of `/app` including `node_modules`.
- **Library warnings routed through logger** — `console.warn` from scrapers now flows through the structured logger with rotation instead of unstructured stdout.

### Contributors
Thanks to [@noamyoyo](https://github.com/noamyoyo) for contributing all the v1.4.0 features.

---

## What's new in v1.3.0

### Bug fixes
- **Fixed missing recurring transactions (dedup false positive)** — Banks that reuse the same transaction identifier for recurring monthly payments (e.g. Mizrahi Bank salary, standing orders) caused every occurrence after the first to be silently skipped. The sourceId format now includes the transaction date, making each monthly occurrence unique. Existing imported transactions are not affected — backward compatibility is handled via a date-aware legacy check.