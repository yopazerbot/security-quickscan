import { ALL_SYSTEMS_KEY } from '@qs/shared';

type TriageRow = { checkId: string; systemKey: string; status: 'open' | 'accepted' | 'false_positive'; note: string };

/** Triage decisions are per (check, system key); legacy rows with '*' apply to every system of the organisation. */
export function triageLookup<T extends TriageRow>(rows: T[]) {
  const map = new Map(rows.map((r) => [`${r.checkId}|${r.systemKey}`, r]));
  return (checkId: string, systemKey: string): T | undefined => map.get(`${checkId}|${systemKey}`) ?? map.get(`${checkId}|${ALL_SYSTEMS_KEY}`);
}
