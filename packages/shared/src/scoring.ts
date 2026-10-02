import { ISO_BY_ID, isoSort, type ControlVerdict } from './iso.js';
import {
  DOMAINS,
  SEVERITY_WEIGHT,
  type CheckMeta,
  type Domain,
  type ResultStatus,
  type Severity,
} from './types.js';

export interface ScoreInput {
  checkId: string;
  status: ResultStatus;
  severity: Severity;
  /** Consultant triage carried across scans for the same customer. */
  triage?: 'open' | 'accepted' | 'false_positive' | null;
}

export interface ControlAssessment {
  id: string;
  title: string;
  verdict: ControlVerdict;
  score: number | null;
  checks: { checkId: string; status: ResultStatus; primary: boolean }[];
  failed: number;
  passed: number;
}

export interface ScoreSummary {
  score: number;
  grade: string;
  counts: Record<ResultStatus | 'accepted', number>;
  severityCounts: Record<Severity, number>;
  domainScores: { domain: Domain; score: number | null }[];
  controls: ControlAssessment[];
}

export function gradeFor(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  if (score >= 35) return 'E';
  return 'F';
}

function effectiveStatus(r: ScoreInput): ResultStatus | 'accepted' {
  if (r.triage === 'false_positive' && (r.status === 'fail' || r.status === 'warn')) return 'pass';
  if (r.triage === 'accepted' && (r.status === 'fail' || r.status === 'warn')) return 'accepted';
  return r.status;
}

/** Fraction of the check weight earned: pass = full, warn = half, fail = none. */
function earned(status: ResultStatus | 'accepted'): number | null {
  switch (status) {
    case 'pass':
      return 1;
    case 'warn':
      return 0.5;
    case 'fail':
      return 0;
    default:
      return null; // na, error, accepted: not scored
  }
}

export function computeScore(
  results: ScoreInput[],
  catalog: Record<string, CheckMeta>,
  domainWeights: Record<Domain, number>,
): ScoreSummary {
  const counts = { pass: 0, fail: 0, warn: 0, na: 0, error: 0, accepted: 0 };
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const domainAcc = Object.fromEntries(DOMAINS.map((d) => [d, { got: 0, max: 0 }])) as Record<
    Domain,
    { got: number; max: number }
  >;
  const controlAcc = new Map<string, { got: number; max: number; checks: ControlAssessment['checks']; severeFail: boolean; failed: number; passed: number }>();
  let got = 0;
  let max = 0;

  for (const r of results) {
    const meta = catalog[r.checkId];
    if (!meta) continue;
    const status = effectiveStatus(r);
    counts[status]++;
    if (status === 'fail' || status === 'warn') severityCounts[r.severity]++;

    const e = earned(status);
    const sevW = Math.max(SEVERITY_WEIGHT[r.severity], 0.5);
    if (e !== null) {
      const w = sevW * (domainWeights[meta.domain] ?? 1);
      got += w * e;
      max += w;
      domainAcc[meta.domain].got += sevW * e;
      domainAcc[meta.domain].max += sevW;
    }

    meta.frameworks.iso27001.forEach((ctrl, idx) => {
      const primary = idx === 0;
      const acc = controlAcc.get(ctrl) ?? { got: 0, max: 0, checks: [], severeFail: false, failed: 0, passed: 0 };
      acc.checks.push({ checkId: r.checkId, status: status === 'accepted' ? 'warn' : status, primary });
      if (e !== null) {
        const w = sevW * (primary ? 1 : 0.5);
        acc.got += w * e;
        acc.max += w;
        if (status === 'fail') {
          acc.failed++;
          if (primary && (r.severity === 'critical' || r.severity === 'high')) acc.severeFail = true;
        }
        if (status === 'pass') acc.passed++;
      }
      controlAcc.set(ctrl, acc);
    });
  }

  const score = max === 0 ? 100 : Math.round((got / max) * 100);
  const controls: ControlAssessment[] = [...controlAcc.entries()]
    .sort(([a], [b]) => isoSort(a, b))
    .map(([id, acc]) => {
      let verdict: ControlVerdict;
      if (acc.max === 0) verdict = 'not_assessed';
      else if (acc.got === acc.max) verdict = 'effective';
      else if (acc.severeFail || acc.got / acc.max < 0.5) verdict = 'not_effective';
      else verdict = 'partial';
      return {
        id,
        title: ISO_BY_ID[id]?.title ?? id,
        verdict,
        score: acc.max === 0 ? null : Math.round((acc.got / acc.max) * 100),
        checks: acc.checks,
        failed: acc.failed,
        passed: acc.passed,
      };
    });

  return {
    score,
    grade: gradeFor(score),
    counts,
    severityCounts,
    domainScores: DOMAINS.map((d) => ({
      domain: d,
      score: domainAcc[d].max === 0 ? null : Math.round((domainAcc[d].got / domainAcc[d].max) * 100),
    })),
    controls,
  };
}
