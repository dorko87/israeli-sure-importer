import type { Transaction } from './types';
import { IMPORT_MARKER } from './sure-client';
import { findMatch } from './merchants';
import logger from './logger';

// ── Output types ──────────────────────────────────────────────────────────────

export interface ReadyTransaction {
  name: string;           // clean merchant name or raw description
  notes: string;          // full structured notes block
  date: string;           // ISO "2026-03-15"
  amount: number;         // chargedAmount (negative = expense)
  currency: string;       // "ILS" or original currency
  sourceId: string;       // dedup key embedded in notes
  txCategory?: string;    // raw scraper category — resolved to UUID in index.ts
}

export interface TransformResult {
  rows: ReadyTransaction[];
  zeroAmountSkipped: number;
  futureSkipped: number;
  alreadySeenSkipped: number;
  pendingSkipped: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds the stable sourceId for a transaction. */
function buildSourceId(
  companyId: string,
  accountNumber: string,
  tx: Transaction
): string {
  const id = tx.identifier != null ? String(tx.identifier) : null;
  if (id && id !== '0') {
    return `${companyId}:${accountNumber}:${id}`;
  }
  // Fallback: plain readable string (no hashing — must be parseable from notes)
  const datePart = tx.date.substring(0, 10);
  const fallback = [datePart, tx.chargedAmount, tx.description, tx.installments?.number ?? 0].join(':');
  return `${companyId}:${accountNumber}:${fallback}`;
}

/** Builds the userContent portion (top lines before the metadata block). */
function buildUserContent(tx: Transaction, resolvedName: string): string {
  const hasOverride = resolvedName !== tx.description;
  const label = tx.installments
    ? `תשלום ${tx.installments.number} מתוך ${tx.installments.total}`
    : null;
  // Skip memo when installments are present — Max sets memo to the installment label
  const memo = !tx.installments && tx.memo?.trim() ? tx.memo.trim() : null;

  if (label && hasOverride) return `${label} | ${tx.description}`;
  if (label)               return label;
  if (hasOverride && memo) return `${tx.description} | ${memo}`;
  if (hasOverride)         return tx.description;
  if (memo)                return memo;
  return '';
}

/** Builds the full notes string including the structured metadata block. */
function buildNotes(
  tx: Transaction,
  resolvedName: string,
  companyId: string,
  accountNumber: string,
  sourceId: string
): string {
  const userContent = buildUserContent(tx, resolvedName);
  const datePart = tx.date.substring(0, 10);

  const metaLines: string[] = [
    IMPORT_MARKER,
    `Source ID: ${sourceId}`,
    `Source bank: ${companyId}`,
    `Source account: ${accountNumber}`,
    `Processed date: ${datePart}`,
  ];

  if (tx.installments) {
    metaLines.push(`Installment: ${tx.installments.number}/${tx.installments.total}`);
  }

  if (tx.originalCurrency && tx.originalCurrency !== 'ILS' && tx.originalAmount != null) {
    metaLines.push(`Original amount: ${tx.originalAmount} ${tx.originalCurrency}`);
  }

  const metaBlock = metaLines.join('\n');

  // If there is user content, separate it from the metadata with a blank line.
  // If there is no user content, start directly with the metadata (no leading blank line).
  return userContent ? `${userContent}\n\n${metaBlock}` : metaBlock;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Filters and transforms scraped transactions for a single bank account.
 *
 * Filters applied (in order):
 *   1. Zero-amount  — unconditionally dropped (chargedAmount === 0)
 *   2. Future-date  — unconditionally dropped (date > today Asia/Jerusalem)
 *   3. Pending      — dropped unless importPending is true
 *   4. Dedup        — dropped if sourceId already in existingIds (Sure-side set)
 */
export function transform(
  txns: Transaction[],
  accountNumber: string,
  companyId: string,
  importPending: boolean,
  existingIds: Set<string>
): TransformResult {
  let zeroAmountSkipped = 0;
  let futureSkipped = 0;
  let alreadySeenSkipped = 0;
  let pendingSkipped = 0;
  const rows: ReadyTransaction[] = [];

  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });

  for (const tx of txns) {
    // 1. Zero-amount filter
    if (tx.chargedAmount === 0) { zeroAmountSkipped++; continue; }

    // 2. Future-date filter
    if (tx.date.substring(0, 10) > todayStr) { futureSkipped++; continue; }

    // 3. Pending filter
    if (tx.status === 'pending' && !importPending) { pendingSkipped++; continue; }

    // 4. Dedup
    const sourceId = buildSourceId(companyId, accountNumber, tx);
    if (existingIds.has(sourceId)) { alreadySeenSkipped++; continue; }

    const name = findMatch(tx.description) ?? tx.description;
    const notes = buildNotes(tx, name, companyId, accountNumber, sourceId);
    // chargedAmount is always in ILS (the account's settlement currency).
    // originalCurrency is the foreign purchase currency — already captured in
    // the metadata block as "Original amount: X USD". Never use it as the
    // transaction currency, since that would misrepresent the charged amount.
    const currency = 'ILS';

    rows.push({
      name,
      notes,
      date: tx.date.substring(0, 10),
      amount: tx.chargedAmount,
      currency,
      sourceId,
      txCategory: tx.type,
    });
  }

  if (zeroAmountSkipped > 0) logger.debug(`[${companyId}] Skipped ${zeroAmountSkipped} zero-amount transactions`);
  if (futureSkipped > 0)     logger.debug(`[${companyId}] Skipped ${futureSkipped} future-dated transactions`);

  return { rows, zeroAmountSkipped, futureSkipped, alreadySeenSkipped, pendingSkipped };
}
