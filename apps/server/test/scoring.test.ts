import { CHECKS, CHECKS_BY_ID, computeRiskProfile, computeScore, DEFAULT_CONTEXT, executiveSummarySentences, GRADE_COLORS, ISO_ASSESSABLE, ISO_BY_ID, IMPLEMENTED, partialLabel, ROLE_LABELS, ROLES, SEVERITY_WEIGHT, type CheckMeta, type ScoreInput } from './fixtures.js';
import { describe, expect, it } from 'vitest';

describe('catalog', () => {
  it('maps every check to a known ISO 27001:2022 Annex A control and has an implementation', () => {
    for (const c of CHECKS) {
      expect(c.frameworks.iso27001.length).toBeGreaterThan(0);
      for (const ctrl of c.frameworks.iso27001) expect(ISO_BY_ID[ctrl], `${c.id} -> ${ctrl}`).toBeDefined();
      expect(IMPLEMENTED.has(c.id), c.id).toBe(true);
    }
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });
});

describe('role labels', () => {
  it('has a display label for every role', () => {
    for (const r of ROLES) expect(ROLE_LABELS[r], r).toBeTruthy();
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...ROLES].sort());
    expect(ROLE_LABELS.consultant).toBe('Analyst');
  });
});

describe('risk profile', () => {
  it('rates a small low-exposure company low and a NIS2 bank critical', () => {
    expect(computeRiskProfile({ ...DEFAULT_CONTEXT, employees: '1-10', securityMaturity: 'managed', remoteWork: 'none', internetExposure: 'none', dataSensitivity: 'low' }).level).toBe('low');
    const bank = computeRiskProfile({ ...DEFAULT_CONTEXT, industry: 'finance', employees: '1000+', regulations: ['nis2_essential', 'dora'], dataSensitivity: 'very_high', internetExposure: 'significant' });
    expect(bank.level).toBe('critical');
    expect(bank.domainWeights.data).toBeGreaterThan(1);
  });
});

describe('scoring', () => {
  const weights = computeRiskProfile(DEFAULT_CONTEXT).domainWeights;
  it('gives 100 / A when everything passes', () => {
    const s = computeScore([{ checkId: 'm365.mfa-all-users', status: 'pass', severity: 'critical' }], CHECKS_BY_ID, weights);
    expect(s.score).toBe(100);
    expect(s.grade).toBe('A');
    expect(s.controls.find((c) => c.id === '8.5')?.verdict).toBe('effective');
  });
  it('marks the primary control not effective on a critical failure', () => {
    const s = computeScore(
      [
        { checkId: 'm365.mfa-all-users', status: 'fail', severity: 'critical' },
        { checkId: 'm365.weak-auth-methods', status: 'pass', severity: 'low' },
      ],
      CHECKS_BY_ID,
      weights,
    );
    expect(s.controls.find((c) => c.id === '8.5')?.verdict).toBe('not_effective');
    expect(s.score).toBeLessThan(20);
  });
  it('needs strong evidence for an effective verdict', () => {
    // A single critical primary check is strong evidence.
    const s = computeScore([{ checkId: 'm365.mfa-all-users', status: 'pass', severity: 'critical' }], CHECKS_BY_ID, weights);
    const c85 = s.controls.find((c) => c.id === '8.5')!;
    expect(c85.evidence).toBe('strong');
    expect(c85.verdict).toBe('effective');
  });
  it('treats false positives as pass and excludes accepted risks', () => {
    const fp = computeScore([{ checkId: 'gh.org-2fa', status: 'fail', severity: 'critical', triage: 'false_positive' }], CHECKS_BY_ID, weights);
    expect(fp.score).toBe(100);
    const acc = computeScore(
      [
        { checkId: 'gh.org-2fa', status: 'fail', severity: 'critical', triage: 'accepted' },
        { checkId: 'gh.base-permissions', status: 'pass', severity: 'high' },
      ],
      CHECKS_BY_ID,
      weights,
    );
    expect(acc.score).toBe(100);
    expect(acc.counts.accepted).toBe(1);
    // In the control, the accepted critical failure still counts as a gap.
    const ctrl = acc.controls.find((c) => c.id === CHECKS_BY_ID['gh.org-2fa'].frameworks.iso27001[0])!;
    expect(['partial', 'not_effective']).toContain(ctrl.verdict);
    expect(ctrl.checks.find((x) => x.checkId === 'gh.org-2fa')).toMatchObject({ status: 'fail', primary: true, triage: 'accepted' });
  });
  it('ignores n/a and errors', () => {
    const s = computeScore([{ checkId: 'aws.rds-public', status: 'na', severity: 'high' }], CHECKS_BY_ID, weights);
    expect(s.controls.find((c) => c.id === '8.20')?.verdict).toBe('not_assessed');
  });
});

