/**
 * Application settings (sign-in methods, scanner identities, general), local passwords and first-run setup.
 * Needs TEST_DATABASE_URL (see api.test.ts).
 */
import { CONFIRM_REQUIRED, PASSWORD_CHANGE_REQUIRED, REAUTH_REQUIRED } from '@qs/shared';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword, passwordProblem } from '../src/auth/password.js';
import { oidcDiscovery } from '../src/auth/routes.js';
import { setupTokenForTest } from '../src/auth/setup.js';
import { loadConfig } from '../src/config.js';
import { randomToken, sha256 } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { auditLog, loginAttempts, sessions, settings, users } from '../src/db/schema.js';
import { getRuntime, invalidateRuntime, secretAad, SETTING_KEYS, writeSetting } from '../src/settings/runtime.js';

describe('password policy', () => {
  it('enforces length, the common password list and the email', () => {
    expect(passwordProblem('short-pass', { minLength: 14 })).toMatch(/at least 14/);
    expect(passwordProblem('1qaz2wsx3edc4rfv', { minLength: 14 })).toMatch(/too common/);
    expect(passwordProblem('Password2024!!!!', { minLength: 14 })).toMatch(/too common/);
    expect(passwordProblem('aaaaaaaaaaaaaaaa', { minLength: 14 })).toMatch(/repetitive/);
    expect(passwordProblem('jane.doe-quiet-harbour', { minLength: 14, email: 'Jane.Doe@example.com' })).toMatch(/email/);
    expect(passwordProblem('quiet-harbour-lantern-9', { minLength: 14, email: 'jane@example.com' })).toBeNull();
    expect(passwordProblem('x'.repeat(257), { minLength: 14 })).toMatch(/at most/);
  });
  it('hashes with Argon2id', async () => {
    expect(await hashPassword('quiet-harbour-lantern-9')).toMatch(/^\$argon2id\$/);
  });
});

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const T1 = '11111111-1111-1111-1111-111111111111';
const C1 = '33333333-3333-3333-3333-333333333333';
const T2 = '44444444-4444-4444-4444-444444444444';
const C2 = '55555555-5555-5555-5555-555555555555';
const ENV_ENTRA_SECRET = 'env-entra-secret-Q7wZ';
const ENV_SCANNER_SECRET = 'env-scanner-secret-K2pX';
const APP_ENTRA_SECRET = 'app-entra-secret-value-M9vR';
const ORIGIN = 'http://localhost:8080';
const DOMAIN = '@settings-test.local';
const GOOD = 'amber-falcon-river-stone-42';

