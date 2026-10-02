import { CHECKS_BY_ID, type CheckOutcome, type ResultStatus } from '@qs/shared';
import { sleep } from './util.js';

/** Deterministic pseudo-random generator so a demo scan always looks the same for a system. */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const SAMPLE_RESOURCES = ['finance-share', 'legacy-admin', 'svc-backup', 'dev-sandbox', 'contractor-jdoe', 'marketing-site', 'prod-db-01', 'ci-runner'];

export async function demoOutcome(systemId: string, checkId: string): Promise<CheckOutcome> {
  const r = rng(`${systemId}:${checkId}`);
  await sleep(400 + r() * 1600);
  const meta = CHECKS_BY_ID[checkId];
  const roll = r();
  const failBias = meta?.severity === 'critical' ? 0.3 : meta?.severity === 'high' ? 0.4 : 0.35;
  const status: ResultStatus = roll < failBias ? 'fail' : roll < failBias + 0.15 ? 'warn' : roll < 0.95 ? 'pass' : 'na';
  if (status === 'pass') return { status, summary: `Demo: ${meta?.title ?? checkId} is configured as recommended.` };
  if (status === 'na') return { status, summary: 'Demo: no applicable resources found.' };
  const n = 1 + Math.floor(r() * 4);
  const resources = Array.from({ length: n }, (_, i) => {
    const name = SAMPLE_RESOURCES[Math.floor(r() * SAMPLE_RESOURCES.length)];
    return { id: `demo-${checkId}-${i}`, name: `${name}-${i + 1}`, detail: 'demo resource' };
  });
  return { status, summary: `Demo: ${n} resource(s) do not meet "${meta?.title ?? checkId}".`, resources };
}
