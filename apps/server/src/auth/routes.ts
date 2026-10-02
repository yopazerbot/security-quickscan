import { verify as argonVerify } from '@node-rs/argon2';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { audit } from '../audit.js';
import { entraEnabled } from '../config.js';
import type { AppCtx } from '../context.js';
import { HttpError } from '../context.js';
import { safeEqual, sha256 } from '../crypto/envelope.js';
import { authStates, loginAttempts, users } from '../db/schema.js';
import { cookieName, createSession, destroySession, loadSession, requireUser } from './session.js';
import { verifyTotp } from './totp.js';
import { parse } from '../routes/helpers.js';
import { demoLoginAvailable } from '../demo/login.js';

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

let discovered: Promise<oidc.Configuration> | null = null;
function entraConfig(ctx: AppCtx) {
  if (!discovered) {
    const c = ctx.config;
    discovered = oidc
      .discovery(new URL(`https://login.microsoftonline.com/${c.ENTRA_TENANT_ID}/v2.0`), c.ENTRA_CLIENT_ID!, c.ENTRA_CLIENT_SECRET!)
      .catch((e) => {
        discovered = null;
        throw e;
      });
  }
  return discovered;
}

/**
 * Counts an attempt atomically *before* the credentials are verified (so parallel requests cannot
 * all slip in under the limit). The counter resets after LOCK_MINUTES without attempts.
 * Returns false when the key is over its limit.
 */
export async function takeAttempt(ctx: AppCtx, key: string, max = MAX_FAILURES): Promise<boolean> {
  const r = await ctx.db.execute(sql`
    insert into login_attempts (key, failures, updated_at) values (${key}, 1, now())
    on conflict (key) do update set
      failures = case when login_attempts.updated_at < now() - make_interval(mins => ${LOCK_MINUTES}) then 1 else login_attempts.failures + 1 end,
      updated_at = now()
    returning failures`);
  return Number((r.rows[0] as { failures: number }).failures) <= max;
}

export async function clearAttempts(ctx: AppCtx, ...keys: string[]) {
  for (const key of keys) await ctx.db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}

