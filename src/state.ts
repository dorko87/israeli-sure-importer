import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Transaction } from './types';
import logger from './logger';

const CACHE_DIR = process.env.CACHE_DIR ?? '/app/cache';
const DB_PATH = path.join(CACHE_DIR, 'state.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dedup_keys (
      key           TEXT PRIMARY KEY,
      importedAt    TEXT NOT NULL,
      bank          TEXT NOT NULL,
      accountNumber TEXT NOT NULL
    )
  `);

  logger.debug(`State DB opened at ${DB_PATH}`);
  return db;
}

/**
 * Compute the deduplication key for a transaction.
 *
 * Primary key (when identifier is present and non-zero):
 *   SHA256( accountNumber + "|" + identifier )
 *
 * Fallback key:
 *   SHA256( accountNumber + "|" + date + "|" + chargedAmount + "|" + description + "|" + installmentNumber )
 *
 * installments.number is included so that monthly installment payments
 * (same merchant, same amount, different month) each produce a unique key.
 */
export function computeKey(tx: Transaction, accountNumber: string): string {
  let input: string;

  if (tx.identifier !== undefined && String(tx.identifier) !== '0' && String(tx.identifier) !== '') {
    input = `${accountNumber}|${tx.identifier}`;
  } else {
    const installNum = tx.installments?.number ?? 0;
    input = `${accountNumber}|${tx.date}|${tx.chargedAmount}|${tx.description}|${installNum}`;
  }

  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Returns true if this key has already been recorded in state.db. */
export function has(key: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM dedup_keys WHERE key = ?').get(key);
  return row !== undefined;
}

export interface DedupRecord {
  key: string;
  bank: string;
  accountNumber: string;
}

/** Writes dedup keys to state.db after a successful import. Uses INSERT OR IGNORE. */
export function insertMany(records: DedupRecord[]): void {
  if (records.length === 0) return;

  const stmt = getDb().prepare(
    'INSERT OR IGNORE INTO dedup_keys (key, importedAt, bank, accountNumber) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();

  const insertAll = getDb().transaction((recs: DedupRecord[]) => {
    for (const r of recs) {
      stmt.run(r.key, now, r.bank, r.accountNumber);
    }
  });

  insertAll(records);
  logger.debug(`State: inserted ${records.length} dedup keys`);
}
