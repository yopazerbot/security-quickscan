/**
 * Users, offboarding, sharing, audit and triage. Needs TEST_DATABASE_URL (see api.test.ts).
 */
import { CHECKS } from '@qs/shared';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { clientKey, takeAttempt } from '../src/auth/routes.js';
import { loadConfig } from '../src/config.js';
import { randomToken, sha256 } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { customerAssignments, customers, loginAttempts, sessions, users } from '../src/db/schema.js';

describe('rate-limit keys', () => {
  it('groups IPv6 clients by /64 and keeps IPv4 as is', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });
});

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('users, sharing and audit', () => {
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
  let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  type Who = { cookie: string; csrf: string; id: string; email: string };
  const S: Record<string, Who> = {};

  async function addUser(name: string, role: 'admin' | 'consultant' | 'viewer', extra: Partial<typeof users.$inferInsert> = {}) {
    const [u] = await db.insert(users).values({ email: `${name}-${randomToken(4)}@test.local`, name, role, ...extra }).returning();
    return u;
  }
  async function login(name: string, role: 'admin' | 'consultant' | 'viewer', extra: Partial<typeof users.$inferInsert> = {}) {
    const u = await addUser(name, role, extra);
    await newSession(name, u);
    return u;
  }
  async function newSession(name: string, u: { id: string; email: string }) {
    const token = randomToken();
    const csrf = randomToken();
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: csrf, authMethod: 'test', expiresAt: new Date(Date.now() + 3600_000) });
    S[name] = { cookie: `qs_session=${token}`, csrf, id: u.id, email: u.email };
  }
  const req = (who: string, method: string, path: string, payload?: unknown) =>
    app.inject({ method: method as any, url: path, payload: payload as any, headers: { cookie: S[who].cookie, 'x-csrf-token': S[who].csrf, origin: 'http://localhost:8080' } });
  const sessionCount = async (id: string) => (await db.select().from(sessions).where(eq(sessions.userId, id))).length;
  const ownerOf = async (id: string) => (await db.select({ o: customers.ownerId }).from(customers).where(eq(customers.id, id)))[0].o;
  const shareOf = async (cid: string, uid: string) =>
    (await db.select().from(customerAssignments).where(sql`${customerAssignments.customerId} = ${cid} and ${customerAssignments.userId} = ${uid}`))[0]?.permission ?? null;
  const org = async (who: string, name: string) => (await req(who, 'POST', '/api/customers', { name })).json().id as string;

  beforeAll(async () => {
    await runMigrations(db);
    ({ app, ctx } = await buildApp(config, db));
    await login('admin', 'admin');
    await login('alice', 'consultant');
    await login('bob', 'consultant');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('returns the idle window from /api/auth/me', async () => {
    const me = (await req('alice', 'GET', '/api/auth/me')).json();
    expect(me.idleMinutes).toBe(30);
    expect(me.sessionExpiresAt).toBeTruthy();
  });

  it('keeps sessions on a name-only edit and audits only changed fields', async () => {
    const u = await login('nina', 'consultant');
    const r = await req('admin', 'PATCH', `/api/users/${u.id}`, { name: 'Nina Renamed', role: 'consultant', active: true });
    expect(r.statusCode).toBe(200);
    expect(await sessionCount(u.id)).toBe(1);
    const log = (await req('admin', 'GET', `/api/audit?action=user.update&userId=${u.id}`)).json();
    expect(log[0].details.changes).toEqual({ name: { from: 'nina', to: 'Nina Renamed' } });
    expect(log[0].targetName).toBe('Nina Renamed');
    expect(log[0].targetEmail).toBe(u.email);
    // Promotion keeps the session, a downgrade signs the user out.
    expect((await req('admin', 'PATCH', `/api/users/${u.id}`, { role: 'admin' })).statusCode).toBe(200);
    expect(await sessionCount(u.id)).toBe(1);
    expect((await req('admin', 'PATCH', `/api/users/${u.id}`, { role: 'consultant' })).statusCode).toBe(200);
    expect(await sessionCount(u.id)).toBe(0);
  });

  it('does not reactivate a user when active is omitted', async () => {
    const u = await addUser('olga', 'consultant', { active: false });
    expect((await req('admin', 'PATCH', `/api/users/${u.id}`, { name: 'Olga B' })).statusCode).toBe(200);
    const row = (await db.select().from(users).where(eq(users.id, u.id)))[0];
    expect(row.active).toBe(false);
    expect(row.name).toBe('Olga B');
  });

  it('requires a new owner to delete a user who owns organisations', async () => {
    const dave = await login('dave', 'consultant');
    const id = await org('dave', 'Dave Corp');
    const r = await req('admin', 'DELETE', `/api/users/${dave.id}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().ownedOrganisations).toEqual([{ id, name: 'Dave Corp' }]);
    expect((await req('admin', 'GET', '/api/users')).json().find((x: any) => x.id === dave.id).ownedCount).toBe(1);
    // Not a valid owner: the user themself, a viewer.
    expect((await req('admin', 'DELETE', `/api/users/${dave.id}`, { newOwnerId: dave.id })).statusCode).toBe(400);
    const vic = await addUser('vic', 'viewer');
    expect((await req('admin', 'DELETE', `/api/users/${dave.id}`, { newOwnerId: vic.id })).statusCode).toBe(400);
    // Bob already had a share: it is replaced by ownership.
    await req('dave', 'POST', `/api/customers/${id}/shares`, { email: S.bob.email, permission: 'view' });
    const ok = await req('admin', 'DELETE', `/api/users/${dave.id}`, { newOwnerId: S.bob.id });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reassigned).toBe(1);
    expect(await ownerOf(id)).toBe(S.bob.id);
    expect(await shareOf(id, S.bob.id)).toBeNull();
    const log = (await req('admin', 'GET', `/api/audit?organisationId=${id}&action=customer.owner_change`)).json();
    expect(log[0].details).toMatchObject({ name: 'Dave Corp', from: dave.id, to: S.bob.id, toEmail: S.bob.email, reason: 'user.delete' });
    expect(log[0].targetName).toBe('Dave Corp');
  });

  it('requires a new owner to deactivate or demote an owner', async () => {
    const erin = await login('erin', 'consultant');
    const id = await org('erin', 'Erin Corp');
    const deact = await req('admin', 'PATCH', `/api/users/${erin.id}`, { active: false });
    expect(deact.statusCode).toBe(409);
    expect(deact.json().ownedOrganisations).toHaveLength(1);
    expect((await db.select().from(users).where(eq(users.id, erin.id)))[0].active).toBe(true);
    expect((await req('admin', 'PATCH', `/api/users/${erin.id}`, { active: false, newOwnerId: S.alice.id })).statusCode).toBe(200);
    expect(await ownerOf(id)).toBe(S.alice.id);
    expect(await shareOf(id, erin.id)).toBeNull();
    expect(await sessionCount(erin.id)).toBe(0);

    const finn = await login('finn', 'consultant');
    const id2 = await org('finn', 'Finn Corp');
    expect((await req('admin', 'PATCH', `/api/users/${finn.id}`, { role: 'viewer' })).statusCode).toBe(409);
    expect((await req('admin', 'PATCH', `/api/users/${finn.id}`, { role: 'viewer', newOwnerId: S.alice.id })).statusCode).toBe(200);
    expect(await ownerOf(id2)).toBe(S.alice.id);
    // A demoted owner keeps read access.
    expect(await shareOf(id2, finn.id)).toBe('view');
    // Renaming does not need a new owner.
    expect((await req('admin', 'PATCH', `/api/users/${S.alice.id}`, { name: 'alice' })).statusCode).toBe(200);
  });

  it('lets admins assign any eligible owner directly; owners still need a share', async () => {
    const id = await org('alice', 'Direct Corp');
    expect((await req('alice', 'PUT', `/api/customers/${id}/owner`, { userId: S.bob.id })).statusCode).toBe(400);
    expect((await req('admin', 'PUT', `/api/customers/${id}/owner`, { userId: S.bob.id })).statusCode).toBe(200);
    expect(await ownerOf(id)).toBe(S.bob.id);
    expect(await shareOf(id, S.alice.id)).toBe('edit');
    const demo = await addUser('visitor-x', 'consultant', { isDemo: true });
    const bg = await addUser('bg-x', 'admin', { isBreakglass: true });
    const gone = await addUser('gone', 'consultant', { active: false });
    expect((await req('admin', 'PUT', `/api/customers/${id}/owner`, { userId: demo.id })).statusCode).toBe(400);
    expect((await req('admin', 'PUT', `/api/customers/${id}/owner`, { userId: bg.id })).statusCode).toBe(400);
    const inactive = await req('admin', 'PUT', `/api/customers/${id}/owner`, { userId: gone.id });
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json().error).toBe('This account is deactivated');
    const log = (await req('admin', 'GET', `/api/audit?organisationId=${id}&action=customer.owner_change`)).json();
    expect(log[0].details).toMatchObject({ name: 'Direct Corp', from: S.alice.id, fromEmail: S.alice.email, to: S.bob.id, toEmail: S.bob.email });
  });

  it('stores view for viewer shares and lists active and role', async () => {
    const vera = await addUser('vera', 'viewer');
    const id = await org('alice', 'Viewer Share Corp');
    const r = await req('alice', 'POST', `/api/customers/${id}/shares`, { email: vera.email, permission: 'edit' });
    expect(r.statusCode).toBe(200);
    expect(r.json().permission).toBe('view');
    expect(await shareOf(id, vera.id)).toBe('view');
    expect((await req('alice', 'PATCH', `/api/customers/${id}/shares/${vera.id}`, { permission: 'edit' })).json().permission).toBe('view');
    expect(await shareOf(id, vera.id)).toBe('view');
    await db.update(users).set({ active: false }).where(eq(users.id, vera.id));
    const shares = (await req('alice', 'GET', `/api/customers/${id}`)).json().shares;
    expect(shares).toEqual([expect.objectContaining({ userId: vera.id, role: 'viewer', active: false, permission: 'view' })]);
    const missing = await req('alice', 'POST', `/api/customers/${id}/shares`, { email: 'nobody-here@test.local', permission: 'view' });
    expect(missing.json().error).toBe('No account with this email. Ask an administrator to add them under Users.');
    const log = (await req('admin', 'GET', `/api/audit?organisationId=${id}&action=customer.share`)).json();
    expect(log.find((x: any) => x.action === 'customer.share').details).toMatchObject({ name: 'Viewer Share Corp', targetEmail: vera.email, permission: 'view' });
  });

  it('keeps demo visitor organisations ownerless and blocks leave and transfer', async () => {
    await login('visitor', 'consultant', { isDemo: true });
    const id = await org('visitor', 'Visitor Corp');
    expect(await ownerOf(id)).toBeNull();
    expect(await shareOf(id, S.visitor.id)).toBe('edit');
    const got = (await req('visitor', 'GET', `/api/customers/${id}`)).json();
    expect(got.myAccess).toBe('edit');
    expect(got.shares).toEqual([]);
    expect((await req('visitor', 'DELETE', `/api/customers/${id}/shares/${S.visitor.id}`)).statusCode).toBe(403);
    expect((await req('visitor', 'PUT', `/api/customers/${id}/owner`, { userId: S.alice.id })).statusCode).toBe(403);
    expect(await shareOf(id, S.visitor.id)).toBe('edit');
  });

  it('filters the audit log by organisation and user', async () => {
    const id = await org('alice', 'Audit Corp');
    await req('alice', 'POST', `/api/customers/${id}/shares`, { email: S.bob.email, permission: 'edit' });
    const byOrg = (await req('admin', 'GET', `/api/audit?organisationId=${id}`)).json();
    expect(byOrg.map((x: any) => x.action).sort()).toEqual(['customer.create', 'customer.share']);
    expect(byOrg.every((x: any) => x.targetName === 'Audit Corp')).toBe(true);
    const share = byOrg.find((x: any) => x.action === 'customer.share');
    expect(share.actorEmail).toBe(S.alice.email);
    expect(share.targetEmail).toBe(S.bob.email);
    const byUser = (await req('admin', 'GET', `/api/audit?userId=${S.bob.id}&action=customer.share`)).json();
    expect(byUser.some((x: any) => x.targetId === id)).toBe(true);
    expect((await req('admin', 'GET', '/api/audit?organisationId=nope')).statusCode).toBe(400);
  });

  it('stores triage per system and rejects unknown system keys', async () => {
    const id = await org('alice', 'Triage Corp');
    const sid = (await req('alice', 'POST', `/api/customers/${id}/scans`, {})).json().id;
    const sys = await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'GH', config: { authMode: 'token', org: 'Acme' } });
    expect(sys.statusCode).toBe(200);
    const check = CHECKS.find((c) => c.provider === 'github')!.id;
    const put = (systemKey: string) => req('alice', 'PUT', `/api/customers/${id}/triage/${check}`, { systemKey, status: 'accepted', note: 'ok' });
    expect((await put('github:other')).statusCode).toBe(400);
    expect((await put('*')).statusCode).toBe(400);
    expect((await req('alice', 'PUT', `/api/customers/${id}/triage/${check}`, { status: 'accepted' })).statusCode).toBe(400);
    expect((await put('github:acme')).statusCode).toBe(200);
    expect((await put('github:acme')).statusCode).toBe(200);
    const triage = (await req('alice', 'GET', `/api/customers/${id}`)).json().triage;
    expect(triage).toEqual([expect.objectContaining({ checkId: check, systemKey: 'github:acme', status: 'accepted' })]);
  });

  it('uses a fixed lockout window that blocked attempts do not extend', async () => {
    const key = `test:${randomToken(6)}`;
    for (let i = 0; i < 5; i++) expect(await takeAttempt(ctx, key)).toBe(true);
    const start = (await db.select().from(loginAttempts).where(eq(loginAttempts.key, key)))[0].updatedAt;
    expect(await takeAttempt(ctx, key)).toBe(false);
    expect((await db.select().from(loginAttempts).where(eq(loginAttempts.key, key)))[0].updatedAt).toEqual(start);
    // Window started 16 minutes ago: the next attempt opens a new window.
    await db.update(loginAttempts).set({ updatedAt: new Date(Date.now() - 16 * 60_000) }).where(eq(loginAttempts.key, key));
    expect(await takeAttempt(ctx, key)).toBe(true);
    expect((await db.select().from(loginAttempts).where(eq(loginAttempts.key, key)))[0].failures).toBe(1);
  });
});
