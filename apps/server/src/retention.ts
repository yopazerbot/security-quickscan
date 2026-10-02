import { eq, inArray } from 'drizzle-orm';
import { audit } from './audit.js';
import type { AppCtx } from './context.js';
import { credentials, scans, scanSystems } from './db/schema.js';

/** Purge-on-completion: credentials are deleted as soon as the scan ends (completed, failed or cancelled). */
export async function applyRetention(ctx: AppCtx, scanId: string) {
  const scan = (await ctx.db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  if (scan?.retentionMode !== 'purge_on_completion') return;
  const ids = (await ctx.db.select({ id: scanSystems.id }).from(scanSystems).where(eq(scanSystems.scanId, scanId))).map((r) => r.id);
  if (!ids.length) return;
  const del = await ctx.db.delete(credentials).where(inArray(credentials.systemId, ids)).returning({ id: credentials.systemId });
  if (del.length) await audit(ctx, null, 'credential.purge', { type: 'scan', id: scanId }, { reason: 'purge_on_completion', count: del.length }, { id: '', email: 'system' });
}
