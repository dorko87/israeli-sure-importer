import { readFileSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

/**
 * Strict allowlist for secret file names — the path-traversal guard.
 * NEVER make this regex more permissive.
 */
const VALID_SECRET_NAME = /^[a-zA-Z0-9_-]+$/;

function secretsDir(): string {
  return process.env['SECRETS_DIR'] ?? '/run/secrets';
}

/**
 * Reads a single credential file from the secrets directory.
 * Throws if the name is invalid, the file is missing, or it is empty.
 *
 * The returned value must NEVER be passed to logger.*, console.*, or
 * JSON.stringify() — see CLAUDE.md security rules.
 */
export function readSecret(name: string): string {
  if (!VALID_SECRET_NAME.test(name)) {
    throw new Error(`Invalid secret name "${name}" — only [a-zA-Z0-9_-] allowed`);
  }

  const dir = resolve(secretsDir());
  const filePath = join(dir, name);

  // Extra guard: path.relative() handles all platforms and edge-cases correctly.
  // A safe path resolves to a simple filename with no leading '..' segments.
  // isAbsolute() catches the impossible-but-defensive case of a relative absolute path.
  const rel = relative(dir, filePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal detected for secret "${name}"`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Secret file "${name}" not found or not readable in ${dir}: ${(err as Error).message}`,
    );
  }

  const value = raw.trim();
  if (!value) {
    throw new Error(`Secret file "${name}" is empty`);
  }

  return value;
}
