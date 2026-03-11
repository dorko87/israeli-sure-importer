import fetch from 'node-fetch';
import FormData from 'form-data';
import { logger } from './logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Reject the nil UUID — it passes format but isn't a real account ID
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = 'israeli-sure-importer/1.0';

export interface UploadResult {
  importId: string;
  rowsCount: number;
}

/**
 * Uploads a CSV to Sure Finance for a specific account.
 *
 * @param baseUrl  Validated base URL (no trailing slash)
 * @param apiKey   API key — NEVER logged
 * @param sureAccountId  UUID from Sure account URL — validated here (SSRF guard)
 * @param csv      CSV string with header row
 * @param label    Human-readable label for log messages
 */
export async function uploadCsv(
  baseUrl: string,
  apiKey: string,
  sureAccountId: string,
  csv: string,
  label: string,
): Promise<UploadResult> {
  // SSRF guard — never remove this validation
  if (!UUID_RE.test(sureAccountId) || sureAccountId.toLowerCase() === NIL_UUID) {
    throw new Error(`sureAccountId "${sureAccountId}" is not a valid non-nil UUID`);
  }

  const url = `${baseUrl}/api/v1/imports`;
  const csvRows = csv.split('\n').length - 1; // exclude header
  const publish = (process.env['PUBLISH'] ?? 'true') === 'true' ? 'true' : 'false';
  logger.debug(`Uploading ${csvRows} rows to Sure account "${label}" (publish=${publish})`);

  const form = new FormData();
  form.append('type', 'TransactionImport');
  form.append('account_id', sureAccountId);
  form.append('publish', publish);
  form.append('date_col_label', 'date');
  form.append('amount_col_label', 'amount');
  form.append('name_col_label', 'name');
  form.append('notes_col_label', 'notes');
  form.append('date_format', '%d/%m/%Y');  // Ruby strftime: DD/MM/YYYY
  form.append('number_format', '1,234.56');
  form.append('signage_convention', 'inflows_positive');
  form.append('col_sep', ',');
  form.append('amount_type_strategy', 'signed_amount');
  form.append('file', Buffer.from(csv, 'utf8'), {
    filename: 'transactions.csv',
    contentType: 'text/csv',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        ...form.getHeaders(),
      },
      body: form,
      signal: controller.signal as Parameters<typeof fetch>[1] extends { signal?: infer S } ? S : never,
    });
  } catch (err) {
    throw new Error(`Network error uploading to Sure (${label}): ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Do NOT read or log the response body — it may contain sensitive server-side info.
    // Log only the HTTP status code, which is safe.
    throw new Error(
      `Sure API returned HTTP ${response.status} for account "${label}" — check Sure logs for details`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Sure API returned non-JSON response for account "${label}"`);
  }

  const data = (body as { data?: { id?: string; stats?: { rows_count?: number } } }).data;
  const importId = data?.id ?? 'unknown';
  const rowsCount = data?.stats?.rows_count ?? 0;

  logger.info(`Uploaded to Sure (${label}): import=${importId}, rows=${rowsCount}`);
  return { importId, rowsCount };
}
