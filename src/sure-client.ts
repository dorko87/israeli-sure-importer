import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import logger from './logger';

// ── Retry helpers ─────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

const MAX_RETRIES = 5;

/**
 * Installs a response interceptor that retries requests on HTTP 429.
 * Respects the `Retry-After` response header when present; otherwise uses
 * exponential back-off starting at 1 s (1 s, 2 s, 4 s, 8 s, 16 s).
 */
function install429Interceptor(instance: AxiosInstance): void {
  instance.interceptors.response.use(
    res => res,
    async (err: unknown) => {
      const axiosErr = err as {
        response?: { status?: number; headers?: Record<string, string> };
        config?: InternalAxiosRequestConfig & { _retryCount?: number };
      };

      if (axiosErr?.response?.status !== 429) return Promise.reject(err);

      const config = axiosErr.config;
      if (!config) return Promise.reject(err);

      config._retryCount = (config._retryCount ?? 0) + 1;
      if (config._retryCount > MAX_RETRIES) {
        logger.warn(`[sure-client] 429 — max retries (${MAX_RETRIES}) exhausted`);
        return Promise.reject(err);
      }

      const retryAfterHeader = axiosErr.response?.headers?.['retry-after'];
      const waitMs = retryAfterHeader
        ? Math.max(parseInt(retryAfterHeader, 10), 1) * 1000
        : Math.min(1000 * 2 ** (config._retryCount - 1), 16_000); // 1 s, 2 s, 4 s, 8 s, 16 s

      const url = `${config.baseURL ?? ''}${config.url ?? ''}`;
      logger.warn(
        `[sure-client] 429 on ${config.method?.toUpperCase()} ${url} — retry ${config._retryCount}/${MAX_RETRIES} after ${waitMs}ms` +
        (retryAfterHeader ? ` (Retry-After: ${retryAfterHeader}s)` : '')
      );
      await sleep(waitMs);
      return instance.request(config);
    }
  );
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface SureAccount {
  id: string;
  name: string;
  balance?: number;
}

export interface SureCategory {
  id: string;
  name: string;
}

export interface SureTag {
  id: string;
  name: string;
}

export interface CreateTransactionInput {
  account_id: string;
  name: string;
  notes: string;
  date: string;         // ISO "2026-03-15"
  amount: number;       // negative = expense
  currency?: string;    // default "ILS"
  category_id?: string;
  tag_ids?: string[];
}

export interface CreateValuationInput {
  account_id: string;
  date: string;         // ISO "2026-04-03"
  amount: number;
}

// ── Module state ──────────────────────────────────────────────────────────────

let client: AxiosInstance | null = null;

// In-memory caches — cleared at start of each run via clearEntityCaches()
const accountCache = new Map<string, SureAccount>();
const categoryCache = new Map<string, string | undefined>(); // name → id or undefined
const tagCache = new Map<string, string>();                   // name → id
let tagCacheLoaded = false;

export function initSureClient(baseUrl: string, apiKey: string): void {
  client = axios.create({
    baseURL: baseUrl,
    headers: { 'X-Api-Key': apiKey },
    timeout: 30_000,
  });
  install429Interceptor(client);
}

export function clearEntityCaches(): void {
  accountCache.clear();
  categoryCache.clear();
  tagCache.clear();
  tagCacheLoaded = false;
}

function getClient(): AxiosInstance {
  if (!client) throw new Error('Sure client not initialized — call initSureClient() first');
  return client;
}

// ── Pagination helper ─────────────────────────────────────────────────────────

/**
 * Fetches all pages from a paginated Sure API endpoint.
 * itemsKey is the envelope field name (e.g. "accounts", "transactions", "tags").
 * An empty first page returns [] — not an error.
 * If the envelope key differs from expectation, change itemsKey at the call site.
 */
async function listPaginatedCollection<T>(
  path: string,
  itemsKey: string,
  params: Record<string, string> = {}
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  for (;;) {
    if (page > 1) await sleep(300); // brief pause between pages to avoid rate limiting
    const res = await getClient().get<Record<string, T[]>>(path, {
      params: { ...params, page: String(page), per_page: '100' },
    });

    const items: T[] = res.data[itemsKey] ?? [];
    if (items.length === 0) break;

    results.push(...items);
    page++;
  }

  return results;
}

// ── Constants for dedup ───────────────────────────────────────────────────────

export const IMPORT_MARKER = 'Imported by israeli-banks-sure-importer';

function extractSourceId(notes: string | undefined): string | undefined {
  if (!notes?.includes(IMPORT_MARKER)) return undefined;
  const match = /^Source ID: (.+)$/m.exec(notes);
  return match?.[1]?.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolves a Sure account by UUID (pass-through) or display name (lookup).
 * Result is cached for the run duration.
 */
export async function resolveAccount(idOrName: string): Promise<SureAccount> {
  if (accountCache.has(idOrName)) return accountCache.get(idOrName)!;

  const accounts = await listPaginatedCollection<SureAccount>('/api/v1/accounts', 'accounts');

  // UUID: find by id; name: find by name
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrName);
  const found = isUuid
    ? accounts.find(a => a.id === idOrName)
    : accounts.find(a => a.name === idOrName);

  if (!found) throw new Error(`Sure account not found: "${idOrName}"`);

  // Cache by both id and name for subsequent lookups
  accountCache.set(found.id, found);
  accountCache.set(found.name, found);
  return found;
}

/**
 * Fetches all previously-imported transaction IDs for the given Sure account.
 * Searches only transactions containing the import marker in their notes.
 * Result is NOT cached — called once per target account per run.
 */
export async function listImportedTransactionIds(accountId: string): Promise<Set<string>> {
  interface SureTx { notes?: string }

  const transactions = await listPaginatedCollection<SureTx>(
    '/api/v1/transactions',
    'transactions',
    { account_id: accountId, search: IMPORT_MARKER }
  );

  const ids = new Set<string>();
  for (const tx of transactions) {
    const sid = extractSourceId(tx.notes);
    if (sid) ids.add(sid);
  }

  logger.debug(`[sure-client] listImportedTransactionIds: found ${ids.size} existing sourceIds for account ${accountId}`);
  return ids;
}

/**
 * Resolves a Sure category UUID by display name.
 * Returns undefined if not found — no auto-create for categories.
 * Result is cached for the run duration.
 */
export async function resolveCategory(name: string): Promise<string | undefined> {
  if (categoryCache.has(name)) return categoryCache.get(name);

  const categories = await listPaginatedCollection<SureCategory>('/api/v1/categories', 'categories');
  const found = categories.find(c => c.name === name);
  const id = found?.id;

  categoryCache.set(name, id);

  if (!id) logger.debug(`[sure-client] Category not found in Sure: "${name}"`);
  return id;
}

/**
 * Returns tag UUIDs for the given names.
 * If createMissing=true, creates missing tags via POST /api/v1/tags (non-fatal on failure).
 * Results are cached for the run duration.
 */
export async function ensureTags(names: string[], createMissing: boolean): Promise<string[]> {
  if (names.length === 0) return [];

  // Load all existing tags once (guarded by tagCacheLoaded, not tagCache.size)
  if (!tagCacheLoaded) {
    const tags = await listPaginatedCollection<SureTag>('/api/v1/tags', 'tags');
    for (const tag of tags) tagCache.set(tag.name, tag.id);
    tagCacheLoaded = true;
  }

  const ids: string[] = [];

  for (const name of names) {
    if (tagCache.has(name)) {
      ids.push(tagCache.get(name)!);
      continue;
    }

    if (!createMissing) {
      logger.warn(`[sure-client] Tag not found in Sure and createMissingTags=false: "${name}" — skipping`);
      continue;
    }

    try {
      const res = await getClient().post<{ data: SureTag }>('/api/v1/tags', { name });
      const created = res.data.data;
      tagCache.set(created.name, created.id);
      ids.push(created.id);
      logger.debug(`[sure-client] Created tag: "${name}" → ${created.id}`);
    } catch (err) {
      logger.warn(`[sure-client] Failed to create tag "${name}": ${String(err)} — skipping`);
    }
  }

  return ids;
}

/**
 * Creates a single transaction in Sure.
 * Returns the created transaction ID.
 *
 * Amount field: Sure expects an absolute (positive) value + transaction_type string.
 * Expenses use transaction_type='expense', income uses 'income'.
 * The signed amount from the scraper (negative = expense) is converted via Math.abs.
 */
export async function createTransaction(input: CreateTransactionInput): Promise<string> {
  const res = await getClient().post<{ data: { id: string } }>('/api/v1/transactions', {
    account_id: input.account_id,
    name: input.name,
    notes: input.notes,
    date: input.date,
    amount: Math.abs(input.amount),
    transaction_type: input.amount < 0 ? 'expense' : 'income',
    currency: input.currency ?? 'ILS',
    ...(input.category_id ? { category_id: input.category_id } : {}),
    ...(input.tag_ids?.length ? { tag_ids: input.tag_ids } : {}),
  });
  return res.data.data.id;
}

/**
 * Creates a valuation entry for balance reconciliation.
 */
export async function createValuation(input: CreateValuationInput): Promise<void> {
  await getClient().post('/api/v1/valuations', {
    account_id: input.account_id,
    date: input.date,
    amount: input.amount,
  });
}
