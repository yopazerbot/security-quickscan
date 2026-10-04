import { setupInput } from '@qs/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import type { AppCtx } from '../context.js';
import { HttpError, notFound } from '../context.js';
import { randomToken, safeEqual, sha256 } from '../crypto/envelope.js';
import { settings, users } from '../db/schema.js';
import { parse } from '../routes/helpers.js';
import { getRuntime, invalidateRuntime, SETTING_KEYS, type PasswordStored } from '../settings/runtime.js';
import { hashPassword, passwordProblem } from './password.js';
import { clientKey, takeAttempt } from './routes.js';
import { createSession } from './session.js';

/** The administrator of a local installation (LOCAL_MODE) never counts as a real administrator. */
export const LOCAL_EMAIL = 'local-admin@localhost';

/** Active administrators that are real people (not demo, break-glass or the local-mode account). */
const realAdmin = sql`${users.role} = 'admin' and ${users.active} and not ${users.isDemo} and not ${users.isBreakglass} and lower(${users.email}) <> ${LOCAL_EMAIL}`;

/**
 * Administrators able to sign in per method, for the lockout guards:
 * - password: a password is set;
 * - entra: linked to a Microsoft account (entra_oid), or without a password (invited for single sign-on: their
 *   first Microsoft sign-in links the account by email). An admin with only a password does not count.
 */
export async function adminsByMethod(ctx: Pick<AppCtx, 'db'>): Promise<{ entra: number; password: number }> {
  const r = await ctx.db.execute(sql`
    select count(*) filter (where ${users.passwordHash} is not null)::int as password,
           count(*) filter (where ${users.entraOid} is not null or ${users.passwordHash} is null)::int as entra
    from ${users} where ${realAdmin}`);
  const row = r.rows[0] as { password: number; entra: number };
  return { entra: Number(row.entra), password: Number(row.password) };
}

export async function realAdminExists(ctx: Pick<AppCtx, 'db'>): Promise<boolean> {
  const r = await ctx.db.select({ id: users.id }).from(users).where(realAdmin).limit(1);
  return r.length > 0;
}

/**
 * First-run setup is needed when nobody can administer the instance: no active administrator, and no
 * legacy bootstrap (Microsoft sign-in configured together with BOOTSTRAP_ADMIN_EMAIL). Never in local mode.
 */
export async function setupRequired(ctx: AppCtx): Promise<boolean> {
  if (ctx.config.LOCAL_MODE) return false;
  const rt = await getRuntime(ctx);
  if (rt.entra.usable && rt.bootstrapAdminEmail) return false;
  return !(await realAdminExists(ctx));
}

const setupTokens = new WeakMap<AppCtx, string>();

/** One-time setup token (in memory only, new on every start). */
function setupToken(ctx: AppCtx): string {
  let t = setupTokens.get(ctx);
  if (!t) {
    t = randomToken(24);
    setupTokens.set(ctx, t);
  }
  return t;
}

/** Test helper: the current setup token. */
export const setupTokenForTest = (ctx: AppCtx) => setupToken(ctx);

/** At startup: when setup is required, print the one-time setup link (like the local mode link). */
export async function announceSetup(ctx: AppCtx) {
  try {
    if (!(await setupRequired(ctx))) return;
  } catch (e) {
    ctx.log.error({ err: e }, 'could not check whether first-run setup is required');
    return;
  }
  const link = `${ctx.config.APP_URL}/setup?token=${setupToken(ctx)}`;
  ctx.log.warn(`First-run setup: no administrator exists yet. Open this one-time link to create one: ${link}`);
  if (ctx.config.NODE_ENV !== 'test') process.stderr.write(`\n  Security QuickScan needs a first administrator. Open this link to set it up:\n  ${link}\n\n`);
}

export function setupRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get('/api/setup/status', async () => ({ required: await setupRequired(ctx) }));

  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!(await setupRequired(ctx))) throw notFound();
    const body = parse(setupInput, req.body);
    const ipKey = `setup:ip:${clientKey(req.ip)}`;
    if (!(await takeAttempt(ctx, ipKey, 10))) throw new HttpError(429, 'Too many attempts. Try again later.');
    // Compare hashes: constant time, independent of the presented length.
    if (!safeEqual(sha256(body.token), sha256(setupToken(ctx)))) {
      await audit(ctx, req, 'setup.failed', undefined, { reason: 'invalid_token' });
      throw new HttpError(403, 'Invalid or expired setup link. Use the link printed in the server log.');
    }
    const rt = await getRuntime(ctx);
    const email = body.email.toLowerCase();
    const problem = passwordProblem(body.password, { minLength: rt.password.minLength, email });
    if (problem) throw new HttpError(400, problem);
    const passwordHash = await hashPassword(body.password);

    const created = await ctx.db.transaction(async (tx) => {
      // Serialises concurrent setup attempts; the check is repeated inside the lock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('qs:first-run-setup'))`);
      const existing = await tx.select({ id: users.id }).from(users).where(realAdmin).limit(1);
      if (existing.length) return null;
      const taken = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
      if (taken.length) throw new HttpError(400, 'A user with this email already exists');
      const [u] = await tx
        .insert(users)
        .values({ email, name: body.name, role: 'admin', passwordHash, passwordChangedAt: new Date(), mustChangePassword: false })
        .returning();
      const stored = ((await tx.select().from(settings).where(eq(settings.key, SETTING_KEYS.password)).limit(1))[0]?.value ?? {}) as PasswordStored;
      const value: PasswordStored = { ...stored, enabled: true, minLength: stored.minLength ?? rt.password.minLength };
      await tx
        .insert(settings)
        .values({ key: SETTING_KEYS.password, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
      return u;
    });
    if (!created) throw new HttpError(409, 'Setup has already been completed');
    invalidateRuntime();
    // The link is single use.
    setupTokens.delete(ctx);
    await createSession(ctx, req, reply, created.id, 'password');
    await audit(ctx, req, 'setup.completed', { type: 'user', id: created.id }, { email, passwordSignIn: 'enabled' }, { id: created.id, email });
    return { ok: true };
  });
}

