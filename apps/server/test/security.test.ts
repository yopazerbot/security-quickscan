import { describe, expect, it } from 'vitest';
import { base32Encode, hotp, verifyTotp, base32Decode } from '../src/auth/totp.js';
import { Envelope } from '../src/crypto/envelope.js';
import { cell } from '../src/reports/csv.js';
import { randomBytes } from 'node:crypto';

const key = () => randomBytes(32).toString('base64');

describe('envelope encryption', () => {
  it('round-trips JSON', () => {
    const e = new Envelope(key());
    const blob = e.encryptJson({ token: 'ghp_secret' }, 'cred:a:b');
    expect(e.decryptJson(blob, 'cred:a:b')).toEqual({ token: 'ghp_secret' });
    expect(blob.toString('latin1')).not.toContain('ghp_secret');
  });
  it('rejects a blob moved to another record (AAD binding)', () => {
    const e = new Envelope(key());
    const blob = e.encryptJson({ x: 1 }, 'cred:a:b');
    expect(() => e.decrypt(blob, 'cred:a:c')).toThrow();
  });
  it('rejects tampered ciphertext', () => {
    const e = new Envelope(key());
    const blob = e.encryptJson({ x: 1 }, 'aad');
    blob[blob.length - 1] ^= 1;
    expect(() => e.decrypt(blob, 'aad')).toThrow();
  });
  it('rejects the wrong master key and supports rotation', () => {
    const a = new Envelope(key());
    const b = new Envelope(key());
    const blob = a.encryptJson({ x: 1 }, 'aad');
    expect(() => b.decrypt(blob, 'aad')).toThrow();
    expect(b.decryptJson(a.rewrap(blob, 'aad', b), 'aad')).toEqual({ x: 1 });
  });
  it('uses a fresh IV per encryption', () => {
    const e = new Envelope(key());
    expect(e.encryptJson(1, 'a').equals(e.encryptJson(1, 'a'))).toBe(false);
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });
  it('accepts current code and rejects others', () => {
    const b32 = base32Encode(randomBytes(20));
    const now = Date.now();
    const code = hotp(base32Decode(b32), Math.floor(now / 30000));
    expect(verifyTotp(b32, code, now)).toBe(true);
    expect(verifyTotp(b32, code, now + 5 * 30000)).toBe(false);
    expect(verifyTotp(b32, 'abcdef', now)).toBe(false);
  });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas and escapes quotes', () => {
    expect(cell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(cell('+1')).toBe(`"'+1"`);
    expect(cell('normal')).toBe('"normal"');
  });
});
