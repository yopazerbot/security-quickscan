import { ISO_ASSESSABLE, ISO_BY_ID, isoSort, type ControlVerdict, type EvidenceStrength } from './iso.js';
import {
  DOMAIN_LABELS,
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
  /** Triage carried across scans for the same organisation. */
  triage?: 'open' | 'accepted' | 'false_positive' | null;
  /** System the result belongs to, so control verdicts can say which system caused them. */
  systemId?: string;
}

export interface ControlAssessment {
  id: string;
  title: string;
  verdict: ControlVerdict;
  evidence: EvidenceStrength;
  score: number | null;
  /** Every result that fed the control; status is the raw result, triage says how it was treated. */
  checks: { checkId: string; systemId?: string; status: ResultStatus; primary: boolean; triage: 'accepted' | 'false_positive' | null }[];
  failed: number;
  passed: number;
}

/** Assessed = a result that says something about the control (pass, fail, warn, also when risk accepted). In scope = every applicable check (all results except 'na' and findings marked not applicable). */
export interface ScoreCoverage {
  assessed: number;
  inScope: number;
}

/** Grade only when at least half of the applicable checks were assessed; 'partial' when less than 90%. */
export const MIN_GRADED_COVERAGE = 0.5;
export const FULL_COVERAGE = 0.9;

export interface ScoreSummary {
  /** Null when too little was assessed to grade (see MIN_GRADED_COVERAGE). */
  score: number | null;
  grade: string | null;
  coverage: ScoreCoverage;
  /** Graded, but fewer than 90% of the applicable checks were assessed. */
  partial: boolean;
  /** Per result after triage. false_positive (not applicable) is counted separately and not scored; tiles sum to the number of results. */
  counts: Record<ResultStatus | 'accepted' | 'false_positive', number>;
  severityCounts: Record<Severity, number>;
  domainScores: { domain: Domain; score: number | null }[];
  controls: ControlAssessment[];
  /** Assessable Annex A controls (ISO_ASSESSABLE) that no result in this scan evidences. */
  notCovered: string[];
}

/** Grade colours (A to D darkened so white text reaches 4.5:1). Used by the web app and the PDF. */
export const GRADE_COLORS: Record<string, string> = { A: '#047857', B: '#4d7c0f', C: '#a16207', D: '#c2410c', E: '#dc2626', F: '#991b1b' };

export function gradeFor(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  if (score >= 35) return 'E';
  return 'F';
}

/** Status after triage: 'false_positive' (not applicable) takes a failure or warning out of the score entirely. */
function effectiveStatus(r: ScoreInput): ResultStatus | 'accepted' | 'false_positive' {
  if (r.triage === 'false_positive' && (r.status === 'fail' || r.status === 'warn')) return 'false_positive';
  if (r.triage === 'accepted' && (r.status === 'fail' || r.status === 'warn')) return 'accepted';
  return r.status;
}

/** Fraction of the check weight earned: pass = full, warn = half, fail = none. */
function earned(status: ResultStatus | 'accepted' | 'false_positive'): number | null {
  switch (status) {
    case 'pass':
      return 1;
    case 'warn':
      return 0.5;
    case 'fail':
      return 0;
    default:
      return null; // na, error, accepted, not applicable: not scored
  }
}

