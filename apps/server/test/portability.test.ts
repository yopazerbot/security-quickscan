/**
 * Export and import of the scan history (.qsx): encryption and tamper evidence, round trip, merge, comparison with
 * imported scans and access rules. The database part needs TEST_DATABASE_URL (see api.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { and, eq, inArray, or } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, loggerOptions } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppCtx } from '../src/context.js';
import { randomToken, sha256 } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import {
  auditLog,
  checkResults,
  credentials,
  customerAssignments,
  customers,
  findingTriage,
  scanCriteria,
  scans,
  scanSystems,
  sessions,
  users,
} from '../src/db/schema.js';
import { seedDemo } from '../src/demo/seed.js';
import {
  canonicalJson,
  decryptExport,
  DECRYPT_FAILED,
  encryptExport,
  exportFileName,
  remapSummarySystems,
  sealExport,
  type ExportPayload,
} from '../src/portability/format.js';
import { controlsCsv, findingsCsv } from '../src/reports/csv.js';
import { buildReport, type ReportModel } from '../src/reports/model.js';
import { renderPdf } from '../src/reports/pdf.js';
import { storeScanScore } from '../src/scoring.js';

/** Built at runtime: a passphrase literal would look like a secret to scanners. */
const PASS = ['quiet', 'harbour', 'lantern', 'export'].join('-');
const OTHER = ['quiet', 'harbour', 'lantern', 'import'].join('-');

const minimal = (over: Partial<ExportPayload> = {}): ExportPayload => ({
  format: 'security-quickscan-export',
  schemaVersion: 1,
  appVersion: '1.0.0',
  exportedAt: new Date().toISOString(),
  exportedBy: { name: 'Test', email: 'test@test.local' },
  scope: 'all',
  organisations: [],
  ...over,
});

