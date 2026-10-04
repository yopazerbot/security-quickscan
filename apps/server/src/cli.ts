/**
 * Operational helpers:
 *   node dist/cli.js gen-master-key
 *   node dist/cli.js hash-password            (reads password from stdin)
 *   node dist/cli.js gen-totp [label]
 *   node dist/cli.js rotate-master-key        (MASTER_KEY_PREVIOUS -> MASTER_KEY)
 *   node dist/cli.js export --as admin@example.com --out backup.qsx [--organisation <id>]
 *   node dist/cli.js import backup.qsx --as admin@example.com [--dry-run]
 * Export and import read the passphrase from QS_EXPORT_PASSPHRASE, or from stdin.
 */
import { hash } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import pino from 'pino';
import { audit } from './audit.js';
import { passwordProblem } from './auth/password.js';
import { base32Encode } from './auth/totp.js';
import { loadConfig } from './config.js';
import type { AppCtx, SessionUser } from './context.js';
import { Envelope } from './crypto/envelope.js';
import { createDb, runMigrations } from './db/index.js';
import { credentials, customers, scanSystems, settings, users } from './db/schema.js';
import { buildExport } from './portability/export.js';
import { decryptExport, encryptExport, MAX_FILE_BYTES, PASSPHRASE_MIN } from './portability/format.js';
import { applyImport, planImport } from './portability/import.js';
import { secretAad, SECRET_FIELDS, type StoredSecret } from './settings/runtime.js';

async function readSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  if (process.stdin.isTTY) return readHidden();
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return '';
}

/** Reads one line from an interactive terminal without echoing it (the break-glass password). */
function readHidden(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (v: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      resolve(v);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u0003') {
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function decryptsWith(env: Envelope, blob: Buffer, aad: string) {
  try {
    env.decrypt(blob, aad);
    return true;
  } catch {
    return false;
  }
}

/** Value of a --flag in the command line, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Export and import run as an existing, active administrator, named with --as. */
async function adminCtx(args: string[]) {
  const email = flag(args, '--as');
  if (!email) throw new Error('Name the administrator to act as: --as admin@example.com');
  const config = loadConfig();
  const { db, pool } = createDb(config);
  await runMigrations(db);
  const ctx: AppCtx = { config, db, envelope: new Envelope([config.MASTER_KEY, config.MASTER_KEY_PREVIOUS]), log: pino({ level: 'warn' }) as unknown as AppCtx['log'] };
  const u = (await db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).limit(1))[0];
  if (!u || !u.active || u.role !== 'admin' || u.isDemo) {
    await pool.end();
    throw new Error('No active administrator with this email');
  }
  const user: SessionUser = {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isBreakglass: u.isBreakglass,
    isDemo: false,
    hasPassword: Boolean(u.passwordHash),
    mustChangePassword: false,
  };
  return { ctx, pool, user };
}

const exportPassphrase = async () => process.env.QS_EXPORT_PASSPHRASE ?? (await readSecret('Export passphrase: '));

async function main() {
  const args = process.argv.slice(2);
  const [cmd, arg] = args;
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
        // Secrets in the application settings (sign-in app, scanner identities).
        for (const { key, field } of SECRET_FIELDS) {
          const row = (await tx.select().from(settings).where(eq(settings.key, key)).for('update'))[0];
          const value = row?.value as Record<string, unknown> | undefined;
          const secret = value?.[field] as StoredSecret | null | undefined;
          if (!value || !secret?.blob) continue;
          const aad = secretAad(key, field);
          const blob = Buffer.from(secret.blob, 'base64');
          if (decryptsWith(newEnv, blob, aad)) continue;
          const next = { ...value, [field]: { ...secret, blob: oldEnv.rewrap(blob, aad, newEnv).toString('base64') } };
          await tx.update(settings).set({ value: next, updatedAt: new Date() }).where(eq(settings.key, key));
          n++;
        }
      });
      await pool.end();
      console.log(`Re-encrypted ${n} item(s). Remove MASTER_KEY_PREVIOUS now.`);
      return;
    }
    case 'export': {
      const out = flag(args, '--out');
      if (!out) throw new Error('Name the output file: --out backup.qsx');
      const orgId = flag(args, '--organisation');
      const passphrase = await exportPassphrase();
      const problem = passwordProblem(passphrase, { minLength: PASSPHRASE_MIN });
      if (problem) throw new Error(problem.replace(/password/gi, 'passphrase'));
      const { ctx, pool, user } = await adminCtx(args);
      try {
        const rows = await ctx.db
          .select({ id: customers.id })
          .from(customers)
          .where(orgId ? and(eq(customers.id, orgId), eq(customers.isDemo, false)) : eq(customers.isDemo, false));
        if (!rows.length) throw new Error(orgId ? 'Organisation not found' : 'There are no organisations to export');
        const ids = rows.map((r) => r.id);
        const payload = await buildExport(ctx, user, ids, orgId ? 'organisation' : 'all', new Set(ids));
        const file = await encryptExport(payload, passphrase);
        writeFileSync(out, file, { mode: 0o600 });
        const scans = payload.organisations.reduce((n, o) => n + o.scans.length, 0);
        await audit(ctx, null, 'data.export', orgId ? { type: 'customer', id: orgId } : undefined, { scope: payload.scope, organisations: ids.length, scans, bytes: file.length, via: 'cli' }, user);
        console.log(`Exported ${ids.length} organisation(s) with ${scans} scan(s) to ${out}.`);
      } finally {
        await pool.end();
      }
      return;
    }
    case 'import': {
      if (!arg || arg.startsWith('--')) throw new Error('Name the file to import: import backup.qsx --as admin@example.com');
      const file = readFileSync(arg);
      if (file.length > MAX_FILE_BYTES) throw new Error(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const passphrase = await exportPassphrase();
      const { ctx, pool, user } = await adminCtx(args);
      try {
        const payload = await decryptExport(file, passphrase);
        const plan = await planImport(ctx.db, user, payload);
        for (const o of plan.organisations) {
          console.log(`${o.name}: ${o.action === 'merge' ? `merge into "${o.targetName}"` : 'new organisation'}, ${o.newScans} new scan(s), ${o.existingScans} already present`);
          for (const n of o.notes) console.log(`  ${n}`);
        }
        if (args.includes('--dry-run')) return;
        const r = await applyImport(ctx, user, payload);
        await audit(ctx, null, 'data.import', undefined, {
          scope: payload.scope,
          appVersion: payload.appVersion,
          exportedAt: payload.exportedAt,
          exportedBy: payload.exportedBy.email,
          organisations: r.totals.organisations,
          newOrganisations: r.totals.newOrganisations,
          scansAdded: r.totals.added,
          scansSkipped: r.totals.skipped,
          organisationIds: r.organisations.map((o) => o.id),
          via: 'cli',
        }, user);
        console.log(`Imported ${r.totals.added} scan(s); ${r.totals.skipped} already present.`);
      } finally {
        await pool.end();
      }
      return;
    }
    default:
      console.log('Commands: gen-master-key | hash-password | gen-totp [label] | rotate-master-key | export | import');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
