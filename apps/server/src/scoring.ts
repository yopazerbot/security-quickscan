import { CHECKS_BY_ID, computeScore, systemKey, type Provider, type ScoreInput, type ScoreSummary } from '@qs/shared';
import { asc, eq } from 'drizzle-orm';
import type { AppCtx } from './context.js';
import { checkResults, findingTriage, scans, scanSystems } from './db/schema.js';
import { triageLookup } from './triage.js';

export const FINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export const isFinalStatus = (s: string) => (FINAL_STATUSES as readonly string[]).includes(s);

export type TriageDecision = { status: 'open' | 'accepted' | 'false_positive'; note: string };

/** What scans.summary holds: the score plus the triage decisions it was computed with, keyed `${systemKey}|${checkId}`. */
export type StoredSummary = ScoreSummary & { triage?: Record<string, TriageDecision> };

/** Stable system identity of a scan system (the frozen start config when there is one). */
export function scanSystemKey(s: { provider: Provider; label: string; config: unknown; startedConfig?: unknown; connectionDetails: unknown }) {
  return systemKey(s.provider, (s.startedConfig ?? s.config) as Record<string, any>, s.connectionDetails as Record<string, any> | null, s.label);
}

export const triageKey = (sysKey: string, checkId: string) => `${sysKey}|${checkId}`;

/** A stored summary is frozen when the scan is final and it was stored in the coverage-aware format. */
export function frozenSummary(scan: { status: string; summary: unknown }): StoredSummary | null {
  const s = scan.summary as StoredSummary | null;
  return isFinalStatus(scan.status) && s && typeof s === 'object' && 'coverage' in s ? s : null;
}

/**
 * Score a scan with the current triage, looked up per (check, system key) with the legacy '*' fallback.
 * Live scores (progress page) and stored scores use this same path. In a finished scan, results still
 * pending or running count as not assessed (error).
 */
export async function scoreScanDetailed(ctx: AppCtx, scanId: string) {
  const scan = (await ctx.db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  if (!scan) throw new Error('scan not found');
  const final = isFinalStatus(scan.status);
  const [results, systems, triageRows] = await Promise.all([
    // In id order: the stored summary lists results the same way every time (and so does an imported copy).
    ctx.db.select().from(checkResults).where(eq(checkResults.scanId, scanId)).orderBy(asc(checkResults.id)),
    ctx.db.select().from(scanSystems).where(eq(scanSystems.scanId, scanId)),
    ctx.db.select().from(findingTriage).where(eq(findingTriage.customerId, scan.customerId)),
  ]);
  const keyOf = new Map(systems.map((s) => [s.id, scanSystemKey(s)]));
  const lookup = triageLookup(triageRows);
  const used: Record<string, TriageDecision> = {};
  const inputs: ScoreInput[] = [];
  for (const r of results) {
    if (!CHECKS_BY_ID[r.checkId]) continue;
    const unfinished = r.status === 'pending' || r.status === 'running';
    if (unfinished && !final) continue;
    const key = keyOf.get(r.systemId) ?? '';
    const t = lookup(r.checkId, key);
    if (t && t.status !== 'open') used[triageKey(key, r.checkId)] = { status: t.status, note: t.note };
    inputs.push({
      checkId: r.checkId,
      status: unfinished ? 'error' : (r.status as ScoreInput['status']),
      severity: CHECKS_BY_ID[r.checkId].severity,
      triage: t?.status ?? null,
      systemId: r.systemId,
    });
  }
  return { summary: computeScore(inputs, CHECKS_BY_ID), triage: used };
}

export async function scoreScan(ctx: AppCtx, scanId: string): Promise<ScoreSummary> {
  return (await scoreScanDetailed(ctx, scanId)).summary;
}

/** Stores the score (null score and grade when too little was assessed) with the triage it used, which freezes it for finished scans. */
export async function storeScanScore(ctx: AppCtx, scanId: string) {
  const { summary, triage } = await scoreScanDetailed(ctx, scanId);
  const stored: StoredSummary = { ...summary, triage };
  await ctx.db.update(scans).set({ score: summary.score, grade: summary.grade, summary: stored }).where(eq(scans.id, scanId));
  return summary;
}

/**
 * Called after a triage change. Finished scans (completed, failed, cancelled) are frozen: their stored score and
 * report stay as issued, and new triage only applies to scans that have not finished yet, whose scores are
 * computed live and stored when they finish. Nothing needs to be rewritten here; kept for the route contract.
 */
export async function refreshCustomerScores(_ctx: AppCtx, _customerId: string): Promise<void> {
  // Intentionally empty: see above.
}
