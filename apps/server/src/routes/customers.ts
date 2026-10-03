import { CHECKS_BY_ID, computeRiskProfile, customerInputSchema, systemKey, triageSchema, type CustomerContext, type Role } from '@qs/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { takeAttempt } from '../auth/routes.js';
import { accessibleCustomerIds, assertCustomerAccess, customerAccess, requireRole, requireUser } from '../auth/session.js';
import { forbidden, HttpError, notFound, type AppCtx } from '../context.js';
import { checkResults, customerAssignments, customers, findingTriage, scans, scanSystems, users } from '../db/schema.js';
import { refreshCustomerScores } from '../scoring.js';
import { parse, uuidParam } from './helpers.js';

/** Why a user cannot own an organisation, or null when they can (active analyst or admin, no shared or emergency account). */
export function ownerCandidateProblem(u: { active: boolean; role: Role; isDemo: boolean; isBreakglass: boolean } | undefined): string | null {
  if (!u) return 'Account not found';
  if (!u.active) return 'This account is deactivated';
  if (u.isDemo || u.isBreakglass) return 'This account cannot own organisations';
  if (u.role === 'viewer') return 'Viewer accounts are read-only and cannot own an organisation';
  return null;
}

const NO_ACCOUNT = 'No account with this email. Ask an administrator to add them under Users.';

