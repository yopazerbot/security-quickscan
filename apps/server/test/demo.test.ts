import { demoOutcomeSync, DEMO_SCENARIO_IDS } from '@qs/checks';
import { CHECKS } from '@qs/shared';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Envelope } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { resetDemo, seedDemo } from '../src/demo/seed.js';
import { customers, scans, settings } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

describe('demo generator', () => {
  it('has a scenario for every check', () => {
    for (const c of CHECKS) expect(DEMO_SCENARIO_IDS, c.id).toContain(c.id);
  });
  it('is deterministic and a more mature scan passes a superset', () => {
    for (const c of CHECKS) {
      expect(demoOutcomeSync(c.id, 0.4)).toEqual(demoOutcomeSync(c.id, 0.4));
      if (demoOutcomeSync(c.id, 0.3).status === 'pass') expect(demoOutcomeSync(c.id, 0.7).status).toBe('pass');
    }
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('demo seeding and PIN login', () => {
  const config = loadConfig({
    NODE_ENV: 'test', APP_URL: 'http://localhost:8080', DATABASE_URL: url ?? 'postgres://skipped@localhost/none',
    MASTER_KEY: randomBytes(32).toString('base64'), COOKIE_SECURE: 'false', ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: 'x', ENTRA_CLIENT_SECRET: 'y', DEMO_MODE: 'true', LOG_LEVEL: 'fatal',
  } as any);
  const { db, pool } = createDb(config);
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];

  beforeAll(async () => {
    await runMigrations(db);
    ({ app, ctx } = await buildApp(config, db));
    await db.delete(customers).where(eq(customers.isDemo, true));
    await db.delete(settings).where(eq(settings.key, 'demo_login'));
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('seeds once, with an improving trend', async () => {
    expect(await seedDemo(ctx)).toBe(true);
    expect(await seedDemo(ctx)).toBe(false);
    const demo = await db.select().from(customers).where(eq(customers.isDemo, true));
    expect(demo).toHaveLength(1);
    const s = await db.select().from(scans).where(eq(scans.customerId, demo[0].id));
    const done = s.filter((x) => x.status === 'completed').sort((a, b) => +a.finishedAt! - +b.finishedAt!);
    expect(done).toHaveLength(2);
    expect(done[1].score!).toBeGreaterThan(done[0].score!);
    expect(s.filter((x) => x.status === 'draft')).toHaveLength(1);
  });

  it('demo PIN login only works when enabled and only sees demo customers', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/demo', payload: { pin: '123456' } })).statusCode).toBe(404);
    const { setDemoLoginForTest } = await import('./helpers.js');
    await setDemoLoginForTest(ctx, '48291357');
    expect((await app.inject({ method: 'GET', url: '/api/auth/config' })).json().demoLogin).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/auth/demo', payload: { pin: '000000' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/demo', payload: { pin: '48291357' } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0];
    await db.insert(customers).values({ name: 'Real Customer', context: {} as any });
    const list = (await app.inject({ method: 'GET', url: '/api/customers', headers: { cookie } })).json();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c: any) => c.isDemo)).toBe(true);
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    expect(me.user.isDemo).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } })).statusCode).toBe(403);
    // Reset removes demo data and reseeds.
    await resetDemo(ctx);
    expect(await db.select().from(customers).where(eq(customers.isDemo, true))).toHaveLength(1);
  });
});
