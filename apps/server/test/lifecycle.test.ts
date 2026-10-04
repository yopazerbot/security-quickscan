/**
 * Scan lifecycle, consent and worker integration tests (needs TEST_DATABASE_URL, see api.test.ts).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppCtx } from '../src/context.js';
import { Envelope, randomToken, sha256 } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { auditLog, checkResults, credentials, customerAssignments, customers, msTenantBindings, scans, scanSystems, sessions, users } from '../src/db/schema.js';
import { withDraftLock } from '../src/routes/helpers.js';
import { finishScan, housekeeping, requeueOwnScans, startWorker } from '../src/worker.js';

const proof = vi.hoisted(() => ({ result: { ok: true } as { ok: boolean; reason?: string } }));
vi.mock('@qs/checks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qs/checks')>()),
  verifyMsConsentSince: vi.fn(async () => proof.result),
}));

const key = () => randomBytes(32).toString('base64');

describe('envelope key rotation', () => {
  it('encrypts with the current key and decrypts with a previous one', () => {
    const oldKey = key();
    const newKey = key();
    const blob = new Envelope(oldKey).encryptJson({ token: 'x' }, 'aad');
    const both = new Envelope([newKey, oldKey]);
    expect(both.decryptJson(blob, 'aad')).toEqual({ token: 'x' });
    const fresh = both.encryptJson({ token: 'y' }, 'aad');
    expect(new Envelope(newKey).decryptJson(fresh, 'aad')).toEqual({ token: 'y' });
    expect(() => new Envelope(oldKey).decrypt(fresh, 'aad')).toThrow();
    expect(() => new Envelope([newKey, undefined]).decrypt(blob, 'aad')).toThrow();
  });
});

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('scan lifecycle', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:8080',
    DATABASE_URL: url ?? 'postgres://skipped@localhost/none',
    MASTER_KEY: key(),
    COOKIE_SECURE: 'false',
    ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: 'x',
    ENTRA_CLIENT_SECRET: 'y',
    SCANNER_MS_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
    SCANNER_MS_CLIENT_SECRET: 'scanner-secret',
    DEMO_MODE: 'true',
    LOG_LEVEL: 'fatal',
  } as any);
  const { db, pool } = createDb(config);
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: AppCtx;
  const S: Record<string, { cookie: string; csrf: string; id: string; email: string }> = {};

  async function login(role: 'admin' | 'consultant' | 'viewer', name: string, isDemo = false) {
    const [u] = await db.insert(users).values({ email: `${name}-${randomToken(4)}@test.local`, name, role, isDemo }).returning();
    const token = randomToken();
    const csrf = randomToken();
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: csrf, authMethod: 'test', expiresAt: new Date(Date.now() + 3600_000) });
    S[name] = { cookie: `qs_session=${token}`, csrf, id: u.id, email: u.email };
  }
  const req = (who: string, method: string, path: string, payload?: unknown) =>
    app.inject({ method: method as any, url: path, payload: payload as any, headers: { cookie: S[who].cookie, 'x-csrf-token': S[who].csrf, origin: 'http://localhost:8080' } });

  const org = async (who = 'alice', name = 'Org') => (await req(who, 'POST', '/api/customers', { name: `${name} ${randomToken(3)}` })).json().id as string;
  const draft = async (cid: string, who = 'alice') => (await req(who, 'POST', `/api/customers/${cid}/scans`, {})).json().id as string;
  const setStatus = (sid: string, status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled', workerId: string | null = null) =>
    db.update(scans).set({ status, workerId, heartbeatAt: new Date() }).where(eq(scans.id, sid));

  beforeAll(async () => {
    await runMigrations(db);
    ({ app, ctx } = await buildApp(config, db));
    await login('admin', 'admin');
    await login('consultant', 'alice');
    await login('consultant', 'bob');
    await login('consultant', 'visitor', true);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('rejects system edits once the scan is no longer a draft', async () => {
    const sid = await draft(await org());
    const sys = (await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'GH', config: { authMode: 'token', org: 'acme' } })).json();
    await setStatus(sid, 'queued');
    const patch = await req('alice', 'PATCH', `/api/scans/${sid}/systems/${sys.id}`, { label: 'GH', config: { authMode: 'token', org: 'evil' } });
    expect(patch.statusCode).toBe(409);
    expect((await req('alice', 'DELETE', `/api/scans/${sid}/systems/${sys.id}`)).statusCode).toBe(409);
    expect((await req('alice', 'PATCH', `/api/scans/${sid}`, { name: 'Renamed' })).statusCode).toBe(409);
  });

  it('serialises draft edits behind the scan lock (Start versus PATCH)', async () => {
    const sid = await draft(await org());
    const sys = (await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'GH', config: { authMode: 'token', org: 'acme' } })).json();
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Simulates Start: holds the lock, then moves the scan out of draft.
    const held = withDraftLock(ctx, sid, async (tx) => {
      locked();
      await new Promise<void>((r) => (release = r));
      await tx.update(scans).set({ status: 'queued' }).where(eq(scans.id, sid));
    });
    await isLocked;
    let settled = false;
    const patch = req('alice', 'PATCH', `/api/scans/${sid}/systems/${sys.id}`, { label: 'GH', config: { authMode: 'token', org: 'evil' } }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await held;
    expect((await patch).statusCode).toBe(409);
    const row = (await db.select().from(scanSystems).where(eq(scanSystems.id, sys.id)))[0];
    expect((row.config as any).org).toBe('acme');
  });

  it('freezes the system config at Start', async () => {
    const sid = await draft(await org());
    await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'Demo', config: { authMode: 'demo' } });
    const r = await req('alice', 'POST', `/api/scans/${sid}/start`);
    expect(r.statusCode).toBe(200);
    const row = (await db.select().from(scanSystems).where(eq(scanSystems.scanId, sid)))[0];
    expect(row.startedConfig).toEqual(row.config);
  });

  it('keeps the connection test on a label-only edit and purges the secret when the target changes', async () => {
    const sid = await draft(await org());
    const sys = (await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'GH', config: { authMode: 'token', org: 'acme' } })).json();
    expect((await req('alice', 'PUT', `/api/scans/${sid}/systems/${sys.id}/credentials`, { secret: { token: `ghp_${'a'.repeat(36)}` } })).statusCode).toBe(200);
    await db.update(scanSystems).set({ connectionOk: true, connectionCheckedAt: new Date() }).where(eq(scanSystems.id, sys.id));
    const label = await req('alice', 'PATCH', `/api/scans/${sid}/systems/${sys.id}`, { label: 'GitHub', config: { authMode: 'token', org: 'acme' } });
    expect(label.json()).toMatchObject({ connectionReset: false, credentialsPurged: false });
    expect((await db.select().from(scanSystems).where(eq(scanSystems.id, sys.id)))[0].connectionOk).toBe(true);
    const target = await req('alice', 'PATCH', `/api/scans/${sid}/systems/${sys.id}`, { label: 'GitHub', config: { authMode: 'token', org: 'other' } });
    expect(target.json()).toMatchObject({ connectionReset: true, credentialsPurged: true });
    expect(await db.select().from(credentials).where(eq(credentials.systemId, sys.id))).toHaveLength(0);
    const entry = (await db.select().from(auditLog).where(and(eq(auditLog.action, 'system.update'), eq(auditLog.targetId, sys.id))))
      .map((a) => a.details as any)
      .find((x) => x.targetBefore);
    expect(entry).toMatchObject({ targetBefore: { org: 'acme' }, targetAfter: { org: 'other' } });
  });

  it('only lets the owner delete a finished scan; edit sharees may discard drafts', async () => {
    const cid = await org();
    await req('alice', 'POST', `/api/customers/${cid}/shares`, { email: S.bob.email, permission: 'edit' });
    const done = await draft(cid);
    await setStatus(done, 'completed');
    expect((await req('bob', 'DELETE', `/api/scans/${done}`)).statusCode).toBe(403);
    expect((await req('alice', 'DELETE', `/api/scans/${done}`)).statusCode).toBe(200);
    const d2 = await draft(cid);
    expect((await req('bob', 'DELETE', `/api/scans/${d2}`)).statusCode).toBe(200);
  });

  it('rescans only finished scans', async () => {
    const cid = await org();
    const sid = await draft(cid);
    await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'Demo', config: { authMode: 'demo' } });
    for (const status of ['queued', 'running'] as const) {
      await setStatus(sid, status);
      expect((await req('alice', 'POST', `/api/scans/${sid}/rescan`)).statusCode).toBe(409);
    }
    await setStatus(sid, 'failed');
    expect((await req('alice', 'POST', `/api/scans/${sid}/rescan`)).statusCode).toBe(200);
  });

  it('accepts only simulated systems in demo organisations, for every user', async () => {
    const cid = await org('admin', 'Demo');
    await db.update(customers).set({ isDemo: true }).where(eq(customers.id, cid));
    const sid = await draft(cid, 'admin');
    const real = await req('admin', 'POST', `/api/scans/${sid}/systems`, { provider: 'aws', label: 'AWS', config: { authMode: 'assume_role', roleArn: 'arn:aws:iam::123456789012:role/x' } });
    expect(real.statusCode).toBe(403);
    const demo = await req('admin', 'POST', `/api/scans/${sid}/systems`, { provider: 'aws', label: 'AWS', config: { authMode: 'demo' } });
    expect(demo.statusCode).toBe(200);
    const patch = await req('admin', 'PATCH', `/api/scans/${sid}/systems/${demo.json().id}`, { label: 'AWS', config: { authMode: 'access_keys' } });
    expect(patch.statusCode).toBe(403);
  });

  it('stops demo visitors from running real systems', async () => {
    const cid = await org();
    await db.insert(customerAssignments).values({ customerId: cid, userId: S.visitor.id, permission: 'edit' });
    const sid = await draft(cid);
    const sys = (await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'GH', config: { authMode: 'token', org: 'acme' } })).json();
    expect((await req('visitor', 'POST', `/api/scans/${sid}/systems/${sys.id}/test`)).statusCode).toBe(403);
    expect((await req('visitor', 'POST', `/api/scans/${sid}/start`)).statusCode).toBe(403);
    await setStatus(sid, 'completed');
    expect((await req('visitor', 'POST', `/api/scans/${sid}/rescan`)).statusCode).toBe(403);
  });

  it('cancels a queued scan with conditional writes and settles its checks', async () => {
    const sid = await draft(await org());
    await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'Demo', config: { authMode: 'demo' } });
    expect((await req('alice', 'POST', `/api/scans/${sid}/start`)).statusCode).toBe(200);
    expect((await req('alice', 'POST', `/api/scans/${sid}/cancel`)).statusCode).toBe(200);
    const scan = (await db.select().from(scans).where(eq(scans.id, sid)))[0];
    expect(scan.status).toBe('cancelled');
    const rows = await db.select().from(checkResults).where(eq(checkResults.scanId, sid));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'na' && /cancelled/.test(r.summary ?? ''))).toBe(true);
    expect(scan.summary).not.toBeNull();
    expect((await req('alice', 'POST', `/api/scans/${sid}/cancel`)).statusCode).toBe(409);
  });

  async function adminConsentSystem(cid: string, tenantId: string) {
    const sid = await draft(cid);
    const sys = (await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'm365', label: 'M365', config: { authMode: 'admin_consent', tenantId } })).json();
    return { sid, sysId: sys.id as string };
  }
  const stateOf = (u: string) => new URL(u).searchParams.get('state')!;

  it('requires proof of a new consent and binds the tenant to one organisation', async () => {
    const tenant = randomUUID();
    const cid = await org();
    const { sid, sysId } = await adminConsentSystem(cid, tenant);
    const link = await req('alice', 'POST', `/api/scans/${sid}/systems/${sysId}/consent-url`);
    expect(link.statusCode).toBe(200);
    const state = stateOf(link.json().url);

    proof.result = { ok: false, reason: 'error' };
    const notYet = await req('alice', 'POST', '/api/consent/complete', { state, tenant, admin_consent: 'True' });
    expect(notYet.statusCode).toBe(400);
    proof.result = { ok: false, reason: 'stale' };
    const stale = await req('alice', 'POST', '/api/consent/complete', { state, tenant, admin_consent: 'True' });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error).toMatch(/earlier consent/);
    expect(await db.select().from(msTenantBindings).where(eq(msTenantBindings.tenantId, tenant))).toHaveLength(0);
    // The stale outcome is final: the link is used up.
    proof.result = { ok: true };
    expect((await req('alice', 'POST', '/api/consent/complete', { state, tenant, admin_consent: 'True' })).statusCode).toBe(400);

    const link2 = await req('alice', 'POST', `/api/scans/${sid}/systems/${sysId}/consent-url`);
    const ok = await req('alice', 'POST', '/api/consent/complete', { state: stateOf(link2.json().url), tenant, admin_consent: 'True' });
    expect(ok.statusCode).toBe(200);
    expect((await db.select().from(msTenantBindings).where(eq(msTenantBindings.tenantId, tenant)))[0].customerId).toBe(cid);

    // Another organisation: the link is issued (nothing revealed), completion is refused and audited.
    const other = await org('bob');
    const b = await (async () => {
      const s = await draft(other, 'bob');
      const sys = (await req('bob', 'POST', `/api/scans/${s}/systems`, { provider: 'm365', label: 'M365', config: { authMode: 'admin_consent', tenantId: tenant } })).json();
      return { sid: s, sysId: sys.id as string };
    })();
    const blink = await req('bob', 'POST', `/api/scans/${b.sid}/systems/${b.sysId}/consent-url`);
    expect(blink.statusCode).toBe(200);
    const conflict = await req('bob', 'POST', '/api/consent/complete', { state: stateOf(blink.json().url), tenant, admin_consent: 'True' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatch(/already linked to another organisation/);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, 'consent.tenant_conflict'), eq(auditLog.targetId, b.sysId)));
    expect(audits.map((a) => (a.details as any).step).sort()).toEqual(['complete', 'link']);

    // A deleted organisation keeps its tenant reserved until an admin releases it.
    expect((await req('alice', 'DELETE', `/api/customers/${cid}`)).statusCode).toBe(200);
    expect((await db.select().from(msTenantBindings).where(eq(msTenantBindings.tenantId, tenant)))[0].customerId).toBeNull();
    const blink2 = await req('bob', 'POST', `/api/scans/${b.sid}/systems/${b.sysId}/consent-url`);
    expect((await req('bob', 'POST', '/api/consent/complete', { state: stateOf(blink2.json().url), tenant, admin_consent: 'True' })).statusCode).toBe(409);

    expect((await req('bob', 'GET', '/api/admin/tenant-bindings')).statusCode).toBe(403);
    const list = (await req('admin', 'GET', '/api/admin/tenant-bindings')).json();
    expect(list.find((x: any) => x.tenantId === tenant)).toMatchObject({ organisation: null, createdBy: S.alice.email });
    expect((await req('bob', 'DELETE', `/api/admin/tenant-bindings/${tenant}`)).statusCode).toBe(403);
    expect((await req('admin', 'DELETE', `/api/admin/tenant-bindings/${tenant}`)).statusCode).toBe(200);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, 'tenant_binding.release'), eq(auditLog.targetId, tenant)))).toHaveLength(1);
    const blink3 = await req('bob', 'POST', `/api/scans/${b.sid}/systems/${b.sysId}/consent-url`);
    expect((await req('bob', 'POST', '/api/consent/complete', { state: stateOf(blink3.json().url), tenant, admin_consent: 'True' })).statusCode).toBe(200);
  });

  it('skips the final write when the scan was taken over, and re-queues on shutdown', async () => {
    const sid = await draft(await org());
    await setStatus(sid, 'failed', 'other-worker');
    expect(await finishScan(ctx, sid, 'completed', { workerId: 'other-worker' })).toBe(false);
    expect((await db.select().from(scans).where(eq(scans.id, sid)))[0].status).toBe('failed');

    await setStatus(sid, 'running', 'w-test');
    expect(await finishScan(ctx, sid, 'completed', { workerId: 'another' })).toBe(false);
    expect(await finishScan(ctx, sid, 'completed', { workerId: 'w-test' })).toBe(true);
    expect((await db.select().from(scans).where(eq(scans.id, sid)))[0].status).toBe('completed');

    const sid2 = await draft(await org());
    const [sys] = await db.insert(scanSystems).values({ scanId: sid2, provider: 'github', label: 'x', config: { authMode: 'demo' } }).returning();
    await db.insert(checkResults).values([
      { scanId: sid2, systemId: sys.id, checkId: 'github.a', status: 'running' },
      { scanId: sid2, systemId: sys.id, checkId: 'github.b', status: 'pass', summary: 'ok' },
    ]);
    await setStatus(sid2, 'running', 'w-shutdown');
    expect(await requeueOwnScans(ctx, 'w-shutdown')).toBe(1);
    expect((await db.select().from(scans).where(eq(scans.id, sid2)))[0]).toMatchObject({ status: 'queued', workerId: null });
    const rows = await db.select().from(checkResults).where(eq(checkResults.scanId, sid2));
    expect(rows.find((r) => r.checkId === 'github.a')?.status).toBe('pending');
    expect(rows.find((r) => r.checkId === 'github.b')?.status).toBe('pass');
    await db.delete(scans).where(eq(scans.id, sid2));
  });

  it('housekeeping removes abandoned empty drafts', async () => {
    const cid = await org();
    const empty = await draft(cid);
    const withSystem = await draft(cid);
    await req('alice', 'POST', `/api/scans/${withSystem}/systems`, { provider: 'github', label: 'Demo', config: { authMode: 'demo' } });
    const old = new Date(Date.now() - 25 * 3600_000);
    await db.update(scans).set({ createdAt: old }).where(eq(scans.customerId, cid));
    await housekeeping(ctx);
    const left = (await db.select({ id: scans.id }).from(scans).where(eq(scans.customerId, cid))).map((r) => r.id);
    expect(left).toEqual([withSystem]);
  });

  it('worker refuses an admin-consent tenant that is not bound to the organisation', async () => {
    const cid = await org();
    const [scan] = await db
      .insert(scans)
      .values({ customerId: cid, name: 'w', context: {}, riskProfile: {}, status: 'queued', queuedAt: new Date(), retentionMode: 'manual' })
      .returning();
    const cfg = { authMode: 'admin_consent', tenantId: randomUUID(), consentGrantedAt: new Date().toISOString() };
    const [sys] = await db.insert(scanSystems).values({ scanId: scan.id, provider: 'm365', label: 'M365', config: cfg, startedConfig: cfg }).returning();
    await db.insert(checkResults).values({ scanId: scan.id, systemId: sys.id, checkId: 'm365.user-consent' });
    const stop = startWorker(ctx);
    try {
      for (let i = 0; i < 100; i++) {
        const s = (await db.select({ status: scans.status }).from(scans).where(eq(scans.id, scan.id)))[0];
        if (s.status !== 'queued' && s.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      await stop(2000);
    }
    expect((await db.select().from(scans).where(eq(scans.id, scan.id)))[0].status).toBe('completed');
    const [r] = await db.select().from(checkResults).where(eq(checkResults.scanId, scan.id));
    expect(r.status).toBe('error');
    expect(r.summary).toMatch(/not linked to this organisation/);
  });

  it('worker turns an undecryptable secret into a system error and keeps the credential', async () => {
    const cid = await org();
    const [scan] = await db
      .insert(scans)
      .values({ customerId: cid, name: 'k', context: {}, riskProfile: {}, status: 'queued', queuedAt: new Date(), retentionMode: 'purge_on_completion' })
      .returning();
    const cfg = { authMode: 'token', org: 'acme' };
    const [sys] = await db.insert(scanSystems).values({ scanId: scan.id, provider: 'github', label: 'GH', config: cfg, startedConfig: cfg }).returning();
    const blob = new Envelope(key()).encryptJson({ token: 'x' }, `cred:${scan.id}:${sys.id}`);
    await db.insert(credentials).values({ systemId: sys.id, blob, hint: 'classic token' });
    await db.insert(checkResults).values({ scanId: scan.id, systemId: sys.id, checkId: 'github.2fa-required' });
    const stop = startWorker(ctx);
    try {
      for (let i = 0; i < 100; i++) {
        const s = (await db.select({ status: scans.status }).from(scans).where(eq(scans.id, scan.id)))[0];
        if (s.status !== 'queued' && s.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      await stop(2000);
    }
    const [r] = await db.select().from(checkResults).where(eq(checkResults.scanId, scan.id));
    expect(r.status).toBe('error');
    expect(r.summary).toMatch(/could not be decrypted/);
    expect(await db.select().from(credentials).where(eq(credentials.systemId, sys.id))).toHaveLength(1);
  });
});
