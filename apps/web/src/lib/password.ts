import { PASSWORD_MIN_LENGTH } from '@qs/shared';

/** No look-alike characters (0/O, 1/l/I), so a temporary password can be read out or typed from a screen. */
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!#$%&*+-=?@_';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

/** Uniform random index below `n` (rejection sampling, no modulo bias). */
function randomIndex(n: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

const pick = (set: string) => set[randomIndex(set.length)];

/** A random temporary password from the browser's CSPRNG with at least one character of each kind. */
export function generatePassword(length = 20): string {
  const n = Math.max(length, 16);
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < n) chars.push(pick(ALL));
  // Fisher-Yates shuffle so the guaranteed characters are not always at the start.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Policy hint shown to every user (the configured minimum is only visible to admins). */
export const PASSWORD_POLICY_HINT = `At least ${PASSWORD_MIN_LENGTH} characters and not a common password. A passphrase of a few words works well.`;
