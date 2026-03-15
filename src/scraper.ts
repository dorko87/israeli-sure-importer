import puppeteer from 'puppeteer';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import type { ScraperScrapingResult } from 'israeli-bank-scrapers';
import { logger } from './logger.js';

// Derive account/transaction types from ScraperScrapingResult rather than
// importing them by name — the library does not export them as top-level symbols.
export type TransactionsAccount = NonNullable<ScraperScrapingResult['accounts']>[number];
export type Transaction = TransactionsAccount['txns'][number];

const SCRAPER_TIMEOUT_MS = parseInt(process.env['TIMEOUT_MINUTES'] ?? '10', 10) * 60 * 1000;

/**
 * Chromium flags required for a hardened Docker environment.
 * --no-sandbox + --disable-setuid-sandbox: run without the setuid sandbox,
 *   which requires SYS_ADMIN cap. Safe in Docker because the container itself
 *   is the isolation boundary (non-root user, read-only FS, no caps).
 * --disable-dev-shm-usage: prevents crashes caused by Docker's limited /dev/shm.
 * --disable-gpu: no GPU in headless containers.
 */
const CHROMIUM_DOCKER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

/**
 * Scrapes a single bank company and returns the raw account list.
 *
 * @param companyId  Must be a key of CompanyTypes (e.g. 'hapoalim')
 * @param credentials  In-memory credentials — NEVER logged
 * @param startDate  Oldest transaction date to fetch
 */
export async function scrapeBank(
  companyId: string,
  credentials: Record<string, string>,
  startDate: Date,
): Promise<TransactionsAccount[]> {
  // Validate that companyId is a known scraper type
  if (!(companyId in CompanyTypes)) {
    throw new Error(
      `Unknown companyId "${companyId}". Valid values: ${Object.keys(CompanyTypes).join(', ')}`,
    );
  }

  logger.info(`Scraping ${companyId} from ${startDate.toISOString().slice(0, 10)}…`);

  const showBrowser = process.env['SHOW_BROWSER'] === 'true';

  // Persistent browser profile — banks remember the "device" and skip security challenges.
  // Each bank gets its own sub-directory so sessions don't collide.
  // When BROWSER_DATA_DIR is unset, userDataDir is omitted and Chromium uses a temp dir
  // (old behaviour — no persistence, challenges on every run).
  const browserDataDir = process.env['BROWSER_DATA_DIR'];
  const userDataDir = browserDataDir ? `${browserDataDir}/${companyId}` : undefined;

  if (userDataDir) {
    logger.debug(`${companyId}: using persistent browser profile at ${userDataDir}`);
  }

  // Launch browser ourselves so we can set protocolTimeout (the CDP-level timeout,
  // separate from navigation timeout). Israeli bank sites can trigger JS operations
  // that take longer than puppeteer's 180 s default, causing Runtime.callFunctionOn
  // timeouts. We set it to match SCRAPER_TIMEOUT_MS.
  const browser = await puppeteer.launch({
    headless: !showBrowser,
    args: CHROMIUM_DOCKER_ARGS,
    protocolTimeout: SCRAPER_TIMEOUT_MS,
    ...(userDataDir ? { userDataDir } : {}),
    ...(process.env['PUPPETEER_EXECUTABLE_PATH']
      ? { executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] }
      : {}),
  });

  try {
    const scraper = createScraper({
      companyId: CompanyTypes[companyId as keyof typeof CompanyTypes],
      startDate,
      defaultTimeout: SCRAPER_TIMEOUT_MS,
      verbose: process.env['LOG_LEVEL'] === 'debug',
      // Pass the pre-launched browser — scraper will use it and leave closing to us
      browser,
      skipCloseBrowser: true,
    });

    let result: ScraperScrapingResult;
    try {
      // credentials is passed directly — never spread into a logged object
      result = await scraper.scrape(credentials as Parameters<typeof scraper.scrape>[0]);
    } catch (err) {
      throw new Error(`Scraper threw for ${companyId}: ${(err as Error).message}`);
    }

    if (!result.success) {
      throw new Error(
        `Scraper failed for ${companyId}: [${result.errorType ?? 'unknown'}] ${result.errorMessage ?? ''}`,
      );
    }

    const accounts = result.accounts ?? [];
    logger.info(
      `${companyId}: scraped ${accounts.length} account(s), ` +
        `${accounts.reduce((n, a) => n + a.txns.length, 0)} transactions total`,
    );
    return accounts;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
