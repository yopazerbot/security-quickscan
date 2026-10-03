import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { notFound, type AppCtx } from '../context.js';
import { customers, msTenantBindings, users } from '../db/schema.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Admin view of Microsoft tenant links. A link whose organisation was deleted stays reserved until released here. */
export function tenantRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db } = ctx;

  app.get('/api/admin/tenant-bindings', async (req) => {
    requireRole(req, 'admin');
    const rows = await db
      .select({
        tenantId: msTenantBindings.tenantId,
        createdAt: msTenantBindings.createdAt,
        customerId: customers.id,
        customerName: customers.name,
        createdByEmail: users.email,
      })
      .from(msTenantBindings)
      .leftJoin(customers, eq(customers.id, msTenantBindings.customerId))
      .leftJoin(users, eq(users.id, msTenantBindings.createdBy))
      .orderBy(desc(msTenantBindings.createdAt));
    return rows.map((r) => ({
      tenantId: r.tenantId,
      organisation: r.customerId ? { id: r.customerId, name: r.customerName } : null,
      createdAt: r.createdAt,
      createdBy: r.createdByEmail ?? null,
    }));
  });

  app.delete('/api/admin/tenant-bindings/:tenantId', async (req) => {
    requireRole(req, 'admin');
    const tenantId = String((req.params as { tenantId?: string }).tenantId ?? '').toLowerCase();
    if (!GUID_RE.test(tenantId)) throw notFound();
    const [b] = await db.delete(msTenantBindings).where(eq(msTenantBindings.tenantId, tenantId)).returning();
    if (!b) throw notFound();
    await audit(ctx, req, 'tenant_binding.release', { type: 'tenant', id: tenantId }, { customerId: b.customerId, boundAt: b.createdAt });
    return { ok: true };
  });
}
