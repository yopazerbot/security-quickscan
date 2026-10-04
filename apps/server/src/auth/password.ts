import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_MAX_LENGTH } from '@qs/shared';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local account passwords: Argon2id (the library default algorithm) with the OWASP baseline parameters
 * (19 MiB, 2 iterations, 1 lane). The parameters are part of each hash, so they can be raised later.
 */
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, ARGON);

let dummy: Promise<string> | null = null;

/**
 * Verifies a password against a stored hash. Without a hash (unknown account, SSO-only user) a dummy hash is
 * verified anyway, so the response time does not reveal whether an account exists.
 */
export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  if (!stored) {
    dummy ??= hashPassword('not-a-real-password-for-timing-only');
    await verify(await dummy, password).catch(() => false);
    return false;
  }
  return verify(stored, password).catch(() => false);
}

function listFile() {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/auth in development, dist/ in the bundled build (copied by tsup.config.ts).
  for (const p of [resolve(here, 'common-passwords.txt'), resolve(here, 'auth/common-passwords.txt'), resolve(here, '../src/auth/common-passwords.txt')]) {
    if (existsSync(p)) return p;
  }
  throw new Error('common-passwords.txt not found');
}

let common: Set<string> | null = null;
/** Bundled list of common and breached passwords (lower case), loaded once. */
export function commonPasswords(): Set<string> {
  common ??= new Set(
    readFileSync(listFile(), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return common;
}

/**
 * Password policy for local accounts (no MFA for local accounts, so length and blocklist carry the weight).
 * Returns a message for the user, or null when the password is acceptable.
 */
export function passwordProblem(password: string, opts: { minLength: number; email?: string | null }): string | null {
  if (password.length < opts.minLength) return `Use at least ${opts.minLength} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (new Set(lower).size < 5) return 'This password is too repetitive. Use a longer phrase with more variety.';
  const list = commonPasswords();
  // Also catches a common password with digits or symbols added at the start or end (e.g. "Password2024!!").
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (list.has(lower) || (core.length >= 4 && list.has(core))) return 'This password is too common. Choose a less predictable one, for example a phrase of several unrelated words.';
  const local = opts.email?.split('@')[0]?.toLowerCase() ?? '';
  if (opts.email && (lower === opts.email.toLowerCase() || (local.length >= 3 && lower.includes(local)))) return 'The password must not contain your email address or user name.';
  return null;
}
