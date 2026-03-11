import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { logger } from './logger.js';

const DEFAULT_LOOKBACK_DAYS = (() => {
  const v = parseInt(process.env['DAYS_BACK'] ?? '', 10);
  return v > 0 ? v : 90;
})();
// Reject any stored date more than 2 years in the future — tamper guard
const MAX_FUTURE_YEARS = 2;

function statePath(): string {
  return resolve(process.env['STATE_PATH'] ?? '/app/cache/sync-state.json');
}

type StateFile = Record<string, string>; // companyId → ISO date string

function readState(): StateFile {
  const path = statePath();
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    // Explicitly copy only string key/value pairs — prevents prototype pollution
    // and rejects any non-string values that shouldn't be in this file.
    const result: StateFile = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string') {
        result[k] = v;
      }
    }
    return result;
  } catch {
    logger.warn('Corrupt sync-state.json — starting fresh');
  }
  return {};
}

function writeState(state: StateFile): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

export function getStartDate(companyId: string): Date {
  const state = readState();
  const stored = state[companyId];
  if (stored) {
    const d = new Date(stored);
    if (!isNaN(d.getTime())) {
      // Sanity check: reject dates tampered to be unreasonably far in the future
      const ceiling = new Date();
      ceiling.setFullYear(ceiling.getFullYear() + MAX_FUTURE_YEARS);
      if (d <= ceiling) {
        logger.debug(`Using stored start date for ${companyId}: ${stored}`);
        return d;
      }
      logger.warn(
        `Stored start date for ${companyId} is more than ${MAX_FUTURE_YEARS} years in the future — resetting`,
      );
    }
  }
  const fallback = new Date();
  fallback.setDate(fallback.getDate() - DEFAULT_LOOKBACK_DAYS);
  fallback.setHours(0, 0, 0, 0);
  logger.debug(
    `No stored start date for ${companyId} — using ${DEFAULT_LOOKBACK_DAYS}-day lookback: ${fallback.toISOString()}`,
  );
  return fallback;
}

export function saveStartDate(companyId: string, date: Date): void {
  const state = readState();
  state[companyId] = date.toISOString();
  writeState(state);
  logger.debug(`Saved sync state for ${companyId}: ${date.toISOString()}`);
}
