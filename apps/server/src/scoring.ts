import { CHECKS_BY_ID, computeScore, type RiskProfile, type ScoreInput } from '@qs/shared';
import { and, eq } from 'drizzle-orm';
import type { AppCtx } from './context.js';
import { checkResults, findingTriage, scans } from './db/schema.js';

export async function scoreScan(ctx: AppCtx, scanId: string) {
  const scan = (await ctx.db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  if (!scan) throw new Error('scan not found');
  const results = await ctx.db.select().from(checkResults).where(eq(checkResults.scanId, scanId));
  const triage = await ctx.db.select().from(findingTriage).where(eq(findingTriage.customerId, scan.customerId));
  const tmap = new Map(triage.map((t) => [t.checkId, t.status]));
  const inputs: ScoreInput[] = results
    .filter((r) => r.status !== 'pending' && r.status !== 'running' && CHECKS_BY_ID[r.checkId])
    .map((r) => ({
      checkId: r.checkId,
      status: r.status as ScoreInput['status'],
      severity: CHECKS_BY_ID[r.checkId].severity,
      triage: tmap.get(r.checkId) ?? null,
    }));
  const profile = scan.riskProfile as RiskProfile;
  return computeScore(inputs, CHECKS_BY_ID, profile.domainWeights);
}

export async function storeScanScore(ctx: AppCtx, scanId: string) {
  const s = await scoreScan(ctx, scanId);
  await ctx.db.update(scans).set({ score: s.score, grade: s.grade, summary: s }).where(eq(scans.id, scanId));
  return s;
}

/** Triage changes affect scores of all completed scans of that organisation. */
export async function refreshCustomerScores(ctx: AppCtx, customerId: string) {
  const done = await ctx.db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.customerId, customerId), eq(scans.status, 'completed')));
  for (const s of done) await storeScanScore(ctx, s.id);
}
