import { verify as argonVerify } from '@node-rs/argon2';
import { passwordChangeInput, passwordLoginInput, reauthInput } from '@qs/shared';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { AppCtx } from '../context.js';
import { HttpError, notFound } from '../context.js';
import { randomToken, safeEqual, sha256 } from '../crypto/envelope.js';
import { authStates, loginAttempts, sessions, users } from '../db/schema.js';
import { cookieName, createSession, destroySession, loadSession, passwordChangePending, recentAuthUntil, requireUser } from './session.js';
import { verifyTotp } from './totp.js';
import { parse } from '../routes/helpers.js';
import { demoLoginAvailable } from '../demo/login.js';
import { getRuntime, type Runtime } from '../settings/runtime.js';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';
import { LOCAL_EMAIL, realAdminExists, setupRequired } from './setup.js';

const OIDC_COOKIE = 'qs_oidc';

/** Short, non-sensitive error code from a failed token exchange (e.g. AADSTS7000215), safe to show on the login page. */
export function oidcErrorCode(e: unknown): string {
  const err = e as { error?: unknown; error_description?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const text = [err?.error_description, err?.message, (err?.cause as any)?.error_description].filter((x) => typeof x === 'string').join(' ');
  const aad = /AADSTS\d+/.exec(text)?.[0];
  if (aad) return aad;
  const raw = typeof err?.error === 'string' ? err.error : typeof err?.code === 'string' ? err.code : 'unknown';
  return raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'unknown';
}
const STATE_TTL_MS = 10 * 60_000;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

/** Indirection so tests can replace OIDC discovery (no network). */
export const oidcDiscovery = { discover: (tenantId: string, clientId: string, clientSecret: string) => oidc.discovery(new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`), clientId, clientSecret) };

/** Discovery result, cached per Entra configuration version (tenant, client ID and secret). */
let discovered: { version: string; config: Promise<oidc.Configuration> } | null = null;
function entraConfig(rt: Runtime) {
  const e = rt.entra;
  if (!discovered || discovered.version !== e.version) {
    const entry = {
      version: e.version,
      config: oidcDiscovery.discover(e.tenantId!, e.clientId!, e.clientSecret.value!).catch((err) => {
        if (discovered === entry) discovered = null;
        throw err;
      }),
    };
    discovered = entry;
  }
  return discovered.config;
}

/** Only same-site paths are accepted as a return target after sign-in. */
function safeReturnTo(v: unknown): string {
  return typeof v === 'string' && v.length <= 200 && /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]*$/.test(v) ? v : '/';
}

/** A Microsoft re-authentication must have entered credentials within this window (auth_time claim). */
const REAUTH_MAX_AGE_S = 10 * 60;
/** Password sign-in: failures per account and per client address within LOCK_MINUTES. */
const PW_ACCOUNT_MAX = 5;
const PW_IP_MAX = 20;
const INVALID_LOGIN = 'Invalid email or password';

/** Global ceiling for failed break-glass attempts from all addresses together (warns and slows down, never locks). */
const BREAKGLASS_GLOBAL_MAX = 50;
const BREAKGLASS_SLOWDOWN_MS = 3000;

/**
 * Counts an attempt atomically *before* the credentials are verified (so parallel requests cannot
 * all slip in under the limit). Fixed window: updated_at holds the window start, and the counter only
 * resets once that start is older than LOCK_MINUTES, so further (blocked) attempts never extend a lock.
 * Returns false when the key is over its limit.
 */
export async function takeAttempt(ctx: AppCtx, key: string, max = MAX_FAILURES): Promise<boolean> {
  const r = await ctx.db.execute(sql`
    insert into login_attempts (key, failures, updated_at) values (${key}, 1, now())
    on conflict (key) do update set
      failures = case when login_attempts.updated_at < now() - make_interval(mins => ${LOCK_MINUTES}) then 1 else login_attempts.failures + 1 end,
      updated_at = case when login_attempts.updated_at < now() - make_interval(mins => ${LOCK_MINUTES}) then now() else login_attempts.updated_at end
    returning failures`);
  return Number((r.rows[0] as { failures: number }).failures) <= max;
}

/** True when the key already reached its limit in the current window (does not count an attempt). */
export async function attemptsExhausted(ctx: AppCtx, key: string, max: number): Promise<boolean> {
  const r = await ctx.db.execute(sql`
    select failures from login_attempts where key = ${key} and updated_at >= now() - make_interval(mins => ${LOCK_MINUTES})`);
  return r.rows.length > 0 && Number((r.rows[0] as { failures: number }).failures) >= max;
}

/** Rate-limit key part for a client address: IPv6 clients usually control a whole /64, so they share one key. */
export function clientKey(ip: string): string {
  if (!ip.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip.replace(/^::ffff:/i, '');
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g || '0', 16) || 0).toString(16))
    .join(':')}::/64`;
}

export async function clearAttempts(ctx: AppCtx, ...keys: string[]) {
  for (const key of keys) await ctx.db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}

export function authRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { config } = ctx;
  const redirectUri = `${config.APP_URL}/api/auth/callback`;
  // Sign-in redirects: generous enough for a shared office IP; a 429 here redirects to /login?error=rate_limited (app.ts).
  const ssoLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const pwLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/api/auth/config', async () => {
    const rt = await getRuntime(ctx);
    return {
      entra: !config.LOCAL_MODE && rt.entra.usable,
      password: !config.LOCAL_MODE && rt.password.enabled,
      breakglass: config.BREAKGLASS_ENABLED,
      demoLogin: await demoLoginAvailable(ctx),
      local: config.LOCAL_MODE,
      setupRequired: await setupRequired(ctx),
    };
  });

  app.get('/api/auth/me', async (req, reply) => {
    // Local mode: no login, the browser on this machine gets a local administrator session. Inside a container
    // the first session needs the one-time startup link (?local_token=...), sent once as query or header.
    if (config.LOCAL_MODE && !req.user) {
      if (config.LOCAL_REQUIRE_TOKEN) {
        const q = (req.query as Record<string, unknown>)?.local_token;
        const h = req.headers['x-local-token'];
        const presented = typeof q === 'string' ? q : typeof h === 'string' ? h : '';
        if (!presented || !safeEqual(presented, localAccessToken(ctx))) {
          throw new HttpError(401, 'Open the sign-in link printed in the container log (docker logs) to start a session');
        }
      }
      const id = await ensureLocalAdmin(ctx);
      req.cookies[cookieName(ctx)] = await createSession(ctx, req, reply, id, 'local');
      await loadSession(ctx, req);
    }
    const user = requireUser(req);
    const rt = await getRuntime(ctx);
    const local = req.session!.authMethod === 'local';
    return {
      user,
      csrfToken: req.session!.csrfToken,
      authMethod: req.session!.authMethod,
      sessionExpiresAt: req.session!.expiresAt,
      /** Sessions end after this many minutes without requests (in addition to sessionExpiresAt). */
      idleMinutes: rt.general.sessionIdleMinutes,
      /** The temporary password must be changed before anything else works (403 password_change_required). */
      mustChangePassword: passwordChangePending(req),
      /** Sensitive settings need a sign-in after this moment (403 reauth_required). Local mode is exempt. */
      recentAuthUntil: (local ? req.session!.expiresAt : recentAuthUntil(req))?.toISOString() ?? null,
      features: {
        demo: rt.general.demoMode,
        local: config.LOCAL_MODE,
        scannerAws: Boolean(rt.scanner.env.aws),
        scannerMs: Boolean(rt.scanner.env.ms),
        scannerMsClientId: rt.scanner.ms.clientId,
      },
    };
  });

  app.get('/api/auth/login', ssoLimit, async (req, reply) => {
    const rt = await getRuntime(ctx);
    if (config.LOCAL_MODE || !rt.entra.usable) throw new HttpError(404, 'Microsoft sign-in is not configured');
    const q = (req.query ?? {}) as Record<string, unknown>;
    // ?reauth=1 from a signed-in browser: confirm the identity again (prompt=login), then mark the session as recent.
    const reauth = (q.reauth === '1' || q.reauth === 'true') && Boolean(req.user && req.session);
    const returnTo = safeReturnTo(q.returnTo);
    const oc = await entraConfig(rt);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    await ctx.db.insert(authStates).values({
      stateHash: sha256(state),
      kind: 'oidc',
      // Only the session's hash is kept; the callback arrives without the SameSite=Strict session cookie.
      data: { verifier, nonce, returnTo, version: rt.entra.version, ...(reauth ? { reauthSession: req.session!.idHash, reauthUser: req.user!.id } : {}) },
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    // Binds the flow to this browser (login CSRF protection). Lax so it survives the redirect back.
    reply.setCookie(OIDC_COOKIE, state, { path: '/api/auth', httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: STATE_TTL_MS / 1000 });
    const url = oidc.buildAuthorizationUrl(oc, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      response_mode: 'query',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: reauth ? 'login' : 'select_account',
      ...(reauth && req.user ? { login_hint: req.user.email } : {}),
    });
    return reply.redirect(url.href);
  });

  app.get('/api/auth/callback', ssoLimit, async (req, reply) => {
    const fail = (code: string, detail?: string) =>
      reply.redirect(`/login?error=${encodeURIComponent(code)}${detail ? `&code=${encodeURIComponent(detail)}` : ''}`);
    const q = req.query as Record<string, string>;
    const cookieState = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: '/api/auth' });
    if (q.error) return fail('idp_error');
    if (!q.state || !cookieState || !safeEqual(q.state, cookieState)) return fail('state_mismatch');

    const st = await ctx.db
      .delete(authStates)
      .where(and(eq(authStates.stateHash, sha256(q.state)), eq(authStates.kind, 'oidc'), gt(authStates.expiresAt, new Date())))
      .returning();
    if (!st[0]) return fail('state_expired');
    const { verifier, nonce, returnTo, version, reauthSession, reauthUser } = st[0].data as {
      verifier: string;
      nonce: string;
      returnTo?: string;
      version?: string;
      reauthSession?: string;
      reauthUser?: string;
    };
    const rt = await getRuntime(ctx);
    // Microsoft sign-in was switched off or reconfigured while this sign-in was in progress.
    if (config.LOCAL_MODE || !rt.entra.usable || (version && version !== rt.entra.version)) return fail('state_expired');

    let claims: oidc.IDToken;
    try {
      const oc = await entraConfig(rt);
      const current = new URL(`${redirectUri}?${new URLSearchParams(q).toString()}`);
      const tokens = await oidc.authorizationCodeGrant(oc, current, { pkceCodeVerifier: verifier, expectedState: q.state, expectedNonce: nonce, idTokenExpected: true });
      claims = tokens.claims()!;
    } catch (e) {
      req.log.warn({ err: e }, 'OIDC code exchange failed');
      return fail('token_error', oidcErrorCode(e));
    }

    const tid = String(claims.tid ?? '');
    const oid = String(claims.oid ?? '');
    // preferred_username is the UPN for member accounts; the optional email claim can be unverified.
    const email = String(claims.preferred_username ?? claims.email ?? '').toLowerCase();
    if (!oid || tid.toLowerCase() !== rt.entra.tenantId!.toLowerCase()) return fail('wrong_tenant');
    // Guests (B2B) carry an idp claim pointing at their home identity provider: not supported.
    if (claims.idp && String(claims.idp) !== String(claims.iss)) {
      await audit(ctx, req, 'auth.login_denied', undefined, { email, oid, reason: 'guest' });
      return fail('guest_not_supported');
    }
    if (rt.entra.requireMfa && !(Array.isArray(claims.amr) && claims.amr.includes('mfa'))) return fail('mfa_required');
    if (reauthSession && !(typeof claims.auth_time === 'number' && Date.now() / 1000 - claims.auth_time <= REAUTH_MAX_AGE_S)) return fail('reauth_failed');

    let user = (await ctx.db.select().from(users).where(eq(users.entraOid, oid)).limit(1))[0];
    if (!user && email) {
      const byEmail = (await ctx.db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1))[0];
      if (byEmail && !byEmail.entraOid && !byEmail.isBreakglass) {
        [user] = await ctx.db.update(users).set({ entraOid: oid, name: String(claims.name ?? byEmail.name) }).where(eq(users.id, byEmail.id)).returning();
      } else if (!byEmail && rt.bootstrapAdminEmail && email === rt.bootstrapAdminEmail && !(await realAdminExists(ctx))) {
        [user] = await ctx.db.insert(users).values({ email, name: String(claims.name ?? email), role: 'admin', entraOid: oid }).returning();
        await audit(ctx, req, 'user.bootstrap_admin', { type: 'user', id: user.id }, undefined, { id: user.id, email });
      }
    }
    if (!user) {
      await audit(ctx, req, 'auth.login_denied', undefined, { email, oid, reason: 'not_invited' });
      return fail('not_invited');
    }
    if (!user.active) {
      await audit(ctx, req, 'auth.login_denied', { type: 'user', id: user.id }, { email, oid, reason: 'inactive' });
      return fail('account_disabled');
    }
    const target = safeReturnTo(returnTo);
    if (reauthSession && reauthUser === user.id) {
      // Same person confirmed again: the existing session counts as recently authenticated.
      const upd = await ctx.db
        .update(sessions)
        .set({ reauthAt: new Date() })
        .where(and(eq(sessions.idHash, reauthSession), eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date())))
        .returning({ id: sessions.idHash });
      if (upd.length) {
        await audit(ctx, req, 'auth.reauth', { type: 'user', id: user.id }, { method: 'entra' }, { id: user.id, email: user.email });
        return reply.redirect(target);
      }
    }
    await createSession(ctx, req, reply, user.id, 'entra');
    await audit(ctx, req, 'auth.login', { type: 'user', id: user.id }, { method: 'entra' }, { id: user.id, email: user.email });
    return reply.redirect(target);
  });

  // ---------- local password sign-in ----------

  const accountKey = (email: string) => `pw:acct:${email.toLowerCase()}`;

  app.post('/api/auth/password/login', pwLimit, async (req, reply) => {
    const rt = await getRuntime(ctx);
    if (config.LOCAL_MODE || !rt.password.enabled) throw notFound();
    const body = parse(passwordLoginInput, req.body);
    const email = body.email.toLowerCase();
    const ipKey = `pw:ip:${clientKey(req.ip)}`;
    const acctKey = accountKey(email);
    // Per address: only failures count (checked here, counted below). Per account: every attempt counts
    // atomically before verification, so parallel guesses cannot slip under the limit.
    if (await attemptsExhausted(ctx, ipKey, PW_IP_MAX)) throw new HttpError(429, 'Too many failed sign-in attempts. Try again later.');
    if (!(await takeAttempt(ctx, acctKey, PW_ACCOUNT_MAX))) {
      await audit(ctx, req, 'auth.password_locked', undefined, { email });
      throw new HttpError(429, 'Too many failed sign-in attempts for this account. Try again in 15 minutes.');
    }
    const user = (await ctx.db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1))[0];
    const eligible = Boolean(user && !user.isDemo && !user.isBreakglass && user.email.toLowerCase() !== LOCAL_EMAIL);
    // Always verifies (a dummy hash without an account), so the timing does not reveal which accounts exist.
    const ok = await verifyPassword(eligible ? user!.passwordHash : null, body.password);
    if (!ok || !user!.active) {
      await takeAttempt(ctx, ipKey, PW_IP_MAX);
      // The typed email is only recorded for existing accounts (it may be a password typed into the wrong field).
      const reason = !user ? 'unknown_account' : !eligible ? 'not_allowed' : !user.passwordHash ? 'no_password' : ok ? 'inactive' : 'wrong_password';
      await audit(ctx, req, 'auth.password_failed', user ? { type: 'user', id: user.id } : undefined, user ? { email: user.email, reason } : { reason });
      throw new HttpError(401, INVALID_LOGIN);
    }
    await clearAttempts(ctx, acctKey);
    await createSession(ctx, req, reply, user.id, 'password');
    await audit(ctx, req, 'auth.login', { type: 'user', id: user.id }, { method: 'password' }, { id: user.id, email: user.email });
    return { ok: true, mustChangePassword: user.mustChangePassword };
  });

  app.post('/api/auth/password/change', pwLimit, async (req, reply) => {
    const me = requireUser(req);
    if (me.isDemo || me.isBreakglass || req.session!.authMethod === 'local') throw new HttpError(403, 'This account has no password to change');
    const body = parse(passwordChangeInput, req.body);
    const row = (await ctx.db.select().from(users).where(eq(users.id, me.id)).limit(1))[0];
    if (!row?.passwordHash) throw new HttpError(400, 'This account signs in with Microsoft and has no password');
    const acctKey = accountKey(row.email);
    if (!(await takeAttempt(ctx, acctKey, PW_ACCOUNT_MAX))) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    if (!(await verifyPassword(row.passwordHash, body.currentPassword))) {
      await audit(ctx, req, 'auth.password_change_failed', { type: 'user', id: me.id }, { reason: 'wrong_password' });
      throw new HttpError(400, 'The current password is incorrect');
    }
    const rt = await getRuntime(ctx);
    const problem = passwordProblem(body.newPassword, { minLength: rt.password.minLength, email: row.email });
    if (problem) throw new HttpError(400, problem);
    if (body.newPassword === body.currentPassword) throw new HttpError(400, 'Choose a new password that differs from the current one.');
    await ctx.db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), mustChangePassword: false })
      .where(eq(users.id, me.id));
    // Every other session of this account ends; this one gets a fresh token.
    const revoked = await ctx.db.delete(sessions).where(and(eq(sessions.userId, me.id), ne(sessions.idHash, req.session!.idHash))).returning({ id: sessions.idHash });
    await clearAttempts(ctx, acctKey);
    await createSession(ctx, req, reply, me.id, req.session!.authMethod);
    await audit(ctx, req, 'auth.password_changed', { type: 'user', id: me.id }, { otherSessionsRevoked: revoked.length, wasTemporary: row.mustChangePassword });
    return { ok: true };
  });

  /** Re-authentication for password sessions (Microsoft sessions use GET /api/auth/login?reauth=1). */
  app.post('/api/auth/reauth', pwLimit, async (req) => {
    const me = requireUser(req);
    if (req.session!.authMethod !== 'password') {
      throw new HttpError(400, req.session!.authMethod === 'entra' ? 'Confirm your identity with Microsoft sign-in' : 'Sign in again to confirm your identity');
    }
    const body = parse(reauthInput, req.body);
    const row = (await ctx.db.select().from(users).where(eq(users.id, me.id)).limit(1))[0];
    const acctKey = accountKey(row.email);
    if (!(await takeAttempt(ctx, acctKey, PW_ACCOUNT_MAX))) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    if (!(await verifyPassword(row.passwordHash, body.password))) {
      await audit(ctx, req, 'auth.reauth_failed', { type: 'user', id: me.id });
      throw new HttpError(400, 'The password is incorrect');
    }
    await clearAttempts(ctx, acctKey);
    const now = new Date();
    await ctx.db.update(sessions).set({ reauthAt: now }).where(eq(sessions.idHash, req.session!.idHash));
    req.session!.reauthAt = now;
    await audit(ctx, req, 'auth.reauth', { type: 'user', id: me.id }, { method: 'password' });
    return { ok: true, recentAuthUntil: recentAuthUntil(req)!.toISOString() };
  });

  const bgSchema = z.object({ username: z.string().max(200), password: z.string().max(500), totp: z.string().max(10) });

  app.post('/api/auth/breakglass', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!config.BREAKGLASS_ENABLED) throw new HttpError(404, 'Not found');
    const body = parse(bgSchema, req.body);
    // Per client IP only: a shared lock would let anyone keep the emergency account locked out.
    // Password (Argon2id) plus TOTP makes guessing infeasible within the per-IP limit.
    const ipKey = `bg:ip:${clientKey(req.ip)}`;
    if (!(await takeAttempt(ctx, ipKey))) {
      await audit(ctx, req, 'auth.breakglass_locked');
      throw new HttpError(429, 'Too many failed attempts. Try again later.');
    }
    // Distributed guessing: past the global ceiling every attempt is slowed down (no hard lock, see above).
    if (await attemptsExhausted(ctx, 'bg:all', BREAKGLASS_GLOBAL_MAX)) {
      req.log.warn({ ceiling: BREAKGLASS_GLOBAL_MAX }, 'break-glass: global failure ceiling reached, slowing down attempts');
      await new Promise((r) => setTimeout(r, BREAKGLASS_SLOWDOWN_MS));
    }
    const userOk = safeEqual(body.username, config.BREAKGLASS_USERNAME!);
    const pwOk = await argonVerify(config.BREAKGLASS_PASSWORD_HASH!, body.password).catch(() => false);
    const step = verifyTotp(config.BREAKGLASS_TOTP_SECRET!, body.totp);
    let replay = false;
    if (userOk && pwOk && step !== null) {
      // Each TOTP time step can be used once (keyed on the step that matched, not the current one).
      const used = await ctx.db
        .insert(authStates)
        .values({ stateHash: sha256(`totp-step:${step}`), kind: 'totp', data: {}, expiresAt: new Date(Date.now() + 5 * 60_000) })
        .onConflictDoNothing()
        .returning();
      replay = used.length === 0;
    }
    if (!(userOk && pwOk && step !== null) || replay) {
      // Never log the typed username: it may be a password pasted into the wrong field.
      await audit(ctx, req, 'auth.breakglass_failed', undefined, { usernameMatched: userOk });
      if (!(await takeAttempt(ctx, 'bg:all', BREAKGLASS_GLOBAL_MAX))) {
        req.log.warn({ ceiling: BREAKGLASS_GLOBAL_MAX }, 'break-glass: many failed attempts from several addresses');
      }
      throw new HttpError(401, 'Invalid credentials');
    }
    await clearAttempts(ctx, ipKey);

    let user = (await ctx.db.select().from(users).where(eq(users.isBreakglass, true)).limit(1))[0];
    if (!user) {
      [user] = await ctx.db
        .insert(users)
        .values({ email: 'breakglass@local', name: 'Break-glass administrator', role: 'admin', isBreakglass: true })
        .returning();
    }
    await createSession(ctx, req, reply, user.id, 'breakglass');
    await audit(ctx, req, 'auth.breakglass_login', { type: 'user', id: user.id }, { warning: 'Emergency access used' }, { id: user.id, email: user.email });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.user) await audit(ctx, req, 'auth.logout');
    await destroySession(ctx, req, reply);
    return { ok: true };
  });
}

const localTokens = new WeakMap<AppCtx, string>();

/** One-time startup token of a local installation in a container (kept in memory, new on every start). */
export function localAccessToken(ctx: AppCtx): string {
  let t = localTokens.get(ctx);
  if (!t) {
    t = randomToken(24);
    localTokens.set(ctx, t);
  }
  return t;
}

/** The single administrator account of a local installation. */
async function ensureLocalAdmin(ctx: AppCtx): Promise<string> {
  const u = (await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${LOCAL_EMAIL}`).limit(1))[0];
  if (u) return u.id;
  const [created] = await ctx.db.insert(users).values({ email: LOCAL_EMAIL, name: 'Local administrator', role: 'admin' }).returning();
  return created.id;
}
