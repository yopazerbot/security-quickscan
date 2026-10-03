import { and, desc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { customerAccess } from '../auth/session.js';
import { HttpError, type AppCtx } from '../context.js';
import { auditLog } from '../db/schema.js';
import { controlsCsv, findingsCsv } from '../reports/csv.js';
import { buildReport } from '../reports/model.js';
import { renderPdf } from '../reports/pdf.js';
import { getLogo } from './admin.js';
import { loadScan, parse } from './helpers.js';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'organisation';

const VIEW_AUDIT_WINDOW_MS = 60 * 60 * 1000;

export function reportRoutes(app: FastifyInstance, ctx: AppCtx) {
  /** In-process memory of recent views; the audit table is the source of truth across instances and restarts. */
  const recentViews = new Map<string, number>();

  /** Audit 'report.view' (the JSON report includes raw evidence) at most once per user, scan and hour. */
  async function auditView(req: FastifyRequest, scanId: string) {
    const user = req.user;
    const now = Date.now();
    const key = `${user?.id ?? ''}|${user?.email ?? ''}|${scanId}`;
    const seen = recentViews.get(key);
    if (seen && now - seen < VIEW_AUDIT_WINDOW_MS) return;
    if (recentViews.size > 5000) for (const [k, t] of recentViews) if (now - t >= VIEW_AUDIT_WINDOW_MS) recentViews.delete(k);
    recentViews.set(key, now);
    if (user?.id) {
      const since = new Date(now - VIEW_AUDIT_WINDOW_MS);
      const last = await ctx.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'report.view'), eq(auditLog.userId, user.id), eq(auditLog.targetId, scanId), gt(auditLog.at, since)))
        .orderBy(desc(auditLog.at))
        .limit(1);
      if (last.length) return;
    }
    await audit(ctx, req, 'report.view', { type: 'scan', id: scanId });
  }

  /** Finished scans only; failed and cancelled scans give a partial report of the checks that did complete. */
  async function completedScan(req: any) {
    const scan = await loadScan(ctx, req);
    if (!['completed', 'cancelled', 'failed'].includes(scan.status)) throw new HttpError(409, 'The report is available once the scan has finished');
    return scan;
  }

  app.get('/api/scans/:scanId/report', async (req) => {
    const scan = await completedScan(req);
    const model = await buildReport(ctx, scan.id);
    await auditView(req, scan.id);
    return { ...model, myAccess: await customerAccess(ctx, req.user!, scan.customerId) };
  });

  app.get('/api/scans/:scanId/report.pdf', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const scan = await completedScan(req);
    const model = await buildReport(ctx, scan.id);
    const pdf = await renderPdf(model, (await getLogo(ctx))?.data ?? null);
    await audit(ctx, req, 'report.export', { type: 'scan', id: scan.id }, { format: 'pdf' });
    const date = (model.scan.finishedAt ?? new Date()).toISOString().slice(0, 10);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="quickscan-${slug(model.customer.name)}-${date}.pdf"`);
    return reply.send(pdf);
  });

  app.get('/api/scans/:scanId/report.csv', async (req, reply) => {
    const scan = await completedScan(req);
    const { type } = parse(z.object({ type: z.enum(['findings', 'controls']).default('findings') }), req.query);
    const model = await buildReport(ctx, scan.id);
    await audit(ctx, req, 'report.export', { type: 'scan', id: scan.id }, { format: `csv-${type}` });
    const date = (model.scan.finishedAt ?? new Date()).toISOString().slice(0, 10);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="quickscan-${slug(model.customer.name)}-${type}-${date}.csv"`);
    return type === 'controls' ? controlsCsv(model) : findingsCsv(model);
  });
}
