import * as fs from 'fs';
import * as path from 'path';

const SECRETS_BASE = '/run/secrets';

/**
 * Reads a secret from the file path stored in the given env var.
 * Throws if the env var is unset, the file is missing, or the file is empty.
 */
export function readSecret(envVar: string): string {
  const filePath = process.env[envVar];
  if (!filePath) {
    throw new Error(`Environment variable ${envVar} is not set`);
  }
  return readFile(filePath, envVar);
}

/**
 * Reads a secret file by name from /run/secrets/<filename>.
 * Used for per-bank credentials referenced in config.json credentialSecrets.
 */
export function readSecretFile(filename: string): string {
  const fullPath = path.join(SECRETS_BASE, filename);
  return readFile(fullPath, filename);
}

function readFile(filePath: string, label: string): string {
  let value: string;
  try {
    value = fs.readFileSync(filePath, 'utf-8').trim();
  } catch (err) {
    throw new Error(`Failed to read secret "${label}" from ${filePath}: ${String(err)}`);
  }
  if (!value) {
    throw new Error(`Secret "${label}" at ${filePath} is empty`);
  }
  return value;
}

export interface AppSecrets {
  sureApiKey: string;
  telegramBotToken: string | null;
}

/**
 * Loads and validates the application-level secrets at startup.
 * Bank credentials are loaded per-target at scrape time via readSecretFile().
 */
export function loadAppSecrets(): AppSecrets {
  const sureApiKey = readSecret('SURE_API_KEY_FILE');

  let telegramBotToken: string | null = null;
  const telegramFile = process.env.TELEGRAM_BOT_TOKEN_FILE;
  if (telegramFile) {
    try {
      const val = fs.readFileSync(telegramFile, 'utf-8').trim();
      telegramBotToken = val || null;
    } catch {
      // Telegram is optional — log warning at call site
      telegramBotToken = null;
    }
  }

  return { sureApiKey, telegramBotToken };
}
