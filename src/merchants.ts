import * as fs from 'fs';
import logger from './logger';

interface MerchantEntry {
  pattern: string;
  name: string;
}

const MERCHANTS_PATH = '/app/merchants.json';

let merchants: MerchantEntry[] | null = null;

function loadMerchants(): MerchantEntry[] {
  if (merchants !== null) return merchants;

  try {
    const content = fs.readFileSync(MERCHANTS_PATH, 'utf-8');
    merchants = JSON.parse(content) as MerchantEntry[];
    if (merchants.length > 0) {
      logger.debug(`Merchants: loaded ${merchants.length} entries`);
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
