import * as fs from 'fs';
import { schedule, type ScheduledTask } from 'node-cron';
import logger from './logger';
import { loadConfig, type Target } from './config';
import { loadAppSecrets, readSecretFile } from './secrets';
import {
  initSureClient,
  postImport,
  pollImport,
  checkImport,
} from './sure-client';
import { initNotifier, notifyLoginFail, notifySyncFail, notifySuccess, notifyErrorThreshold, notifySlowScrape } from './notifier';
import { scrapeTarget } from './scraper';
import { reloadMerchants } from './merchants';
import { transform, buildCsv } from './transformer';
import { insertMany, backupDb, closeDb, type DedupRecord } from './state';
import { appendHistory } from './history';

// --- CLI flags ---
const args = process.argv.slice(2);
const runOnce = args.includes('--run-once');
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const importPending = process.env.IMPORT_PENDING === 'true';
const publish = process.env.PUBLISH ?? 'false';
const scheduleExpr = process.env.SCHEDULE;

// --- Graceful shutdown state ---
let shuttingDown = false;
let cronTask: ScheduledTask | null = null;

/**
 * Thrown by processTarget() when it has already sent a Telegram alert for the failure.
 * The outer run() catch must NOT send a second alert when it sees this error type.
 */
class AlreadyNotifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyNotifiedError';
  }
}

// --- Per-target pipeline ---

interface TargetStats {
  bank: string;
  scraped: number;        // total txns from scraper across all accounts
  newTx: number;          // rows sent to Sure (or would-be-sent in dry run)
  dedupSkipped: number;
  futureSkipped: number;
  pendingSkipped: number;
  error: boolean;
  importFailed: boolean;
}

