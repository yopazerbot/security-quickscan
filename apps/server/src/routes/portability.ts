import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { passwordProblem } from '../auth/password.js';
import { accessibleCustomerIds, allows, assertCustomerAccess, customerAccess, requireRole, requireUser } from '../auth/session.js';
import { badRequest, HttpError, notFound, type AppCtx } from '../context.js';
import { customers } from '../db/schema.js';
import { buildExport } from '../portability/export.js';
import { decryptExport, encryptExport, exportFileName, MAX_FILE_BYTES, PASSPHRASE_MAX, PASSPHRASE_MIN } from '../portability/format.js';
import { applyImport, planImport } from '../portability/import.js';
import { parse } from './helpers.js';

/** The import request carries the file as base64 (4/3 of its size) plus a little JSON. */
const IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

const exportSchema = z.union([
  z.object({ organisationId: z.uuid(), passphrase: z.string().max(PASSPHRASE_MAX) }).strict(),
  z.object({ all: z.literal(true), passphrase: z.string().max(PASSPHRASE_MAX) }).strict(),
]);

const importSchema = z.object({
  file: z.base64().max(Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4),
  passphrase: z.string().min(1).max(PASSPHRASE_MAX),
  dryRun: z.boolean(),
});

/**
 * Export and import of the complete scan history (see portability/ and docs/EXPORT-FORMAT.md). The passphrase only
 * ever travels in a POST body: never in a URL, never in the audit log, redacted from request logs.
 */
export function portabilityRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db } = ctx;

  app.post('/api/export', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = requireUser(req);
    const body = parse(exportSchema, req.body);
    const problem = passwordProblem(body.passphrase, { minLength: PASSPHRASE_MIN });
    if (problem) throw badRequest(problem.replace(/password/gi, 'passphrase'));

    let ids: string[];
    let label: string;
    if ('organisationId' in body) {
      // 404 without access, as everywhere else: the existence of other organisations is not revealed.
      await assertCustomerAccess(ctx, req, body.organisationId);
      const c = (await db.select({ name: customers.name }).from(customers).where(eq(customers.id, body.organisationId)).limit(1))[0];
      if (!c) throw notFound();
      ids = [body.organisationId];
      label = c.name;
    } else {
      // The demo visitor is a shared account: it never exports everything it can see.
      if (u.isDemo) throw new HttpError(403, 'Not available in a demo session');
      const access = await accessibleCustomerIds(ctx, u);
      const rows = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.isDemo, false), access ? inArray(customers.id, access.length ? access : ['00000000-0000-0000-0000-000000000000']) : undefined));
      ids = rows.map((r) => r.id);
      if (!ids.length) throw badRequest('There are no organisations to export');
      label = 'all';
    }
    // Who has access is only exported for organisations the user manages (same rule as the organisation page).
    const manage = new Set<string>();
    if (!u.isDemo) for (const id of ids) if (allows(await customerAccess(ctx, u, id), 'manage')) manage.add(id);

    const payload = await buildExport(ctx, u, ids, 'organisationId' in body ? 'organisation' : 'all', manage);
    const file = await encryptExport(payload, body.passphrase);
    const scanCount = payload.organisations.reduce((n, o) => n + o.scans.length, 0);
    await audit(ctx, req, 'data.export', 'organisationId' in body ? { type: 'customer', id: body.organisationId } : undefined, {
      scope: payload.scope,
      organisations: payload.organisations.length,
      scans: scanCount,
      bytes: file.length,
    });
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${exportFileName(label)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(file);
  });

  app.post('/api/import', { bodyLimit: IMPORT_BODY_LIMIT, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireRole(req, 'admin', 'consultant');
    if (u.isDemo) throw new HttpError(403, 'Not available in a demo session');
    const body = parse(importSchema, req.body);
    const file = Buffer.from(body.file, 'base64');
    if (file.length > MAX_FILE_BYTES) throw new HttpError(413, `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const payload = await decryptExport(file, body.passphrase);
    if (body.dryRun) return { plan: await planImport(db, u, payload) };
    const result = await applyImport(ctx, u, payload);
    await audit(ctx, req, 'data.import', undefined, {
      scope: payload.scope,
      appVersion: payload.appVersion,
      exportedAt: payload.exportedAt,
      exportedBy: payload.exportedBy.email,
      organisations: result.totals.organisations,
      newOrganisations: result.totals.newOrganisations,
      scansAdded: result.totals.added,
      scansSkipped: result.totals.skipped,
      organisationIds: result.organisations.map((o) => o.id),
    });
    return { result };
  });
}
