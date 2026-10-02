import { CHECKS_BY_ID, computeRiskProfile, customerInputSchema, triageSchema, type CustomerContext } from '@qs/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { takeAttempt } from '../auth/routes.js';
import { accessibleCustomerIds, assertCustomerAccess, customerAccess, requireRole, requireUser } from '../auth/session.js';
import { HttpError, notFound, type AppCtx } from '../context.js';
import { checkResults, customerAssignments, customers, findingTriage, scans, scanSystems, users } from '../db/schema.js';
import { refreshCustomerScores } from '../scoring.js';
import { parse, uuidParam } from './helpers.js';

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
    // Organisations created by the demo visitor are demo data (removed by "Reset demo data").
    const [c] = await db.insert(customers).values({ ...body, createdBy: u.id, ownerId: u.id, isDemo: u.isDemo }).returning();
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
    const manage = myAccess === 'owner' || myAccess === 'admin';
    // Need-to-know: only those who manage an organisation see who else has access to it.
    const shares = manage
      ? await db
          .select({ userId: users.id, name: users.name, email: users.email, role: users.role, permission: customerAssignments.permission, grantedAt: customerAssignments.createdAt })
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
        .select({ id: users.id, name: users.name, email: users.email, active: users.active, isDemo: users.isDemo, isBreakglass: users.isBreakglass })
        .from(users)
        .where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`)
        .limit(1)
    )[0];
    if (!target || !target.active || target.isDemo || target.isBreakglass) throw new HttpError(404, 'No active account with this email address');
    const c = (await db.select({ ownerId: customers.ownerId }).from(customers).where(eq(customers.id, id)).limit(1))[0];
    if (target.id === c?.ownerId) throw new HttpError(400, 'This person owns the organisation');
    await db
      .insert(customerAssignments)
      .values({ userId: target.id, customerId: id, permission: body.permission, grantedBy: u.id })
      .onConflictDoUpdate({ target: [customerAssignments.userId, customerAssignments.customerId], set: { permission: body.permission, grantedBy: u.id } });
    await audit(ctx, req, 'customer.share', { type: 'customer', id }, { userId: target.id, permission: body.permission });
    return { ok: true, name: target.name };
  });

  app.patch('/api/customers/:customerId/shares/:userId', async (req) => {
    const id = uuidParam(req, 'customerId');
    const userId = uuidParam(req, 'userId');
    await assertCustomerAccess(ctx, req, id, 'manage');
    const { permission } = parse(z.object({ permission: permissionSchema }), req.body);
    const r = await db
      .update(customerAssignments)
      .set({ permission })
      .where(and(eq(customerAssignments.customerId, id), eq(customerAssignments.userId, userId)))
      .returning();
    if (!r.length) throw notFound();
    await audit(ctx, req, 'customer.share_update', { type: 'customer', id }, { userId, permission });
    return { ok: true };
  });

  /** Removes a share; the owner or an admin can remove anyone, everyone can remove themselves (leave). */
  app.delete('/api/customers/:customerId/shares/:userId', async (req) => {
    const id = uuidParam(req, 'customerId');
    const userId = uuidParam(req, 'userId');
    const u = await assertCustomerAccess(ctx, req, id, userId === requireUser(req).id ? 'view' : 'manage');
    const r = await db
      .delete(customerAssignments)
      .where(and(eq(customerAssignments.customerId, id), eq(customerAssignments.userId, userId)))
      .returning();
    if (!r.length) throw notFound();
    await audit(ctx, req, userId === u.id ? 'customer.leave' : 'customer.unshare', { type: 'customer', id }, { userId });
    return { ok: true };
  });

  /** Hands ownership to someone who already has access; the previous owner keeps edit access. */
  app.put('/api/customers/:customerId/owner', async (req) => {
    const id = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, id, 'manage');
    const { userId } = parse(z.object({ userId: z.uuid() }), req.body);
    const share = (
      await db
        .select({ role: users.role })
        .from(customerAssignments)
        .innerJoin(users, eq(users.id, customerAssignments.userId))
        .where(and(eq(customerAssignments.customerId, id), eq(customerAssignments.userId, userId), eq(users.active, true)))
        .limit(1)
    )[0];
    if (!share) throw new HttpError(400, 'Share the organisation with this person first');
    if (share.role === 'viewer') throw new HttpError(400, 'A read-only account cannot own an organisation');
    const c = (await db.select({ ownerId: customers.ownerId }).from(customers).where(eq(customers.id, id)).limit(1))[0];
    await db.transaction(async (tx) => {
      await tx.update(customers).set({ ownerId: userId, updatedAt: new Date() }).where(eq(customers.id, id));
      await tx.delete(customerAssignments).where(and(eq(customerAssignments.customerId, id), eq(customerAssignments.userId, userId)));
      if (c?.ownerId) {
        await tx
          .insert(customerAssignments)
          .values({ userId: c.ownerId, customerId: id, permission: 'edit', grantedBy: u.id })
          .onConflictDoUpdate({ target: [customerAssignments.userId, customerAssignments.customerId], set: { permission: 'edit' } });
      }
    });
    await audit(ctx, req, 'customer.owner_change', { type: 'customer', id }, { from: c?.ownerId ?? null, to: userId });
    return { ok: true };
  });

  app.put('/api/customers/:customerId/triage/:checkId', async (req) => {
    const id = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, id, true);
    const checkId = (req.params as any).checkId as string;
    if (!CHECKS_BY_ID[checkId]) throw notFound();
    const body = parse(triageSchema, req.body);
    await db
      .insert(findingTriage)
      .values({ customerId: id, checkId, ...body, updatedBy: u.id, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [findingTriage.customerId, findingTriage.checkId], set: { ...body, updatedBy: u.id, updatedAt: new Date() } });
    await audit(ctx, req, 'finding.triage', { type: 'customer', id }, { checkId, status: body.status });
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
