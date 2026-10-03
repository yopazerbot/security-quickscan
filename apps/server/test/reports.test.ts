import { brandingSchema, computeRiskProfile, DEFAULT_CONTEXT, REPORT_TITLE } from '@qs/shared';
import { randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { randomToken, sha256 } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { auditLog, checkResults, customers, findingTriage, scans, scanSystems, sessions, users } from '../src/db/schema.js';
import { controlsCsv, findingsCsv, statusText } from '../src/reports/csv.js';
import { buildReport, type ReportModel } from '../src/reports/model.js';
import { cover, renderPdf } from '../src/reports/pdf.js';
import { refreshCustomerScores, scoreScan, storeScanScore } from '../src/scoring.js';

function fakeModel(over: Partial<ReportModel['summary']> = {}): ReportModel {
  const summary = {
    score: 72,
    grade: 'C',
    coverage: { assessed: 7, inScope: 10 },
    partial: true,
    counts: { pass: 5, fail: 1, warn: 1, na: 1, error: 3, accepted: 0, false_positive: 0 },
    severityCounts: { critical: 1, high: 0, medium: 1, low: 0, info: 0 },
    domainScores: [],
    controls: [],
    ...over,
  } as ReportModel['summary'];
  return {
    generatedAt: new Date().toISOString(),
    scan: { id: 'x', name: 'Scan', status: 'completed', startedAt: new Date(), finishedAt: new Date(), retentionMode: 'days', retentionDays: 7, frozen: true },
    customer: { id: 'c', name: 'Acme', country: 'BE', context: DEFAULT_CONTEXT },
    riskProfile: computeRiskProfile(DEFAULT_CONTEXT),
    branding: brandingSchema.parse({ consultantName: 'A very long consultant name that keeps going', companyName: 'An equally long consultancy company name BV', contactEmail: 'hello@example.com' }),
    systems: [],
    summary,
    findings: [],
    passed: [],
    notAssessed: [],
    excluded: [],
    topRisks: [],
    quickWins: [],
    comparison: null,
  };
}

describe('PDF', () => {
  it('draws the cover title in white (regression)', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const calls: [string, unknown][] = [];
    const fill = doc.fillColor.bind(doc);
    const text = doc.text.bind(doc);
    vi.spyOn(doc, 'fillColor').mockImplementation(((c: any, o?: any) => (calls.push(['fill', c]), fill(c, o))) as any);
    vi.spyOn(doc, 'text').mockImplementation(((t: any, ...rest: any[]) => (calls.push(['text', t]), (text as any)(t, ...rest))) as any);
    cover(doc, fakeModel(), null);
    const titleAt = calls.findIndex(([k, v]) => k === 'text' && v === 'Cloud Security');
    expect(titleAt).toBeGreaterThan(-1);
    const lastFill = calls.slice(0, titleAt).filter(([k]) => k === 'fill').pop();
    expect(lastFill?.[1]).toBe('#ffffff');
    // The second title line inherits the same fill.
    expect(calls[titleAt + 1]).toEqual(['text', 'Quick Scan Report']);
    expect(REPORT_TITLE).toBe('Cloud Security Quick Scan Report');
    doc.end();
  });

  it('renders not-assessed and partial grades', async () => {
    for (const m of [fakeModel(), fakeModel({ score: null, grade: null, partial: false, coverage: { assessed: 0, inScope: 0 } })]) {
      const pdf = await renderPdf(m, null);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });
});

describe('CSV labels', () => {
  it('uses readable status and triage labels', () => {
    expect(statusText('fail', { status: 'accepted', note: '' })).toBe('fail (risk accepted)');
    expect(statusText('warn', { status: 'false_positive', note: '' })).toBe('warning (false positive)');
    expect(statusText('na', null)).toBe('not applicable');
    expect(statusText('pass', { status: 'accepted', note: '' })).toBe('pass');
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('report model', () => {
  const config = loadConfig({
    NODE_ENV: 'test', APP_URL: 'http://localhost:8080', DATABASE_URL: url ?? 'postgres://skipped@localhost/none',
    MASTER_KEY: randomBytes(32).toString('base64'), COOKIE_SECURE: 'false', ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: 'x', ENTRA_CLIENT_SECRET: 'y', LOG_LEVEL: 'fatal',
  } as any);
  const { db, pool } = createDb(config);
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  let customerId: string;
  const profile = computeRiskProfile(DEFAULT_CONTEXT);

  beforeAll(async () => {
    await runMigrations(db);
    ({ app, ctx } = await buildApp(config, db));
    [{ id: customerId }] = await db.insert(customers).values({ name: `Report Co ${randomToken(3)}`, context: { ...DEFAULT_CONTEXT, industry: 'retail' } }).returning();
  });
  afterAll(async () => {
    await db.delete(customers).where(eq(customers.id, customerId));
    await app.close();
    await pool.end();
  });

  let at = Date.UTC(2026, 0, 1);
  async function makeScan(systems: { label: string; provider: 'aws' | 'github'; config: Record<string, unknown>; results: [string, string][] }[], status: 'completed' | 'failed' = 'completed') {
    at += 86_400_000;
    const [scan] = await db
      .insert(scans)
      .values({ customerId, name: 'Scan', status, context: DEFAULT_CONTEXT, riskProfile: profile, retentionMode: 'days', retentionDays: 14, startedAt: new Date(at - 60_000), finishedAt: new Date(at) })
      .returning();
    for (const s of systems) {
      const [sys] = await db.insert(scanSystems).values({ scanId: scan.id, provider: s.provider, label: s.label, config: s.config }).returning();
      for (const [checkId, st] of s.results) await db.insert(checkResults).values({ scanId: scan.id, systemId: sys.id, checkId, status: st as any, summary: `${checkId} ${st}` });
    }
    return scan.id;
  }

  const prodAws = { label: 'Production AWS', provider: 'aws' as const, config: { accountId: '111122223333' } };
  const sandboxAws = { label: 'Sandbox AWS', provider: 'aws' as const, config: { accountId: '444455556666' } };

  it('applies triage per system, freezes finished reports and compares like for like', async () => {
    const prodOnly = await makeScan([{ ...prodAws, results: [['aws.root-mfa', 'fail'], ['aws.cloudtrail', 'fail']] }]);
    await storeScanScore(ctx, prodOnly);
    const gh = await makeScan([{ label: 'GitHub', provider: 'github', config: { org: 'acme' }, results: [['gh.org-2fa', 'fail']] }]);
    await storeScanScore(ctx, gh);
    // Triage the root MFA finding on the sandbox account only.
    await db.insert(findingTriage).values({ customerId, checkId: 'aws.root-mfa', systemKey: 'aws:444455556666', status: 'accepted', note: 'sandbox' });
    const both = await makeScan([
      { ...prodAws, results: [['aws.root-mfa', 'fail'], ['aws.cloudtrail', 'pass'], ['aws.password-policy', 'running']] },
      { ...sandboxAws, results: [['aws.root-mfa', 'fail']] },
    ]);
    await storeScanScore(ctx, both);

    const m = await buildReport(ctx, both);
    expect(m.scan.frozen).toBe(true);
    expect(m.scan.retentionDays).toBe(14);
    expect(m.customer.context.industry).toBe(DEFAULT_CONTEXT.industry); // scan-time context, not the live 'retail'
    const root = (k: string) => m.findings.find((f) => f.checkId === 'aws.root-mfa' && f.systemKey === k)!;
    expect(root('aws:444455556666').triage?.status).toBe('accepted');
    expect(root('aws:111122223333').triage).toBeNull();
    expect(m.topRisks.some((f) => f.systemKey === 'aws:111122223333' && f.checkId === 'aws.root-mfa')).toBe(true);
    // Unfinished results of a finished scan are not assessed.
    expect(m.notAssessed.find((i) => i.checkId === 'aws.password-policy')?.status).toBe('error');
    expect(m.summary.coverage).toEqual({ assessed: 3, inScope: 4 });
    expect(m.summary.counts.accepted).toBe(1);

    // Compared with the production-only scan (shared system), not the later GitHub-only one in between.
    expect(m.comparison?.previousScanId).toBe(prodOnly);
    expect(m.comparison?.differentScope).toBe(true);
    expect(m.comparison?.resolved).toEqual(['aws:111122223333|aws.cloudtrail']);
    expect(m.comparison?.persisting).toEqual(['aws:111122223333|aws.root-mfa']);
    expect(m.comparison?.newFindings).toEqual([]);
    expect(root('aws:444455556666').isNew).toBe(false); // the sandbox was not in the previous scan
    expect((await buildReport(ctx, gh)).comparison).toBeNull();

    // New triage does not rescore a finished scan, but shows as the current decision.
    const before = (await db.select().from(scans).where(eq(scans.id, both)))[0];
    await db.insert(findingTriage).values({ customerId, checkId: 'aws.root-mfa', systemKey: 'aws:111122223333', status: 'accepted', note: 'prod' });
    await refreshCustomerScores(ctx, customerId);
    const after = (await db.select().from(scans).where(eq(scans.id, both)))[0];
    expect(after.score).toBe(before.score);
    const m2 = await buildReport(ctx, both);
    expect(m2.summary.counts.accepted).toBe(1);
    const prodRoot = m2.findings.find((f) => f.checkId === 'aws.root-mfa' && f.systemKey === 'aws:111122223333')!;
    expect(prodRoot.triage).toBeNull();
    expect(prodRoot.currentTriage?.status).toBe('accepted');
    // A live (re)score uses the new decision.
    expect((await scoreScan(ctx, both)).counts.accepted).toBe(2);

    expect(findingsCsv(m2)).toContain('"fail (risk accepted)"');
    expect(controlsCsv(m2)).toContain('[aws.root-mfa]');
    const pdf = await renderPdf(m2, null);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('stores no grade when every check errored', async () => {
    const id = await makeScan([{ ...prodAws, results: [['aws.root-mfa', 'error'], ['aws.cloudtrail', 'error']] }]);
    const s = await storeScanScore(ctx, id);
    expect(s.grade).toBeNull();
    const row = (await db.select().from(scans).where(eq(scans.id, id)))[0];
    expect(row.score).toBeNull();
    expect(row.grade).toBeNull();
  });

  it('audits report.view at most once per user, scan and hour', async () => {
    const id = await makeScan([{ ...prodAws, results: [['aws.root-mfa', 'pass']] }]);
    await storeScanScore(ctx, id);
    const [u] = await db.insert(users).values({ email: `viewer-${randomToken(4)}@test.local`, name: 'Admin', role: 'admin' }).returning();
    const token = randomToken();
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: randomToken(), authMethod: 'test', expiresAt: new Date(Date.now() + 3600_000) });
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'GET', url: `/api/scans/${id}/report`, headers: { cookie: `qs_session=${token}` } });
      expect(r.statusCode).toBe(200);
      expect(r.json().items ?? r.json().findings).toBeDefined();
    }
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.action, 'report.view'), eq(auditLog.targetId, id)));
    expect(rows).toHaveLength(1);
  });
});
