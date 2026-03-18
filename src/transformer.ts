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
 * Builds the notes column value.
 *
 * With installments:  "תשלום N מתוך M | <raw description>"
 * Without:            "<raw description>"
 *
 * The raw bank description is always preserved here regardless of merchant match.
 */
function buildNotes(tx: Transaction): string {
  if (tx.installments) {
    const label = `תשלום ${tx.installments.number} מתוך ${tx.installments.total}`;
    return `${label} | ${tx.description}`;
  }
  return tx.description;
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
 *   2. Pending — dropped unless importPending is true
 *   3. Deduplication — dropped if key already in state.db
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
  let alreadySeenSkipped = 0;
  let pendingSkipped = 0;
  const rows: TransformedTransaction[] = [];

  for (const tx of txns) {
    // 1. Unconditional zero-amount filter
    if (tx.chargedAmount === 0) {
      zeroAmountSkipped++;
      continue;
    }

    // 2. Pending filter
    if (tx.status === 'pending' && !importPending) {
      pendingSkipped++;
      continue;
    }

    // 3. Deduplication
    const dedupKey = computeKey(tx, accountNumber);
    if (has(dedupKey)) {
      alreadySeenSkipped++;
      continue;
    }

    // Build CSV columns
    const name = findMatch(tx.description) ?? tx.description;
    const notes = buildNotes(tx);

    rows.push({
      row: { date: formatDate(tx.date), amount: tx.chargedAmount, name, notes },
      dedupKey,
    });
  }

  if (zeroAmountSkipped > 0) {
    logger.debug(`[${bank}] Skipped ${zeroAmountSkipped} zero-amount transactions`);
  }

  return { rows, zeroAmountSkipped, alreadySeenSkipped, pendingSkipped };
}

/** Builds a CSV string from an array of rows. Header: date,amount,name,notes */
export function buildCsv(rows: CsvRow[]): string {
  const header = 'date,amount,name,notes';
  const lines = rows.map(r =>
    [csvEscape(r.date), csvEscape(r.amount), csvEscape(r.name), csvEscape(r.notes)].join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}
