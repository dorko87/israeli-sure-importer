# Graceful SIGTERM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle SIGTERM/SIGINT gracefully — stop new cron triggers, close SQLite cleanly, flush logs, and exit 0 within Docker's default 10-second kill window.

**Architecture (Option A — immediate cleanup):** On SIGTERM, set `shuttingDown = true` to block new cron triggers, stop the cron task, call `closeDb()`, log the shutdown, and exit 0. We do NOT wait for any in-flight run — Docker's 10-second default stop timeout makes waiting impractical without changing compose.yml, and the code change is minimal. The small risk window (postImport sent but insertMany not yet written) is acceptable for a homelab tool.

**Tech Stack:** Node.js signal events (`process.on`), node-cron `ScheduledTask.stop()`, better-sqlite3 `db.close()`, existing Winston logger.

---

## Context (read before touching code)

- **No test framework** — this project has no Jest/Mocha setup. All verification is manual via `docker compose run` and log inspection.
- **Option A tradeoff**: If SIGTERM fires between `postImport()` returning and `insertMany()` running, those transactions will be re-imported as duplicates on the next run. This is a small timing window and an acceptable tradeoff — the user just deletes the duplicate in the Sure UI.
- **SQLite re-open behaviour**: `getDb()` in state.ts reopens the DB if `db === null`. After `closeDb()`, any in-flight `insertMany()` call will just re-open the file, which is safe — the OS closes the FD on `process.exit()`.
- **Chromium / Puppeteer**: `israeli-bank-scrapers` manages its own browser lifecycle. We do NOT close it explicitly. Puppeteer handles its own cleanup on process exit.
- **Winston flush**: Use `process.exitCode = 0` + `setTimeout(() => process.exit(0), 1000).unref()` — same pattern as the existing run-once exit path, gives Winston 1 second to drain file buffers.
- **No compose.yml change needed** — Option A exits within 10 seconds, well within Docker's default stop timeout.

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `src/state.ts` | Modify | Export `closeDb()` — closes the SQLite connection and nulls the module-level `db` |
| `src/index.ts` | Modify | Add `shuttingDown` flag, `cronTask` reference, simplified `handleShutdown()` function, signal registrations, cron guard, and capture of the scheduled task return value |

**No new files. No compose.yml change.**

**Ripple effects:** None. `closeDb()` is additive — no existing callers change.

---

## Task 1: Export `closeDb()` from state.ts

**Files:**
- Modify: `src/state.ts`

- [ ] **Step 1: Add `closeDb()` at the end of `src/state.ts`, after `backupDb()`**

```typescript
/**
 * Closes the SQLite connection cleanly.
 * Call during graceful shutdown — after backupDb() if a backup is desired.
 * Safe to call if the DB was never opened.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.debug('State DB closed');
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles clean**

```bash
cd /app  # or wherever the project root is
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/state.ts
git commit -m "feat: export closeDb() for graceful shutdown"
```

---

## Task 2: Add shutdown state variables and update imports in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `ScheduledTask` type import and `closeDb` to existing imports**

```typescript
// Before (line 2):
import { schedule } from 'node-cron';

// After:
import { schedule, type ScheduledTask } from 'node-cron';
```

```typescript
// Before (line 18):
import { insertMany, backupDb, type DedupRecord } from './state';

// After:
import { insertMany, backupDb, closeDb, type DedupRecord } from './state';
```

- [ ] **Step 2: Add shutdown state variables after the CLI flags block**

Insert after `const scheduleExpr = process.env.SCHEDULE;` (line 27) and before the `// --- Account resolution ---` comment:

```typescript
// --- Graceful shutdown state ---
let shuttingDown = false;
let cronTask: ScheduledTask | null = null;
```

- [ ] **Step 3: Verify TypeScript compiles clean**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add shutdown state variables and closeDb import to index.ts"
```

---

## Task 3: Add `handleShutdown()` and register signal handlers

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `handleShutdown()` just before the `// --- Entry point ---` comment**

```typescript
// --- Graceful shutdown ---

function handleShutdown(signal: string): void {
  if (shuttingDown) return; // prevent double-invocation (SIGTERM + SIGINT racing)
  shuttingDown = true;

  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  closeDb();
  logger.info(`${signal} received — scheduler stopped, database closed, shutting down`);

  // Let Winston file transports drain before exit.
  // 1000ms is sufficient — log volume at shutdown is low.
  // (The run-once path uses 3000ms as a Puppeteer handle guard; not needed here.)
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 1000).unref();
}
```

- [ ] **Step 2: Register signal handlers before `main()` is called**

Replace the current entry-point block at the bottom of the file:

```typescript
// Before:
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// After:
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT',  () => handleShutdown('SIGINT'));

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

Signal handlers must be registered **before** `main()` is called so they are in place before any async scraping begins.

Note: `handleShutdown` is synchronous (no `async`/`await`), so no `void` cast is needed on the event listener.

- [ ] **Step 3: Verify TypeScript compiles clean**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add handleShutdown() and register SIGTERM/SIGINT handlers"
```

