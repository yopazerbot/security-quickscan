import { brandingSchema, CHECKS, ISO_CONTROLS, ISO_THEME_LABELS, userInputSchema, userUpdateSchema, type Branding, type Role } from '@qs/shared';
import { awsPrincipalArn, IMPLEMENTED_CHECKS } from '@qs/checks';
import { and, desc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireRole, requireUser } from '../auth/session.js';
import { scannerEnv } from '../config.js';
import { badRequest, notFound, type AppCtx } from '../context.js';
import { auditLog, customerAssignments, customers, scans, sessions, settings, users } from '../db/schema.js';
import { resetDemo } from '../demo/seed.js';
import { ownerCandidateProblem } from './customers.js';
import { parse, uuidParam } from './helpers.js';

type Tx = Parameters<Parameters<AppCtx['db']['transaction']>[0]>[0];
const ROLE_RANK: Record<Role, number> = { viewer: 0, consultant: 1, admin: 2 };

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

  /** Public identifiers of the platform's own scanner identities (shown in the setup guidance). */
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

  /** Demo mode only: delete the fictional demo organisation(s) and seed them again. */
  app.post('/api/admin/demo/reset', async (req) => {
    requireRole(req, 'admin');
    if (!ctx.config.DEMO_MODE) throw notFound();
    await resetDemo(ctx);
    await audit(ctx, req, 'demo.reset');
    return { ok: true };
  });

  // ---------- users ----------

  app.get('/api/users', async (req) => {
    requireRole(req, 'admin');
    const rows = await db.select().from(users).orderBy(users.name);
    const active = await db
      .select({ userId: sessions.userId, n: sql<number>`count(*)::int`, last: sql<Date>`max(${sessions.lastSeenAt})` })
      .from(sessions)
      .groupBy(sessions.userId);
    const owned = await db
      .select({ ownerId: customers.ownerId, n: sql<number>`count(*)::int` })
      .from(customers)
      .where(isNotNull(customers.ownerId))
      .groupBy(customers.ownerId);
    return rows.map((u) => ({
      ...u,
      activeSessions: active.find((a) => a.userId === u.id)?.n ?? 0,
      lastSeenAt: active.find((a) => a.userId === u.id)?.last ?? null,
      ownedCount: owned.find((o) => o.ownerId === u.id)?.n ?? 0,
    }));
  });

  app.post('/api/users', async (req) => {
    requireRole(req, 'admin');
    const body = parse(userInputSchema, req.body);
    const exists = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);
    if (exists.length) throw badRequest('A user with this email already exists');
    const [u] = await db.insert(users).values({ ...body, email: body.email.toLowerCase() }).returning();
    await audit(ctx, req, 'user.create', { type: 'user', id: u.id }, { email: u.email, role: u.role });
    return u;
  });

  /**
   * Offboarding: a user who owns organisations can only be deleted, deactivated or demoted to viewer
   * when the admin names a new owner in the same request. Runs inside the caller's transaction and
   * returns the organisations that need a new owner (without newOwnerId) or were reassigned.
   */
  async function reassignOwned(
    tx: Tx,
    from: { id: string; email: string },
    newOwnerId: string | undefined,
    keepOldAs: 'edit' | 'view' | null,
    grantedBy: string,
  ): Promise<{ conflict: { id: string; name: string }[] } | { moved: { id: string; name: string }[]; to: { id: string; email: string } | null }> {
    const owned = await tx
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.ownerId, from.id))
      .orderBy(customers.name)
      .for('update');
    if (!owned.length) return { moved: [], to: null };
    if (!newOwnerId) return { conflict: owned };
    if (newOwnerId === from.id) throw badRequest('Choose a different person as the new owner');
    const to = (await tx.select().from(users).where(eq(users.id, newOwnerId)).limit(1).for('update'))[0];
    const problem = ownerCandidateProblem(to);
    if (problem) throw badRequest(`New owner: ${problem}`);
    const ids = owned.map((c) => c.id);
    await tx.update(customers).set({ ownerId: to!.id, updatedAt: new Date() }).where(inArray(customers.id, ids));
    await tx.delete(customerAssignments).where(and(eq(customerAssignments.userId, to!.id), inArray(customerAssignments.customerId, ids)));
    if (keepOldAs) {
      await tx
        .insert(customerAssignments)
        .values(ids.map((customerId) => ({ userId: from.id, customerId, permission: keepOldAs, grantedBy })))
        .onConflictDoUpdate({ target: [customerAssignments.userId, customerAssignments.customerId], set: { permission: keepOldAs } });
    }
    return { moved: owned, to: { id: to!.id, email: to!.email } };
  }

  async function auditOwnerChanges(req: FastifyRequest, moved: { id: string; name: string }[], from: { id: string; email: string }, to: { id: string; email: string } | null, reason: string) {
    if (!to) return;
    for (const c of moved) {
      await audit(ctx, req, 'customer.owner_change', { type: 'customer', id: c.id }, { name: c.name, from: from.id, fromEmail: from.email, to: to.id, toEmail: to.email, reason });
    }
  }

  const ownerConflict = (reply: FastifyReply, owned: { id: string; name: string }[], verb: string) =>
    reply.code(409).send({
      error: `This user owns ${owned.length} organisation${owned.length === 1 ? '' : 's'}. Choose a new owner before you ${verb} them.`,
      ownedOrganisations: owned,
    });

  app.patch('/api/users/:userId', async (req, reply) => {
    const me = requireRole(req, 'admin');
    const id = uuidParam(req, 'userId');
    const { newOwnerId, ...body } = parse(userUpdateSchema, req.body);
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target) throw notFound();
    if (target.isBreakglass) throw badRequest('The break-glass account is managed through environment variables');
    if (target.isDemo) throw badRequest('The demo visitor account is managed under Settings, Demo data');
    if (id === me.id && ((body.role && body.role !== 'admin') || body.active === false)) throw badRequest('You cannot demote or deactivate yourself');
    // Only fields that actually change are written and audited.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['name', 'role', 'active'] as const) {
      if (body[k] !== undefined && body[k] !== target[k]) changes[k] = { from: target[k], to: body[k] };
    }
    if (!Object.keys(changes).length) return { ok: true };
    const deactivate = target.active && body.active === false;
    const demoteToViewer = target.role !== 'viewer' && body.role === 'viewer';
    const downgrade = Boolean(changes.role) && ROLE_RANK[body.role!] < ROLE_RANK[target.role];
    const reason = deactivate ? 'user.deactivate' : 'user.demote';
    const verb = deactivate ? 'deactivate' : 'demote';
    const result = await db.transaction(async (tx) => {
      let moved: Awaited<ReturnType<typeof reassignOwned>> = { moved: [], to: null };
      if (deactivate || demoteToViewer) {
        // A deactivated user loses access anyway; a demoted one keeps read access to what they owned.
        moved = await reassignOwned(tx, target, newOwnerId, deactivate ? null : 'view', me.id);
        if ('conflict' in moved) return moved;
      }
      const set = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to]));
      await tx.update(users).set(set).where(eq(users.id, id));
      // Viewer accounts can only view: store the effective permission on their shares.
      if (demoteToViewer) await tx.update(customerAssignments).set({ permission: 'view' }).where(eq(customerAssignments.userId, id));
      if (deactivate || downgrade) await tx.delete(sessions).where(eq(sessions.userId, id));
      return moved;
    });
    if ('conflict' in result) return ownerConflict(reply, result.conflict, verb);
    await audit(ctx, req, 'user.update', { type: 'user', id }, { email: target.email, changes });
    await auditOwnerChanges(req, result.moved, target, result.to, reason);
    return { ok: true, reassigned: result.moved.length };
  });

  app.delete('/api/users/:userId', async (req, reply) => {
    const me = requireRole(req, 'admin');
    const id = uuidParam(req, 'userId');
    // newOwnerId in the JSON body or the query string (some clients send no body with DELETE).
    const fromBody = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).newOwnerId : undefined;
    const fromQuery = (req.query as Record<string, unknown>)?.newOwnerId;
    const { newOwnerId } = parse(z.object({ newOwnerId: z.uuid().optional() }), { newOwnerId: fromBody ?? fromQuery });
    if (id === me.id) throw badRequest('You cannot delete yourself');
    const target = (await db.select().from(users).where(and(eq(users.id, id), eq(users.isBreakglass, false))).limit(1))[0];
    if (!target) throw notFound();
    const result = await db.transaction(async (tx) => {
      const moved = await reassignOwned(tx, target, newOwnerId, null, me.id);
      if ('conflict' in moved) return moved;
      await tx.delete(users).where(eq(users.id, id));
      return moved;
    });
    if ('conflict' in result) return ownerConflict(reply, result.conflict, 'delete');
    await audit(ctx, req, 'user.delete', { type: 'user', id }, { email: target.email, name: target.name });
    await auditOwnerChanges(req, result.moved, target, result.to, 'user.delete');
    return { ok: true, reassigned: result.moved.length };
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
    const q = parse(
      z.object({
        before: z.coerce.number().int().optional(),
        action: z.string().max(100).optional(),
        organisationId: z.uuid().optional(),
        userId: z.uuid().optional(),
      }),
      req.query,
    );
    const conds = [];
    if (q.before) conds.push(lt(auditLog.id, q.before));
    // Prefix match; LIKE wildcards in the input are escaped (actions contain '_', e.g. customer.owner_change).
    if (q.action) conds.push(sql`${auditLog.action} like ${`${q.action.replace(/[\\%_]/g, '\\$&')}%`}`);
    if (q.organisationId) {
      // Events on the organisation itself and on its scans.
      conds.push(
        sql`((${auditLog.targetType} = 'customer' and ${auditLog.targetId} = ${q.organisationId})
          or (${auditLog.targetType} = 'scan' and ${auditLog.targetId} in (select ${scans.id}::text from ${scans} where ${scans.customerId} = ${q.organisationId})))`,
      );
    }
    if (q.userId) {
      // Done by the user, or done to the user (account changes, shares, ownership).
      conds.push(
        sql`(${auditLog.userId} = ${q.userId}
          or (${auditLog.targetType} = 'user' and ${auditLog.targetId} = ${q.userId})
          or ${auditLog.details}->>'userId' = ${q.userId}
          or ${auditLog.details}->>'to' = ${q.userId}
          or ${auditLog.details}->>'from' = ${q.userId})`,
      );
    }
    const targetUser = alias(users, 'target_user');
    const rows = await db
      .select({
        log: auditLog,
        actorEmail: sql<string | null>`coalesce(${auditLog.userEmail}, ${users.email})`,
        targetName: sql<string | null>`coalesce(${customers.name}, ${targetUser.name}, ${auditLog.details}->>'name')`,
        targetEmail: sql<string | null>`coalesce(${targetUser.email}, ${auditLog.details}->>'targetEmail', ${auditLog.details}->>'toEmail', ${auditLog.details}->>'email')`,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .leftJoin(customers, sql`${auditLog.targetType} = 'customer' and ${customers.id}::text = ${auditLog.targetId}`)
      .leftJoin(
        targetUser,
        sql`${targetUser.id}::text = case when ${auditLog.targetType} = 'user' then ${auditLog.targetId} else ${auditLog.details}->>'userId' end`,
      )
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(100);
    return rows.map((r) => ({ ...r.log, userEmail: r.actorEmail, actorEmail: r.actorEmail, targetName: r.targetName, targetEmail: r.targetEmail }));
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
    await audit(ctx, req, 'settings.logo_removed');
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