/** Every check is weighted by its severity only; there is no weighting per domain or organisation. */
export function computeScore(results: ScoreInput[], catalog: Record<string, CheckMeta>): ScoreSummary {
  const counts = { pass: 0, fail: 0, warn: 0, na: 0, error: 0, accepted: 0, false_positive: 0 };
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const domainAcc = Object.fromEntries(DOMAINS.map((d) => [d, { got: 0, max: 0 }])) as Record<
    Domain,
    { got: number; max: number }
  >;
  type Acc = {
    got: number;
    max: number;
    checks: ControlAssessment['checks'];
    severeFail: boolean;
    severeSecondaryFail: boolean;
    failed: number;
    passed: number;
    primaryAssessed: number;
    primaryMajor: boolean;
    secondaryAssessed: number;
  };
  const controlAcc = new Map<string, Acc>();
  let got = 0;
  let max = 0;

  for (const r of results) {
    const meta = catalog[r.checkId];
    if (!meta) continue;
    const status = effectiveStatus(r);
    const falsePositive = status === 'false_positive';
    counts[status]++;
    if (status === 'fail' || status === 'warn') severityCounts[r.severity]++;

    const e = earned(status);
    const sevW = Math.max(SEVERITY_WEIGHT[r.severity], 0.5);
    if (e !== null) {
      got += sevW * e;
      max += sevW;
      domainAcc[meta.domain].got += sevW * e;
      domainAcc[meta.domain].max += sevW;
    }

    // For controls, an accepted risk still counts as a gap (half credit): accepting a risk does not make a control effective.
    const ce = status === 'accepted' ? 0.5 : e;
    const major = r.severity === 'critical' || r.severity === 'high';
    const triage = status === 'accepted' ? 'accepted' : falsePositive ? 'false_positive' : null;
    meta.frameworks.iso27001.forEach((ctrl, idx) => {
      const primary = idx === 0;
      const acc: Acc = controlAcc.get(ctrl) ?? {
        got: 0, max: 0, checks: [], severeFail: false, severeSecondaryFail: false, failed: 0, passed: 0,
        primaryAssessed: 0, primaryMajor: false, secondaryAssessed: 0,
      };
      acc.checks.push({ checkId: r.checkId, systemId: r.systemId, status: r.status, primary, triage });
      if (ce !== null) {
        const w = sevW * (primary ? 1 : 0.5);
        acc.got += w * ce;
        acc.max += w;
        if (primary) {
          acc.primaryAssessed++;
          if (major) acc.primaryMajor = true;
        } else acc.secondaryAssessed++;
        if (status === 'fail') {
          acc.failed++;
          if (major && primary) acc.severeFail = true;
          if (major && !primary) acc.severeSecondaryFail = true;
        }
        if (status === 'pass') acc.passed++;
      }
      controlAcc.set(ctrl, acc);
    });
  }

  // Findings marked not applicable (false_positive) leave the scope, like results that are not applicable.
  const inScope = results.filter((r) => catalog[r.checkId] && r.status !== 'na').length - counts.false_positive;
  const assessed = counts.pass + counts.fail + counts.warn + counts.accepted;
  const graded = inScope > 0 && max > 0 && assessed / inScope >= MIN_GRADED_COVERAGE;
  const score = graded ? Math.round((got / max) * 100) : null;
  const controls: ControlAssessment[] = [...controlAcc.entries()]
    .sort(([a], [b]) => isoSort(a, b))
    .map(([id, acc]) => {
      const evidence: EvidenceStrength =
        acc.primaryAssessed === 0 ? (acc.secondaryAssessed > 0 ? 'indirect' : 'none') : acc.primaryMajor || acc.primaryAssessed >= 2 ? 'strong' : 'limited';
      let verdict: ControlVerdict;
      if (acc.max === 0) verdict = 'not_assessed';
      else if (acc.severeFail || acc.got / acc.max < 0.5) verdict = 'not_effective';
      else if (acc.got < acc.max || acc.severeSecondaryFail) verdict = 'partial';
      // Clean results only make a control "effective" when the evidence is strong enough to say so.
      else verdict = evidence === 'strong' ? 'effective' : 'no_issues_limited';
      return {
        id,
        title: ISO_BY_ID[id]?.title ?? id,
        verdict,
        evidence,
        score: acc.max === 0 ? null : Math.round((acc.got / acc.max) * 100),
        checks: acc.checks,
        failed: acc.failed,
        passed: acc.passed,
      };
    });

  const evidenced = new Set(controls.filter((c) => c.verdict !== 'not_assessed').map((c) => c.id));
  const notCovered = ISO_ASSESSABLE.filter((id) => !evidenced.has(id));

  return {
    score,
    grade: score === null ? null : gradeFor(score),
    coverage: { assessed, inScope },
    partial: score !== null && assessed / inScope < FULL_COVERAGE,
    counts,
    severityCounts,
    domainScores: DOMAINS.map((d) => ({
      domain: d,
      score: domainAcc[d].max === 0 ? null : Math.round((domainAcc[d].got / domainAcc[d].max) * 100),
    })),
    controls,
    notCovered,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Partial: 12 of 20 checks assessed" when graded on partial coverage, otherwise null. */
export function partialLabel(s: Pick<ScoreSummary, 'partial' | 'coverage'>): string | null {
  return s.partial ? `Partial: ${s.coverage.assessed} of ${s.coverage.inScope} checks assessed` : null;
}

/** Executive summary sentences shared by the web report and the PDF so they never disagree. */
export function executiveSummarySentences(s: ScoreSummary): string[] {
  const parts: string[] = [];
  const { assessed, inScope } = s.coverage;
  const na = s.counts.na ?? 0;
  const naNote = na ? ` (${na} not applicable)` : '';
  if (inScope === 0 || assessed === 0) {
    parts.push(`No checks could be assessed${naNote}, so no grade is given.`);
    return parts;
  }
  parts.push(`${assessed} of ${plural(inScope, 'check', 'checks')} could be assessed${naNote}.`);
  if (s.score === null || s.grade === null) parts.push('Too few checks could be assessed for a reliable grade, so no grade is given.');
  else parts.push(`Overall grade ${s.grade} (${s.score}/100)${s.partial ? ', partial because not every check could be assessed' : ''}.`);
  const fail = s.counts.fail ?? 0;
  const warn = s.counts.warn ?? 0;
  const crit = s.severityCounts.critical ?? 0;
  const high = s.severityCounts.high ?? 0;
  if (fail + warn === 0) parts.push('No failed checks or warnings.');
  else {
    const sev = [crit && `${crit} critical`, high && `${high} high`].filter(Boolean).join(' and ');
    parts.push(`${plural(fail, 'failed check', 'failed checks')} and ${plural(warn, 'warning', 'warnings')}${sev ? `, of which ${sev} severity` : ''}.`);
  }
  const gaps = s.domainScores
    .filter((d) => d.score !== null && d.score < 75)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, 2)
    .map((d) => DOMAIN_LABELS[d.domain] ?? d.domain);
  if (gaps.length) parts.push(`Biggest gaps: ${gaps.join(', ')}.`);
  const accepted = s.counts.accepted ?? 0;
  const fp = s.counts.false_positive ?? 0;
  if (accepted) parts.push(`${plural(accepted, 'finding is', 'findings are')} risk accepted.`);
  if (fp) parts.push(`${plural(fp, 'finding is', 'findings are')} marked not applicable or false positive and left out of the score.`);
  return parts;
}
