import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { HttpError, type AppCtx } from '../context.js';
import { controlsCsv, findingsCsv } from '../reports/csv.js';
import { buildReport } from '../reports/model.js';
import { renderPdf } from '../reports/pdf.js';
import { getLogo } from './admin.js';
import { loadScan, parse } from './helpers.js';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'customer';

export function reportRoutes(app: FastifyInstance, ctx: AppCtx) {
  /** Finished scans only; failed and cancelled scans give a partial report of the checks that did complete. */
  async function completedScan(req: any) {
    const scan = await loadScan(ctx, req);
    if (!['completed', 'cancelled', 'failed'].includes(scan.status)) throw new HttpError(409, 'The report is available once the scan has finished');
    return scan;
  }

  app.get('/api/scans/:scanId/report', async (req) => {
    const scan = await completedScan(req);
    return buildReport(ctx, scan.id);
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
