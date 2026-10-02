import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Envelope encryption for scan credentials and other secrets.
 * A fresh 256-bit data key (DEK) encrypts the payload with AES-256-GCM. The DEK is wrapped with
 * the master key (AES-256-GCM as well). The additional authenticated data (AAD) binds a ciphertext
 * to its owning record, so a blob copied to another row fails to decrypt.
 *
 * Layout: ver(1) | dekIv(12) | dekTag(16) | wrappedDek(32) | iv(12) | tag(16) | ciphertext
 */
const VERSION = 1;
const MIN_LEN = 1 + 12 + 16 + 32 + 12 + 16;
const GCM = { authTagLength: 16 } as const;

export class Envelope {
  private readonly key: Buffer;

  constructor(masterKeyB64: string) {
    this.key = Buffer.from(masterKeyB64, 'base64');
    if (this.key.length !== 32) throw new Error('Master key must be 32 bytes');
  }

  encrypt(plaintext: Buffer, aad: string): Buffer {
    const dek = randomBytes(32);
    const dekIv = randomBytes(12);
    const w = createCipheriv('aes-256-gcm', this.key, dekIv, GCM);
    w.setAAD(Buffer.from(`dek:${aad}`));
    const wrapped = Buffer.concat([w.update(dek), w.final()]);
    const dekTag = w.getAuthTag();

    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', dek, iv, GCM);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    const tag = c.getAuthTag();
    dek.fill(0);
    return Buffer.concat([Buffer.from([VERSION]), dekIv, dekTag, wrapped, iv, tag, ct]);
  }

  decrypt(blob: Buffer, aad: string): Buffer {
    if (blob.length < MIN_LEN || blob[0] !== VERSION) throw new Error('Unsupported or truncated ciphertext');
    let o = 1;
    const take = (n: number) => blob.subarray(o, (o += n));
    const dekIv = take(12);
    const dekTag = take(16);
    const wrapped = take(32);
    const iv = take(12);
    const tag = take(16);
    const ct = blob.subarray(o);

    const u = createDecipheriv('aes-256-gcm', this.key, dekIv, GCM);
    u.setAAD(Buffer.from(`dek:${aad}`));
    u.setAuthTag(dekTag);
    const dek = Buffer.concat([u.update(wrapped), u.final()]);

    const d = createDecipheriv('aes-256-gcm', dek, iv, GCM);
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]);
    dek.fill(0);
    return pt;
  }

  encryptJson(value: unknown, aad: string): Buffer {
    return this.encrypt(Buffer.from(JSON.stringify(value), 'utf8'), aad);
  }

  decryptJson<T = unknown>(blob: Buffer, aad: string): T {
    return JSON.parse(this.decrypt(blob, aad).toString('utf8')) as T;
  }

  /** Re-wrap only the DEK under a new master key (used for key rotation). */
  rewrap(blob: Buffer, aad: string, next: Envelope): Buffer {
    return next.encrypt(this.decrypt(blob, aad), aad);
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