async function processTarget(
  target: Target,
  accountId: string
): Promise<TargetStats> {
  // Load bank credentials from /run/secrets/
  const credentials: Record<string, string> = {};
  for (const [field, secretFile] of Object.entries(target.credentialSecrets)) {
    credentials[field] = readSecretFile(secretFile);
  }

  // Scrape — #19: log elapsed time per bank, #13: alert if approaching timeout
  const scrapeStart = Date.now();
  const scrapeResult = await scrapeTarget({
    companyId: target.companyId,
    credentials,
    name: target.name,
  });
  const elapsedMs = Date.now() - scrapeStart;
  const elapsedSecs = Math.round(elapsedMs / 1000);
  const limitMs = parseInt(process.env.TIMEOUT_MINUTES ?? '10', 10) * 60 * 1000;
  logger.info(`[${target.name}] Scraped in ${elapsedSecs}s`);
  if (elapsedMs > limitMs * 0.8) {
    await notifySlowScrape(target.name, elapsedSecs, Math.round(limitMs / 1000));
  }

  if (!scrapeResult.success) {
    const isLoginError = ['INVALID_PASSWORD', 'CHANGE_PASSWORD', 'ACCOUNT_BLOCKED'].includes(
      scrapeResult.errorType
    );
    logger.error(
      `[${target.name}] Scraper failed | errorType=${scrapeResult.errorType}` +
      (scrapeResult.errorMessage ? ` | ${scrapeResult.errorMessage}` : '')
    );
    if (isLoginError) {
      await notifyLoginFail(target.name, scrapeResult.errorType);
    } else {
      await notifySyncFail(target.name, scrapeResult.errorType);
    }
    throw new AlreadyNotifiedError(`Scraper failed: ${scrapeResult.errorType}`);
  }

  let totalImported = 0;
  let totalScraped = 0;
  let totalDedup = 0;
  let totalFuture = 0;
  let totalPending = 0;
  let hasImportFailure = false;

  for (const account of scrapeResult.accounts) {
    const txResult = transform(
      account.txns,
      account.accountNumber,
      target.companyId,
      importPending
    );

    const newCount = txResult.rows.length;
    logger.info(
      `[${target.name}] account=${account.accountNumber} | scraped=${account.txns.length}` +
      ` → ${newCount} new | dedup=${txResult.alreadySeenSkipped} zero=${txResult.zeroAmountSkipped} future=${txResult.futureSkipped} pending=${txResult.pendingSkipped}`
    );

    totalScraped += account.txns.length;
    totalDedup += txResult.alreadySeenSkipped;
    totalFuture += txResult.futureSkipped;
    totalPending += txResult.pendingSkipped;

    if (newCount === 0) continue;

    const csv = buildCsv(txResult.rows.map(r => r.row));

    if (dryRun) {
      logger.info(`[${target.name}] [DRY RUN] Would import ${newCount} transactions`);
      logger.debug(`[${target.name}] [DRY RUN] CSV:\n${csv}`);
      // #17 — Write CSV to logs volume for inspection
      const ts = new Date().toISOString().replace(/:/g, '-').substring(0, 19); // "2026-03-21T08-00-14"
      const csvPath = `/app/logs/dry-run-${target.companyId}-${ts}.csv`;
      try {
        fs.writeFileSync(csvPath, csv, 'utf-8');
        logger.info(`[${target.name}] Dry run: CSV written to ${csvPath}`);
      } catch (err) {
        logger.warn(`[${target.name}] Dry run: failed to write CSV: ${String(err)}`);
      }
      appendHistory({
        timestamp: new Date().toISOString(),
        bank: target.name,
        companyId: target.companyId,
        importId: null,
        rowsSent: newCount,
        status: 'dry_run',
        dryRun: true,
      });
      totalImported += newCount;
      continue;
    }

    // Submit CSV to Sure
    let importId: string | null = null;
    importId = await postImport({ accountId, csv, publish });
    logger.info(`[${target.name}] CSV posted → import_id=${importId}`);

    // When publish=false, Sure places the import in the review queue with status=pending.
    // That is the terminal state — it won't change until the user confirms in the Sure UI.
    // When publish=true, Sure auto-processes: pending → importing → complete.
    const importResult = publish !== 'true'
      ? await checkImport(importId)  // single GET — pending is the expected terminal state
      : await pollImport(importId);  // full poll — wait for auto-processing to complete

    const rowSummary = `${importResult.valid_rows_count ?? '?'}/${importResult.rows_count ?? '?'} rows`;

    const isSuccess =
      importResult.status === 'complete' ||
      (publish !== 'true' && importResult.status === 'pending');

    if (isSuccess) {
      if (importResult.status === 'complete') {
        logger.info(`[${target.name}] Import status: complete | ${rowSummary}`);
      } else {
        logger.info(`[${target.name}] Import status: pending | ${rowSummary} — review in Sure UI`);
      }

      // Persist dedup keys — import was accepted by Sure (pending = in review queue)
      const dedupRecords: DedupRecord[] = txResult.rows.map(r => ({
        key: r.dedupKey,
        bank: target.companyId,
        accountNumber: account.accountNumber,
      }));
      insertMany(dedupRecords);
      const failedRows = (importResult.rows_count ?? 0) - (importResult.valid_rows_count ?? 0);
      if (failedRows > 0) await notifyErrorThreshold(target.name, failedRows);
      appendHistory({
        timestamp: new Date().toISOString(),
        bank: target.name,
        companyId: target.companyId,
        importId,
        rowsSent: newCount,
        status: importResult.status,
        dryRun: false,
      });
      totalImported += newCount;
    } else {
      const errMsg = importResult.error ?? importResult.status;
      logger.error(`[${target.name}] Import failed | status=${importResult.status} | ${errMsg}`);
      await notifySyncFail(target.name, errMsg);
      hasImportFailure = true;
      appendHistory({
        timestamp: new Date().toISOString(),
        bank: target.name,
        companyId: target.companyId,
        importId: importId ?? null,
        rowsSent: newCount,
        status: 'failed',
        dryRun: false,
      });
    }
  }

  return {
    bank: target.name,
    scraped: totalScraped,
    newTx: totalImported,
    dedupSkipped: totalDedup,
    futureSkipped: totalFuture,
    pendingSkipped: totalPending,
    error: false,
    importFailed: hasImportFailure,
  };
}

