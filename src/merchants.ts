import * as fs from 'fs';
import logger from './logger';

interface MerchantEntry {
  pattern: string;
  name: string;
}

function isMerchantEntry(entry: unknown): entry is MerchantEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as Record<string, unknown>).pattern === 'string' &&
    typeof (entry as Record<string, unknown>).name === 'string'
  );
}

const MERCHANTS_PATH = process.env.MERCHANTS_PATH ?? '/app/logs/merchants.json';

let merchants: MerchantEntry[] | null = null;

function loadMerchants(): MerchantEntry[] {
  if (merchants !== null) return merchants;

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
    logger.debug('merchants.json not found or unreadable — merchant normalization disabled');
    merchants = [];
  }

  return merchants;
}

/**
 * Returns the clean merchant name for a raw bank description,
 * or undefined if no pattern matches.
 *
 * Matching is case-insensitive substring search.
 * First matching entry wins.
 */
export function findMatch(description: string): string | undefined {
  const list = loadMerchants();
  const lower = description.toLowerCase();

  for (const entry of list) {
    if (lower.includes(entry.pattern.toLowerCase())) {
      return entry.name;
    }
  }

  return undefined;
}

/**
 * Clears the in-memory cache so the next findMatch() call re-reads merchants.json from disk.
 * Called at the start of each run() — edits take effect without a container restart.
 */
export function reloadMerchants(): void {
  merchants = null;
}