export function authRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { config } = ctx;
  const redirectUri = `${config.APP_URL}/api/auth/callback`;
  const strictLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/api/auth/config', async () => ({
    entra: entraEnabled(config),
    breakglass: config.BREAKGLASS_ENABLED,
    demoLogin: await demoLoginAvailable(ctx),
    local: config.LOCAL_MODE,
  }));

  app.get('/api/auth/me', async (req, reply) => {
    // Local mode: no login, the browser on this machine gets a local administrator session.
    if (config.LOCAL_MODE && !req.user) {
      const id = await ensureLocalAdmin(ctx);
      req.cookies[cookieName(ctx)] = await createSession(ctx, req, reply, id, 'local');
      await loadSession(ctx, req);
    }
    const user = requireUser(req);
    return {
      user,
      csrfToken: req.session!.csrfToken,
      authMethod: req.session!.authMethod,
      sessionExpiresAt: req.session!.expiresAt,
      features: {
        demo: config.DEMO_MODE,
        local: config.LOCAL_MODE,
        scannerAws: Boolean(config.SCANNER_AWS_ACCESS_KEY_ID),
        scannerMs: Boolean(config.SCANNER_MS_CLIENT_ID),
        scannerMsClientId: config.SCANNER_MS_CLIENT_ID ?? null,
      },
    };
  });

  app.get('/api/auth/login', strictLimit, async (req, reply) => {
    if (!entraEnabled(config)) throw new HttpError(404, 'Microsoft sign-in is not configured');
    const oc = await entraConfig(ctx);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    await ctx.db.insert(authStates).values({
      stateHash: sha256(state),
      kind: 'oidc',
      data: { verifier, nonce },
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
      prompt: 'select_account',
    });
    return reply.redirect(url.href);
  });

  app.get('/api/auth/callback', strictLimit, async (req, reply) => {
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
    const { verifier, nonce } = st[0].data as { verifier: string; nonce: string };

    let claims: oidc.IDToken;
    try {
      const oc = await entraConfig(ctx);
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
    if (!oid || tid.toLowerCase() !== config.ENTRA_TENANT_ID!.toLowerCase()) return fail('wrong_tenant');
    // Guests (B2B) carry an idp claim pointing at their home identity provider: not supported.
    if (claims.idp && String(claims.idp) !== String(claims.iss)) {
      await audit(ctx, req, 'auth.login_denied', undefined, { email, oid, reason: 'guest' });
      return fail('guest_not_supported');
    }
    if (config.ENTRA_REQUIRE_MFA && !(Array.isArray(claims.amr) && claims.amr.includes('mfa'))) return fail('mfa_required');

    let user = (await ctx.db.select().from(users).where(eq(users.entraOid, oid)).limit(1))[0];
    if (!user && email) {
      const byEmail = (await ctx.db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1))[0];
      if (byEmail && !byEmail.entraOid && !byEmail.isBreakglass) {
        [user] = await ctx.db.update(users).set({ entraOid: oid, name: String(claims.name ?? byEmail.name) }).where(eq(users.id, byEmail.id)).returning();
      } else if (!byEmail && config.BOOTSTRAP_ADMIN_EMAIL && email === config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() && !(await realAdminExists(ctx))) {
        [user] = await ctx.db.insert(users).values({ email, name: String(claims.name ?? email), role: 'admin', allCustomers: true, entraOid: oid }).returning();
        await audit(ctx, req, 'user.bootstrap_admin', { type: 'user', id: user.id }, undefined, { id: user.id, email });
      }
    }
    if (!user || !user.active) {
      await audit(ctx, req, 'auth.login_denied', undefined, { email, oid, reason: user ? 'inactive' : 'not_invited' });
      return fail('not_invited');
    }
    await createSession(ctx, req, reply, user.id, 'entra');
    await audit(ctx, req, 'auth.login', { type: 'user', id: user.id }, { method: 'entra' }, { id: user.id, email: user.email });
    return reply.redirect('/');
  });

  const bgSchema = z.object({ username: z.string().max(200), password: z.string().max(500), totp: z.string().max(10) });

  /** Bootstrap only creates the first administrator, never again once one exists. */
  async function realAdminExists(c: AppCtx) {
    const r = await c.db.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), eq(users.isBreakglass, false), eq(users.isDemo, false), sql`${users.entraOid} is not null`)).limit(1);
    return r.length > 0;
  }

  app.post('/api/auth/breakglass', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!config.BREAKGLASS_ENABLED) throw new HttpError(404, 'Not found');
    const body = parse(bgSchema, req.body);
    // Per client IP only: a shared lock would let anyone keep the emergency account locked out.
    // Password (Argon2id) plus TOTP makes guessing infeasible within the per-IP limit.
    const ipKey = `bg:ip:${req.ip}`;
    if (!(await takeAttempt(ctx, ipKey))) {
      await audit(ctx, req, 'auth.breakglass_locked');
      throw new HttpError(429, 'Too many failed attempts. Try again later.');
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
      await audit(ctx, req, 'auth.breakglass_failed', undefined, { username: body.username.slice(0, 50) });
      throw new HttpError(401, 'Invalid credentials');
    }
    await clearAttempts(ctx, ipKey);

    let user = (await ctx.db.select().from(users).where(eq(users.isBreakglass, true)).limit(1))[0];
    if (!user) {
      [user] = await ctx.db
        .insert(users)
        .values({ email: 'breakglass@local', name: 'Break-glass administrator', role: 'admin', allCustomers: true, isBreakglass: true })
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

const LOCAL_EMAIL = 'local-admin@localhost';

/** The single administrator account of a local installation. */
async function ensureLocalAdmin(ctx: AppCtx): Promise<string> {
  const u = (await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${LOCAL_EMAIL}`).limit(1))[0];
  if (u) return u.id;
  const [created] = await ctx.db.insert(users).values({ email: LOCAL_EMAIL, name: 'Local administrator', role: 'admin', allCustomers: true }).returning();
  return created.id;
}
