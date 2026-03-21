import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import * as path from 'path';
import * as fs from 'fs';
import type { ScrapeResult, ScraperAccount } from './types';
import logger from './logger';

const BROWSER_DATA_DIR = process.env.BROWSER_DATA_DIR ?? '/app/browser-data';
const TIMEOUT_MINUTES = parseInt(process.env.TIMEOUT_MINUTES ?? '10', 10);
const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? '30', 10);

export interface ScrapeTargetOptions {
  companyId: string;
  credentials: Record<string, string>;
  name: string;
}

/** Builds the start date (today minus DAYS_BACK). */
function buildStartDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() - DAYS_BACK);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Scrapes a single bank target.
 *
 * - Uses per-bank Chromium browser profile at BROWSER_DATA_DIR/<companyId>/
 * - Sets both the job timeout (Promise.race) and the Puppeteer protocolTimeout
 *   to TIMEOUT_MINUTES to prevent hung browser sessions.
 * - Returns a discriminated union: { success: true, accounts } | { success: false, errorType, errorMessage }
 */
export async function scrapeTarget(options: ScrapeTargetOptions): Promise<ScrapeResult> {
  const timeoutMs = TIMEOUT_MINUTES * 60 * 1000;
  const startDate = buildStartDate();
  const browserDataDir = path.join(BROWSER_DATA_DIR, options.companyId);

  // #11 — Remove stale SingletonLock before launching the browser.
  // Left behind when the container is killed mid-scrape; Chromium refuses to start if present.
  const lockFile = path.join(browserDataDir, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    try {
      fs.rmSync(lockFile);
      logger.warn(`[${options.name}] Removed stale SingletonLock — previous run may have been killed`);
    } catch (err) {
      logger.warn(`[${options.name}] Could not remove SingletonLock: ${String(err)}`);
    }
  }

  const scraperOptions = {
    companyId: options.companyId as CompanyTypes,
    startDate,
    futureMonthsToScrape: 1,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--user-data-dir=${browserDataDir}`,
    ],
    showBrowser: false,
    verbose: process.env.LOG_LEVEL === 'debug',
    defaultTimeout: timeoutMs,
  };

  logger.debug(`[${options.name}] Launching scraper | startDate=${startDate.toISOString().substring(0, 10)} | timeout=${TIMEOUT_MINUTES}m`);

  const scraper = createScraper(scraperOptions);

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Scraper timed out after ${TIMEOUT_MINUTES} minutes`)),
      timeoutMs
    )
  );

  let raw: {
    success: boolean;
    accounts?: unknown[];
    errorType?: string;
    errorMessage?: string;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = await Promise.race([scraper.scrape(options.credentials as any), timeoutPromise]) as typeof raw;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.toLowerCase().includes('timed out');
    return {
      success: false,
      errorType: isTimeout ? 'TIMEOUT' : 'GENERIC',
      errorMessage: msg,
    };
  }

  if (!raw.success) {
    return {
      success: false,
      errorType: raw.errorType ?? 'GENERIC',
      errorMessage: raw.errorMessage,
    };
  }

  const accounts = (raw.accounts ?? []) as ScraperAccount[];
  const totalTxns = accounts.reduce((sum, a) => sum + (a.txns?.length ?? 0), 0);
  logger.debug(`[${options.name}] Scrape complete | accounts=${accounts.length} | txns=${totalTxns}`);

  return { success: true, accounts };
}
