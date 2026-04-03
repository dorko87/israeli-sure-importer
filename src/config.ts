import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as fs from 'fs';

export interface SureConfig {
  baseUrl: string;
  createMissingTags?: boolean;
}

export interface Target {
  name: string;
  companyId: string;
  credentialSecrets: Record<string, string>;
  sureAccountId?: string;
  sureAccountName?: string;
  reconcile?: boolean;
  tags?: string[];
  categoryMap?: Record<string, string>;
}

export interface Config {
  sure: SureConfig;
  targets: Target[];
}

const schema = {
  type: 'object',
  required: ['sure', 'targets'],
  additionalProperties: false,
  properties: {
    sure: {
      type: 'object',
      required: ['baseUrl'],
      additionalProperties: false,
      properties: {
        baseUrl: { type: 'string', minLength: 1 },
        createMissingTags: { type: 'boolean' },
      },
    },
    targets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'companyId', 'credentialSecrets'],
        additionalProperties: false,
        oneOf: [
          { required: ['sureAccountId'], not: { required: ['sureAccountName'] } },
          { required: ['sureAccountName'], not: { required: ['sureAccountId'] } },
        ],
        properties: {
          name: { type: 'string', minLength: 1 },
          companyId: { type: 'string', minLength: 1 },
          credentialSecrets: {
            type: 'object',
            additionalProperties: { type: 'string' },
            minProperties: 1,
          },
          sureAccountId: { type: 'string', minLength: 1 },
          sureAccountName: { type: 'string', minLength: 1 },
          reconcile: { type: 'boolean' },
          tags: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
          categoryMap: {
            type: 'object',
            additionalProperties: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
} as const;

const CONFIG_PATH = '/app/config.json';

export function loadConfig(): Config {
  let raw: unknown;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to read config from ${CONFIG_PATH}: ${String(err)}`);
  }

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (!validate(raw)) {
    const errors = validate.errors
      ?.map(e => `  ${e.instancePath || '(root)'} ${e.message}`)
      .join('\n') ?? '';
    throw new Error(`config.json validation failed:\n${errors}`);
  }

  const config = raw as Config;

  return config;
}
