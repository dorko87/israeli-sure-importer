# Robustness Fixes (M1, M2, M3, M5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four small robustness gaps identified in the post-SIGTERM code review: correct misleading error messaging for account resolution failures and add a Telegram alert (M1); add defensive JSON schema validation to merchants.json parsing (M3); add HISTORY_PATH env var override for consistency with MERCHANTS_PATH (M5); document the missing account type on the auto-create path (M2).

**Architecture:** All changes are isolated within existing files — no new modules needed. M1 changes the account resolution error path in `index.ts`. M3 adds a type guard after `JSON.parse` in `merchants.ts`. M5 promotes the hardcoded history path to an env var in `history.ts`. M2 adds one JSDoc comment in `sure-client.ts`. Each change compiles independently. Verified with `npx tsc --noEmit` after every task.

**Tech Stack:** TypeScript strict mode, Node.js 22, Winston logger, existing module structure

---

## M4 — No action (acknowledged limitation)

Timeout-abandoned browser processes are a known limitation of `israeli-bank-scrapers` managing its own Chromium lifecycle. This is per-design. No code change. Already documented in CLAUDE.md Known gaps section.

---

## File Map

| File | Change |
|------|--------|
| `src/index.ts` | M1: add `notifySyncFail()` to account-resolution catch block; add `accountResolutionFailed` field to `TargetStats`; fix Telegram summary label |
| `src/merchants.ts` | M3: add `isMerchantEntry()` type guard; validate array + entry shape after `JSON.parse`; log warning for invalid entries |
| `src/history.ts` | M5: replace hardcoded path constant with `HISTORY_PATH` env var (default unchanged) |
| `src/sure-client.ts` | M2: add JSDoc warning on `createAccount()` about missing account type |
| `CLAUDE.md` | Add M1/M2/M3/M5 to fixes table; add `HISTORY_PATH` to env vars table |

### Ripple effects

- **M1** — `TargetStats` is a file-local interface (not exported). Changing it affects **three** sites: two `allStats.push(...)` calls inside `run()` (lines ~303 and ~317) plus the `return` statement inside `processTarget()` (line ~230) — because `processTarget()` constructs a `TargetStats` object directly. No other file imports it.
- **M3** — `findMatch()` signature unchanged; callers (`transformer.ts`) are unaffected.
- **M5** — `HISTORY_PATH` defaults to same value as before; existing deployments see no behaviour change.
- **M2** — JSDoc only; no runtime behaviour change.

---

### Task 1: M1 — Fix account resolution error path (`src/index.ts`)

**Problem:** When `resolveAccountId()` throws (UUID not found in Sure and `autoCreateAccounts: false`), the catch block logs the error but does not call `notifySyncFail()`. Later the Telegram summary reads `❌ [bank] — scrape failed` — wrong, the scraper never ran.

**Fix:** (a) Call `notifySyncFail()` in the account-resolution catch. (b) Add `accountResolutionFailed` boolean to `TargetStats`. (c) Map it to a distinct Telegram label.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Read the relevant section of index.ts**

  Read `src/index.ts` lines 62–335 to understand `TargetStats`, the account-resolution loop, the processing loop, and the Telegram summary builder before making changes.

- [ ] **Step 2: Add `accountResolutionFailed` to the `TargetStats` interface**

  Locate the `TargetStats` interface (around line 62). Add the new field:

  ```typescript
  interface TargetStats {
    bank: string;
    scraped: number;
    newTx: number;
    dedupSkipped: number;
    futureSkipped: number;
    pendingSkipped: number;
    error: boolean;
    importFailed: boolean;
    accountResolutionFailed: boolean;   // ← new
  }
  ```

- [ ] **Step 3: Add `notifySyncFail()` to the account-resolution catch block**

  Locate the account-resolution loop (around line 277). In the `catch` block, add the Telegram alert:

  ```typescript
      } catch (err) {
        logger.error(`[${target.name}] Account resolution failed: ${String(err)}`);
        await notifySyncFail(target.name, `Account resolution failed: ${String(err)}`);
        // Target will be skipped in the processing loop
      }
  ```

