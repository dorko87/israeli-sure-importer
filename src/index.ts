import { schedule, type ScheduledTask } from 'node-cron';
import logger from './logger';
import { loadConfig, type Target } from './config';
import { loadAppSecrets, readSecretFile } from './secrets';
import {
  initSureClient,
  clearEntityCaches,
  resolveAccount,
  listImportedTransactionIds,
  resolveCategory,
  ensureTags,
  createTransaction,
  createValuation,
  type SureAccount,
} from './sure-client';
import { initNotifier, notifyLoginFail, notifySyncFail, notifySuccess, notifyErrorThreshold, notifySlowScrape } from './notifier';
import { scrapeTarget } from './scraper';
import { reloadMerchants } from './merchants';
import { transform } from './transformer';
import { appendHistory } from './history';

// --- CLI flags ---
const args = process.argv.slice(2);
const runOnce = args.includes('--run-once');
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const importPending = process.env.IMPORT_PENDING === 'true';
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
  newTx: number;          // transactions successfully posted (or would-be in dry run)
  txFailed: number;       // transactions that failed to post
  dedupSkipped: number;
  futureSkipped: number;
  pendingSkipped: number;
  reconciled: boolean;
  error: boolean;
}

async function processTarget(
  target: Target,
  createMissingTags: boolean
): Promise<TargetStats> {
  // Load bank credentials from /run/secrets/
  const credentials: Record<string, string> = {};
  for (const [field, secretFile] of Object.entries(target.credentialSecrets)) {
    credentials[field] = readSecretFile(secretFile);
  }

  // Resolve Sure account (by UUID or name)
  const sureAccount: SureAccount = await resolveAccount(
    target.sureAccountId ?? target.sureAccountName!
  );

  // Resolve tags for this target
  const tagIds = await ensureTags(target.tags ?? [], createMissingTags);

  // Fetch existing sourceIds from Sure (dedup set)
  const existingIds = await listImportedTransactionIds(sureAccount.id);
  logger.debug(`[${target.name}] Dedup: ${existingIds.size} existing sourceIds in Sure`);

  // Scrape — log elapsed time per bank; alert if approaching timeout
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

  let totalScraped = 0;
  let totalNewTx = 0;
  let totalTxFailed = 0;
  let totalDedup = 0;
  let totalFuture = 0;
  let totalPending = 0;
  let didReconcile = false;

  for (const account of scrapeResult.accounts) {
    const txResult = transform(account.txns, account.accountNumber, target.companyId, importPending, existingIds);
    const newCount = txResult.rows.length;

    logger.info(
      `[${target.name}] account=${account.accountNumber} | scraped=${account.txns.length}` +
      ` → ${newCount} new | dedup=${txResult.alreadySeenSkipped} zero=${txResult.zeroAmountSkipped}` +
      ` future=${txResult.futureSkipped} pending=${txResult.pendingSkipped}`
    );

    totalScraped += account.txns.length;
    totalDedup += txResult.alreadySeenSkipped;
    totalFuture += txResult.futureSkipped;
    totalPending += txResult.pendingSkipped;

    if (newCount === 0) continue;

    if (dryRun) {
      logger.info(`[${target.name}] [DRY RUN] Would import ${newCount} transactions`);
      for (const tx of txResult.rows) {
        logger.debug(`[${target.name}] [DRY RUN] tx: name=${tx.name}\nnotes=\n${tx.notes}`);
      }
      appendHistory({
        timestamp: new Date().toISOString(),
        bank: target.name,
        companyId: target.companyId,
        txSent: newCount,
        txFailed: 0,
        status: 'dry_run',
        dryRun: true,
      });
      totalNewTx += newCount;
      continue;
    }

    // Post each transaction individually
    let txSuccessCount = 0;
    let txFailCount = 0;

    for (const tx of txResult.rows) {
      let categoryId: string | undefined;
      if (tx.txCategory && target.categoryMap?.[tx.txCategory]) {
        categoryId = await resolveCategory(target.categoryMap[tx.txCategory]);
      }

      try {
        await createTransaction({
          account_id: sureAccount.id,
          name: tx.name,
          notes: tx.notes,
          date: tx.date,
          amount: tx.amount,
          currency: tx.currency,
          category_id: categoryId,
          tag_ids: tagIds.length ? tagIds : undefined,
        });
        existingIds.add(tx.sourceId);
        txSuccessCount++;
      } catch (txErr) {
        logger.error(`[${target.name}] Failed to create transaction "${tx.name}": ${String(txErr)}`);
        txFailCount++;
      }
    }

    totalNewTx += txSuccessCount;
    totalTxFailed += txFailCount;

    // Reconciliation — post valuation when target.reconcile and balance is available
    if (target.reconcile && account.balance != null) {
      const todayISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
      await createValuation({ account_id: sureAccount.id, date: todayISO, amount: account.balance });
      logger.info(`[${target.name}] Reconciled balance: ${account.balance}`);
      didReconcile = true;
    }
  }

  // Post-loop: always write a history entry after a real run so every
  // scheduled execution is visible in import_history.jsonl — even when
  // everything is deduped and 0 new transactions are imported.
  if (!dryRun) {
    appendHistory({
      timestamp: new Date().toISOString(),
      bank: target.name,
      companyId: target.companyId,
      txSent: totalNewTx,
      txFailed: totalTxFailed,
      status: totalTxFailed > 0 ? 'partial' : 'complete',
      dryRun: false,
    });
  }
  if (totalTxFailed > 0) await notifyErrorThreshold(target.name, totalTxFailed);

  return {
    bank: target.name,
    scraped: totalScraped,
    newTx: totalNewTx,
    txFailed: totalTxFailed,
    dedupSkipped: totalDedup,
    futureSkipped: totalFuture,
    pendingSkipped: totalPending,
    reconciled: didReconcile,
    error: false,
  };
}