d('application settings and local passwords', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: ORIGIN,
    DATABASE_URL: url ?? 'postgres://skipped@localhost/none',
    MASTER_KEY: randomBytes(32).toString('base64'),
    COOKIE_SECURE: 'false',
    ENTRA_TENANT_ID: T1,
    ENTRA_CLIENT_ID: C1,
    ENTRA_CLIENT_SECRET: ENV_ENTRA_SECRET,
    SCANNER_MS_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
    SCANNER_MS_CLIENT_SECRET: ENV_SCANNER_SECRET,
    SESSION_IDLE_MINUTES: '45',
    LOG_LEVEL: 'fatal',
  } as any);
  const { db, pool } = createDb(config);
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  let otherAdmins: string[] = [];
  type Who = { cookie: string; csrf: string; id: string; email: string };
  const S: Record<string, Who> = {};
  let ipSeq = 10;
  const nextIp = () => `198.51.100.${ipSeq++}`;

  async function addUser(name: string, role: 'admin' | 'consultant' | 'viewer', password?: string, extra: Partial<typeof users.$inferInsert> = {}) {
    const [u] = await db
      .insert(users)
      .values({ email: `${name}-${randomToken(4).toLowerCase()}${DOMAIN}`, name, role, ...(password ? { passwordHash: await hashPassword(password) } : {}), ...extra })
      .returning();
    return u;
  }
  /** A session row created `ageMinutes` ago (old sessions are not recent enough for sensitive settings). */
  async function session(name: string, u: { id: string; email: string }, authMethod = 'password', ageMinutes = 0) {
    const token = randomToken();
    const csrf = randomToken();
    const createdAt = new Date(Date.now() - ageMinutes * 60_000);
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: csrf, authMethod, createdAt, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) });
    S[name] = { cookie: `qs_session=${token}`, csrf, id: u.id, email: u.email };
  }
  const req = (who: string, method: string, path: string, payload?: unknown) =>
    app.inject({ method: method as any, url: path, payload: payload as any, headers: { cookie: S[who].cookie, 'x-csrf-token': S[who].csrf, origin: ORIGIN } });
  const cookieFrom = (r: { headers: Record<string, unknown> }) => {
    const raw = ([] as string[]).concat((r.headers['set-cookie'] as string | string[]) ?? []);
    const c = raw.find((x) => x.startsWith('qs_session=') && !x.startsWith('qs_session=;'));
    return c?.split(';')[0] ?? null;
  };
  /** Signs in through the password endpoint and stores the resulting session under `name`. */
  async function passwordLogin(name: string, email: string, password: string, ip = nextIp()) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/password/login', payload: { email, password }, remoteAddress: ip, headers: { origin: ORIGIN } });
    const cookie = cookieFrom(r);
    if (cookie) {
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      S[name] = { cookie, csrf: me.json().csrfToken, id: me.json().user.id, email };
    }
    return r;
  }
  const clearSettings = async () => {
    await db.delete(settings).where(inArray(settings.key, Object.values(SETTING_KEYS)));
    invalidateRuntime();
  };

  let root: typeof users.$inferSelect;
  const ROOT_PW = 'root-admin-passphrase-81';

  beforeAll(async () => {
    await runMigrations(db);
    await clearSettings();
    // Other test files share this database: their administrators would influence the lockout guards and setup.
    otherAdmins = (
      await db
        .update(users)
        .set({ active: false })
        .where(and(eq(users.role, 'admin'), eq(users.active, true), eq(users.isBreakglass, false), eq(users.isDemo, false)))
        .returning({ id: users.id })
    ).map((r) => r.id);
    ({ app, ctx } = await buildApp(config, db));
    root = await addUser('root', 'admin', ROOT_PW);
    await writeSetting(ctx, SETTING_KEYS.password, { enabled: true, minLength: 14 });
    await session('root', root);
  });
  afterAll(async () => {
    oidcDiscovery.discover = (t, c, s) => oidc.discovery(new URL(`https://login.microsoftonline.com/${t}/v2.0`), c, s);
    await db.delete(users).where(like(users.email, `%${DOMAIN}`));
    if (otherAdmins.length) await db.update(users).set({ active: true }).where(inArray(users.id, otherAdmins));
    await db.delete(loginAttempts).where(like(loginAttempts.key, 'pw:%'));
    await clearSettings();
    await app.close();
    await pool.end();
  });

  it('reports environment fallbacks and their source without revealing secrets', async () => {
    const auth = await req('root', 'GET', '/api/admin/settings/auth');
    expect(auth.statusCode).toBe(200);
    const a = auth.json();
    expect(a.entra).toMatchObject({ enabled: true, tenantId: T1, clientId: C1, source: 'env', redirectUri: `${ORIGIN}/api/auth/callback` });
    expect(a.entra.clientSecret).toEqual({ set: true, hint: '…Q7wZ', source: 'env' });
    expect(a.password).toEqual({ enabled: true, minLength: 14 });
    expect(auth.body).not.toContain(ENV_ENTRA_SECRET);

    const general = (await req('root', 'GET', '/api/admin/settings/general')).json();
    expect(general).toMatchObject({ sessionIdleMinutes: 45, sessionMaxHours: 8, auditRetentionMonths: 24, demoMode: false });
    expect(general.sources).toEqual({ sessionIdleMinutes: 'env', sessionMaxHours: 'none', auditRetentionMonths: 'none', demoMode: 'none' });

    const scanner = await req('root', 'GET', '/api/admin/settings/scanner');
    expect(scanner.json().ms).toMatchObject({ clientId: '22222222-2222-2222-2222-222222222222', source: 'env', clientSecret: { set: true, source: 'env' } });
    expect(scanner.json().aws).toMatchObject({ accessKeyId: null, source: 'none', principalArn: null, secretAccessKey: { set: false } });
    expect(scanner.body).not.toContain(ENV_SCANNER_SECRET);

    const cfg = (await app.inject({ method: 'GET', url: '/api/auth/config' })).json();
    expect(cfg).toMatchObject({ entra: true, password: true, local: false, setupRequired: false });
    const me = (await req('root', 'GET', '/api/auth/me')).json();
    expect(me).toMatchObject({ idleMinutes: 45, mustChangePassword: false, user: { hasPassword: true } });
    expect(Date.parse(me.recentAuthUntil)).toBeGreaterThan(Date.now());
  });

  it('only lets administrators read or change settings', async () => {
    await session('cons', await addUser('cons', 'consultant'));
    expect((await req('cons', 'GET', '/api/admin/settings/auth')).statusCode).toBe(403);
    expect((await req('cons', 'PUT', '/api/admin/settings/general', { sessionIdleMinutes: 30, sessionMaxHours: 8, auditRetentionMonths: 24, demoMode: false })).statusCode).toBe(403);
  });

  it('stores secrets encrypted, bound to the setting, and never returns or audits them', async () => {
    const r = await req('root', 'PUT', '/api/admin/settings/auth/entra', { enabled: true, tenantId: T2, clientId: C2, clientSecret: APP_ENTRA_SECRET, requireMfa: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().entra).toMatchObject({ tenantId: T2, clientId: C2, requireMfa: true, source: 'app', clientSecret: { set: true, hint: '…M9vR', source: 'app' } });
    expect(r.body).not.toContain(APP_ENTRA_SECRET);
    expect((await req('root', 'GET', '/api/admin/settings/auth')).body).not.toContain(APP_ENTRA_SECRET);

    const row = (await db.select().from(settings).where(eq(settings.key, SETTING_KEYS.entra)))[0];
    expect(JSON.stringify(row.value)).not.toContain(APP_ENTRA_SECRET);
    const blob = Buffer.from((row.value as any).clientSecret.blob, 'base64');
    expect(ctx.envelope.decrypt(blob, secretAad(SETTING_KEYS.entra, 'clientSecret')).toString()).toBe(APP_ENTRA_SECRET);
    expect(() => ctx.envelope.decrypt(blob, secretAad(SETTING_KEYS.scannerMs, 'clientSecret'))).toThrow();
    expect((await getRuntime(ctx)).entra.clientSecret.value).toBe(APP_ENTRA_SECRET);

    const audits = await db.select().from(auditLog).where(like(auditLog.action, 'settings.%'));
    expect(audits.some((x) => x.action === 'settings.auth_entra')).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(APP_ENTRA_SECRET);

    // An omitted secret keeps the saved one.
    const keep = await req('root', 'PUT', '/api/admin/settings/auth/entra', { enabled: true, tenantId: T2, clientId: C2, requireMfa: false });
    expect(keep.json().entra.clientSecret).toMatchObject({ set: true, source: 'app' });
    expect((await getRuntime(ctx)).entra.clientSecret.value).toBe(APP_ENTRA_SECRET);
    expect((await req('root', 'PUT', '/api/admin/settings/auth/entra', { enabled: true, tenantId: 'common', clientId: C2, requireMfa: false })).statusCode).toBe(400);
  });

  it('uses the saved Microsoft configuration for sign-in redirects', async () => {
    const seen: string[] = [];
    oidcDiscovery.discover = async (tenantId, clientId, secret) => {
      seen.push(`${tenantId}|${clientId}|${secret === APP_ENTRA_SECRET}`);
      const base = `https://login.microsoftonline.com/${tenantId}`;
      return new oidc.Configuration(
        { issuer: `${base}/v2.0`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`, token_endpoint: `${base}/oauth2/v2.0/token`, jwks_uri: `${base}/discovery/v2.0/keys` },
        clientId,
        secret,
      );
    };
    const r = await app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(r.statusCode).toBe(302);
    const loc = new URL(r.headers.location as string);
    expect(loc.href.startsWith(`https://login.microsoftonline.com/${T2}/oauth2/v2.0/authorize`)).toBe(true);
    expect(loc.searchParams.get('client_id')).toBe(C2);
    expect(loc.searchParams.get('prompt')).toBe('select_account');
    expect(seen).toContain(`${T2}|${C2}|true`);

    // Re-authentication of a signed-in user forces a fresh Microsoft sign-in.
    const re = await app.inject({ method: 'GET', url: '/api/auth/login?reauth=1&returnTo=/settings', headers: { cookie: S.root.cookie } });
    expect(new URL(re.headers.location as string).searchParams.get('prompt')).toBe('login');

    // The connection test never echoes the secret.
    oidcDiscovery.discover = async () => {
      throw new Error('unreachable');
    };
    const t = await req('root', 'POST', '/api/admin/settings/auth/entra/test', { clientSecret: 'typed-but-unsaved-secret-1' });
    expect(t.statusCode).toBe(200);
    expect(t.json().ok).toBe(false);
    expect(t.body).not.toContain('typed-but-unsaved-secret-1');
    expect(t.body).not.toContain(APP_ENTRA_SECRET);
  });

  it('requires a recent sign-in for sensitive settings and accepts a password re-authentication', async () => {
    await session('stale', root, 'password', 30);
    const put = () => req('stale', 'PUT', '/api/admin/settings/auth/password', { enabled: true, minLength: 15 });
    const denied = await put();
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'Sign in again to change this setting', code: REAUTH_REQUIRED });
    expect((await req('stale', 'POST', '/api/admin/settings/import-env')).json().code).toBe(REAUTH_REQUIRED);
    expect((await req('stale', 'PUT', '/api/admin/settings/scanner', { aws: { accessKeyId: null } })).json().code).toBe(REAUTH_REQUIRED);

    expect((await req('stale', 'POST', '/api/auth/reauth', { password: 'wrong-password-entirely' })).statusCode).toBe(400);
    const ok = await req('stale', 'POST', '/api/auth/reauth', { password: ROOT_PW });
    expect(ok.statusCode).toBe(200);
    expect(Date.parse(ok.json().recentAuthUntil)).toBeGreaterThan(Date.now());
    expect((await put()).statusCode).toBe(200);
    expect((await getRuntime(ctx)).password.minLength).toBe(15);
    await req('root', 'PUT', '/api/admin/settings/auth/password', { enabled: true, minLength: 14 });
  });

  it('refuses changes that would lock every administrator out, and asks to confirm switching off your own method', async () => {
    // root only has a password, so Microsoft sign-in has no administrator: password cannot be switched off.
    const off = await req('root', 'PUT', '/api/admin/settings/auth/password', { enabled: false, minLength: 14 });
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toMatch(/no sign-in method/);
    expect((await req('root', 'GET', '/api/admin/settings/auth')).json().adminsByMethod).toEqual({ entra: 0, password: 1 });

    // An administrator invited for single sign-on makes Microsoft sign-in a way in.
    const sso = await addUser('sso-admin', 'admin', undefined, { entraOid: randomToken(8) });
    const needsConfirm = await req('root', 'PUT', '/api/admin/settings/auth/password', { enabled: false, minLength: 14 });
    expect(needsConfirm.statusCode).toBe(409);
    expect(needsConfirm.json().code).toBe(CONFIRM_REQUIRED);
    expect((await req('root', 'PUT', '/api/admin/settings/auth/password', { enabled: false, minLength: 14, confirm: true })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/config' })).json().password).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/login', payload: { email: root.email, password: ROOT_PW } })).statusCode).toBe(404);

    // Now Microsoft sign-in is the only way in: it cannot be switched off.
    expect((await req('root', 'PUT', '/api/admin/settings/auth/entra', { enabled: false, requireMfa: false })).statusCode).toBe(400);
    expect((await req('root', 'PUT', '/api/admin/settings/auth/password', { enabled: true, minLength: 14 })).statusCode).toBe(200);
    expect((await req('root', 'PUT', '/api/admin/settings/auth/entra', { enabled: false, requireMfa: false })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/login' })).statusCode).toBe(404);
    expect((await req('root', 'PUT', '/api/admin/settings/auth/entra', { enabled: true, requireMfa: false })).statusCode).toBe(200);
    await db.delete(users).where(eq(users.id, sso.id));
  });

  it('signs in with a password, with one generic error and a lockout per account', async () => {
    const ok = await passwordLogin('rootpw', root.email.toUpperCase(), ROOT_PW);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, mustChangePassword: false });
    expect((await req('rootpw', 'GET', '/api/auth/me')).json().authMethod).toBe('password');

    const wrong = await passwordLogin('x', root.email, 'not-the-right-password');
    const unknown = await passwordLogin('x', `nobody${DOMAIN}`, 'not-the-right-password');
    const sso = await addUser('nopw', 'consultant');
    const noPassword = await passwordLogin('x', sso.email, 'not-the-right-password');
    for (const r of [wrong, unknown, noPassword]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'Invalid email or password' });
    }
    const failed = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.password_failed'));
    expect(JSON.stringify(failed)).not.toContain('not-the-right-password');

    const victim = await addUser('victim', 'consultant', GOOD);
    for (let i = 0; i < 5; i++) expect((await passwordLogin('x', victim.email, `wrong-guess-number-${i}`)).statusCode).toBe(401);
    // Locked for this account (from any address), even with the right password.
    expect((await passwordLogin('x', victim.email, GOOD)).statusCode).toBe(429);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'auth.password_locked'))).length).toBeGreaterThan(0);

    const inactive = await addUser('inactive', 'consultant', GOOD, { active: false });
    expect((await passwordLogin('x', inactive.email, GOOD)).statusCode).toBe(401);
    const demo = await addUser('demo', 'consultant', GOOD, { isDemo: true });
    expect((await passwordLogin('x', demo.email, GOOD)).statusCode).toBe(401);
  });

  it('creates users with a temporary password that must be changed first', async () => {
    const common = await req('root', 'POST', '/api/users', { email: `common${DOMAIN}`, name: 'Common', role: 'consultant', temporaryPassword: '1qaz2wsx3edc4rfv' });
    expect(common.statusCode).toBe(400);
    expect(common.json().error).toMatch(/too common/);

    const email = `newbie${DOMAIN}`;
    const temp = 'temporary-lantern-otter-7';
    const created = await req('root', 'POST', '/api/users', { email, name: 'Newbie', role: 'consultant', temporaryPassword: temp });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ hasPassword: true, mustChangePassword: true });
    expect(created.json().passwordHash).toBeUndefined();
    const list = (await req('root', 'GET', '/api/users')).json();
    expect(list.find((u: any) => u.email === email)).toMatchObject({ hasPassword: true, mustChangePassword: true });
    expect(JSON.stringify(list)).not.toContain('argon2');

    const login = await passwordLogin('newbie', email, temp);
    expect(login.json().mustChangePassword).toBe(true);
    expect((await req('newbie', 'GET', '/api/auth/me')).json().mustChangePassword).toBe(true);
    const blocked = await req('newbie', 'GET', '/api/catalog');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe(PASSWORD_CHANGE_REQUIRED);

    expect((await req('newbie', 'POST', '/api/auth/password/change', { currentPassword: 'wrong-current-pass', newPassword: GOOD })).statusCode).toBe(400);
    expect((await req('newbie', 'POST', '/api/auth/password/change', { currentPassword: temp, newPassword: temp })).statusCode).toBe(400);
    expect((await req('newbie', 'POST', '/api/auth/password/change', { currentPassword: temp, newPassword: '1qaz2wsx3edc4rfv' })).json().error).toMatch(/too common/);
    const other = { ...S.newbie };
    await passwordLogin('newbie2', email, temp);
    const changed = await req('newbie', 'POST', '/api/auth/password/change', { currentPassword: temp, newPassword: GOOD });
    expect(changed.statusCode).toBe(200);
    const rotated = cookieFrom(changed)!;
    expect(rotated).toBeTruthy();
    // The old token of this session and the user's other sessions no longer work.
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: other.cookie } })).statusCode).toBe(401);
    expect((await req('newbie2', 'GET', '/api/auth/me')).statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: rotated } });
    expect(me.json()).toMatchObject({ mustChangePassword: false, user: { mustChangePassword: false } });
    expect((await app.inject({ method: 'GET', url: '/api/catalog', headers: { cookie: rotated } })).statusCode).toBe(200);
  });

  it('lets an administrator reset a password, which ends the user\'s sessions', async () => {
    const u = await addUser('reset', 'consultant', GOOD);
    await passwordLogin('r1', u.email, GOOD);
    await passwordLogin('r2', u.email, GOOD);
    const temp = 'brand-new-temporary-pass-5';
    const r = await req('root', 'POST', `/api/users/${u.id}/reset-password`, { temporaryPassword: temp });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, sessionsRevoked: 2 });
    expect((await req('r1', 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await passwordLogin('x', u.email, GOOD)).statusCode).toBe(401);
    expect((await passwordLogin('r3', u.email, temp)).json().mustChangePassword).toBe(true);
    const audit = (await db.select().from(auditLog).where(eq(auditLog.action, 'user.password_reset'))).at(-1)!;
    expect(JSON.stringify(audit)).not.toContain(temp);

    expect((await req('root', 'POST', `/api/users/${u.id}/reset-password`, { temporaryPassword: 'short' })).statusCode).toBe(400);
    expect((await req('root', 'POST', `/api/users/${root.id}/reset-password`, { temporaryPassword: temp })).statusCode).toBe(400);
    const demo = await addUser('demo2', 'consultant', undefined, { isDemo: true });
    expect((await req('root', 'POST', `/api/users/${demo.id}/reset-password`, { temporaryPassword: temp })).statusCode).toBe(400);
    await session('stale2', root, 'password', 30);
    expect((await req('stale2', 'POST', `/api/users/${u.id}/reset-password`, { temporaryPassword: temp })).json().code).toBe(REAUTH_REQUIRED);
  });

  it('imports environment values into the app settings', async () => {
    await db.delete(settings).where(inArray(settings.key, [SETTING_KEYS.scannerMs, SETTING_KEYS.general]));
    invalidateRuntime();
    const r = await req('root', 'POST', '/api/admin/settings/import-env');
    expect(r.statusCode).toBe(200);
    const imported: string[] = r.json().imported;
    expect(imported).toEqual(expect.arrayContaining(['SCANNER_MS_CLIENT_ID', 'SCANNER_MS_CLIENT_SECRET', 'SESSION_IDLE_MINUTES']));
    // Values already saved in the app win.
    expect(imported).not.toContain('ENTRA_CLIENT_SECRET');
    expect(imported).not.toContain('ENTRA_TENANT_ID');
    const scanner = (await req('root', 'GET', '/api/admin/settings/scanner')).json();
    expect(scanner.ms).toMatchObject({ source: 'app', clientSecret: { set: true, source: 'app', hint: '…K2pX' } });
    expect((await req('root', 'GET', '/api/admin/settings/general')).json().sources.sessionIdleMinutes).toBe('app');
    const row = (await db.select().from(settings).where(eq(settings.key, SETTING_KEYS.scannerMs)))[0];
    expect(JSON.stringify(row.value)).not.toContain(ENV_SCANNER_SECRET);
    const audit = (await db.select().from(auditLog).where(eq(auditLog.action, 'settings.import_env'))).at(-1)!;
    expect(JSON.stringify(audit)).not.toContain(ENV_SCANNER_SECRET);
    expect((await getRuntime(ctx)).scanner.env.ms?.clientSecret).toBe(ENV_SCANNER_SECRET);
    // Clearing an imported secret does not fall back to the environment again.
    await req('root', 'PUT', '/api/admin/settings/scanner', { ms: { clientId: null, clientSecret: '' } });
    expect((await getRuntime(ctx)).scanner.env.ms).toBeUndefined();
    expect((await req('root', 'GET', '/api/auth/me')).json().features).toMatchObject({ scannerMs: false, scannerMsClientId: null });
  });

  it('saves general settings and applies session timeouts from them', async () => {
    const r = await req('root', 'PUT', '/api/admin/settings/general', { sessionIdleMinutes: 20, sessionMaxHours: 4, auditRetentionMonths: 12, demoMode: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sessionIdleMinutes: 20, sessionMaxHours: 4, sources: { sessionMaxHours: 'app' } });
    expect((await req('root', 'GET', '/api/auth/me')).json().idleMinutes).toBe(20);
    await passwordLogin('short', root.email, ROOT_PW);
    const s = (await db.select().from(sessions).where(eq(sessions.userId, root.id))).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBeLessThanOrEqual(4 * 3600_000 + 5000);
  });

  it('runs first-run setup only with the one-time token and only once', async () => {
    const admins = await db
      .update(users)
      .set({ active: false })
      .where(and(eq(users.role, 'admin'), eq(users.active, true)))
      .returning({ id: users.id });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ required: true });
      expect((await app.inject({ method: 'GET', url: '/api/auth/config' })).json().setupRequired).toBe(true);
      const body = { email: `first-admin${DOMAIN}`, name: 'First admin', password: GOOD };
      const bad = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...body, token: 'wrong-token' }, remoteAddress: nextIp() });
      expect(bad.statusCode).toBe(403);
      const token = setupTokenForTest(ctx);
      const weak = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...body, token, password: '1qaz2wsx3edc4rfv' }, remoteAddress: nextIp() });
      expect(weak.statusCode).toBe(400);
      const ok = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...body, token }, remoteAddress: nextIp() });
      expect(ok.statusCode).toBe(200);
      const cookie = cookieFrom(ok)!;
      const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
      expect(me.user).toMatchObject({ email: body.email, role: 'admin', hasPassword: true, mustChangePassword: false });
      expect((await getRuntime(ctx)).password.enabled).toBe(true);
      expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ required: false });
      const again = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...body, email: `second${DOMAIN}`, token }, remoteAddress: nextIp() });
      expect(again.statusCode).toBe(404);
      expect((await db.select().from(users).where(sql`lower(${users.email}) = ${`second${DOMAIN}`}`)).length).toBe(0);
    } finally {
      await db.update(users).set({ active: true }).where(inArray(users.id, admins.map((a) => a.id)));
    }
  });
});
