import axios from 'axios';
import logger from './logger';

let botToken: string | null = null;
const chatId = process.env.TELEGRAM_CHAT_ID ?? '';

const NOTIFY_ON_LOGIN_FAIL = process.env.NOTIFY_ON_LOGIN_FAIL !== 'false';
const NOTIFY_ON_SYNC_FAIL = process.env.NOTIFY_ON_SYNC_FAIL !== 'false';
const NOTIFY_ON_SUCCESS = process.env.NOTIFY_ON_SUCCESS === 'true';
const NOTIFY_ERROR_THRESHOLD = parseInt(process.env.NOTIFY_ERROR_THRESHOLD ?? '0', 10);

export function initNotifier(token: string | null): void {
  botToken = token;
  if (!token) {
    logger.debug('Telegram bot token not set — Telegram alerts disabled');
  }
}

async function send(text: string): Promise<void> {
  if (!botToken || !chatId) {
    logger.debug('Telegram notification skipped — no token or chat_id configured');
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML' },
      { timeout: 10_000 }
    );
    logger.info('Telegram notification sent');
  } catch (err) {
    logger.warn(`Telegram notification failed: ${String(err)}`);
  }
}

export async function notifyLoginFail(bank: string, errorType: string): Promise<void> {
  if (!NOTIFY_ON_LOGIN_FAIL) return;
  await send(`🔴 Login failed — ${bank} | ${errorType}`);
}

export async function notifySyncFail(bank: string, error: string): Promise<void> {
  if (!NOTIFY_ON_SYNC_FAIL) return;
  await send(`🔴 Sync failed — ${bank} | ${error}`);
}

export async function notifyErrorThreshold(bank: string, failedCount: number): Promise<void> {
  if (NOTIFY_ERROR_THRESHOLD <= 0 || failedCount < NOTIFY_ERROR_THRESHOLD) return;
  await send(`⚠️ ${bank} — ${failedCount} transactions failed (threshold: ${NOTIFY_ERROR_THRESHOLD})`);
}

export async function notifySuccess(summary: string): Promise<void> {
  if (!NOTIFY_ON_SUCCESS) return;
  await send(`✅ ${summary}`);
}