export function customerRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db } = ctx;

  app.get('/api/customers', async (req) => {
    const u = requireUser(req);
    const ids = await accessibleCustomerIds(ctx, u);
    if (ids && !ids.length) return [];
    const rows = await db
      .select()
      .from(customers)
      .where(ids ? inArray(customers.id, ids) : undefined)
      .orderBy(customers.name);
    const latest = rows.length
      ? await db
          .selectDistinctOn([scans.customerId], { customerId: scans.customerId, score: scans.score, grade: scans.grade, finishedAt: scans.finishedAt, id: scans.id })
          .from(scans)
          .where(and(inArray(scans.customerId, rows.map((r) => r.id)), eq(scans.status, 'completed')))
          .orderBy(scans.customerId, desc(scans.finishedAt))
      : [];
    const counts = rows.length
      ? await db
          .select({ customerId: scans.customerId, n: sql<number>`count(*)::int` })
          .from(scans)
          .where(inArray(scans.customerId, rows.map((r) => r.id)))
          .groupBy(scans.customerId)
      : [];
    const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => Boolean(x)))];
    const owners = ownerIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds)) : [];
    return rows.map((c) => ({
      id: c.id,
      owned: c.ownerId === u.id,
      ownerName: owners.find((o) => o.id === c.ownerId)?.name ?? null,
      name: c.name,
      contactName: c.contactName,
      country: c.country,
      industry: (c.context as any)?.industry,
      isDemo: c.isDemo,
      updatedAt: c.updatedAt,
      latestScan: latest.find((l) => l.customerId === c.id) ?? null,
      scanCount: counts.find((x) => x.customerId === c.id)?.n ?? 0,
    }));
  });

  app.post('/api/customers', async (req) => {
    const u = requireRole(req, 'admin', 'consultant');
    const body = parse(customerInputSchema, req.body);
    if (u.isDemo) {
      const n = (await db.select({ id: customers.id }).from(customers).where(eq(customers.isDemo, true))).length;
      if (n >= 15) throw new HttpError(429, 'Demo limit reached. An administrator can reset the demo data.');
    }
    // Organisations created by the demo visitor are demo data (removed by "Reset demo data"). The visitor is a
    // shared account, so it never owns them: it gets an edit share and only admins manage access.
    const c = await db.transaction(async (tx) => {
      const [row] = await tx.insert(customers).values({ ...body, createdBy: u.id, ownerId: u.isDemo ? null : u.id, isDemo: u.isDemo }).returning();
      if (u.isDemo) await tx.insert(customerAssignments).values({ userId: u.id, customerId: row.id, permission: 'edit' });
      return row;
    });
    await audit(ctx, req, 'customer.create', { type: 'customer', id: c.id }, { name: c.name });
    return c;
  });

  app.get('/api/customers/:customerId', async (req) => {
    const id = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, id);
    const myAccess = (await customerAccess(ctx, u, id))!;
    const c = (await db.select().from(customers).where(eq(customers.id, id)).limit(1))[0];
    if (!c) throw notFound();
    const scanRows = await db
      .select({
        id: scans.id,
        name: scans.name,
        status: scans.status,
        score: scans.score,
        grade: scans.grade,
        createdAt: scans.createdAt,
        startedAt: scans.startedAt,
        finishedAt: scans.finishedAt,
        wizardStep: scans.wizardStep,
        providers: sql<string[]>`coalesce((select array_agg(distinct ${scanSystems.provider}::text) from ${scanSystems} where ${scanSystems.scanId} = ${scans.id}), '{}'::text[])`,
      })
      .from(scans)
      .where(eq(scans.customerId, id))
      .orderBy(desc(scans.createdAt));
    const triage = await db.select().from(findingTriage).where(eq(findingTriage.customerId, id));
    const owner = c.ownerId ? (await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, c.ownerId)).limit(1))[0] ?? null : null;
    // The demo visitor is a shared account: it never sees who else has access.
    const manage = (myAccess === 'owner' || myAccess === 'admin') && !u.isDemo;
    // Need-to-know: only those who manage an organisation see who else has access to it.
    const shares = manage
      ? await db
          .select({
            userId: users.id,
            name: users.name,
            email: users.email,
            role: users.role,
            active: users.active,
            permission: customerAssignments.permission,
            grantedAt: customerAssignments.createdAt,
          })
          .from(customerAssignments)
          .innerJoin(users, eq(users.id, customerAssignments.userId))
          .where(eq(customerAssignments.customerId, id))
          .orderBy(users.name)
      : [];
    return {
      ...c,
      scans: scanRows,
      triage,
      myAccess,
      owner: owner && (manage ? owner : { id: owner.id, name: owner.name, email: '' }),
      shares,
    };
  });

  app.put('/api/customers/:customerId', async (req) => {
    const id = uuidParam(req, 'customerId');
    await assertCustomerAccess(ctx, req, id, true);
    const body = parse(customerInputSchema, req.body);
    const [c] = await db.update(customers).set({ ...body, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
    // Draft scans follow the customer context; started scans keep the snapshot they ran with.
    if (body.context) {
      await db
        .update(scans)
        .set({ context: body.context, riskProfile: computeRiskProfile(body.context as CustomerContext) })
        .where(and(eq(scans.customerId, id), eq(scans.status, 'draft')));
    }
    await audit(ctx, req, 'customer.update', { type: 'customer', id });
    return c;
  });

  app.delete('/api/customers/:customerId', async (req) => {
    const id = uuidParam(req, 'customerId');
    await assertCustomerAccess(ctx, req, id, 'manage');
    const c = (await db.select({ name: customers.name }).from(customers).where(eq(customers.id, id)).limit(1))[0];
    if (!c) throw notFound();
    // Cascades to scans, systems, credentials, results and triage.
    await db.delete(customers).where(eq(customers.id, id));
    await audit(ctx, req, 'customer.delete', { type: 'customer', id }, { name: c.name });
    return { ok: true };
  });

  // ---------- sharing (need-to-know) ----------

  const customerName = async (id: string) => (await db.select({ name: customers.name }).from(customers).where(eq(customers.id, id)).limit(1))[0]?.name ?? null;

  const permissionSchema = z.enum(['view', 'edit']);

  app.post('/api/customers/:customerId/shares', async (req) => {
    const id = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, id, 'manage');
    if (u.isDemo) throw new HttpError(403, 'Sharing is not available in a demo session');
    const body = parse(z.object({ email: z.email().max(320), permission: permissionSchema }), req.body);
    // Limits probing which email addresses have an account.
    if (!(await takeAttempt(ctx, `share:${u.id}`, 30))) throw new HttpError(429, 'Too many share attempts. Try again in 15 minutes.');
    const target = (
      await db
        .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, isDemo: users.isDemo, isBreakglass: users.isBreakglass })
        .from(users)
        .where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`)
        .limit(1)
    )[0];
    if (!target || target.isDemo || target.isBreakglass) throw new HttpError(404, NO_ACCOUNT);
    if (!target.active) throw new HttpError(400, 'This account is deactivated');
    const c = (await db.select({ ownerId: customers.ownerId, name: customers.name }).from(customers).where(eq(customers.id, id)).limit(1))[0];
    if (!c) throw notFound();
    if (target.id === c.ownerId) throw new HttpError(400, 'This person owns the organisation');
    // Store the effective permission: Viewer accounts can only ever view.
    const permission = target.role === 'viewer' ? 'view' : body.permission;
    await db
      .insert(customerAssignments)
      .values({ userId: target.id, customerId: id, permission, grantedBy: u.id })
      .onConflictDoUpdate({ target: [customerAssignments.userId, customerAssignments.customerId], set: { permission, grantedBy: u.id } });
    await audit(ctx, req, 'customer.share', { type: 'customer', id }, { name: c.name, userId: target.id, targetEmail: target.email, permission });
    return { ok: true, name: target.name, permission };
  });

  app.patch('/api/customers/:customerId/shares/:userId', async (req) => {
    const id = uuidParam(req, 'customerId');
    const userId = uuidParam(req, 'userId');
    await assertCustomerAccess(ctx, req, id, 'manage');
    const body = parse(z.object({ permission: permissionSchema }), req.body);
    const target = (await db.select({ email: users.email, role: users.role }).from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!target) throw notFound();
    const permission = target.role === 'viewer' ? 'view' : body.permission;
    const r = await db
      .update(customerAssignments)
      .set({ permission })
      .where(and(eq(customerAssignments.customerId, id), eq(customerAssignments.userId, userId)))
      .returning();
    if (!r.length) throw notFound();
    await audit(ctx, req, 'customer.share_update', { type: 'customer', id }, { name: await customerName(id), userId, targetEmail: target.email, permission });
    return { ok: true, permission };
  });

  /** Removes a share; the owner or an admin can remove anyone, everyone can remove themselves (leave). */
  app.delete('/api/customers/:customerId/shares/:userId', async (req) => {
    const id = uuidParam(req, 'customerId');
    const userId = uuidParam(req, 'userId');
    const u = await assertCustomerAccess(ctx, req, id, userId === requireUser(req).id ? 'view' : 'manage');
    // The visitor account is shared: one visitor leaving would remove the organisation for all of them.
    if (u.isDemo) throw forbidden('Not available in a demo session');
    const r = await db
      .delete(customerAssignments)
      .where(and(eq(customerAssignments.customerId, id), eq(customerAssignments.userId, userId)))
      .returning();
    if (!r.length) throw notFound();
    const target = (await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1))[0];
    await audit(ctx, req, userId === u.id ? 'customer.leave' : 'customer.unshare', { type: 'customer', id }, {
      name: await customerName(id),
      userId,
      targetEmail: target?.email ?? null,
    });
    return { ok: true };
  });

  /**
   * Hands ownership to another active analyst or admin; the previous owner keeps edit access.
   * Owners can only pick someone the organisation is already shared with; admins can pick anyone eligible.
   */
  app.put('/api/customers/:customerId/owner', async (req) => {
    const id = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, id, 'manage');
    if (u.isDemo) throw forbidden('Not available in a demo session');
    const { userId } = parse(z.object({ userId: z.uuid() }), req.body);
    const r = await db.transaction(async (tx) => {
      // Lock the row so concurrent transfers serialise; every check below uses the locked owner.
      const c = (await tx.select({ ownerId: customers.ownerId, name: customers.name }).from(customers).where(eq(customers.id, id)).limit(1).for('update'))[0];
      if (!c) throw notFound();
      if (u.role !== 'admin' && c.ownerId !== u.id) throw forbidden('Only the owner can do this');
      if (c.ownerId === userId) throw new HttpError(400, 'This person already owns the organisation');
      const target = (await tx.select().from(users).where(eq(users.id, userId)).limit(1))[0];
      if (!target) throw new HttpError(400, 'Account not found');
      const share = (
        await tx
          .select({ permission: customerAssignments.permission })
          .from(customerAssignments)
          .where(and(eq(customerAssignments.customerId, id), eq(customerAssignments.userId, userId)))
          .limit(1)
      )[0];
      if (!share && u.role !== 'admin' && target.active && !target.isDemo && !target.isBreakglass) throw new HttpError(400, 'Share the organisation with this person first');
      const problem = ownerCandidateProblem(target);
      if (problem) throw new HttpError(400, problem);
      const from = c.ownerId ? (await tx.select({ id: users.id, email: users.email, role: users.role, active: users.active }).from(users).where(eq(users.id, c.ownerId)).limit(1))[0] : undefined;
      await tx.update(customers).set({ ownerId: userId, updatedAt: new Date() }).where(eq(customers.id, id));
      await tx.delete(customerAssignments).where(and(eq(customerAssignments.customerId, id), eq(customerAssignments.userId, userId)));
      if (from) {
        const permission = from.role === 'viewer' ? 'view' : 'edit';
        await tx
          .insert(customerAssignments)
          .values({ userId: from.id, customerId: id, permission, grantedBy: u.id })
          .onConflictDoUpdate({ target: [customerAssignments.userId, customerAssignments.customerId], set: { permission } });
      }
      return { name: c.name, from, to: target };
    });
    await audit(ctx, req, 'customer.owner_change', { type: 'customer', id }, {
      name: r.name,
      from: r.from?.id ?? null,
      fromEmail: r.from?.email ?? null,
      to: r.to.id,
      toEmail: r.to.email,
    });
    return { ok: true };
  });

  app.put('/api/customers/:customerId/triage/:checkId', async (req) => {
    const id = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, id, true);
    const checkId = (req.params as any).checkId as string;
    if (!CHECKS_BY_ID[checkId]) throw notFound();
    const { systemKey: key, ...body } = parse(triageSchema, req.body);
    // Decisions apply to one system identity, which must belong to this organisation.
    const systems = await db
      .select({ provider: scanSystems.provider, label: scanSystems.label, config: scanSystems.config, startedConfig: scanSystems.startedConfig, details: scanSystems.connectionDetails })
      .from(scanSystems)
      .innerJoin(scans, eq(scans.id, scanSystems.scanId))
      .where(eq(scans.customerId, id));
    const known = systems.some(
      (s) =>
        systemKey(s.provider, s.config as Record<string, any>, s.details as Record<string, any> | null, s.label) === key ||
        (s.startedConfig != null && systemKey(s.provider, s.startedConfig as Record<string, any>, s.details as Record<string, any> | null, s.label) === key),
    );
    if (!known) throw new HttpError(400, 'Unknown system for this organisation');
    await db
      .insert(findingTriage)
      .values({ customerId: id, checkId, systemKey: key, ...body, updatedBy: u.id, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [findingTriage.customerId, findingTriage.checkId, findingTriage.systemKey], set: { ...body, updatedBy: u.id, updatedAt: new Date() } });
    await audit(ctx, req, 'finding.triage', { type: 'customer', id }, { checkId, systemKey: key, status: body.status });
    await refreshCustomerScores(ctx, id);
    return { ok: true };
  });

  /** GDPR-style export of everything stored about an organisation (never includes secrets). */
  app.get('/api/customers/:customerId/export', async (req, reply) => {
    const id = uuidParam(req, 'customerId');
    await assertCustomerAccess(ctx, req, id);
    const c = (await db.select().from(customers).where(eq(customers.id, id)).limit(1))[0];
    if (!c) throw notFound();
    const s = await db.select().from(scans).where(eq(scans.customerId, id));
    const ids = s.map((x) => x.id);
    const systems = ids.length ? await db.select().from(scanSystems).where(inArray(scanSystems.scanId, ids)) : [];
    const results = ids.length ? await db.select().from(checkResults).where(inArray(checkResults.scanId, ids)) : [];
    const triage = await db.select().from(findingTriage).where(eq(findingTriage.customerId, id));
    await audit(ctx, req, 'customer.export', { type: 'customer', id });
    reply.header('Content-Disposition', `attachment; filename="organisation-export-${id}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      customer: c,
      scans: s,
      systems,
      results,
      triage,
    };
  });
}
