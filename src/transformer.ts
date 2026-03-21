import type { Transaction } from './types';
import { computeKey, has } from './state';
import { findMatch } from './merchants';
import logger from './logger';

export interface CsvRow {
  date: string;
  amount: number;
  name: string;
  notes: string;
}

export interface TransformedTransaction {
  row: CsvRow;
  dedupKey: string;
}

export interface TransformResult {
  rows: TransformedTransaction[];
  zeroAmountSkipped: number;
  futureSkipped: number;
  alreadySeenSkipped: number;
  pendingSkipped: number;
}

/**
 * Converts ISO date string to DD/MM/YYYY (the format Sure's CSV import expects).
 * Input examples: "2026-03-15" or "2026-03-15T00:00:00.000Z"
 */
function formatDate(isoDate: string): string {
  // Parse only the date portion to avoid timezone shifts
  const datePart = isoDate.substring(0, 10); // "2026-03-15"
  const [year, month, day] = datePart.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Builds the notes column value. Notes should only contain information that is
 * NOT already present in the name column — no redundant duplication.
 *
 * | Scenario                              | notes result                          |
 * |---------------------------------------|---------------------------------------|
 * | No installments, no merchant match    | ""  (empty — name is identical)       |
 * | No installments, merchant match found | raw description (audit trail)         |
 * | Installments, no merchant match       | "תשלום N מתוך M" (label only)         |
 * | Installments, merchant match found    | "תשלום N מתוך M | raw description"    |
 */
function buildNotes(tx: Transaction, resolvedName: string): string {
  const hasOverride = resolvedName !== tx.description;
  const label = tx.installments
    ? `תשלום ${tx.installments.number} מתוך ${tx.installments.total}`
    : null;

  if (label && hasOverride) return `${label} | ${tx.description}`;
  if (label)                return label;           // description already in name
  if (hasOverride)          return tx.description;  // raw for audit trail
  return '';                                        // notes would duplicate name — leave empty
}

/**
 * Wraps a CSV field value in double-quotes if it contains commas, quotes, or newlines.
 * Inner double-quotes are escaped by doubling them.
 */
function csvEscape(val: string | number): string {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Filters and transforms scraped transactions for a single bank account.
 *
 * Filters applied (in order):
 *   1. Zero-amount — unconditionally dropped (chargedAmount === 0)
 *   2. Future-date — unconditionally dropped (date > today in Asia/Jerusalem)
 *   3. Pending — dropped unless importPending is true
 *   4. Deduplication — dropped if key already in state.db
 *
 * Output rows use:
 *   name  = merchants.json match OR raw description (never includes installment info)
 *   notes = installment label (if any) + " | " + raw description
 */
export function transform(
  txns: Transaction[],
  accountNumber: string,
  bank: string,
  importPending: boolean
): TransformResult {
  let zeroAmountSkipped = 0;
  let futureSkipped = 0;
  let alreadySeenSkipped = 0;
  let pendingSkipped = 0;
  const rows: TransformedTransaction[] = [];

  // Today's date in Asia/Jerusalem as ISO string "YYYY-MM-DD" — used for future-date filter.
  // 'sv-SE' locale reliably produces ISO format without any extra dependencies.
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });

  for (const tx of txns) {
    // 1. Unconditional zero-amount filter
    if (tx.chargedAmount === 0) {
      zeroAmountSkipped++;
      continue;
    }

    // 2. Future-date filter — drop transactions dated after today (Israel timezone).
    // Credit cards (e.g. Max) return upcoming scheduled charges; these are not settled yet.
    const txDateStr = tx.date.substring(0, 10); // "2026-03-31" from any ISO string
    if (txDateStr > todayStr) {
      futureSkipped++;
      continue;
    }

    // 3. Pending filter
    if (tx.status === 'pending' && !importPending) {
      pendingSkipped++;
      continue;
    }

    // 4. Deduplication
    const dedupKey = computeKey(tx, accountNumber);
    if (has(dedupKey)) {
      alreadySeenSkipped++;
      continue;
    }

    // Build CSV columns
    const name = findMatch(tx.description) ?? tx.description;
    const notes = buildNotes(tx, name);

    rows.push({
      row: { date: formatDate(tx.date), amount: tx.chargedAmount, name, notes },
      dedupKey,
    });
  }

  if (zeroAmountSkipped > 0) {
    logger.debug(`[${bank}] Skipped ${zeroAmountSkipped} zero-amount transactions`);
  }
  if (futureSkipped > 0) {
    logger.debug(`[${bank}] Skipped ${futureSkipped} future-dated transactions`);
  }

  return { rows, zeroAmountSkipped, futureSkipped, alreadySeenSkipped, pendingSkipped };
}

/** Builds a CSV string from an array of rows. Header: date,amount,name,notes */
export function buildCsv(rows: CsvRow[]): string {
  const header = 'date,amount,name,notes';
  const lines = rows.map(r =>
    [csvEscape(r.date), csvEscape(r.amount), csvEscape(r.name), csvEscape(r.notes)].join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}
