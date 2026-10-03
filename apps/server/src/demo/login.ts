import { hash, verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { attemptsExhausted, clearAttempts, clientKey, takeAttempt } from '../auth/routes.js';
import { createSession, requireRole } from '../auth/session.js';
import { HttpError, notFound, type AppCtx } from '../context.js';
import { customerAssignments, customers, sessions, settings, users } from '../db/schema.js';
import { parse } from '../routes/helpers.js';

const KEY = 'demo_login';
const DEMO_EMAIL = 'demo-visitor@local';
const DEMO_GLOBAL_MAX = 300;

interface DemoLoginSetting {
  enabled: boolean;
  pinHash: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function getDemoLogin(ctx: AppCtx): Promise<DemoLoginSetting> {
  const r = (await ctx.db.select().from(settings).where(eq(settings.key, KEY)).limit(1))[0];
  const v = (r?.value ?? {}) as Partial<DemoLoginSetting>;
  return { enabled: Boolean(v.enabled), pinHash: v.pinHash ?? null, updatedAt: v.updatedAt ?? null, updatedBy: v.updatedBy ?? null };
}

export async function demoLoginAvailable(ctx: AppCtx) {
  if (!ctx.config.DEMO_MODE) return false;
  const s = await getDemoLogin(ctx);
  return s.enabled && Boolean(s.pinHash);
}

/** The shared demo visitor account, assigned to every demo organisation and nothing else. */
export async function ensureDemoUser(ctx: AppCtx): Promise<string> {
  let u = (await ctx.db.select().from(users).where(eq(users.isDemo, true)).limit(1))[0];
  if (!u) {
    [u] = await ctx.db
      .insert(users)
      .values({ email: DEMO_EMAIL, name: 'Demo visitor', role: 'consultant', isDemo: true })
      .returning();
  }
  const demoCustomers = await ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.isDemo, true));
  if (demoCustomers.length) {
    await ctx.db
      .insert(customerAssignments)
      .values(demoCustomers.map((c) => ({ userId: u.id, customerId: c.id, permission: 'edit' as const })))
      .onConflictDoNothing();
  }
  return u.id;
}

async function revokeDemoSessions(ctx: AppCtx) {
  const u = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.isDemo, true)).limit(1))[0];
  if (u) await ctx.db.delete(sessions).where(eq(sessions.userId, u.id));
}

export function demoLoginRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get('/api/admin/demo/login', async (req) => {
    requireRole(req, 'admin');
    if (!ctx.config.DEMO_MODE) throw notFound();
    const s = await getDemoLogin(ctx);
    return { enabled: s.enabled, pinSet: Boolean(s.pinHash), updatedAt: s.updatedAt, updatedBy: s.updatedBy };
  });

  app.put('/api/admin/demo/login', async (req) => {
    const me = requireRole(req, 'admin');
    if (me.isDemo) throw new HttpError(403, 'Forbidden');
    if (!ctx.config.DEMO_MODE) throw notFound();
    const body = parse(z.object({ enabled: z.boolean(), pin: z.string().regex(/^\d{8,12}$/, 'PIN must be 8 to 12 digits').optional() }), req.body);
    const current = await getDemoLogin(ctx);
    const pinHash = body.pin ? await hash(body.pin, { memoryCost: 65536, timeCost: 3, parallelism: 1 }) : current.pinHash;
    if (body.enabled && !pinHash) throw new HttpError(400, 'Set a PIN before enabling demo login');
    const value: DemoLoginSetting = { enabled: body.enabled, pinHash, updatedAt: new Date().toISOString(), updatedBy: me.email };
    await ctx.db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    // A new PIN or disabling demo login ends all existing demo sessions.
    if (!body.enabled || body.pin) await revokeDemoSessions(ctx);
    if (body.enabled) await ensureDemoUser(ctx);
    await audit(ctx, req, 'demo.login_settings', undefined, { enabled: body.enabled, pinChanged: Boolean(body.pin) });
    return { ok: true };
  });

  app.post('/api/auth/demo', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!(await demoLoginAvailable(ctx))) throw notFound();
    const { pin } = parse(z.object({ pin: z.string().max(20) }), req.body);
    const ipKey = `demo:ip:${clientKey(req.ip)}`;
    // Per IP 5 attempts per 15 minutes, plus a global ceiling of wrong PINs against distributed guessing.
    // A global lock only blocks demo access, never real accounts; successful logins do not count towards it.
    if (!(await takeAttempt(ctx, ipKey)) || (await attemptsExhausted(ctx, 'demo:all', DEMO_GLOBAL_MAX))) {
      throw new HttpError(429, 'Too many attempts. Try again later.');
    }
    const s = await getDemoLogin(ctx);
    const ok = /^\d{8,12}$/.test(pin) && (await verify(s.pinHash!, pin).catch(() => false));
    if (!ok) {
      await takeAttempt(ctx, 'demo:all', DEMO_GLOBAL_MAX);
      await audit(ctx, req, 'auth.demo_failed');
      throw new HttpError(401, 'Invalid PIN');
    }
    await clearAttempts(ctx, ipKey);
    const userId = await ensureDemoUser(ctx);
    await createSession(ctx, req, reply, userId, 'demo');
    await audit(ctx, req, 'auth.demo_login', { type: 'user', id: userId }, undefined, { id: userId, email: DEMO_EMAIL });
    return { ok: true };
  });
}