- [ ] **Step 4: Update the three `TargetStats` construction sites to include the new field**

  There are **three** sites — two `allStats.push(...)` calls in `run()` and one `return` inside `processTarget()`.

  **Site A** — `allStats.push` inside `if (!accountId)` branch (around line 303):

  ```typescript
      allStats.push({
        bank: target.name,
        scraped: 0, newTx: 0, dedupSkipped: 0, futureSkipped: 0, pendingSkipped: 0,
        error: false,
        importFailed: false,
        accountResolutionFailed: true,   // ← account-resolution failure
      });
  ```

  **Site B** — `return` at the end of `processTarget()` (around line 230):

  ```typescript
  return {
    bank: target.name,
    scraped: totalScraped,
    newTx: totalImported,
    dedupSkipped: totalDedup,
    futureSkipped: totalFuture,
    pendingSkipped: totalPending,
    error: false,
    importFailed: hasImportFailure,
    accountResolutionFailed: false,   // ← successful pipeline, not an account issue
  };
  ```

  **Site C** — `allStats.push` inside the `catch` for `processTarget` failure (around line 317):

  ```typescript
      allStats.push({
        bank: target.name,
        scraped: 0, newTx: 0, dedupSkipped: 0, futureSkipped: 0, pendingSkipped: 0,
        error: true,
        importFailed: false,
        accountResolutionFailed: false,   // ← scrape/pipeline failure, not account lookup
      });
  ```

  > **Pre-flight sanity check:** Run `grep -n "allStats.push\|return {" src/index.ts` to confirm exactly 2 `allStats.push` sites and 1 `return` in `processTarget`. If there are more, add `accountResolutionFailed: false` to each additional site before compiling.

- [ ] **Step 5: Update the Telegram summary line builder**

  Locate the `bankLines` map (around line 325). Add the new check as the first condition:

  ```typescript
  const bankLines = allStats.map(s => {
    if (s.accountResolutionFailed) return `❌ ${s.bank} — account not found in Sure`;
    if (s.error) return `❌ ${s.bank} — scrape failed`;
    if (s.importFailed) return `⚠️ ${s.bank} — import failed`;
    const parts: string[] = [`${s.scraped} scraped → ${s.newTx} new`];
    if (s.dedupSkipped > 0)   parts.push(`${s.dedupSkipped} dedup`);
    if (s.pendingSkipped > 0) parts.push(`${s.pendingSkipped} pending skipped`);
    if (s.futureSkipped > 0)  parts.push(`${s.futureSkipped} future skipped`);
    return `✅ ${s.bank} — ${parts.join(' | ')}`;
  });
  ```

- [ ] **Step 6: Confirm zero compile errors**

  ```bash
  cd C:\Users\dorko\.vscode\docker-compose\unraid\sure\israeli-sure-importer
  npx tsc --noEmit
  ```

  Expected: no output (zero errors).

- [ ] **Step 7: Commit**

  ```bash
  git add src/index.ts
  git commit -m "fix(M1): add Telegram alert and correct label for account resolution failures"
  ```

---

### Task 2: M3 — Defensive JSON schema validation in `merchants.ts`

**Problem:** After `JSON.parse(content)`, the code casts directly to `MerchantEntry[]` without validating shape. If `merchants.json` is valid JSON but not an array of `{pattern, name}` objects (e.g. array of strings, wrong key names), `findMatch()` throws a TypeError on first access to `.pattern`, crashing the run.

**Fix:** Add a `isMerchantEntry()` type guard. After parsing, check it's an array, filter entries through the guard, log a warning for any skipped entries.

**Files:**
- Modify: `src/merchants.ts`

- [ ] **Step 1: Read merchants.ts in full**

  Read `src/merchants.ts` lines 1–57.

- [ ] **Step 2: Add the `isMerchantEntry` type guard after the interface**

  After the `MerchantEntry` interface definition (around line 7), add:

  ```typescript
  function isMerchantEntry(entry: unknown): entry is MerchantEntry {
    return (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).pattern === 'string' &&
      typeof (entry as Record<string, unknown>).name === 'string'
    );
  }
  ```

