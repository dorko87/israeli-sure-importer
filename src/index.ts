import { schedule } from 'node-cron';
import logger from './logger';
import { loadConfig, type Target } from './config';
import { loadAppSecrets, readSecretFile } from './secrets';
import {
  initSureClient,
  getAccounts,
  createAccount,
  postImport,
  pollImport,
} from './sure-client';
import { initNotifier, notifyLoginFail, notifySyncFail, notifySuccess, notifyErrorThreshold } from './notifier';
import { scrapeTarget } from './scraper';
import { transform, buildCsv } from './transformer';
import { insertMany, type DedupRecord } from './state';

// --- CLI flags ---
const args = process.argv.slice(2);
const runOnce = args.includes('--run-once');
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const importPending = process.env.IMPORT_PENDING === 'true';
const publish = process.env.PUBLISH ?? 'false';
const scheduleExpr = process.env.SCHEDULE;

// --- Account resolution ---

async function resolveAccountId(target: Target, autoCreate: boolean): Promise<string> {
  if (target.sureAccountId !== 'auto') {
    return target.sureAccountId;
  }

  const accounts = await getAccounts();
  const match = accounts.find(a => a.name === target.name);

  if (match) {
    logger.info(`[${target.name}] Matched Sure account id=${match.id}`);
    return match.id;
  }

  if (!autoCreate) {
    throw new Error(
      `[${target.name}] No Sure account found with name "${target.name}" and autoCreateAccounts=false`
    );
  }

  logger.info(`[${target.name}] Creating Sure account "${target.name}"`);
  const created = await createAccount(target.name);
  logger.info(`[${target.name}] Created Sure account id=${created.id}`);
  return created.id;
}

// --- Per-target pipeline ---

async function processTarget(
  target: Target,
  accountId: string
): Promise<{ imported: number }> {
  // Load bank credentials from /run/secrets/
  const credentials: Record<string, string> = {};
  for (const [field, secretFile] of Object.entries(target.credentialSecrets)) {
    credentials[field] = readSecretFile(secretFile);
  }

  // Scrape
  const scrapeResult = await scrapeTarget({
    companyId: target.companyId,
    credentials,
    name: target.name,
  });

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
    throw new Error(`Scraper failed: ${scrapeResult.errorType}`);
  }

  let totalImported = 0;

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
      ` → ${newCount} new | dedup=${txResult.alreadySeenSkipped} zero=${txResult.zeroAmountSkipped} pending=${txResult.pendingSkipped}`
    );

    if (newCount === 0) continue;

    const csv = buildCsv(txResult.rows.map(r => r.row));

    if (dryRun) {
      logger.info(`[${target.name}] [DRY RUN] Would import ${newCount} transactions`);
      logger.debug(`[${target.name}] [DRY RUN] CSV:\n${csv}`);
      totalImported += newCount;
      continue;
    }

    // Submit CSV to Sure
    const importId = await postImport({ accountId, csv, publish });
    logger.info(`[${target.name}] CSV posted → import_id=${importId}`);

    // Poll until settled
    const importResult = await pollImport(importId);
    const rowSummary = `${importResult.valid_rows_count ?? '?'}/${importResult.rows_count ?? '?'} rows`;

    if (importResult.status === 'complete') {
      logger.info(`[${target.name}] Import status: complete | ${rowSummary}` +
        (publish === 'false' ? ' — review in Sure UI' : ''));

      // Persist dedup keys only after confirmed success
      const dedupRecords: DedupRecord[] = txResult.rows.map(r => ({
        key: r.dedupKey,
        bank: target.companyId,
        accountNumber: account.accountNumber,
      }));
      insertMany(dedupRecords);
      const failedRows = (importResult.rows_count ?? 0) - (importResult.valid_rows_count ?? 0);
      if (failedRows > 0) await notifyErrorThreshold(target.name, failedRows);
      totalImported += newCount;
    } else {
      const errMsg = importResult.error ?? importResult.status;
      logger.error(`[${target.name}] Import failed | status=${importResult.status} | ${errMsg}`);
      await notifySyncFail(target.name, errMsg);
    }
  }

  return { imported: totalImported };
}

// --- Main run ---

async function run(): Promise<void> {
  logger.info('=== Run started ===');
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

  // Resolve Sure account IDs upfront (skipped in dry run)
  const accountIds = new Map<string, string>();
  if (!dryRun) {
    for (const target of config.targets) {
      try {
        const id = await resolveAccountId(target, config.sure.autoCreateAccounts ?? false);
        accountIds.set(target.name, id);
      } catch (err) {
        logger.error(`[${target.name}] Account resolution failed: ${String(err)}`);
        // Target will be skipped in the processing loop
      }
    }
  } else {
    // In dry run, use placeholder so processTarget can still run
    for (const target of config.targets) {
      accountIds.set(target.name, 'dry-run');
    }
  }

  // Process each target sequentially — one bank failing does not stop the others
  let totalImported = 0;
  let successCount = 0;
  let failCount = 0;

  for (const target of config.targets) {
    const accountId = accountIds.get(target.name);
    if (!accountId) {
      failCount++;
      continue;
    }

    try {
      const { imported } = await processTarget(target, accountId);
      totalImported += imported;
      successCount++;
    } catch (err) {
      logger.error(`[${target.name}] Pipeline failed: ${String(err)}`);
      failCount++;
    }
  }

  const summary =
    `Run complete | banks=${config.targets.length} ok=${successCount} fail=${failCount}` +
    ` | imported=${totalImported} tx` +
    (dryRun ? ' [DRY RUN]' : '');

  logger.info(summary);

  if (!dryRun && successCount > 0 && failCount === 0) {
    await notifySuccess(summary);
  }

  logger.info('=== Run finished ===');
}

// --- Entry point ---

async function main(): Promise<void> {
  if (runOnce || !scheduleExpr) {
    await run();
    process.exit(0);
  }

  // Scheduled mode — keep process alive
  logger.info(`Scheduling runs with cron: ${scheduleExpr}`);
  schedule(scheduleExpr, () => {
    run().catch(err => logger.error(`Unhandled run error: ${String(err)}`));
  }, { timezone: 'Asia/Jerusalem' });
  logger.info('Scheduler started — waiting for next trigger');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
