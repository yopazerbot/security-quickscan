import { ALL_SYSTEMS_KEY, systemKeyFallbacks } from '@qs/shared';

type TriageRow = { checkId: string; systemKey: string; status: 'open' | 'accepted' | 'false_positive'; note: string };

/**
 * Triage decisions are per (check, system key). Lookup order: the exact key, then older keys of the same system
 * (an Azure system scoped to subscriptions was keyed by tenant only), then legacy '*' rows for every system.
 */
export function triageLookup<T extends TriageRow>(rows: T[]) {
  const map = new Map(rows.map((r) => [`${r.checkId}|${r.systemKey}`, r]));
  return (checkId: string, systemKey: string): T | undefined => {
    for (const k of systemKeyFallbacks(systemKey)) {
      const hit = map.get(`${checkId}|${k}`);
      if (hit) return hit;
    }
    return map.get(`${checkId}|${ALL_SYSTEMS_KEY}`);
  };
}

/** Triage a frozen summary was scored with, keyed `${systemKey}|${checkId}`; summaries frozen before the Azure key change use the tenant key. */
export function frozenTriageFor<T>(frozen: Record<string, T>, systemKey: string, checkId: string): T | null {
  for (const k of systemKeyFallbacks(systemKey)) {
    const hit = frozen[`${k}|${checkId}`];
    if (hit) return hit;
  }
  return null;
}
