import { readFileSync } from 'fs';
import { resolve } from 'path';
import Ajv from 'ajv';
import { readSecret } from './secrets.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Target {
  /** UUID from Sure Finance account URL — validated before use */
  sureAccountId: string;
  /** Human-readable label for log messages only */
  sureAccountName?: string;
  /** Which account numbers to include.  'all' or an explicit list. */
  accounts?: 'all' | string[];
  /** Include pending (uncleared) transactions */
  includePending?: boolean;
}

/** Shape of config.json — zero credentials, safe to commit */
export interface AppConfig {
  sure: {
    baseUrl: string;
    /** Secret file name for the Sure API key */
    apiKeyFile: string;
  };
  banks: Record<
    string,
    {
      /** Maps scraper field names to secret file names */
      credentialKeys: Record<string, string>;
      targets: Target[];
    }
  >;
}

/** Fully resolved config held only in memory — never serialised */
export interface ResolvedBank {
  credentials: Record<string, string>;
  targets: Target[];
}

export interface ResolvedConfig {
  sure: {
    baseUrl: string;
    apiKey: string;
  };
  banks: Record<string, ResolvedBank>;
}

// ---------------------------------------------------------------------------
// JSON Schema for AppConfig
// ---------------------------------------------------------------------------

const schema = {
  type: 'object',
  required: ['sure', 'banks'],
  additionalProperties: false,
  properties: {
    sure: {
      type: 'object',
      required: ['baseUrl', 'apiKeyFile'],
      additionalProperties: false,
      properties: {
        // Require http:// or https:// — blocks non-URL strings at schema level
        baseUrl: { type: 'string', pattern: '^https?://' },
        apiKeyFile: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
      },
    },
    banks: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        required: ['credentialKeys', 'targets'],
        additionalProperties: false,
        properties: {
          credentialKeys: {
            type: 'object',
            minProperties: 1,
            additionalProperties: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
          },
          targets: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['sureAccountId'],
              additionalProperties: false,
              properties: {
                sureAccountId: {
                  type: 'string',
                  pattern:
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                },
                sureAccountName: { type: 'string' },
                accounts: {
                  oneOf: [
                    { type: 'string', enum: ['all'] },
                    { type: 'array', items: { type: 'string' }, minItems: 1 },
                  ],
                },
                includePending: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function configPath(): string {
  return resolve(process.env['CONFIG_PATH'] ?? '/app/config.json');
}

/**
 * Validates baseUrl is a well-formed http/https URL.
 * Second line of defence after the JSON Schema pattern check — defence in depth.
 */
function validateBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`config.sure.baseUrl is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `config.sure.baseUrl must use http: or https: — got "${parsed.protocol}"`,
    );
  }
  return raw.replace(/\/$/, '');
}

export function loadConfig(): ResolvedConfig {
  const path = configPath();

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read config at ${path}: ${(err as Error).message}`);
  }

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(raw)) {
    const errors = ajv.errorsText(validate.errors, { dataVar: 'config' });
    throw new Error(`config.json is invalid: ${errors}`);
  }

  const appConfig = raw as AppConfig;

  // Runtime URL validation (defence-in-depth after schema check)
  const baseUrl = validateBaseUrl(appConfig.sure.baseUrl);

  // Resolve the Sure API key from its secret file
  const apiKey = readSecret(appConfig.sure.apiKeyFile);

  // Resolve each bank's credentials from their secret files
  const banks: Record<string, ResolvedBank> = {};
  for (const [companyId, bank] of Object.entries(appConfig.banks)) {
    const credentials: Record<string, string> = {};
    for (const [field, secretFile] of Object.entries(bank.credentialKeys)) {
      credentials[field] = readSecret(secretFile);
    }
    banks[companyId] = { credentials, targets: bank.targets };
  }

  return {
    sure: { baseUrl, apiKey },
    banks,
  };
}
