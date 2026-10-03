import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { audit } from './audit.js';
import type { AppCtx } from './context.js';
import { checkResults, credentials, scans, scanSystems } from './db/schema.js';

/**
 * Purge-on-completion: credentials are deleted as soon as the scan ends (completed, failed or cancelled).
 * Systems in `keep` (their stored secret could not be decrypted, e.g. during a key rotation) keep it, so nothing
 * is lost before an operator has fixed the key.
 */
export async function applyRetention(ctx: AppCtx, scanId: string, keep: string[] = []) {
  const scan = (await ctx.db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  if (scan?.retentionMode !== 'purge_on_completion') return;
  const ids = (await ctx.db.select({ id: scanSystems.id }).from(scanSystems).where(eq(scanSystems.scanId, scanId))).map((r) => r.id);
  if (!ids.length) return;
  const del = await ctx.db
    .delete(credentials)
    .where(and(inArray(credentials.systemId, ids), keep.length ? notInArray(credentials.systemId, keep) : undefined))
    .returning({ id: credentials.systemId });
  if (del.length) await audit(ctx, null, 'credential.purge', { type: 'scan', id: scanId }, { reason: 'purge_on_completion', count: del.length }, { id: '', email: 'system' });
}

/** Results that never ran get a final status, so reports and progress tiles never show them as pending forever. */
export async function settleOpenChecks(ctx: AppCtx, scanId: string, status: 'na' | 'error', summary: string) {
  await ctx.db
    .update(checkResults)
    .set({ status, summary, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(checkResults.scanId, scanId), inArray(checkResults.status, ['pending', 'running'])));
}
