import winston from 'winston';

const VALID_LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
type LogLevel = (typeof VALID_LOG_LEVELS)[number];

function resolveLogLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (VALID_LOG_LEVELS.includes(raw as LogLevel)) return raw as LogLevel;
  process.stderr.write(`Invalid LOG_LEVEL "${raw}", defaulting to "info"\n`);
  return 'info';
}

/**
 * Redacts credential-like values from log messages.
 *
 * Three layers:
 *  1. Key:value patterns for known credential field names (password, token, etc.)
 *  2. Bearer token header values
 *  3. Long base64/hex strings that look like API keys or tokens
 *
 * NOTE: This is defence-in-depth. The primary rule is that readSecret() return
 * values must NEVER be passed to logger.* in the first place.
 */
const redactFormat = winston.format((info) => {
  const redact = (val: unknown): unknown => {
    if (typeof val !== 'string') return val;
    return val
      // Layer 1 — key:value / key=value patterns for known credential field names
      .replace(
        /("?(?:password|token|apiKey|api_key|secret|credential|auth|Authorization|x-api-key)"?\s*[:=]\s*)"?([^",}\s]{4,})"?/gi,
        '$1[REDACTED]',
      )
      // Layer 2 — Bearer tokens in Authorization headers
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]')
      // Layer 3 — Long base64/hex-like strings in quoted context (>= 20 chars).
      // Uses lookbehind/lookahead instead of \b because \b does not work correctly
      // next to base64 characters '+' and '/' which are non-word characters.
      .replace(/(?<=["\s(,=:]|^)([A-Za-z0-9+/]{20,}={0,2})(?=["\s),\n]|$)/gm, (_, token: string) =>
        // Allow UUIDs through — they are safe account identifiers, not secrets
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
          ? token
          : '[REDACTED]',
      );
  };

  info['message'] = redact(info['message']);
  if (info['stack']) info['stack'] = redact(info['stack']);
  return info;
});

export const logger = winston.createLogger({
  level: resolveLogLevel(),
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      const base = `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`;
      return stack ? `${base}\n${stack}` : base;
    }),
  ),
  transports: [new winston.transports.Console()],
});
