import type { ResolvedConfig } from './config.js';
import { scrapeBank } from './scraper.js';
import { buildCsvPerTarget } from './mapper.js';
import { uploadCsv } from './sure-client.js';
import { getStartDate, saveStartDate } from './state.js';
import { logger } from './logger.js';

/**
 * Runs a full scrape → map → upload cycle for every configured bank.
 * Each bank is processed sequentially to avoid hammering the scraper.
 */
export async function runImport(config: ResolvedConfig): Promise<void> {
  const bankEntries = Object.entries(config.banks);
  logger.info(`Starting import for ${bankEntries.length} bank(s)`);

  let totalUploaded = 0;
  let totalErrors = 0;

  for (const [companyId, bank] of bankEntries) {
    logger.info(`--- Processing bank: ${companyId} ---`);
    try {
      await importBank(companyId, bank.credentials, bank.targets, config.sure);
      totalUploaded++;
    } catch (err) {
      logger.error(`Bank ${companyId} failed: ${(err as Error).message}`);
      totalErrors++;
    }
  }

  logger.info(
    `Import complete — ${totalUploaded} bank(s) succeeded, ${totalErrors} failed`,
  );

  if (totalErrors > 0 && totalUploaded === 0) {
    throw new Error('All banks failed — see errors above');
  }
}

async function importBank(
  companyId: string,
  credentials: Record<string, string>,
  targets: ResolvedConfig['banks'][string]['targets'],
  sure: ResolvedConfig['sure'],
): Promise<void> {
  const startDate = getStartDate(companyId);

  // Scrape
  const accounts = await scrapeBank(companyId, credentials, startDate);

  if (accounts.length === 0) {
    logger.info(`${companyId}: no accounts returned — skipping`);
    return;
  }

  // Build one CSV per target
  const csvMap = buildCsvPerTarget(accounts, targets);

  if (csvMap.size === 0) {
    logger.info(`${companyId}: no transactions matched any target — skipping upload`);
    saveStartDate(companyId, new Date());
    return;
  }

  const dryRun = process.env['DRY_RUN'] === 'true';

  // Upload each target's CSV to Sure
  for (const [sureAccountId, csv] of csvMap.entries()) {
    const target = targets.find((t) => t.sureAccountId === sureAccountId);
    const label = target?.sureAccountName ?? sureAccountId;
    const rowCount = csv.split('\n').length - 1;

    if (dryRun) {
      logger.info(`${companyId}: DRY_RUN — would upload ${rowCount} rows to "${label}" (skipping)`);
      continue;
    }

    logger.info(`${companyId}: uploading ${rowCount} rows to Sure account "${label}"…`);
    const t0 = Date.now();
    await uploadCsv(sure.baseUrl, sure.apiKey, sureAccountId, csv, label);
    logger.debug(`${companyId}: upload to "${label}" completed in ${Date.now() - t0}ms`);
  }

  // Persist sync state only after all uploads succeed
  saveStartDate(companyId, new Date());
}
