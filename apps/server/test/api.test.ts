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
import { customerAssignments, sessions, users } from '../src/db/schema.js';
import { DEFAULT_CONTEXT } from '@qs/shared';

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
  const S: Record<string, { cookie: string; csrf: string; id: string }> = {};

  async function login(role: 'admin' | 'consultant' | 'viewer', name: string) {
    const [u] = await db.insert(users).values({ email: `${name}-${randomToken(4)}@test.local`, name, role }).returning();
    const token = randomToken();
    const csrf = randomToken();
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: csrf, authMethod: 'test', expiresAt: new Date(Date.now() + 3600_000) });
    S[name] = { cookie: `qs_session=${token}`, csrf, id: u.id };
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
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const customer = (name: string) => ({ name, context: DEFAULT_CONTEXT });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/customers' })).statusCode).toBe(401);
  });

  it('isolates customers between consultants', async () => {
    const created = await req('alice', 'POST', '/api/customers', customer('Alice Corp'));
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect((await req('alice', 'GET', `/api/customers/${id}`)).statusCode).toBe(200);
    expect((await req('bob', 'GET', `/api/customers/${id}`)).statusCode).toBe(404);
    expect((await req('bob', 'GET', '/api/customers')).json().some((c: any) => c.id === id)).toBe(false);
    expect((await req('bob', 'POST', `/api/customers/${id}/scans`, {})).statusCode).toBe(404);
    expect((await req('admin', 'GET', `/api/customers/${id}`)).statusCode).toBe(200);
  });

  it('keeps viewers read-only', async () => {
    const id = (await req('alice', 'POST', '/api/customers', customer('Shared Corp'))).json().id;
    await db.insert(customerAssignments).values({ userId: S.victor.id, customerId: id });
    expect((await req('victor', 'GET', `/api/customers/${id}`)).statusCode).toBe(200);
    expect((await req('victor', 'POST', `/api/customers/${id}/scans`, {})).statusCode).toBe(403);
    expect((await req('victor', 'POST', '/api/customers', customer('Nope'))).statusCode).toBe(403);
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

  it('refuses to start without authorisation and a tested connection', async () => {
    const cid = (await req('alice', 'POST', '/api/customers', customer('Start Corp'))).json().id;
    const sid = (await req('alice', 'POST', `/api/customers/${cid}/scans`, {})).json().id;
    await req('alice', 'POST', `/api/scans/${sid}/systems`, { provider: 'github', label: 'GH', config: { authMode: 'token', org: 'acme' } });
    const r = await req('alice', 'POST', `/api/scans/${sid}/start`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/authorisation/i);
  });

  it('makes the audit log append-only', async () => {
    await expect(pool.query('delete from audit_log')).rejects.toThrow(/append-only/);
  });
});
