import { CHECKS_BY_ID, customerInputSchema, triageSchema } from '@qs/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { assertCustomerAccess, requireRole, requireUser } from '../auth/session.js';
import { notFound, type AppCtx } from '../context.js';
import { checkResults, customerAssignments, customers, findingTriage, scans, scanSystems, users } from '../db/schema.js';
import { refreshCustomerScores } from '../scoring.js';
import { parse, uuidParam } from './helpers.js';

export function customerRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db } = ctx;

  async function accessibleCustomerIds(userId: string, all: boolean) {
    if (all) return null;
    const r = await db.select({ id: customerAssignments.customerId }).from(customerAssignments).where(eq(customerAssignments.userId, userId));
    return r.map((x) => x.id);
  }

  app.get('/api/customers', async (req) => {
    const u = requireUser(req);
    const ids = await accessibleCustomerIds(u.id, u.role === 'admin' || u.allCustomers);
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
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      contactName: c.contactName,
      country: c.country,
      industry: (c.context as any)?.industry,
      updatedAt: c.updatedAt,
      latestScan: latest.find((l) => l.customerId === c.id) ?? null,
      scanCount: counts.find((x) => x.customerId === c.id)?.n ?? 0,
    }));
  });

  app.post('/api/customers', async (req) => {
    const u = requireRole(req, 'admin', 'consultant');
    const body = parse(customerInputSchema, req.body);
    const [c] = await db.insert(customers).values({ ...body, createdBy: u.id }).returning();
    if (u.role !== 'admin' && !u.allCustomers) await db.insert(customerAssignments).values({ userId: u.id, customerId: c.id });
    await audit(ctx, req, 'customer.create', { type: 'customer', id: c.id }, { name: c.name });
    return c;
  });

  app.get('/api/customers/:customerId', async (req) => {
    const id = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, id);
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
        providers: sql<string[]>`coalesce((select array_agg(distinct ${scanSystems.provider}) from ${scanSystems} where ${scanSystems.scanId} = ${scans.id}), '{}')`,
      })
      .from(scans)
      .where(eq(scans.customerId, id))
      .orderBy(desc(scans.createdAt));
    const triage = await db.select().from(findingTriage).where(eq(findingTriage.customerId, id));
    const assigned =
      u.role === 'admin'
        ? await db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(customerAssignments)
            .innerJoin(users, eq(users.id, customerAssignments.userId))
            .where(eq(customerAssignments.customerId, id))
        : [];
    return { ...c, scans: scanRows, triage, assigned };
  });

  app.put('/api/customers/:customerId', async (req) => {
    const id = uuidParam(req, 'customerId');
    await assertCustomerAccess(ctx, req, id, true);
    const body = parse(customerInputSchema, req.body);
    const [c] = await db.update(customers).set({ ...body, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
    await audit(ctx, req, 'customer.update', { type: 'customer', id });
    return c;
  });

  app.delete('/api/customers/:customerId', async (req) => {
    requireRole(req, 'admin');
    const id = uuidParam(req, 'customerId');
    const c = (await db.select({ name: customers.name }).from(customers).where(eq(customers.id, id)).limit(1))[0];
    if (!c) throw notFound();
    // Cascades to scans, systems, credentials, results and triage.
    await db.delete(customers).where(eq(customers.id, id));
    await audit(ctx, req, 'customer.delete', { type: 'customer', id }, { name: c.name });
    return { ok: true };
  });

  app.put('/api/customers/:customerId/assignments', async (req) => {
    requireRole(req, 'admin');
    const id = uuidParam(req, 'customerId');
    const { userIds } = parse(z.object({ userIds: z.array(z.uuid()).max(200) }), req.body);
    await db.transaction(async (tx) => {
      await tx.delete(customerAssignments).where(eq(customerAssignments.customerId, id));
      if (userIds.length) await tx.insert(customerAssignments).values(userIds.map((userId) => ({ userId, customerId: id })));
    });
    await audit(ctx, req, 'customer.assignments', { type: 'customer', id }, { userIds });
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

  /** GDPR-style export of everything stored about a customer (never includes secrets). */
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
    reply.header('Content-Disposition', `attachment; filename="customer-export-${id}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      customer: c,
      scans: s.map(({ authorizationDoc, ...rest }) => ({ ...rest, hasAuthorizationDoc: Boolean(authorizationDoc) })),
      systems,
      results,
      triage,
    };
  });
}