---

## Task 4: Capture `cronTask` and add shutdown guard in `main()`

**Files:**
- Modify: `src/index.ts` — `main()` function only

- [ ] **Step 1: Capture the scheduled task and add `shuttingDown` guard**

Replace the scheduled-mode block inside `main()`:

```typescript
// Before:
logger.info(`Scheduling runs with cron: ${scheduleExpr}`);
schedule(scheduleExpr, () => {
  run().catch(err => logger.error(`Unhandled run error: ${String(err)}`));
}, { timezone: 'Asia/Jerusalem' });
logger.info('Scheduler started — waiting for next trigger');

// After:
logger.info(`Scheduling runs with cron: ${scheduleExpr}`);
cronTask = schedule(scheduleExpr, () => {
  if (shuttingDown) {
    logger.debug('Cron fired during shutdown — skipping run');
    return;
  }
  run().catch(err => logger.error(`Unhandled run error: ${String(err)}`));
}, { timezone: 'Asia/Jerusalem' });
logger.info('Scheduler started — waiting for next trigger');
```

The run-once path (`if (runOnce || !scheduleExpr)`) does **not** need changes — it's a single `await run()`, and if SIGTERM fires during that, `handleShutdown` closes the DB and exits 0.

- [ ] **Step 2: Verify TypeScript compiles clean**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: capture cronTask and add shuttingDown guard in scheduler"
```

---

## Task 5: Build and manual verification

- [ ] **Step 1: Build the image**

```bash
docker compose build
```

Expected: build completes with no errors.

- [ ] **Step 2: Verify SIGTERM with no active run**

Start the container in scheduled mode (ensure `SCHEDULE` is set to a future time so no run fires immediately):

```bash
docker compose up -d
sleep 3
docker stop israeli-sure-importer
```

Check the log:

```bash
tail -20 /mnt/user/appdata/sure/israeli-sure-importer/logs/importer.log
```

Expected log line:
```
SIGTERM received — scheduler stopped, database closed, shutting down
```

Expected exit code (0, not 143):
```bash
docker inspect israeli-sure-importer --format='{{.State.ExitCode}}'
# → 0
```

- [ ] **Step 3: Verify SIGTERM during an active run**

```bash
docker compose run -d --rm israeli-sure-importer node dist/index.js --run-once
sleep 30  # let the scrape start — adjust if bank login takes longer on your network
docker stop $(docker ps -qf "ancestor=dorko87/israeli-sure-importer")
```

Expected: container exits within ~2 seconds with code 0 (not killed after 10s). Log shows the shutdown message before the process exits.

- [ ] **Step 4: Verify state.db is not corrupted**

```bash
sqlite3 /mnt/user/appdata/sure/israeli-sure-importer/cache/state.db \
  "SELECT COUNT(*) FROM dedup_keys;"
```

Expected: a number ≥ 0, no SQLite errors.

- [ ] **Step 5: Update CLAUDE.md — add fix to the table and bump date**

In `CLAUDE.md → ## Current Status → All fixes applied`, add:

```
| S3 | `index.ts` + `state.ts`: graceful SIGTERM/SIGINT handling — stops cron, closes SQLite cleanly, exits 0; no compose.yml change needed (exits within 10s) |
```

Update `*Last updated*` to today's date.

```bash
git add CLAUDE.md
git commit -m "docs: record graceful SIGTERM feature in CLAUDE.md"
```

---

## Acceptance Criteria

| Criterion | How to verify |
|-----------|--------------|
| SIGTERM with no active run exits in < 2s with code 0 | `docker stop` → `docker inspect` exit code = 0 |
| SIGTERM during active run exits in < 2s with code 0 | Container stops well before Docker's 10s kill timeout |
| state.db readable after shutdown | `sqlite3 state.db "SELECT COUNT(*) FROM dedup_keys"` returns without error |
| Log shows clean shutdown message | `tail` log — last line is the SIGTERM shutdown message |
| No new cron run starts after SIGTERM | `shuttingDown` guard in cron callback prevents race |

---

## Out of Scope

- **Waiting for in-flight run to complete** — requires `stop_grace_period` in compose.yml (Option B); excluded by design choice.
- **AbortController through pipeline** — would eliminate the small duplicate-import window but is much more invasive (Option C); excluded by design choice.
- **compose.yml `stop_grace_period`** — not needed for Option A.
- **Aborting a mid-scrape Puppeteer session** — Puppeteer cleans up on process exit; not our responsibility.
- **SIGUSR1/SIGUSR2 for log rotation** — Winston daily-rotate-file handles this; out of scope.
- **Health-check endpoint** — explicitly out of scope per PRD §6.
