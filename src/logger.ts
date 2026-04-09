import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

// Patterns that might appear in log messages — replace value with [REDACTED]
const REDACT_PATTERNS: RegExp[] = [
  /("?password"?\s*[:=]\s*)"?[^\s,"'}]+"?/gi,
  /("?token"?\s*[:=]\s*)"?[^\s,"'}]+"?/gi,
  /("?api.?key"?\s*[:=]\s*)"?[^\s,"'}]+"?/gi,
  /("?secret"?\s*[:=]\s*)"?[^\s,"'}]+"?/gi,
];

function redact(message: string): string {
  let result = message;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, '$1[REDACTED]');
  }
  return result;
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    const safe = redact(String(message));
    return `[${timestamp}] [${level.toUpperCase()}] ${safe}`;
  })
);

const transports: winston.transport[] = [
  new DailyRotateFile({
    filename: '/app/logs/importer-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: process.env.LOG_MAX_FILES ?? '7d',
    auditFile: '/app/logs/.audit.json',
    createSymlink: true,
    symlinkName: 'importer.log',
  }),
  new winston.transports.Console(),
];

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: logFormat,
  transports,
});

export default logger;
