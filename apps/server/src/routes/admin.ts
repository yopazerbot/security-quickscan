import { brandingSchema, CHECKS, ISO_CONTROLS, ISO_THEME_LABELS, userInputSchema, type Branding } from '@qs/shared';
import { awsPrincipalArn, IMPLEMENTED_CHECKS } from '@qs/checks';
import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireRole, requireUser } from '../auth/session.js';
import { scannerEnv } from '../config.js';
import { badRequest, notFound, type AppCtx } from '../context.js';
import { auditLog, customerAssignments, sessions, settings, users } from '../db/schema.js';
import { parse, uuidParam } from './helpers.js';

export async function getBranding(ctx: AppCtx): Promise<Branding> {
  const r = (await ctx.db.select().from(settings).where(eq(settings.key, 'branding')).limit(1))[0];
  return brandingSchema.parse(r?.value ?? {});
}

export async function getLogo(ctx: AppCtx): Promise<{ mime: string; data: Buffer } | null> {
  const r = (await ctx.db.select().from(settings).where(eq(settings.key, 'logo')).limit(1))[0];
  if (!r) return null;
  const v = r.value as { mime: string; data: string };
  return { mime: v.mime, data: Buffer.from(v.data, 'base64') };
}

export function adminRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db } = ctx;

  app.get('/api/catalog', async (req) => {
    requireUser(req);
    return {
      checks: CHECKS.filter((c) => IMPLEMENTED_CHECKS.has(c.id)),
      isoControls: ISO_CONTROLS,
      isoThemes: ISO_THEME_LABELS,
    };
  });

  /** Public identifiers of the platform's own scanner identities (shown in customer guidance). */
  app.get('/api/platform', async (req) => {
    requireUser(req);
    let awsPrincipal: string | null = null;
    let awsError: string | null = null;
    try {
      awsPrincipal = await awsPrincipalArn(scannerEnv(ctx.config));
    } catch {
      awsError = 'The platform AWS credentials are invalid.';
    }
    return {
      awsPrincipal,
      awsError,
      msClientId: ctx.config.SCANNER_MS_CLIENT_ID ?? null,
      consentRedirectUri: `${ctx.config.APP_URL}/consent/callback`,
      demo: ctx.config.DEMO_MODE,
    };
  });

  // ---------- users ----------

  app.get('/api/users', async (req) => {
    requireRole(req, 'admin');
    const rows = await db.select().from(users).orderBy(users.name);
    const assigned = await db.select().from(customerAssignments);
    const active = await db
      .select({ userId: sessions.userId, n: sql<number>`count(*)::int`, last: sql<Date>`max(${sessions.lastSeenAt})` })
      .from(sessions)
      .groupBy(sessions.userId);
    return rows.map((u) => ({
      ...u,
      customerIds: assigned.filter((a) => a.userId === u.id).map((a) => a.customerId),
      activeSessions: active.find((a) => a.userId === u.id)?.n ?? 0,
      lastSeenAt: active.find((a) => a.userId === u.id)?.last ?? null,
    }));
  });

  app.post('/api/users', async (req) => {
    requireRole(req, 'admin');
    const body = parse(userInputSchema, req.body);
    const exists = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);
    if (exists.length) throw badRequest('A user with this e-mail already exists');
    const [u] = await db.insert(users).values({ ...body, email: body.email.toLowerCase() }).returning();
    await audit(ctx, req, 'user.create', { type: 'user', id: u.id }, { email: u.email, role: u.role });
    return u;
  });

  app.patch('/api/users/:userId', async (req) => {
    const me = requireRole(req, 'admin');
    const id = uuidParam(req, 'userId');
    const body = parse(userInputSchema.partial().omit({ email: true }), req.body);
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target) throw notFound();
    if (target.isBreakglass) throw badRequest('The break-glass account is managed through environment variables');
    if (id === me.id && (body.role && body.role !== 'admin' || body.active === false)) throw badRequest('You cannot demote or deactivate yourself');
    await db.update(users).set(body).where(eq(users.id, id));
    if (body.active === false || body.role) await db.delete(sessions).where(eq(sessions.userId, id));
    await audit(ctx, req, 'user.update', { type: 'user', id }, body);
    return { ok: true };
  });

  app.delete('/api/users/:userId', async (req) => {
    const me = requireRole(req, 'admin');
    const id = uuidParam(req, 'userId');
    if (id === me.id) throw badRequest('You cannot delete yourself');
    const del = await db.delete(users).where(and(eq(users.id, id), eq(users.isBreakglass, false))).returning({ email: users.email });
    if (!del.length) throw notFound();
    await audit(ctx, req, 'user.delete', { type: 'user', id }, { email: del[0].email });
    return { ok: true };
  });

  app.post('/api/users/:userId/revoke-sessions', async (req) => {
    requireRole(req, 'admin');
    const id = uuidParam(req, 'userId');
    const del = await db.delete(sessions).where(and(eq(sessions.userId, id), ne(sessions.idHash, req.session!.idHash))).returning({ id: sessions.idHash });
    await audit(ctx, req, 'user.revoke_sessions', { type: 'user', id }, { count: del.length });
    return { revoked: del.length };
  });

  // ---------- audit ----------

  app.get('/api/audit', async (req) => {
    requireRole(req, 'admin');
    const q = parse(z.object({ before: z.coerce.number().int().optional(), action: z.string().max(100).optional() }), req.query);
    const conds = [];
    if (q.before) conds.push(lt(auditLog.id, q.before));
    if (q.action) conds.push(sql`${auditLog.action} like ${`${q.action.replace(/[%_]/g, '')}%`}`);
    return db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(100);
  });

  // ---------- branding ----------

  app.get('/api/settings/branding', async (req) => {
    requireUser(req);
    const logo = await getLogo(ctx);
    return { ...(await getBranding(ctx)), hasLogo: Boolean(logo) };
  });

  app.put('/api/settings/branding', async (req) => {
    requireRole(req, 'admin');
    const body = parse(brandingSchema, req.body);
    await db.insert(settings).values({ key: 'branding', value: body }).onConflictDoUpdate({ target: settings.key, set: { value: body, updatedAt: new Date() } });
    await audit(ctx, req, 'settings.branding');
    return { ok: true };
  });

  app.put('/api/settings/logo', { bodyLimit: 1024 * 1024 }, async (req) => {
    requireRole(req, 'admin');
    const { contentBase64 } = parse(z.object({ contentBase64: z.string().max(700_000) }), req.body);
    const buf = Buffer.from(contentBase64, 'base64');
    // Only raster PNG/JPEG (no SVG: avoids script content in reports).
    const mime = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : null;
    if (!mime) throw badRequest('Logo must be a PNG or JPEG image');
    if (buf.length > 500_000) throw badRequest('Logo too large (max 500 KB)');
    const value = { mime, data: buf.toString('base64') };
    await db.insert(settings).values({ key: 'logo', value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    await audit(ctx, req, 'settings.logo');
    return { ok: true };
  });

  app.delete('/api/settings/logo', async (req) => {
    requireRole(req, 'admin');
    await db.delete(settings).where(eq(settings.key, 'logo'));
    return { ok: true };
  });

  app.get('/api/settings/logo', async (req, reply) => {
    requireUser(req);
    const logo = await getLogo(ctx);
    if (!logo) throw notFound();
    reply.header('Content-Type', logo.mime).header('Cache-Control', 'private, max-age=60');
    return reply.send(logo.data);
  });
}