// --- Main run ---

async function run(): Promise<void> {
  logger.info('=== Run started ===');
  reloadMerchants(); // re-read merchants.json on each run; picks up edits without restart
  if (dryRun) logger.info('[DRY RUN] mode — no Sure API writes will be made');

  if (process.env.PUBLISH !== undefined) {
    logger.warn('PUBLISH env var is set but has no effect — direct transaction API does not use a review queue');
  }

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

  initSureClient(config.sure.baseUrl, secrets.sureApiKey);
  clearEntityCaches();
  initNotifier(secrets.telegramBotToken);

  // Process each target sequentially — one bank failing does not stop the others
  const allStats: TargetStats[] = [];
  let totalImported = 0;
  let successCount = 0;
  let failCount = 0;

  for (const target of config.targets) {
    try {
      const stats = await processTarget(target, config.sure.createMissingTags ?? false);
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
      allStats.push({ bank: target.name, scraped: 0, newTx: 0, txFailed: 0, dedupSkipped: 0, futureSkipped: 0, pendingSkipped: 0, reconciled: false, error: true });
    }
  }

  // Build per-bank summary lines for Telegram
  const bankLines = allStats.map(s => {
    if (s.error) return `❌ ${s.bank} — scrape failed`;
    const parts: string[] = [`${s.scraped} scraped → ${s.newTx} new`];
    if (s.txFailed > 0)       parts.push(`${s.txFailed} failed`);
    if (s.dedupSkipped > 0)   parts.push(`${s.dedupSkipped} dedup`);
    if (s.pendingSkipped > 0) parts.push(`${s.pendingSkipped} pending skipped`);
    if (s.futureSkipped > 0)  parts.push(`${s.futureSkipped} future skipped`);
    return `${s.txFailed > 0 ? '⚠️' : '✅'} ${s.bank} — ${parts.join(' | ')}`;
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

  logger.info(`${signal} received — scheduler stopped, shutting down`);

  // Let Winston file transports drain before exit.
  // 1000ms is sufficient — log volume at shutdown is low.
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