- [ ] **Step 3: Replace the `JSON.parse` cast with validated parsing inside `loadMerchants()`**

  Replace this block:

  ```typescript
    try {
      const content = fs.readFileSync(MERCHANTS_PATH, 'utf-8');
      merchants = JSON.parse(content) as MerchantEntry[];
      if (merchants.length > 0) {
        logger.debug(`Merchants: loaded ${merchants.length} entries from ${MERCHANTS_PATH}`);
      }
    } catch {
  ```

  With:

  ```typescript
    try {
      const content = fs.readFileSync(MERCHANTS_PATH, 'utf-8');
      const parsed: unknown = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        logger.warn(`merchants.json is not an array — merchant normalization disabled`);
        merchants = [];
      } else {
        const valid = parsed.filter(isMerchantEntry);
        const skipped = parsed.length - valid.length;
        if (skipped > 0) {
          logger.warn(`merchants.json: skipped ${skipped} invalid entries (missing pattern or name field)`);
        }
        merchants = valid;
        if (merchants.length > 0) {
          logger.debug(`Merchants: loaded ${merchants.length} entries from ${MERCHANTS_PATH}`);
        }
      }
    } catch {
  ```

- [ ] **Step 4: Confirm zero compile errors**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no output.

- [ ] **Step 5: Commit**

  ```bash
  git add src/merchants.ts
  git commit -m "fix(M3): validate merchants.json shape after JSON.parse — bad entries skipped with warning"
  ```

---

### Task 3: M5 — Add `HISTORY_PATH` env var override in `history.ts`

**Problem:** `history.ts` hardcodes `/app/logs/import_history.jsonl` as a constant. `merchants.ts` supports `MERCHANTS_PATH` for the same pattern. The inconsistency is minor but confusing. Default value is unchanged so no existing deployments are affected.

**Files:**
- Modify: `src/history.ts`

- [ ] **Step 1: Read history.ts in full**

  Read `src/history.ts` lines 1–27.

- [ ] **Step 2: Replace the hardcoded path with an env-backed constant**

  Replace:

  ```typescript
  const HISTORY_PATH = path.join('/app/logs', 'import_history.jsonl');
  ```

  With:

  ```typescript
  const HISTORY_PATH = process.env.HISTORY_PATH ?? path.join('/app/logs', 'import_history.jsonl');
  ```

- [ ] **Step 3: Confirm zero compile errors**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no output.

- [ ] **Step 4: Commit**

  ```bash
  git add src/history.ts
  git commit -m "fix(M5): add HISTORY_PATH env var override — consistent with MERCHANTS_PATH pattern"
  ```

---

### Task 4: M2 — Document missing account type on `createAccount()` (`src/sure-client.ts`)

**Problem:** `createAccount()` sends `POST /api/v1/accounts` with `{ name }` only. Sure creates the account with its default type, which may be Cash when the user needs Credit Card. This only affects the `autoCreateAccounts: true` opt-in path, but a future reader could unknowingly enable it for a credit card target. A JSDoc warning is sufficient.

**Files:**
- Modify: `src/sure-client.ts`

- [ ] **Step 1: Read createAccount in sure-client.ts**

  Read `src/sure-client.ts` lines 40–43.

- [ ] **Step 2: Add the JSDoc warning**

  Replace:

  ```typescript
  export async function createAccount(name: string): Promise<SureAccount> {
    const res = await getClient().post<SureAccount>('/api/v1/accounts', { name });
    return res.data;
  }
  ```

  With:

  ```typescript
  /**
   * Creates a new Sure account with the given name.
   *
   * ⚠️  WARNING: This call sends no account type. Sure will use its default type
   * (likely Cash). If the target requires a Credit Card account, create the account
   * manually in the Sure UI with the correct type and paste the UUID into config.json
   * instead of relying on auto-creation.
   *
   * This function is only reached when `autoCreateAccounts: true` is set in config.json
   * (opt-in, off by default).
   */
  export async function createAccount(name: string): Promise<SureAccount> {
    const res = await getClient().post<SureAccount>('/api/v1/accounts', { name });
    return res.data;
  }
  ```