describe('coverage-aware grade', () => {
  const weights = computeRiskProfile(DEFAULT_CONTEXT).domainWeights;
  const ids = CHECKS.filter((c) => c.provider === 'aws').map((c) => c.id).slice(0, 10);
  const mk = (statuses: string[]) => statuses.map((status, i) => ({ checkId: ids[i], status: status as any, severity: CHECKS_BY_ID[ids[i]].severity }));

  it('gives no score or grade when nothing is in scope', () => {
    const empty = computeScore([], CHECKS_BY_ID, weights);
    expect(empty.score).toBeNull();
    expect(empty.grade).toBeNull();
    expect(empty.coverage).toEqual({ assessed: 0, inScope: 0 });
    expect(empty.partial).toBe(false);
    const allNa = computeScore(mk(['na', 'na']), CHECKS_BY_ID, weights);
    expect(allNa.grade).toBeNull();
    expect(allNa.coverage.inScope).toBe(0);
    expect(executiveSummarySentences(allNa)[0]).toBe('No checks could be assessed (2 not applicable), so no grade is given.');
  });

  it('gives no grade when fewer than half of the applicable checks were assessed (all errors included)', () => {
    const allErrors = computeScore(mk(['error', 'error', 'error']), CHECKS_BY_ID, weights);
    expect(allErrors.score).toBeNull();
    expect(allErrors.grade).toBeNull();
    expect(executiveSummarySentences(allErrors)).toEqual(['No checks could be assessed, so no grade is given.']);
    const s = computeScore(mk(['pass', 'pass', 'error', 'error', 'error']), CHECKS_BY_ID, weights);
    expect(s.coverage).toEqual({ assessed: 2, inScope: 5 });
    expect(s.score).toBeNull();
    expect(s.grade).toBeNull();
    expect(s.partial).toBe(false);
    expect(executiveSummarySentences(s).slice(0, 2)).toEqual(['2 of 5 checks could be assessed.', 'Too few checks could be assessed for a reliable grade, so no grade is given.']);
  });

  it('grades with a partial flag between 50% and 90%', () => {
    const s = computeScore(mk(['pass', 'pass', 'pass', 'error', 'error', 'na']), CHECKS_BY_ID, weights);
    expect(s.coverage).toEqual({ assessed: 3, inScope: 5 });
    expect(s.score).toBe(100);
    expect(s.grade).toBe('A');
    expect(s.partial).toBe(true);
    expect(partialLabel(s)).toBe('Partial: 3 of 5 checks assessed');
    // Exactly half is still graded.
    expect(computeScore(mk(['pass', 'error']), CHECKS_BY_ID, weights).grade).toBe('A');
  });

  it('grades fully at 90% coverage or more and counts every result once', () => {
    const s = computeScore(
      [
        ...mk(['pass', 'fail', 'warn', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'error']),
        { checkId: 'gh.org-2fa', status: 'fail', severity: 'critical', triage: 'false_positive' },
        { checkId: 'gh.base-permissions', status: 'fail', severity: 'high', triage: 'accepted' },
      ],
      CHECKS_BY_ID,
      weights,
    );
    expect(s.coverage).toEqual({ assessed: 11, inScope: 12 });
    expect(s.partial).toBe(false);
    expect(s.grade).not.toBeNull();
    expect(s.counts.false_positive).toBe(1);
    expect(s.counts.accepted).toBe(1);
    expect(s.counts.pass).toBe(7);
    const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(12);
  });

  it('uses darker grade colours that keep white text readable', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const g of ['A', 'B', 'C', 'D', 'E', 'F']) expect(1.05 / (lum(GRADE_COLORS[g]) + 0.05), g).toBeGreaterThanOrEqual(4.5);
  });
});

