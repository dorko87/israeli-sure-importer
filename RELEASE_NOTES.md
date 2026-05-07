## What's new in v1.3.0

### Bug fixes
- **Fixed missing recurring transactions (dedup false positive)** — Banks that reuse the same transaction identifier for recurring monthly payments (e.g. Mizrahi Bank salary, standing orders) caused every occurrence after the first to be silently skipped. The sourceId format now includes the transaction date, making each monthly occurrence unique. Existing imported transactions are not affected — backward compatibility is handled via a date-aware legacy check.