- [ ] **Step 3: Confirm zero compile errors**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no output.

- [ ] **Step 4: Commit**

  ```bash
  git add src/sure-client.ts
  git commit -m "docs(M2): warn that createAccount() sends no type — Cash default wrong for credit card targets"
  ```

---

### Task 5: Update `CLAUDE.md`

**What:** Record all four fixes in the fixes table, add `HISTORY_PATH` to the environment variables table.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `HISTORY_PATH` to the Environment Variables table**

  In the `## Environment Variables` section, after the `MERCHANTS_PATH` row, add:

  ```
  | `HISTORY_PATH` | string | Override import_history.jsonl path (default: `/app/logs/import_history.jsonl`) |
  ```

- [ ] **Step 2: Append M1/M2/M3/M5 entries to the fixes table**

  In the `### All fixes applied and verified` section, after the S3 row, append:

  ```
  | M1 | `index.ts`: account resolution failures now call `notifySyncFail()` and show `"account not found in Sure"` in Telegram summary; `accountResolutionFailed` field added to `TargetStats` |
  | M2 | `sure-client.ts`: JSDoc warning on `createAccount()` — sends no account type; default is Cash which is wrong for credit card targets; only affects `autoCreateAccounts: true` (opt-in, off by default) |
  | M3 | `merchants.ts`: `isMerchantEntry()` type guard added; validates array + `{pattern, name}` shape after `JSON.parse`; invalid entries skipped with `warn` log instead of crashing the run |
  | M5 | `history.ts`: promoted hardcoded `/app/logs/import_history.jsonl` to `HISTORY_PATH` env var; default unchanged, existing deployments unaffected |
  ```

- [ ] **Step 3: Confirm `Last updated` date is current**

  The date line reads `*Last updated: 2026-03-21*`. Today is 2026-03-21 — no change needed.

- [ ] **Step 4: Commit**

  ```bash
  git add CLAUDE.md
  git commit -m "docs: record M1/M2/M3/M5 fixes in CLAUDE.md; add HISTORY_PATH to env vars table"
  ```

---

### Task 6: Push to Forgejo

- [ ] **Step 1: Push all commits**

  ```bash
  git push origin main
  ```

  Expected: 5 commits pushed. Komodo webhook fires automatically and redeploys the `sure` stack on Unraid.

- [ ] **Step 2: Verify no startup errors**

  Via Komodo UI or:

  ```bash
  # From Unraid terminal
  docker logs israeli-sure-importer --tail=20
  ```

  Expected: no `Error` or `Fatal` lines. Container idles waiting for next cron trigger.

---

## Acceptance Criteria

- [ ] `npx tsc --noEmit` produces zero output after all tasks complete
- [ ] When a target's `sureAccountId` UUID does not exist in Sure and `autoCreateAccounts: false`: log shows `"Account resolution failed"`, Telegram shows `"❌ [bank] — account not found in Sure"`, other targets continue processing normally
- [ ] `merchants.json` containing non-array JSON: `loadMerchants()` returns `[]`, `warn` log appears, no crash
- [ ] `merchants.json` containing an array with one entry missing `pattern` key: that entry is skipped with a `warn` log, valid entries are loaded
- [ ] `HISTORY_PATH` env var (if set) is used as the path for `import_history.jsonl`; if unset, behaviour is identical to before
- [ ] `createAccount()` JSDoc is visible in IDE hover on the function
- [ ] CLAUDE.md env vars table includes `HISTORY_PATH`; fixes table includes M1/M2/M3/M5
- [ ] All 5 commits pushed to Forgejo; Komodo redeploy completes without errors

## Out of Scope

- No changes to `compose.yml` — `HISTORY_PATH` defaults to the same path as before; no need to add it to the environment block unless the user wants to override it
- No changes to `Dockerfile`
- No account type field added to `createAccount()` — the correct fix is manual account creation in the Sure UI (per CLAUDE.md: "NOT used — do not add: POST /api/v1/accounts")
- No test harness setup — the project has no automated test framework; verification is compile-check + dry-run manual test
- M4 (browser timeout cleanup) — acknowledged limitation, no action
