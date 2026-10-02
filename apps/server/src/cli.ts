/**
 * Operational helpers:
 *   node dist/cli.js gen-master-key
 *   node dist/cli.js hash-password            (reads password from stdin)
 *   node dist/cli.js gen-totp [label]
 *   node dist/cli.js rotate-master-key        (MASTER_KEY_PREVIOUS -> MASTER_KEY)
 */
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { base32Encode } from './auth/totp.js';
import { loadConfig } from './config.js';
import { Envelope } from './crypto/envelope.js';
import { createDb } from './db/index.js';
import { credentials, scans, scanSystems } from './db/schema.js';

async function readSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return '';
}

function decryptsWith(env: Envelope, blob: Buffer, aad: string) {
  try {
    env.decrypt(blob, aad);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'gen-master-key':
      console.log(randomBytes(32).toString('base64'));
      return;
    case 'hash-password': {
      const pw = await readSecret('Password (min 16 chars): ');
      if (pw.length < 16) throw new Error('Use at least 16 characters');
      console.log(await hash(pw, { memoryCost: 65536, timeCost: 3, parallelism: 1 }));
      return;
    }
    case 'gen-totp': {
      const secret = base32Encode(randomBytes(20));
      const label = encodeURIComponent(arg ?? 'breakglass');
      console.log(`Secret:  ${secret}`);
      console.log(`URI:     otpauth://totp/SecurityQuickScan:${label}?secret=${secret}&issuer=SecurityQuickScan&algorithm=SHA1&digits=6&period=30`);
      return;
    }
    case 'rotate-master-key': {
      const config = loadConfig();
      if (!config.MASTER_KEY_PREVIOUS) throw new Error('Set MASTER_KEY_PREVIOUS to the old key and MASTER_KEY to the new key');
      const oldEnv = new Envelope(config.MASTER_KEY_PREVIOUS);
      const newEnv = new Envelope(config.MASTER_KEY);
      const { db, pool } = createDb(config);
      let n = 0;
      await db.transaction(async (tx) => {
        const rows = await tx.select({ c: credentials, scanId: scanSystems.scanId }).from(credentials).innerJoin(scanSystems, eq(scanSystems.id, credentials.systemId));
        for (const r of rows) {
          const aad = `cred:${r.scanId}:${r.c.systemId}`;
          if (decryptsWith(newEnv, r.c.blob, aad)) continue; // already on the new key (written after the switch)
          await tx.update(credentials).set({ blob: oldEnv.rewrap(r.c.blob, aad, newEnv), keyVersion: r.c.keyVersion + 1 }).where(eq(credentials.systemId, r.c.systemId));
          n++;
        }
        const docs = await tx.select({ id: scans.id, doc: scans.authorizationDoc }).from(scans);
        for (const d of docs) {
          if (!d.doc) continue;
          if (decryptsWith(newEnv, d.doc, `doc:${d.id}`)) continue;
          await tx.update(scans).set({ authorizationDoc: oldEnv.rewrap(d.doc, `doc:${d.id}`, newEnv) }).where(eq(scans.id, d.id));
          n++;
        }
      });
      await pool.end();
      console.log(`Re-encrypted ${n} item(s). Remove MASTER_KEY_PREVIOUS now.`);
      return;
    }
    default:
      console.log('Commands: gen-master-key | hash-password | gen-totp [label] | rotate-master-key');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
