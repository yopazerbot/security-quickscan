import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { assertCustomerAccess } from '../auth/session.js';
import { badRequest, HttpError, notFound, type AppCtx } from '../context.js';
import type { Db } from '../db/index.js';
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

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** A query runner: the pool or an open transaction. */
export type Q = Db | Tx;

/**
 * Runs fn in a transaction that holds the scan row lock (SELECT ... FOR UPDATE) while the scan is still a draft.
 * Start takes the same lock, so a draft edit can never interleave with Start's validation.
 */
export async function withDraftLock<T>(ctx: AppCtx, scanId: string, fn: (tx: Tx, scan: typeof scans.$inferSelect) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    const scan = (await tx.select().from(scans).where(eq(scans.id, scanId)).for('update'))[0];
    if (!scan) throw notFound();
    if (scan.status !== 'draft') throw new HttpError(409, 'Scan is no longer a draft');
    return fn(tx, scan);
  });
}