describe('export file format', () => {
  it('round-trips and authenticates the header', async () => {
    const file = await encryptExport(minimal(), PASS);
    const env = JSON.parse(file.toString());
    expect(env).toMatchObject({ format: 'security-quickscan-export', version: 1, kdf: { alg: 'argon2id', memoryKiB: 65536, iterations: 3, parallelism: 1 }, cipher: { alg: 'aes-256-gcm' } });
    expect((await decryptExport(file, PASS)).scope).toBe('all');
    // Key order in the file does not matter (canonical AAD).
    const reordered = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(env).reverse())));
    expect((await decryptExport(reordered, PASS)).scope).toBe('all');
  });

  it('gives one generic error for a wrong passphrase, a flipped byte and an edited header', async () => {
    const file = await encryptExport(minimal(), PASS);
    await expect(decryptExport(file, OTHER)).rejects.toMatchObject({ statusCode: 400, message: DECRYPT_FAILED });
    const env = JSON.parse(file.toString());
    const data = Buffer.from(env.data, 'base64');
    data[5] ^= 1;
    await expect(decryptExport(Buffer.from(JSON.stringify({ ...env, data: data.toString('base64') })), PASS)).rejects.toMatchObject({ message: DECRYPT_FAILED });
    await expect(decryptExport(Buffer.from(JSON.stringify({ ...env, createdAt: new Date(0).toISOString() })), PASS)).rejects.toMatchObject({ message: DECRYPT_FAILED });
    await expect(decryptExport(Buffer.from(JSON.stringify({ ...env, kdf: { ...env.kdf, iterations: 4 } })), PASS)).rejects.toMatchObject({ message: DECRYPT_FAILED });
    // Parameters outside the accepted bounds (memory exhaustion) are refused before deriving a key.
    await expect(decryptExport(Buffer.from(JSON.stringify({ ...env, kdf: { ...env.kdf, memoryKiB: 4_000_000 } })), PASS)).rejects.toMatchObject({ message: DECRYPT_FAILED });
    await expect(decryptExport(Buffer.from('not json'), PASS)).rejects.toMatchObject({ message: /not a Security QuickScan export/ });
  });

  it('refuses files from a newer version', async () => {
    const env = JSON.parse((await encryptExport(minimal(), PASS)).toString());
    await expect(decryptExport(Buffer.from(JSON.stringify({ ...env, version: 2 })), PASS)).rejects.toMatchObject({ message: /newer version/ });
    const newer = await sealExport(gzipSync(JSON.stringify({ ...minimal(), schemaVersion: 2 })), PASS);
    await expect(decryptExport(newer, PASS)).rejects.toMatchObject({ message: /newer version/ });
  });

  it('refuses a decompression bomb and invalid content', async () => {
    const bomb = await sealExport(gzipSync(Buffer.alloc(260 * 1024 * 1024, 0x20), { level: 9 }), PASS);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    await expect(decryptExport(bomb, PASS)).rejects.toMatchObject({ statusCode: 413 });
    const bad = await sealExport(gzipSync(JSON.stringify(minimal({ organisations: [{ exportId: 'nope' }] as any }))), PASS);
    await expect(decryptExport(bad, PASS)).rejects.toMatchObject({ statusCode: 400, message: /not valid/ });
  }, 60_000);

  it('remaps system ids in a frozen summary and names files', () => {
    const map = new Map([['a', 'x']]);
    const s = remapSummarySystems({ score: 50, controls: [{ id: 'A.5.1', checks: [{ checkId: 'c', systemId: 'a' }, { checkId: 'd', systemId: 'gone' }] }] }, map);
    expect((s as any).controls[0].checks).toEqual([{ checkId: 'c', systemId: 'x' }, { checkId: 'd' }]);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(exportFileName('Noordkust Logistiek B.V.', new Date('2026-10-04T10:00:00Z'))).toBe('quickscan-noordkust-logistiek-b-v-2026-10-04.qsx');
    expect(exportFileName('all', new Date('2026-10-04T10:00:00Z'))).toBe('quickscan-all-2026-10-04.qsx');
  });

  it('redacts the passphrase and file from logs', () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
    const cfg = loadConfig({
      NODE_ENV: 'test', APP_URL: 'http://localhost:8080', DATABASE_URL: 'postgres://x@localhost/none', MASTER_KEY: randomBytes(32).toString('base64'),
      COOKIE_SECURE: 'false', ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111', ENTRA_CLIENT_ID: 'x', ENTRA_CLIENT_SECRET: 'y', LOG_LEVEL: 'info',
    } as any);
    const log = pino(loggerOptions(cfg) as any, sink);
    log.info({ body: { passphrase: PASS, file: 'QUJD', dryRun: true } }, 'request');
    expect(lines.join('')).not.toContain(PASS);
    expect(lines.join('')).not.toContain('QUJD');
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('export and import', () => {
  const config = loadConfig({
    NODE_ENV: 'test', APP_URL: 'http://localhost:8080', DATABASE_URL: url ?? 'postgres://skipped@localhost/none',
    MASTER_KEY: randomBytes(32).toString('base64'), COOKIE_SECURE: 'false', ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: 'x', ENTRA_CLIENT_SECRET: 'y', DEMO_MODE: 'true', LOG_LEVEL: 'fatal',
  } as any);
  const { db, pool } = createDb(config);
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: AppCtx;
  const S: Record<string, { cookie: string; csrf: string; id: string; email: string }> = {};
  const created: string[] = [];
  // Every request from its own address: the import and export rate limits are per client.
  let ip = 0;
  const HINT = `hint-${randomToken(6)}`;

  async function login(role: 'admin' | 'consultant' | 'viewer', name: string, isDemo = false) {
    const [u] = await db.insert(users).values({ email: `${name}-${randomToken(4)}@test.local`, name, role, isDemo }).returning();
    const token = randomToken();
    const csrf = randomToken();
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: csrf, authMethod: 'test', expiresAt: new Date(Date.now() + 3600_000) });
    S[name] = { cookie: `qs_session=${token}`, csrf, id: u.id, email: u.email };
  }
  const req = (who: string, method: string, path: string, payload?: unknown) =>
    app.inject({
      method: method as any,
      url: path,
      payload: payload as any,
      remoteAddress: `10.9.${Math.floor(++ip / 250)}.${ip % 250}`,
      headers: { cookie: S[who].cookie, 'x-csrf-token': S[who].csrf, origin: 'http://localhost:8080' },
    });
  const exportOrg = async (who: string, organisationId: string) => {
    const r = await req(who, 'POST', '/api/export', { organisationId, passphrase: PASS });
    expect(r.statusCode, r.body).toBe(200);
    return r.rawPayload;
  };
  const doImport = async (who: string, file: Buffer, dryRun: boolean, passphrase = PASS) => req(who, 'POST', '/api/import', { file: file.toString('base64'), passphrase, dryRun });
  const imported = async (who: string, file: Buffer) => {
    const r = await doImport(who, file, false);
    expect(r.statusCode, r.body).toBe(200);
    const result = r.json().result;
    created.push(...result.organisations.map((o: any) => o.id));
    return result;
  };

  /** A report without the fields that differ by design (ids, generation time, import marks, retention, stored secrets). */
  function comparable(m: ReportModel) {
    const { generatedAt: _g, scan, customer: _c, ...rest } = m;
    const { id: _i, importedAt: _a, importedFromVersion: _v, retentionMode: _r, retentionDays: _d, ...s } = scan;
    const json = JSON.stringify({ ...rest, scan: s, systems: m.systems.map(({ credentialsStored: _x, credentialsExpireAt: _y, ...x }) => x) });
    // Row ids differ between the original and the import: number them by first appearance.
    const ids = new Map<string, string>();
    return JSON.parse(json.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => (ids.has(u) ? ids.get(u)! : (ids.set(u, `id${ids.size}`), `id${ids.size - 1}`))));
  }

  let orgId = '';
  let orgName = '';
  let scanIds: string[] = [];
  let originals: ReportModel[] = [];

  beforeAll(async () => {
    await runMigrations(db);
    ({ app, ctx } = await buildApp(config, db));
    await login('admin', 'admin');
    await login('consultant', 'alice');
    await login('consultant', 'bob');
    await login('consultant', 'carol');
    await login('viewer', 'victor');
    await login('consultant', 'visitor', true);

    // Realistic history: the seeded demo organisation (two finished scans, a draft, triage, environments),
    // turned into a regular organisation owned by alice and shared with carol and victor.
    await db.delete(customers).where(eq(customers.isDemo, true));
    await seedDemo(ctx);
    const org = (await db.select().from(customers).where(eq(customers.isDemo, true)))[0];
    orgId = org.id;
    orgName = `Portable ${randomToken(3)}`;
    await db.update(customers).set({ isDemo: false, ownerId: S.alice.id, name: orgName }).where(eq(customers.id, orgId));
    await db.delete(customerAssignments).where(eq(customerAssignments.customerId, orgId));
    await db.insert(customerAssignments).values([
      { userId: S.carol.id, customerId: orgId, permission: 'edit' },
      { userId: S.victor.id, customerId: orgId, permission: 'view' },
    ]);
    const done = await db.select().from(scans).where(and(eq(scans.customerId, orgId), eq(scans.status, 'completed'))).orderBy(scans.finishedAt);
    scanIds = done.map((s) => s.id);
    // A stored credential (must never be exported), a legacy exclusion and a result of a check this version does not know.
    const sys = await db.select().from(scanSystems).where(eq(scanSystems.scanId, scanIds[1])).orderBy(scanSystems.createdAt);
    await db.insert(credentials).values({ systemId: sys[0].id, blob: Buffer.from(`blob-${HINT}`), hint: HINT });
    await db.insert(scanCriteria).values({ scanId: scanIds[0], checkId: 'gh.org-2fa', included: false, reason: 'Out of scope then' });
    await db.insert(checkResults).values({ scanId: scanIds[1], systemId: sys[0].id, checkId: 'future.check-from-a-newer-catalog', status: 'pass', summary: 'later' });
    originals = await Promise.all(scanIds.map((id) => buildReport(ctx, id)));
  }, 60_000);

  afterAll(async () => {
    const all = [orgId, ...created].filter(Boolean);
    if (all.length) await db.delete(customers).where(inArray(customers.id, all));
    await app.close();
    await pool.end();
  });

  it('exports finished scans only, without secrets or demo data', async () => {
    const r = await req('alice', 'POST', '/api/export', { organisationId: orgId, passphrase: PASS });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="quickscan-portable-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.qsx"$/);
    const p = await decryptExport(r.rawPayload, PASS);
    expect(p).toMatchObject({ schemaVersion: 1, scope: 'organisation', exportedBy: { email: S.alice.email } });
    const [o] = p.organisations;
    expect(o.exportId).toBe(orgId);
    expect(o.scans.map((s) => s.exportId)).toEqual(scanIds);
    expect(o.ownerEmail).toBe(S.alice.email);
    expect(o.shares.map((s) => s.email).sort()).toEqual([S.carol.email, S.victor.email].sort());
    expect(o.triage.length).toBeGreaterThan(0);
    const raw = JSON.stringify(p);
    expect(raw).not.toContain(HINT);
    expect(raw).not.toMatch(/"(blob|hint|expiresAt|passwordHash|keyVersion)"/);
    // Frozen summaries point at the exported system ids.
    const sysIds = new Set(o.scans[1].systems.map((s) => s.exportId));
    const refs = ((o.scans[1].summary as any).controls as any[]).flatMap((c) => c.checks.map((x: any) => x.systemId)).filter(Boolean);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((id: string) => sysIds.has(id))).toBe(true);
    // The audit entry has counts, never the passphrase.
    const a = (await db.select().from(auditLog).where(and(eq(auditLog.action, 'data.export'), eq(auditLog.userId, S.alice.id))))[0];
    expect(a.details).toMatchObject({ scope: 'organisation', organisations: 1, scans: 2 });
    expect(JSON.stringify(a)).not.toContain(PASS);
  });

  it('checks access and the passphrase policy', async () => {
    expect((await req('bob', 'POST', '/api/export', { organisationId: orgId, passphrase: PASS })).statusCode).toBe(404);
    expect((await req('alice', 'POST', '/api/export', { organisationId: orgId, passphrase: 'short' })).statusCode).toBe(400);
    expect((await req('alice', 'POST', '/api/export', { organisationId: orgId, passphrase: 'aaaaaaaaaaaaaaaa' })).json().error).toMatch(/passphrase is too repetitive/);
    expect((await req('alice', 'POST', '/api/export', { organisationId: orgId })).statusCode).toBe(400);
    // A view-only share exports the history, but not who has access.
    const v = await decryptExport(await exportOrg('victor', orgId), PASS);
    expect(v.organisations[0].ownerEmail).toBeNull();
    expect(v.organisations[0].shares).toEqual([]);
    expect(v.organisations[0].triage.every((t) => t.updatedByEmail === null)).toBe(true);
    // Export all: everything accessible, never demo organisations; not for the demo visitor.
    const all = await req('bob', 'POST', '/api/export', { all: true, passphrase: PASS });
    expect([200, 400]).toContain(all.statusCode);
    if (all.statusCode === 200) expect((await decryptExport(all.rawPayload, PASS)).organisations.some((o) => o.exportId === orgId)).toBe(false);
    const adminAll = await decryptExport((await req('admin', 'POST', '/api/export', { all: true, passphrase: PASS })).rawPayload, PASS);
    expect(adminAll.scope).toBe('all');
    expect(adminAll.organisations.some((o) => o.exportId === orgId)).toBe(true);
    const demoIds = (await db.select({ id: customers.id }).from(customers).where(eq(customers.isDemo, true))).map((r) => r.id);
    expect(adminAll.organisations.some((o) => demoIds.includes(o.exportId))).toBe(false);
    expect((await req('visitor', 'POST', '/api/export', { all: true, passphrase: PASS })).statusCode).toBe(403);
  });

  it('refuses imports from viewers and demo visitors, and oversize requests', async () => {
    const file = await exportOrg('alice', orgId);
    expect((await doImport('victor', file, true)).statusCode).toBe(403);
    expect((await doImport('visitor', file, true)).statusCode).toBe(403);
    const wrong = await doImport('alice', file, true, OTHER);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe(DECRYPT_FAILED);
    expect((await req('alice', 'POST', '/api/export', { organisationId: orgId, passphrase: 'x'.repeat(1024 * 1024 + 10) })).statusCode).toBe(413);
    const huge = await req('alice', 'POST', '/api/import', { file: 'A'.repeat(65 * 1024 * 1024), passphrase: PASS, dryRun: true });
    expect(huge.statusCode).toBe(413);
  }, 60_000);

  it('previews an import into the same organisation as already present, and re-importing adds nothing', async () => {
    const file = await exportOrg('alice', orgId);
    const prev = await doImport('alice', file, true);
    expect(prev.statusCode, prev.body).toBe(200);
    expect(prev.json().plan.organisations[0]).toMatchObject({ action: 'merge', targetId: orgId, scans: 2, newScans: 0, existingScans: 2 });
    const r = await imported('alice', file);
    expect(r.totals).toMatchObject({ added: 0, skipped: 2, newOrganisations: 0 });
    expect(await db.select().from(scans).where(eq(scans.customerId, orgId))).toHaveLength(3);
  });

  it('creates a new organisation when the importer cannot edit the match, without restoring access', async () => {
    const file = await exportOrg('alice', orgId);
    const plan = (await doImport('bob', file, true)).json().plan;
    expect(plan.organisations[0]).toMatchObject({ action: 'new', targetId: null, targetName: null, newScans: 2 });
    expect(plan.organisations[0].notes.join(' ')).toMatch(/Who has access is not imported/);
    const r = await imported('bob', file);
    const newId = r.organisations[0].id;
    expect(newId).not.toBe(orgId);
    const c = (await db.select().from(customers).where(eq(customers.id, newId)))[0];
    expect(c).toMatchObject({ ownerId: S.bob.id, originId: orgId, isDemo: false });
    expect(await db.select().from(customerAssignments).where(eq(customerAssignments.customerId, newId))).toEqual([]);
    // A view share does not count as a match either: victor cannot import (viewer), carol with edit merges.
    expect((await doImport('carol', file, true)).json().plan.organisations[0]).toMatchObject({ action: 'merge', targetId: orgId });
    // Origin identity across hops: an export of bob's copy merges into alice's original with nothing new.
    const copy = await exportOrg('bob', newId);
    const back = (await doImport('alice', copy, true)).json().plan.organisations[0];
    expect(back).toMatchObject({ action: 'merge', targetId: orgId, newScans: 0, existingScans: 2 });
    expect((await imported('bob', copy)).totals).toMatchObject({ added: 0, skipped: 2 });
  });

  it('round-trips into a fresh organisation: reports, PDF, CSV, triage and the trend match', async () => {
    const file = await exportOrg('admin', orgId);
    // A fresh installation: neither the original nor bob's copy of it exists.
    await db.delete(customers).where(or(eq(customers.id, orgId), eq(customers.originId, orgId)));
    const plan = (await doImport('admin', file, true)).json().plan;
    expect(plan.organisations[0]).toMatchObject({ action: 'new', newScans: 2, from: expect.any(String), to: expect.any(String) });
    expect(plan.organisations[0].notes.join(' ')).toMatch(/unknown to this version/);
    const r = await imported('admin', file);
    const id = r.organisations[0].id;
    orgId = id;
    // An administrator restores the owner and the shares (viewer accounts stay view).
    expect((await db.select().from(customers).where(eq(customers.id, id)))[0]).toMatchObject({ ownerId: S.alice.id, originId: plan.organisations[0].exportId, name: orgName });
    const shares = await db.select().from(customerAssignments).where(eq(customerAssignments.customerId, id));
    expect(shares.map((s) => [s.userId, s.permission]).sort()).toEqual([[S.carol.id, 'edit'], [S.victor.id, 'view']].sort());

    const rows = await db.select().from(scans).where(eq(scans.customerId, id)).orderBy(scans.finishedAt);
    expect(rows.map((s) => s.originId)).toEqual(scanIds);
    expect(rows.every((s) => s.importedAt && s.importedBy === S.admin.id && s.retentionMode === 'manual' && s.importedFromVersion)).toBe(true);
    for (const [i, s] of rows.entries()) {
      const m = await buildReport(ctx, s.id);
      expect(comparable(m)).toEqual(comparable(originals[i]));
      expect(m.scan.importedAt).toBeInstanceOf(Date);
      expect(m.systems.every((x) => !x.credentialsStored)).toBe(true);
      expect((await renderPdf(m, null)).subarray(0, 4).toString()).toBe('%PDF');
      expect(findingsCsv(m).length).toBeGreaterThan(100);
      expect(controlsCsv(m).length).toBeGreaterThan(100);
    }
    expect(originals[0].excluded.map((e) => e.reason)).toEqual(['Out of scope then']);
    expect((await db.select().from(checkResults).where(and(eq(checkResults.scanId, rows[1].id), eq(checkResults.checkId, 'future.check-from-a-newer-catalog'))))).toHaveLength(1);
    expect((await db.select().from(credentials).innerJoin(scanSystems, eq(scanSystems.id, credentials.systemId)).where(inArray(scanSystems.scanId, rows.map((s) => s.id))))).toEqual([]);

    // The organisation page lists the imported scans (trend by creation date) with their import mark.
    const detail = (await req('alice', 'GET', `/api/customers/${id}`)).json();
    expect(detail.scans.filter((s: any) => s.status === 'completed').map((s: any) => [s.score, Boolean(s.importedAt)])).toEqual(rows.map((s) => [s.score, true]).reverse());
    expect(detail.environments.length).toBeGreaterThan(0);
    // Re-importing the same file adds nothing.
    expect((await imported('admin', file)).totals).toMatchObject({ added: 0, skipped: 2 });
  });

  it('compares a new scan with the imported history and allows scanning it again', async () => {
    const prev = (await db.select().from(scans).where(eq(scans.customerId, orgId)).orderBy(scans.finishedAt)).at(-1)!;
    const [n] = await db
      .insert(scans)
      .values({ customerId: orgId, name: 'After import', status: 'completed', context: {}, riskProfile: {}, startedAt: new Date(), finishedAt: new Date() })
      .returning();
    for (const s of await db.select().from(scanSystems).where(eq(scanSystems.scanId, prev.id)).orderBy(scanSystems.createdAt)) {
      const [x] = await db.insert(scanSystems).values({ scanId: n.id, provider: s.provider, label: s.label, environment: s.environment, config: s.config, startedConfig: s.startedConfig, connectionDetails: s.connectionDetails }).returning();
      const rs = await db.select().from(checkResults).where(eq(checkResults.systemId, s.id));
      await db.insert(checkResults).values(rs.map((r) => ({ scanId: n.id, systemId: x.id, checkId: r.checkId, status: r.status, summary: r.summary, resources: r.resources })));
    }
    await storeScanScore(ctx, n.id);
    const m = await buildReport(ctx, n.id);
    expect(m.comparison).toMatchObject({ previousScanId: prev.id, differentScope: false, newFindings: [] });
    expect(m.comparison!.persisting.length).toBeGreaterThan(0);
    const re = await req('alice', 'POST', `/api/scans/${prev.id}/rescan`);
    expect(re.statusCode, re.body).toBe(200);
  });

  it('merges triage: the newer decision wins', async () => {
    const file = await exportOrg('alice', orgId);
    const p = await decryptExport(file, PASS);
    const t = p.organisations[0].triage[0];
    const key = and(eq(findingTriage.customerId, orgId), eq(findingTriage.checkId, t.checkId), eq(findingTriage.systemKey, t.systemKey));
    // Newer here than in the file: kept.
    await db.update(findingTriage).set({ note: 'changed here', updatedAt: new Date(Date.now() + 60_000) }).where(key);
    await imported('alice', file);
    expect((await db.select().from(findingTriage).where(key))[0].note).toBe('changed here');
    // Newer in the file: taken over.
    const newer = { ...p, organisations: [{ ...p.organisations[0], triage: [{ ...t, note: 'from the file', status: 'accepted' as const, updatedAt: new Date(Date.now() + 120_000).toISOString() }] }] };
    await imported('alice', await encryptExport(newer, PASS));
    expect((await db.select().from(findingTriage).where(key))[0]).toMatchObject({ note: 'from the file', status: 'accepted' });
  });

  it('never creates Microsoft tenant bindings and gives AWS role systems a new external ID', async () => {
    const tenant = '0a0b0c0d-1111-4222-8333-777788889999';
    const p = minimal({
      scope: 'organisation',
      organisations: [
        {
          exportId: crypto.randomUUID(),
          name: `Consent Co ${randomToken(3)}`,
          createdAt: new Date().toISOString(),
          ownerEmail: null,
          shares: [],
          triage: [],
          scans: [
            {
              exportId: crypto.randomUUID(),
              name: 'Old scan',
              status: 'completed',
              createdAt: new Date(Date.now() - 86_400_000).toISOString(),
              queuedAt: null,
              startedAt: null,
              finishedAt: new Date().toISOString(),
              score: null,
              grade: null,
              summary: null,
              systems: [
                { exportId: crypto.randomUUID(), provider: 'm365', label: 'M365', environment: null, config: { authMode: 'admin_consent', tenantId: tenant, consentGrantedAt: new Date().toISOString() }, startedConfig: null, connectionOk: true, connectionMessage: null, connectionDetails: null, connectionCheckedAt: null, createdAt: new Date().toISOString() },
                { exportId: crypto.randomUUID(), provider: 'aws', label: 'AWS', environment: 'prod', config: { authMode: 'assume_role', roleArn: 'arn:aws:iam::111122223333:role/QuickScan', externalId: 'qs-chosen-by-the-file' }, startedConfig: null, connectionOk: true, connectionMessage: null, connectionDetails: null, connectionCheckedAt: null, createdAt: new Date(Date.now() + 1).toISOString() },
              ],
              results: [],
              excludedChecks: [],
            },
          ],
        },
      ],
    });
    const file = await encryptExport(p, PASS);
    const notes = (await doImport('alice', file, true)).json().plan.organisations[0].notes.join(' ');
    expect(notes).toMatch(/grant consent again/);
    expect(notes).toMatch(/new external ID/);
    const r = await imported('alice', file);
    const { msTenantBindings } = await import('../src/db/schema.js');
    expect(await db.select().from(msTenantBindings).where(eq(msTenantBindings.tenantId, tenant))).toEqual([]);
    const sid = (await db.select().from(scans).where(eq(scans.customerId, r.organisations[0].id)))[0].id;
    const aws = (await db.select().from(scanSystems).where(and(eq(scanSystems.scanId, sid), eq(scanSystems.provider, 'aws'))))[0];
    expect((aws.config as any).externalId).toMatch(/^qs-/);
    expect((aws.config as any).externalId).not.toBe('qs-chosen-by-the-file');
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'data.import'));
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(PASS);
  });
});
