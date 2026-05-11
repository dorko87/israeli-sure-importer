## What's new in v1.5.0

### New features
- **Per-target `richDetails: true` config flag** — When set, passes `additionalTransactionInformation: true` to the scraper. For **Mizrahi** and **Hapoalim** this fetches sender/recipient/purpose details for each transaction (so transfers like `העברת יומן` now show who sent the money in notes). No-op for all other supported scrapers. Per-target opt-in because the extra HTTP call per transaction increases scrape time.
- **Auto-categorization for Max and Visa Cal** — `categoryMap` in config now matches the bank-provided category (`tx.category`) instead of the useless `tx.type` ("normal"/"installments"). Example: `"categoryMap": { "Restaurants": "Dining Out", "Gas Stations": "Transportation" }` now actually does something for Max. Backward compatible — falls back to `tx.type` when the bank doesn't provide a category.

### Bug fixes
- **`Processed date:` in notes now reflects the real bank `processedDate`** — Previously we emitted the transaction date here, which for credit cards (Max, Visa Cal) is the purchase date — not the date the card actually charges. Now correctly shows the payment/processing date. Falls back to transaction date when the scraper doesn't populate `processedDate`. Existing imported transactions are unaffected; dedup backward-compat is preserved (the line is still emitted on every transaction).

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