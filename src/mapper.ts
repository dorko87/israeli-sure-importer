import type { Transaction, TransactionsAccount } from './scraper.js';
import type { Target } from './config.js';
import { logger } from './logger.js';

export interface MappedTransaction {
  date: string;       // DD/MM/YYYY (Sure's expected format)
  amount: string;     // decimal, positive = inflow, negative = outflow
  name: string;       // description
  notes: string;      // memo
  status: string;     // 'completed' | 'pending'
}

/**
 * Normalises any date value from the scraper into DD/MM/YYYY (Sure's expected format).
 * Banks return dates in varying forms: ISO strings, DD/MM/YYYY, Date objects, etc.
 */
function toCsvDate(raw: unknown): string {
  let year = '', month = '', day = '';

  if (!raw) return '';

  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return '';
    // Use local-time parts to avoid UTC-midnight off-by-one for Israeli dates
    year  = String(raw.getFullYear());
    month = String(raw.getMonth() + 1).padStart(2, '0');
    day   = String(raw.getDate()).padStart(2, '0');
  } else if (typeof raw === 'number') {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return '';
    year  = String(d.getFullYear());
    month = String(d.getMonth() + 1).padStart(2, '0');
    day   = String(d.getDate()).padStart(2, '0');
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return '';
    // YYYY-MM-DD (optionally with time component)
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) { year = isoMatch[1]; month = isoMatch[2]; day = isoMatch[3]; }
    else {
      // DD/MM/YYYY or DD.MM.YYYY (already Israeli format)
      const dmyMatch = s.match(/^(\d{2})[./](\d{2})[./](\d{4})/);
      if (dmyMatch) { day = dmyMatch[1]; month = dmyMatch[2]; year = dmyMatch[3]; }
      else {
        // Fallback: let Date parse it
        const d = new Date(s);
        if (isNaN(d.getTime())) return '';
        year  = String(d.getFullYear());
        month = String(d.getMonth() + 1).padStart(2, '0');
        day   = String(d.getDate()).padStart(2, '0');
      }
    }
  }

  if (!year || !month || !day) return '';
  return `${day}/${month}/${year}`;
}

/**
 * Converts a single scraper Transaction to the Sure CSV row format.
 * chargedAmount is already signed: negative for charges, positive for credits.
 */
function mapTransaction(txn: Transaction): MappedTransaction {
  let date = toCsvDate(txn.date ?? txn.processedDate);

  // Sure rejects future dates. Installment payments (תשלומים) often carry the
  // next charge date rather than the purchase date — cap to today.
  if (date) {
    const [d, m, y] = date.split('/').map(Number);
    const txnDate = new Date(y!, m! - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (txnDate > today) {
      date = toCsvDate(today);
    }
  }

  return {
    date,
    amount: String(txn.chargedAmount ?? 0),
    name: sanitizeFormula((txn.description ?? '').trim()),
    notes: sanitizeFormula((txn.memo ?? '').trim()),
    status: txn.status ?? 'completed',
  };
}

/**
 * Neutralises CSV formula injection by prefixing a tab when the value starts
 * with a spreadsheet formula trigger character (=, @, +, -, |, %).
 * This is a defence-in-depth measure for if the generated CSV is ever opened
 * directly in a spreadsheet application.
 */
const FORMULA_TRIGGER = /^[=@+\-|%]/;

function sanitizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `\t${value}` : value;
}

function escapeField(value: string): string {
  // Strip \r to prevent row splits in CSV (Hebrew bank data sometimes includes CR)
  const v = value.replace(/\r/g, '');
  if (v.includes(',') || v.includes('"') || v.includes('\n') || v.startsWith('\t')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function toCsvRow(row: MappedTransaction): string {
  return [row.date, row.amount, row.name, row.notes]
    .map(escapeField)
    .join(',');
}

const CSV_HEADER = 'date,amount,name,notes';

/**
 * Given the full set of scraped accounts for one bank, produce one CSV string
 * per target, containing only the transactions that match the target's account
 * filter and pending preference.
 *
 * Returns a map of sureAccountId → CSV string (including header).
 * Targets with no matching transactions get no map entry (skip upload).
 */
export function buildCsvPerTarget(
  accounts: TransactionsAccount[],
  targets: Target[],
): Map<string, string> {
  const result = new Map<string, string>();

  for (const target of targets) {
    const wantAccounts = target.accounts ?? 'all';
    const includePending = target.includePending ?? false;

    const rows: MappedTransaction[] = [];
    let pendingFiltered = 0;
    let futureCapped = 0;

    for (const account of accounts) {
      // Account filter
      if (
        wantAccounts !== 'all' &&
        !wantAccounts.includes(account.accountNumber)
      ) {
        logger.debug(`  account ${account.accountNumber}: skipped (not in target filter)`);
        continue;
      }

      for (const txn of account.txns) {
        if (!includePending && txn.status === 'pending') {
          pendingFiltered++;
          continue;
        }
        const mapped = mapTransaction(txn);
        // Detect if date was capped (original was in the future)
        const originalDate = toCsvDate(txn.date ?? txn.processedDate);
        if (originalDate !== mapped.date) futureCapped++;
        rows.push(mapped);
      }

      logger.debug(`  account ${account.accountNumber}: ${account.txns.length} txns total`);
    }

    if (pendingFiltered > 0) logger.debug(`  target "${target.sureAccountName ?? target.sureAccountId}": ${pendingFiltered} pending txn(s) filtered`);
    if (futureCapped > 0)    logger.debug(`  target "${target.sureAccountName ?? target.sureAccountId}": ${futureCapped} future-dated txn(s) capped to today`);

    if (rows.length === 0) continue;

    const csv = [CSV_HEADER, ...rows.map(toCsvRow)].join('\n');
    result.set(target.sureAccountId, csv);
  }

  return result;
}
