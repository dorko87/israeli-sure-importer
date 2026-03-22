import * as fs from 'fs';
import * as path from 'path';
import logger from './logger';

const HISTORY_PATH = process.env.HISTORY_PATH ?? path.join('/app/logs', 'import_history.jsonl');

export interface HistoryEntry {
  timestamp: string;       // ISO 8601
  bank: string;            // target.name (human label)
  companyId: string;       // target.companyId
  importId: string | null; // null on dry run
  rowsSent: number;
  status: string;          // 'complete' | 'pending' | 'failed' | 'dry_run' | 'error'
  dryRun: boolean;
}

/**
 * Appends one JSON line to import_history.jsonl.
 * Wrapped in try/catch — history failure must never crash the pipeline.
 */
export function appendHistory(entry: HistoryEntry): void {
  try {
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    logger.warn(`History: failed to append entry: ${String(err)}`);
  }
}