describe('ISO control evidence', () => {
  const weights = computeRiskProfile(DEFAULT_CONTEXT).domainWeights;
  const input = (c: CheckMeta, status: ScoreInput['status'] = 'pass', extra: Partial<ScoreInput> = {}): ScoreInput => ({ checkId: c.id, status, severity: c.severity, ...extra });
  const primaryOf = (ctrl: string) => CHECKS.filter((c) => c.frameworks.iso27001[0] === ctrl);
  const control = (results: ScoreInput[], id: string) => computeScore(results, CHECKS_BY_ID, weights).controls.find((c) => c.id === id)!;

  it('rates a single minor primary check as limited evidence (no issues found, not effective)', () => {
    const minor = CHECKS.find((c) => ['low', 'medium', 'info'].includes(c.severity))!;
    const c = control([input(minor)], minor.frameworks.iso27001[0]);
    expect(c.evidence).toBe('limited');
    expect(c.verdict).toBe('no_issues_limited');
  });

  it('rates two primary checks as strong evidence', () => {
    const ctrl = Object.keys(ISO_BY_ID).find((id) => primaryOf(id).filter((c) => c.severity !== 'critical' && c.severity !== 'high').length >= 2);
    if (!ctrl) return;
    const two = primaryOf(ctrl).filter((c) => c.severity !== 'critical' && c.severity !== 'high').slice(0, 2);
    expect(control([input(two[0])], ctrl).evidence).toBe('limited');
    const c = control(two.map((x) => input(x)), ctrl);
    expect(c.evidence).toBe('strong');
    expect(c.verdict).toBe('effective');
  });

  it('rates controls with only secondary mappings as indirect evidence', () => {
    const check = CHECKS.find((c) => c.frameworks.iso27001.length > 1)!;
    const secondary = check.frameworks.iso27001[1];
    const c = control([input(check)], secondary);
    expect(c.evidence).toBe('indirect');
    expect(c.verdict).toBe('no_issues_limited');
    expect(c.checks).toEqual([{ checkId: check.id, systemId: undefined, status: 'pass', primary: false, triage: null }]);
  });

  it('caps a control at partial on a high or critical secondary failure', () => {
    // The control with the most primary weight that a high or critical check maps to as a secondary control.
    const candidates = CHECKS.filter((c) => ['critical', 'high'].includes(c.severity)).flatMap((c) =>
      c.frameworks.iso27001.slice(1).map((ctrl) => ({ check: c, ctrl, primaries: primaryOf(ctrl).filter((p) => p.id !== c.id) })),
    );
    const weight = (cs: CheckMeta[]) => cs.reduce((a, c) => a + Math.max(SEVERITY_WEIGHT[c.severity], 0.5), 0);
    const best = candidates.sort((a, b) => weight(b.primaries) - weight(a.primaries))[0];
    expect(best.primaries.length).toBeGreaterThan(0);
    const results = [...best.primaries.map((p) => input(p)), input(best.check, 'fail')];
    const c = control(results, best.ctrl);
    expect(c.evidence).toBe('strong');
    expect(c.verdict).toBe('partial');
    // Without the secondary failure the same evidence is effective.
    expect(control(best.primaries.map((p) => input(p)), best.ctrl).verdict).toBe('effective');
  });

  it('keeps a primary critical or high failure not effective', () => {
    const major = CHECKS.find((c) => c.severity === 'critical')!;
    expect(control([input(major, 'fail')], major.frameworks.iso27001[0]).verdict).toBe('not_effective');
  });

  it('lists assessable controls without results as not covered', () => {
    const check = CHECKS_BY_ID['m365.mfa-all-users'];
    const s = computeScore([input(check)], CHECKS_BY_ID, weights);
    const covered = new Set(check.frameworks.iso27001);
    expect(s.notCovered).toEqual(ISO_ASSESSABLE.filter((id) => !covered.has(id)));
    // Not applicable results evidence nothing.
    expect(computeScore([input(check, 'na')], CHECKS_BY_ID, weights).notCovered).toEqual(ISO_ASSESSABLE);
    expect(computeScore([], CHECKS_BY_ID, weights).notCovered).toEqual(ISO_ASSESSABLE);
  });

  it('attributes control results to their system', () => {
    const check = CHECKS_BY_ID['m365.mfa-all-users'];
    const c = control([input(check, 'fail', { systemId: 'sys-a' }), input(check, 'pass', { systemId: 'sys-b' })], '8.5');
    expect(c.checks.map((x) => [x.systemId, x.status])).toEqual([['sys-a', 'fail'], ['sys-b', 'pass']]);
    expect(c.verdict).toBe('not_effective');
  });
});
