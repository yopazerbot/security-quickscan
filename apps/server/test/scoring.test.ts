import { CHECKS, CHECKS_BY_ID, computeRiskProfile, computeScore, DEFAULT_CONTEXT, ISO_BY_ID, IMPLEMENTED } from './fixtures.js';
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
  });
  it('ignores n/a and errors', () => {
    const s = computeScore([{ checkId: 'aws.rds-public', status: 'na', severity: 'high' }], CHECKS_BY_ID, weights);
    expect(s.controls.find((c) => c.id === '8.20')?.verdict).toBe('not_assessed');
  });
});