// --- Main run ---

async function run(): Promise<void> {
  logger.info('=== Run started ===');
  reloadMerchants(); // #9 — re-read merchants.json on each run; picks up edits without restart
  if (dryRun) logger.info('[DRY RUN] mode — no Sure API writes will be made');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error(`Config error: ${String(err)}`);
    process.exit(1);
  }

  let secrets;
  try {
    secrets = loadAppSecrets();
  } catch (err) {
    logger.error(`Secrets error: ${String(err)}`);
    process.exit(1);
  }

  if (!secrets.telegramBotToken && process.env.TELEGRAM_BOT_TOKEN_FILE) {
    logger.warn('TELEGRAM_BOT_TOKEN_FILE set but could not be read — Telegram alerts disabled');
  }

  if (!dryRun) {
    initSureClient(config.sure.baseUrl, secrets.sureApiKey);
  }
  initNotifier(secrets.telegramBotToken);

  // Process each target sequentially — one bank failing does not stop the others
  const allStats: TargetStats[] = [];
  let totalImported = 0;
  let successCount = 0;
  let failCount = 0;

  for (const target of config.targets) {
    const accountId = dryRun ? 'dry-run' : target.sureAccountId;

    try {
      const stats = await processTarget(target, accountId);
      allStats.push(stats);
      totalImported += stats.newTx;
      successCount++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[${target.name}] Pipeline failed: ${errMsg}`);
      // AlreadyNotifiedError: scraper notified Telegram — skip duplicate alert
      if (!(err instanceof AlreadyNotifiedError)) {
        await notifySyncFail(target.name, errMsg);
      }
      failCount++;
      allStats.push({ bank: target.name, scraped: 0, newTx: 0, dedupSkipped: 0, futureSkipped: 0, pendingSkipped: 0, error: true, importFailed: false });
    }
  }

  // #12 — Back up dedup state after each run
  await backupDb();

  // Build per-bank summary lines for Telegram
  const bankLines = allStats.map(s => {
    if (s.error) return `❌ ${s.bank} — scrape failed`;
    if (s.importFailed) return `⚠️ ${s.bank} — import failed`;
    const parts: string[] = [`${s.scraped} scraped → ${s.newTx} new`];
    if (s.dedupSkipped > 0)   parts.push(`${s.dedupSkipped} dedup`);
    if (s.pendingSkipped > 0) parts.push(`${s.pendingSkipped} pending skipped`);
    if (s.futureSkipped > 0)  parts.push(`${s.futureSkipped} future skipped`);
    return `✅ ${s.bank} — ${parts.join(' | ')}`;
  });

  const header =
    `Run complete | banks=${config.targets.length} ok=${successCount} fail=${failCount}` +
    ` | imported=${totalImported} tx` +
    (dryRun ? ' [DRY RUN]' : '');

  const fullSummary = [header, ...bankLines].join('\n');

  logger.info(header);

  if (!dryRun && successCount > 0) {
    await notifySuccess(fullSummary);
  } else if (dryRun) {
    logger.debug('Skipping success notification — dry run');
  }

  logger.info('=== Run finished ===');
}

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

// --- Entry point ---

async function main(): Promise<void> {
  if (runOnce || !scheduleExpr) {
    await run();
    // Set exit code and return — Node.js drains file transport buffers naturally.
    // process.exit() would kill buffered writes immediately; this avoids that.
    // Force-exit after 3 s as a fallback in case Puppeteer left lingering handles.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 3000).unref();
    return;
  }

  // Scheduled mode — keep process alive
  logger.info(`Scheduling runs with cron: ${scheduleExpr}`);
  cronTask = schedule(scheduleExpr, () => {
    if (shuttingDown) {
      logger.debug('Cron fired during shutdown — skipping run');
      return;
    }
    run().catch(err => logger.error(`Unhandled run error: ${String(err)}`));
  }, { timezone: 'Asia/Jerusalem' });
  logger.info('Scheduler started — waiting for next trigger');
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT',  () => handleShutdown('SIGINT'));

main().catch(err => {
  logger.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
