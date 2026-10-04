/**
 * Environments of the same platform in one scan: free-text environment per system, distinct system keys
 * (Azure scoped to subscriptions), duplicate detection and triage compatibility with the old tenant-only Azure key.
 * The database part needs TEST_DATABASE_URL (see api.test.ts).
 */
import { demoOutcomeSync } from '@qs/checks';
import { environmentKey, normalizeEnvironment, systemDisplayName, systemInputSchema, systemKey, systemKeyFallbacks } from '@qs/shared';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppCtx } from '../src/context.js';
import { randomToken, sha256 } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { checkResults, customers, findingTriage, msTenantBindings, scans, scanSystems, sessions, users } from '../src/db/schema.js';
import { controlsCsv, findingsCsv } from '../src/reports/csv.js';
import { buildReport } from '../src/reports/model.js';
import { duplicateSystemProblem } from '../src/routes/scans.js';
import { scoreScanDetailed, storeScanScore } from '../src/scoring.js';
import { frozenTriageFor, triageLookup } from '../src/triage.js';

const TENANT = '0a0b0c0d-1111-4222-8333-444455556666';
const SUB_PROD = 'AAAAAAAA-0000-4000-8000-000000000001';
const SUB_ACC = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('system keys per environment', () => {
  it('keys Azure by tenant, plus sorted lower-case subscriptions when scoped', () => {
    expect(systemKey('azure', { tenantId: TENANT, subscriptionIds: [] })).toBe(`azure:${TENANT}`);
    expect(systemKey('azure', { tenantId: TENANT.toUpperCase(), subscriptionIds: [SUB_ACC, SUB_PROD] })).toBe(`azure:${TENANT}/${SUB_PROD.toLowerCase()},${SUB_ACC}`);
    expect(systemKey('azure', { tenantId: TENANT, subscriptionIds: [SUB_PROD] })).not.toBe(systemKey('azure', { tenantId: TENANT, subscriptionIds: [SUB_ACC] }));
    // The tenant from the connection test wins over a configured domain.
    expect(systemKey('azure', { tenantId: 'contoso.example', subscriptionIds: [SUB_ACC] }, { tenantId: TENANT })).toBe(`azure:${TENANT}/${SUB_ACC}`);
    // Microsoft 365, AWS and GitHub keys are unchanged.
    expect(systemKey('m365', { tenantId: TENANT, subscriptionIds: [SUB_ACC] })).toBe(`m365:${TENANT}`);
    expect(systemKey('aws', { accountId: '111122223333' })).toBe('aws:111122223333');
    expect(systemKey('github', { org: 'Acme' })).toBe('github:acme');
  });

  it('gives simulated systems without an identity of their own a key per display name', () => {
    expect(systemKey('github', { authMode: 'demo', org: 'demo-org' }, null, 'GitHub test')).toBe('github:label:github test');
    expect(systemKey('github', { authMode: 'demo', org: 'noordkust-demo' }, null, 'x')).toBe('github:noordkust-demo');
    expect(systemKey('aws', { authMode: 'demo' }, null, 'AWS acceptance')).toBe('aws:label:aws acceptance');
  });

  it('falls back from a scoped Azure key to the tenant key only', () => {
    expect(systemKeyFallbacks(`azure:${TENANT}/${SUB_ACC}`)).toEqual([`azure:${TENANT}/${SUB_ACC}`, `azure:${TENANT}`]);
    expect(systemKeyFallbacks(`azure:${TENANT}`)).toEqual([`azure:${TENANT}`]);
    expect(systemKeyFallbacks('azure:label:a/b')).toEqual(['azure:label:a/b']);
    expect(systemKeyFallbacks('aws:111122223333')).toEqual(['aws:111122223333']);
  });

  it('looks triage up by exact key, then the tenant key, then the legacy * row', () => {
    const scoped = `azure:${TENANT}/${SUB_ACC}`;
    const row = (systemKey: string, note: string) => ({ checkId: 'azure.storage-public', systemKey, status: 'accepted' as const, note });
    expect(triageLookup([row('*', 'all'), row(`azure:${TENANT}`, 'tenant'), row(scoped, 'exact')])('azure.storage-public', scoped)?.note).toBe('exact');
    expect(triageLookup([row('*', 'all'), row(`azure:${TENANT}`, 'tenant')])('azure.storage-public', scoped)?.note).toBe('tenant');
    expect(triageLookup([row('*', 'all')])('azure.storage-public', scoped)?.note).toBe('all');
    // A decision for one subscription scope does not leak to another one or to the whole tenant.
    expect(triageLookup([row(scoped, 'exact')])('azure.storage-public', `azure:${TENANT}/${SUB_PROD.toLowerCase()}`)).toBeUndefined();
    expect(triageLookup([row(scoped, 'exact')])('azure.storage-public', `azure:${TENANT}`)).toBeUndefined();
    expect(frozenTriageFor({ [`azure:${TENANT}|c`]: 'old' }, scoped, 'c')).toBe('old');
    expect(frozenTriageFor({ [`${scoped}|c`]: 'new', [`azure:${TENANT}|c`]: 'old' }, scoped, 'c')).toBe('new');
    expect(frozenTriageFor({}, scoped, 'c')).toBeNull();
  });

  it('normalises free-text environments and names systems with them', () => {
    expect(normalizeEnvironment('  User   acceptance ')).toBe('User acceptance');
    expect(normalizeEnvironment('')).toBeNull();
    expect(normalizeEnvironment(null)).toBeNull();
    expect(environmentKey('Production')).toBe(environmentKey(' production'));
    expect(systemDisplayName('AWS', 'acceptance')).toBe('AWS (acceptance)');
    expect(systemDisplayName('AWS production', 'Production')).toBe('AWS production');
    expect(systemDisplayName('AWS production', null)).toBe('AWS production');
    const parse = (environment: unknown) => systemInputSchema.safeParse({ provider: 'aws', label: 'AWS', environment, config: { authMode: 'demo' } });
    expect(parse('uat').success).toBe(true);
    expect(parse(null).success).toBe(true);
    expect(parse(undefined).success).toBe(true);
    expect(parse('x'.repeat(41)).success).toBe(false);
    expect(parse('prod\nuction').success).toBe(false);
  });

  it('rejects the same account, tenant scope or organisation twice in one scan', () => {
    const aws = (id: string, accountId?: string, extra: Record<string, unknown> = {}) => ({ id, provider: 'aws' as const, label: `AWS ${id}`, config: { authMode: 'assume_role', accountId }, ...extra });
    expect(duplicateSystemProblem([aws('a', '111122223333')], aws('b', '444455556666'))).toBeNull();
    expect(duplicateSystemProblem([aws('a', '111122223333')], aws('b', '111122223333'))).toMatch(/already includes AWS a for the same AWS account/);
    expect(duplicateSystemProblem([aws('a', '111122223333')], aws('a', '111122223333'))).toBeNull(); // itself
    // Unknown identity while editing: only checked at start, with the connection details.
    expect(duplicateSystemProblem([aws('a')], aws('b'))).toBeNull();
    const known = { connectionDetails: { accountId: '111122223333' } };
    expect(duplicateSystemProblem([aws('a', undefined, known)], aws('b', undefined, known), true)).toMatch(/same AWS account/);
    const az = (id: string, subs: string[]) => ({ id, provider: 'azure' as const, label: `Azure ${id}`, config: { authMode: 'app_secret', tenantId: TENANT, subscriptionIds: subs } });
    expect(duplicateSystemProblem([az('p', [SUB_PROD])], az('a', [SUB_ACC]))).toBeNull();
    expect(duplicateSystemProblem([az('p', [SUB_PROD]), az('a', [SUB_ACC])], az('all', []))).toBeNull();
    expect(duplicateSystemProblem([az('p', [SUB_PROD])], az('q', [SUB_PROD.toLowerCase()]))).toMatch(/same Microsoft tenant and subscriptions/);
    // Simulated systems: the display name is their identity.
    const demo = (id: string, label: string) => ({ id, provider: 'aws' as const, label, config: { authMode: 'demo' } });
    expect(duplicateSystemProblem([demo('a', 'AWS production')], demo('b', 'AWS acceptance'))).toBeNull();
    expect(duplicateSystemProblem([demo('a', 'AWS production')], demo('b', 'aws production'))).toMatch(/named AWS production/);
  });

  it('simulates another AWS account with its own resource ARNs', () => {
    const prod = demoOutcomeSync('aws.root-mfa', 0);
    const acc = demoOutcomeSync('aws.root-mfa', 0, { awsAccount: '444455556666' });
    expect(acc.status).toBe(prod.status);
    expect(JSON.stringify(acc)).toContain('444455556666');
    expect(JSON.stringify(acc)).not.toContain('111122223333');
    // Other providers are left alone.
    expect(demoOutcomeSync('gh.org-2fa', 0, { awsAccount: '444455556666' })).toEqual(demoOutcomeSync('gh.org-2fa', 0));
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('environments in scans', () => {
  const config = loadConfig({
    NODE_ENV: 'test', APP_URL: 'http://localhost:8080', DATABASE_URL: url ?? 'postgres://skipped@localhost/none',
    MASTER_KEY: randomBytes(32).toString('base64'), COOKIE_SECURE: 'false', ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: 'x', ENTRA_CLIENT_SECRET: 'y', DEMO_MODE: 'true', LOG_LEVEL: 'fatal',
  } as any);
  const { db, pool } = createDb(config);
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: AppCtx;
  let cookie = '';
  let csrf = '';
  const orgs: string[] = [];
  const req = (method: string, path: string, payload?: unknown) =>
    app.inject({ method: method as any, url: path, payload: payload as any, headers: { cookie, 'x-csrf-token': csrf, origin: 'http://localhost:8080' } });
  const org = async () => {
    const id = (await req('POST', '/api/customers', { name: `Env Co ${randomToken(3)}` })).json().id as string;
    orgs.push(id);
    return id;
  };
  const draft = async (cid: string) => (await req('POST', `/api/customers/${cid}/scans`, {})).json().id as string;
  const add = (sid: string, body: Record<string, unknown>) => req('POST', `/api/scans/${sid}/systems`, body);
  const azure = (label: string, subs: string[], environment?: string, authMode = 'app_secret') => ({
    provider: 'azure',
    label,
    environment,
    config: { authMode, tenantId: TENANT, subscriptionIds: subs },
  });

  beforeAll(async () => {
    await runMigrations(db);
    ({ app, ctx } = await buildApp(config, db));
    const [u] = await db.insert(users).values({ email: `env-${randomToken(4)}@test.local`, name: 'Env', role: 'consultant' }).returning();
    const token = randomToken();
    csrf = randomToken();
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: csrf, authMethod: 'test', expiresAt: new Date(Date.now() + 3600_000) });
    cookie = `qs_session=${token}`;
  });
  afterAll(async () => {
    for (const id of orgs) await db.delete(customers).where(eq(customers.id, id));
    await db.delete(msTenantBindings).where(eq(msTenantBindings.tenantId, TENANT));
    await app.close();
    await pool.end();
  });

  it('stores a trimmed free-text environment, keeps it on label-only updates and copies it on rescan', async () => {
    const cid = await org();
    const sid = await draft(cid);
    const r = await add(sid, { provider: 'aws', label: 'AWS', environment: '  User  acceptance ', config: { authMode: 'demo' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().environment).toBe('User acceptance');
    const sysId = r.json().id;
    expect((await add(sid, { provider: 'aws', label: 'AWS 2', environment: 'x'.repeat(41), config: { authMode: 'demo' } })).statusCode).toBe(400);
    // Leaving the environment out keeps it (the Access step only sends label and config).
    expect((await req('PATCH', `/api/scans/${sid}/systems/${sysId}`, { label: 'AWS uat', config: { authMode: 'demo' } })).statusCode).toBe(200);
    let sys = (await req('GET', `/api/scans/${sid}`)).json().systems[0];
    expect(sys).toMatchObject({ label: 'AWS uat', environment: 'User acceptance' });
    expect((await req('PATCH', `/api/scans/${sid}/systems/${sysId}`, { label: 'AWS uat', environment: '', config: { authMode: 'demo' } })).statusCode).toBe(200);
    sys = (await req('GET', `/api/scans/${sid}`)).json().systems[0];
    expect(sys.environment).toBeNull();
    expect((await req('PATCH', `/api/scans/${sid}/systems/${sysId}`, { label: 'AWS uat', environment: 'UAT', config: { authMode: 'demo' } })).statusCode).toBe(200);

    expect((await req('POST', `/api/scans/${sid}/start`)).statusCode).toBe(200);
    await db.update(scans).set({ status: 'completed', finishedAt: new Date() }).where(eq(scans.id, sid));
    const re = (await req('POST', `/api/scans/${sid}/rescan`)).json().id as string;
    expect((await req('GET', `/api/scans/${re}`)).json().systems[0]).toMatchObject({ label: 'AWS uat', environment: 'UAT' });
  });

  it('suggests the organisation’s environments, distinct ignoring case, most recent first', async () => {
    const cid = await org();
    const s1 = await draft(cid);
    await add(s1, { provider: 'aws', label: 'A', environment: 'production', config: { authMode: 'demo' } });
    await add(s1, { provider: 'aws', label: 'B', environment: 'Acceptance', config: { authMode: 'demo' } });
    await new Promise((r) => setTimeout(r, 5));
    const s2 = await draft(cid);
    await add(s2, { provider: 'aws', label: 'C', environment: 'acceptance', config: { authMode: 'demo' } });
    await add(s2, { provider: 'aws', label: 'D', config: { authMode: 'demo' } });
    const detail = (await req('GET', `/api/customers/${cid}`)).json();
    expect(detail.environments).toEqual(['acceptance', 'production']);
    expect(detail.scans.find((s: any) => s.id === s1).environments.sort()).toEqual(['Acceptance', 'production']);
  });

  it('allows several Azure environments in one bound tenant and rejects the same scope twice', async () => {
    const cid = await org();
    const sid = await draft(cid);
    await db.insert(msTenantBindings).values({ tenantId: TENANT, customerId: cid }).onConflictDoUpdate({ target: msTenantBindings.tenantId, set: { customerId: cid } });
    const prod = await add(sid, azure('Azure production', [SUB_PROD], 'production', 'admin_consent'));
    expect(prod.statusCode).toBe(200);
    // A second environment (acceptance subscriptions) in the tenant already bound to this organisation.
    const acc = await add(sid, azure('Azure acceptance', [SUB_ACC], 'acceptance', 'admin_consent'));
    expect(acc.statusCode).toBe(200);
    const dup = await add(sid, azure('Azure prod again', [SUB_PROD.toLowerCase()], 'production'));
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error ?? dup.json().message).toMatch(/already includes Azure production for the same Microsoft tenant and subscriptions/);
    // Editing acceptance onto the production subscriptions is rejected too.
    const edit = await req('PATCH', `/api/scans/${sid}/systems/${acc.json().id}`, azure('Azure acceptance', [SUB_PROD], 'acceptance', 'admin_consent'));
    expect(edit.statusCode).toBe(400);

    // Both systems pass the tenant binding at start (consent recorded per system).
    for (const s of [prod.json(), acc.json()]) {
      await db
        .update(scanSystems)
        .set({ config: { ...s.config, consentGrantedAt: new Date().toISOString() }, connectionOk: true, connectionDetails: { tenantId: TENANT }, connectionCheckedAt: new Date() })
        .where(eq(scanSystems.id, s.id));
    }
    const start = await req('POST', `/api/scans/${sid}/start`);
    expect(start.statusCode, start.body).toBe(200);
  });

  it('re-checks at start with the identities the connection tests found', async () => {
    const cid = await org();
    const sid = await draft(cid);
    const ids: string[] = [];
    for (const label of ['AWS one', 'AWS two']) {
      const r = await add(sid, { provider: 'aws', label, config: { authMode: 'access_keys' } });
      expect(r.statusCode).toBe(200);
      ids.push(r.json().id);
      const put = await req('PUT', `/api/scans/${sid}/systems/${r.json().id}/credentials`, { secret: { accessKeyId: 'AKIAEXAMPLEKEY000001', secretAccessKey: 'x'.repeat(40) } });
      expect(put.statusCode).toBe(200);
    }
    for (const id of ids) {
      await db.update(scanSystems).set({ connectionOk: true, connectionDetails: { accountId: '111122223333' }, connectionCheckedAt: new Date() }).where(eq(scanSystems.id, id));
    }
    const start = await req('POST', `/api/scans/${sid}/start`);
    expect(start.statusCode).toBe(400);
    expect(start.json().error ?? start.json().message).toMatch(/same AWS account/);
    await db.update(scanSystems).set({ connectionDetails: { accountId: '444455556666' } }).where(eq(scanSystems.id, ids[1]));
    expect((await req('POST', `/api/scans/${sid}/start`)).statusCode).toBe(200);
  });

  it('allows several simulated systems of one platform with their own names', async () => {
    const sid = await draft(await org());
    expect((await add(sid, { provider: 'github', label: 'GitHub production', config: { authMode: 'demo' } })).statusCode).toBe(200);
    expect((await add(sid, { provider: 'github', label: 'GitHub test', config: { authMode: 'demo' } })).statusCode).toBe(200);
    expect((await add(sid, { provider: 'github', label: 'github test', config: { authMode: 'demo' } })).statusCode).toBe(400);
  });

  it('reports per environment and keeps tenant-key triage for Azure systems scoped to subscriptions', async () => {
    const cid = await org();
    const [scan] = await db
      .insert(scans)
      .values({ customerId: cid, name: 'Envs', status: 'completed', context: {}, riskProfile: {}, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date() })
      .returning();
    const sys = async (label: string, environment: string | null, subs: string[], status: 'fail' | 'pass', at: number) => {
      const [s] = await db
        .insert(scanSystems)
        .values({ scanId: scan.id, provider: 'azure', label, environment, config: { authMode: 'app_secret', tenantId: TENANT, subscriptionIds: subs }, createdAt: new Date(at) })
        .returning();
      await db.insert(checkResults).values({ scanId: scan.id, systemId: s.id, checkId: 'azure.storage-public', status, summary: status });
      await db.insert(checkResults).values({ scanId: scan.id, systemId: s.id, checkId: 'azure.keyvault-protection', status: 'pass', summary: 'ok' });
      return s;
    };
    const prod = await sys('Azure', 'production', [SUB_PROD], 'fail', 1000);
    const acc = await sys('Azure', 'Acceptance', [SUB_ACC], 'fail', 2000);
    await sys('Azure sandbox', null, ['cccccccc-0000-4000-8000-000000000003'], 'pass', 3000);
    // Accepted before the key change, under the tenant-only key: still applies to every scoped system.
    await db.insert(findingTriage).values({ customerId: cid, checkId: 'azure.storage-public', systemKey: `azure:${TENANT}`, status: 'accepted', note: 'tenant-wide' });
    const live = await scoreScanDetailed(ctx, scan.id);
    expect(Object.keys(live.triage).sort()).toEqual(
      [SUB_PROD.toLowerCase(), SUB_ACC, 'cccccccc-0000-4000-8000-000000000003'].map((sub) => `azure:${TENANT}/${sub}|azure.storage-public`),
    );

    // A new decision for acceptance is stored under its exact key and only overrides acceptance.
    const accKey = `azure:${TENANT}/${SUB_ACC}`;
    const put = await req('PUT', `/api/customers/${cid}/triage/azure.storage-public`, { systemKey: accKey, status: 'false_positive', note: 'acc only' });
    expect(put.statusCode).toBe(200);
    expect((await db.select().from(findingTriage).where(eq(findingTriage.customerId, cid))).map((t) => t.systemKey).sort()).toEqual([`azure:${TENANT}`, accKey]);
    await storeScanScore(ctx, scan.id);
    const m = await buildReport(ctx, scan.id);
    const f = (id: string) => m.findings.find((x) => x.systemId === id)!;
    expect(f(prod.id).triage).toMatchObject({ status: 'accepted', note: 'tenant-wide' });
    expect(f(acc.id).triage).toMatchObject({ status: 'false_positive', note: 'acc only' });
    expect(f(acc.id).systemEnvironment).toBe('Acceptance');

    // Environments: system order, without environment last, each scored over its own results.
    expect(m.environments.map((e) => [e.key, e.name, e.systemIds.length])).toEqual([
      ['production', 'production', 1],
      ['acceptance', 'Acceptance', 1],
      ['', null, 1],
    ]);
    expect(m.environments[2].summary.counts.fail).toBe(0);
    expect(m.environments[0].summary.counts.accepted).toBe(1);
    expect(m.systems.map((s) => s.environment)).toEqual(['production', 'Acceptance', null]);

    const csv = findingsCsv(m).split('\r\n');
    expect(csv[0]).toContain('"System","Environment","Identity"');
    expect(csv.some((l) => l.includes('"Azure","Acceptance"'))).toBe(true);
    expect(controlsCsv(m)).toContain('Azure (production)');

    // A summary frozen before the key change used the tenant key; the report still shows that decision.
    const frozen = (await db.select().from(scans).where(eq(scans.id, scan.id)))[0].summary as any;
    frozen.triage = { [`azure:${TENANT}|azure.storage-public`]: { status: 'accepted', note: 'frozen tenant' } };
    await db.update(scans).set({ summary: frozen }).where(eq(scans.id, scan.id));
    const old = await buildReport(ctx, scan.id);
    expect(old.findings.find((x) => x.systemId === acc.id)!.triage?.note).toBe('frozen tenant');
  });
});
