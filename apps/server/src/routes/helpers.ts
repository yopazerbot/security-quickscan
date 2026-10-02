import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { assertCustomerAccess } from '../auth/session.js';
import { badRequest, HttpError, notFound, type AppCtx } from '../context.js';
import { scans } from '../db/schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw badRequest(msg.slice(0, 1000));
  }
  return r.data;
}

export function uuidParam(req: FastifyRequest, name: string): string {
  const v = (req.params as Record<string, string>)[name];
  if (!v || !UUID_RE.test(v)) throw notFound();
  return v;
}

export async function loadScan(ctx: AppCtx, req: FastifyRequest, opts: { write?: boolean; draft?: boolean } = {}) {
  const id = uuidParam(req, 'scanId');
  const scan = (await ctx.db.select().from(scans).where(eq(scans.id, id)).limit(1))[0];
  if (!scan) throw notFound();
  await assertCustomerAccess(ctx, req, scan.customerId, opts.write);
  if (opts.draft && scan.status !== 'draft') throw new HttpError(409, 'Scan is no longer a draft');
  return scan;
}
