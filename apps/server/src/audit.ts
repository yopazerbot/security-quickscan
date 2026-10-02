import type { FastifyRequest } from 'fastify';
import type { AppCtx } from './context.js';
import { auditLog } from './db/schema.js';

export async function audit(
  ctx: AppCtx,
  req: FastifyRequest | null,
  action: string,
  target?: { type: string; id: string },
  details?: Record<string, unknown>,
  actor?: { id: string; email: string },
) {
  const user = actor ?? req?.user;
  try {
    await ctx.db.insert(auditLog).values({
      userId: user?.id || null,
      userEmail: user?.email ?? null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      ip: req?.ip ?? null,
      details: details ?? null,
    });
  } catch (e) {
    ctx.log.error({ err: e, action }, 'audit write failed');
  }
  ctx.log.info({ audit: action, user: user?.email, target }, 'audit');
}
