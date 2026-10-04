/**
 * Integration tests against a real Postgres. Set TEST_DATABASE_URL to an empty database, e.g.
 * TEST_DATABASE_URL=postgres://postgres@localhost:5432/quickscan_test npm test
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { randomToken, sha256 } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { checkResults, scanCriteria, sessions, users } from '../src/db/schema.js';
import { CHECKS } from '@qs/shared';
import { eq } from 'drizzle-orm';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('API authorisation', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:8080',
    DATABASE_URL: url ?? 'postgres://skipped@localhost/none',
    MASTER_KEY: randomBytes(32).toString('base64'),
    COOKIE_SECURE: 'false',
    ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: 'x',
    ENTRA_CLIENT_SECRET: 'y',
    DEMO_MODE: 'true',
    LOG_LEVEL: 'fatal',
  } as any);
  const { db, pool } = createDb(config);
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  const S: Record<string, { cookie: string; csrf: string; id: string; email: string }> = {};

  async function login(role: 'admin' | 'consultant' | 'viewer', name: string) {
    const [u] = await db.insert(users).values({ email: `${name}-${randomToken(4)}@test.local`, name, role }).returning();
    const token = randomToken();
    const csrf = randomToken();
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: csrf, authMethod: 'test', expiresAt: new Date(Date.now() + 3600_000) });
    S[name] = { cookie: `qs_session=${token}`, csrf, id: u.id, email: u.email };
  }
  const req = (who: string, method: string, path: string, payload?: unknown, extra: Record<string, string> = {}) =>
    app.inject({ method: method as any, url: path, payload: payload as any, headers: { cookie: S[who].cookie, 'x-csrf-token': S[who].csrf, origin: 'http://localhost:8080', ...extra } });

  beforeAll(async () => {
    await runMigrations(db);
    ({ app } = await buildApp(config, db));
    await login('admin', 'admin');
    await login('consultant', 'alice');
    await login('consultant', 'bob');
    await login('viewer', 'victor');
    await login('consultant', 'carol');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const customer = (name: string) => ({ name });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/customers' })).statusCode).toBe(401);
  });

  it('isolates organisations: only the owner and admins see them by default', async () => {
    const created = await req('alice', 'POST', '/api/customers', customer('Alice Corp'));
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    const mine = await req('alice', 'GET', `/api/customers/${id}`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().myAccess).toBe('owner');
    expect((await req('bob', 'GET', `/api/customers/${id}`)).statusCode).toBe(404);
    expect((await req('bob', 'GET', '/api/customers')).json().some((c: any) => c.id === id)).toBe(false);
    expect((await req('bob', 'POST', `/api/customers/${id}/scans`, {})).statusCode).toBe(404);
    const sid = (await req('alice', 'POST', `/api/customers/${id}/scans`, {})).json().id;
    expect((await req('bob', 'GET', `/api/scans/${sid}`)).statusCode).toBe(404);
    expect((await req('bob', 'GET', '/api/scans')).json().some((s: any) => s.id === sid)).toBe(false);
    const admin = await req('admin', 'GET', `/api/customers/${id}`);
    expect(admin.statusCode).toBe(200);
    expect(admin.json().myAccess).toBe('admin');
  });

  it('shares an organisation with view or edit access, and revokes it', async () => {
    const id = (await req('alice', 'POST', '/api/customers', customer('Share Corp'))).json().id;
    const share = (who: string, permission: string, email = S[who].email) => req('alice', 'POST', `/api/customers/${id}/shares`, { email: email.toUpperCase(), permission });
    expect((await share('bob', 'view')).statusCode).toBe(200);
    const asBob = await req('bob', 'GET', `/api/customers/${id}`);
    expect(asBob.statusCode).toBe(200);
    expect(asBob.json().myAccess).toBe('view');
    expect(asBob.json().shares).toEqual([]);
    expect(asBob.json().owner.email).toBe('');
    expect((await req('bob', 'GET', '/api/customers')).json().find((c: any) => c.id === id)).toMatchObject({ owned: false, ownerName: 'alice' });
    expect((await req('bob', 'POST', `/api/customers/${id}/scans`, {})).statusCode).toBe(403);
    expect((await req('bob', 'PUT', `/api/customers/${id}`, customer('Renamed'))).statusCode).toBe(403);
    // Only the owner (or an admin) manages access.
    expect((await req('bob', 'POST', `/api/customers/${id}/shares`, { email: S.carol.email, permission: 'view' })).statusCode).toBe(403);
    expect((await req('bob', 'DELETE', `/api/customers/${id}`)).statusCode).toBe(403);

    expect((await req('alice', 'PATCH', `/api/customers/${id}/shares/${S.bob.id}`, { permission: 'edit' })).statusCode).toBe(200);
    expect((await req('bob', 'POST', `/api/customers/${id}/scans`, {})).statusCode).toBe(200);
    expect((await req('alice', 'GET', `/api/customers/${id}`)).json().shares.map((x: any) => [x.userId, x.permission])).toEqual([[S.bob.id, 'edit']]);

    expect((await req('alice', 'DELETE', `/api/customers/${id}/shares/${S.bob.id}`)).statusCode).toBe(200);
    expect((await req('bob', 'GET', `/api/customers/${id}`)).statusCode).toBe(404);
    expect((await req('admin', 'GET', `/api/customers/${id}`)).statusCode).toBe(200);
  });

  it('only shares with existing active accounts', async () => {
    const id = (await req('alice', 'POST', '/api/customers', customer('Lookup Corp'))).json().id;
    const r = await req('alice', 'POST', `/api/customers/${id}/shares`, { email: 'nobody@test.local', permission: 'view' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatch(/no account with this email/i);
    expect((await req('alice', 'POST', `/api/customers/${id}/shares`, { email: S.alice.email, permission: 'view' })).statusCode).toBe(400);
  });

  it('keeps viewer accounts read-only, even when shared with edit', async () => {
    const id = (await req('alice', 'POST', '/api/customers', customer('Viewer Corp'))).json().id;
    expect((await req('alice', 'POST', `/api/customers/${id}/shares`, { email: S.victor.email, permission: 'edit' })).statusCode).toBe(200);
    const v = await req('victor', 'GET', `/api/customers/${id}`);
    expect(v.statusCode).toBe(200);
    expect(v.json().myAccess).toBe('view');
    expect((await req('victor', 'POST', `/api/customers/${id}/scans`, {})).statusCode).toBe(403);
    expect((await req('victor', 'POST', '/api/customers', customer('Nope'))).statusCode).toBe(403);
    // A read-only account cannot become owner.
    expect((await req('alice', 'PUT', `/api/customers/${id}/owner`, { userId: S.victor.id })).statusCode).toBe(400);
  });

  it('lets a user leave a shared organisation', async () => {
    const id = (await req('alice', 'POST', '/api/customers', customer('Leave Corp'))).json().id;
    await req('alice', 'POST', `/api/customers/${id}/shares`, { email: S.carol.email, permission: 'view' });
    expect((await req('carol', 'DELETE', `/api/customers/${id}/shares/${S.carol.id}`)).statusCode).toBe(200);
    expect((await req('carol', 'GET', `/api/customers/${id}`)).statusCode).toBe(404);
  });

  it('transfers ownership to someone with access', async () => {
    const id = (await req('alice', 'POST', '/api/customers', customer('Transfer Corp'))).json().id;
    expect((await req('alice', 'PUT', `/api/customers/${id}/owner`, { userId: S.carol.id })).statusCode).toBe(400);
    await req('alice', 'POST', `/api/customers/${id}/shares`, { email: S.carol.email, permission: 'view' });
    expect((await req('alice', 'PUT', `/api/customers/${id}/owner`, { userId: S.carol.id })).statusCode).toBe(200);
    expect((await req('carol', 'GET', `/api/customers/${id}`)).json().myAccess).toBe('owner');
    expect((await req('alice', 'GET', `/api/customers/${id}`)).json().myAccess).toBe('edit');
    expect((await req('alice', 'POST', `/api/customers/${id}/shares`, { email: S.bob.email, permission: 'view' })).statusCode).toBe(403);
  });

  it('restricts admin endpoints', async () => {
    expect((await req('alice', 'GET', '/api/users')).statusCode).toBe(403);
    expect((await req('alice', 'GET', '/api/audit')).statusCode).toBe(403);
    expect((await req('admin', 'GET', '/api/users')).statusCode).toBe(200);
  });

  it('rejects missing CSRF tokens and cross-origin requests', async () => {
    expect((await req('alice', 'POST', '/api/customers', customer('X'), { 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    expect((await req('alice', 'POST', '/api/customers', customer('X'), { origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('never returns stored secrets', async () => {
    const cid = (await req('alice', 'POST', '/api/customers', customer('Secret Corp'))).json().id;
    const sid = (await req('alice', 'POST', `/api/customers/${cid}/scans`, {})).json().id;
    const sys = (await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'GH', config: { authMode: 'token', org: 'acme' } })).json();
    const token = `github_pat_${'A'.repeat(40)}`;
    expect((await req('alice', 'PUT', `/api/scans/${sid}/systems/${sys.id}/credentials`, { secret: { token } })).statusCode).toBe(200);
    const body = (await req('alice', 'GET', `/api/scans/${sid}`)).body;
    expect(body).not.toContain(token);
    expect(body).toContain('fine-grained token');
    const audit = (await req('admin', 'GET', '/api/audit')).body;
    expect(audit).not.toContain(token);
  });

  it('refuses to start without credentials', async () => {
    const cid = (await req('alice', 'POST', '/api/customers', customer('Start Corp'))).json().id;
    const sid = (await req('alice', 'POST', `/api/customers/${cid}/scans`, {})).json().id;
    await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'GH', config: { authMode: 'token', org: 'acme' } });
    const r = await req('alice', 'POST', `/api/scans/${sid}/start`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/credentials/i);
  });

  it('stores an organisation as a name only and ignores fields older clients still send', async () => {
    const created = await req('alice', 'POST', '/api/customers', { name: 'Name Only', contactName: 'Old form', context: { industry: 'finance' } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: 'Name Only', contactName: '', context: {} });
    expect((await req('alice', 'POST', '/api/customers', { name: ' ' })).statusCode).toBe(400);
    const id = created.json().id;
    const renamed = await req('alice', 'PUT', `/api/customers/${id}`, { name: 'Renamed Org', context: { industry: 'finance' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Renamed Org', context: {} });
  });

  it('runs every check for the providers in scope, ignoring criteria stored by older drafts', async () => {
    const cid = (await req('alice', 'POST', '/api/customers', customer('All Checks Corp'))).json().id;
    const sid = (await req('alice', 'POST', `/api/customers/${cid}/scans`, {})).json().id;
    const scan = (await req('alice', 'GET', `/api/scans/${sid}`)).json();
    expect(scan.context).toEqual({});
    expect(scan.riskProfile).toEqual({});
    // The criteria API is gone; exclusions are made afterwards via triage.
    expect((await req('alice', 'GET', `/api/scans/${sid}/criteria`)).statusCode).toBe(404);
    expect((await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'Demo', config: { authMode: 'demo' } })).statusCode).toBe(200);
    // An exclusion left behind by the former criteria step no longer applies.
    await db.insert(scanCriteria).values({ scanId: sid, checkId: 'gh.org-2fa', included: false, reason: 'old draft' });
    expect((await req('alice', 'POST', `/api/scans/${sid}/start`)).statusCode).toBe(200);
    const ran = (await db.select({ checkId: checkResults.checkId }).from(checkResults).where(eq(checkResults.scanId, sid))).map((r) => r.checkId).sort();
    expect(ran).toEqual(CHECKS.filter((c) => c.provider === 'github').map((c) => c.id).sort());
    expect(await db.select().from(scanCriteria).where(eq(scanCriteria.scanId, sid))).toEqual([]);
    // The organisation's scan list shows the platforms of each scan.
    const detail = (await req('alice', 'GET', `/api/customers/${cid}`)).json();
    expect(detail.scans.find((x: { id: string }) => x.id === sid).providers).toEqual(['github']);
  });

  it('makes the audit log append-only', async () => {
    await expect(pool.query('delete from audit_log')).rejects.toThrow(/append-only/);
  });
});
