import axios, { type AxiosInstance } from 'axios';
import logger from './logger';

export interface SureAccount {
  id: string;
  name: string;
}

export interface ImportResult {
  id: string;
  status: string;
  rows_count?: number;
  valid_rows_count?: number;
  error?: string;
}

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60; // up to 3 minutes of polling

let client: AxiosInstance | null = null;

export function initSureClient(baseUrl: string, apiKey: string): void {
  client = axios.create({
    baseURL: baseUrl,
    headers: { 'X-Api-Key': apiKey },
    timeout: 30_000,
  });
}

function getClient(): AxiosInstance {
  if (!client) throw new Error('Sure client not initialized — call initSureClient() first');
  return client;
}

export async function getAccounts(): Promise<SureAccount[]> {
  const res = await getClient().get<SureAccount[]>('/api/v1/accounts');
  return res.data;
}

export async function createAccount(name: string): Promise<SureAccount> {
  const res = await getClient().post<SureAccount>('/api/v1/accounts', { name });
  return res.data;
}

export interface PostImportParams {
  accountId: string;
  csv: string;
  publish: string;
}

export async function postImport(params: PostImportParams): Promise<string> {
  const body = {
    raw_file_content: params.csv,
    type: 'TransactionImport',
    account_id: params.accountId,
    publish: params.publish,
    date_col_label: 'date',
    amount_col_label: 'amount',
    name_col_label: 'name',
    notes_col_label: 'notes',
    date_format: '%d/%m/%Y',
    number_format: '1,234.56',
    signage_convention: 'inflows_positive',
    col_sep: ',',
  };

  const res = await getClient().post<{ id: string }>('/api/v1/imports', body);
  return res.data.id;
}

/**
 * Polls GET /api/v1/imports/:id until status is no longer pending or importing.
 * Throws if the import does not settle within POLL_MAX_ATTEMPTS × POLL_INTERVAL_MS.
 */
export async function pollImport(importId: string): Promise<ImportResult> {
  const pending = new Set(['pending', 'importing']);

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const res = await getClient().get<ImportResult>(`/api/v1/imports/${importId}`);
    const result = res.data;

    if (!pending.has(result.status)) {
      return result;
    }

    logger.debug(`[import ${importId}] status=${result.status} — polling (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})`);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Import ${importId} did not complete within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`
  );
}
