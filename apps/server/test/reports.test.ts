import { brandingSchema, CHECKS_BY_ID, computeScore, ISO_ASSESSABLE, PROVIDER_ICONS, PROVIDERS, REPORT_TITLE, VERDICT_LABELS } from '@qs/shared';
import { randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { randomToken, sha256 } from '../src/crypto/envelope.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { auditLog, checkResults, customers, findingTriage, scanCriteria, scans, scanSystems, sessions, users } from '../src/db/schema.js';
import { controlsCsv, findingsCsv, statusText } from '../src/reports/csv.js';
import { buildReport, systemIdentity, type ReportItem, type ReportModel } from '../src/reports/model.js';
import { cover, drawProviderIcon, isoPage, notCoveredList, renderPdf, systemsTable } from '../src/reports/pdf.js';
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
    notCovered: [],
    ...over,
  } as ReportModel['summary'];
  return {
    generatedAt: new Date().toISOString(),
    scan: { id: 'x', name: 'Scan', status: 'completed', startedAt: new Date(), finishedAt: new Date(), retentionMode: 'days', retentionDays: 7, frozen: true },
    customer: { id: 'c', name: 'Acme' },
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

/** Records drawing calls on a fresh document. */
function spyDoc() {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const calls: [string, unknown][] = [];
  for (const k of ['path', 'roundedRect', 'rect', 'circle', 'text', 'fill', 'stroke'] as const) {
    const orig = (doc as any)[k].bind(doc);
    vi.spyOn(doc as any, k).mockImplementation((...a: any[]) => (calls.push([k, a[0]]), orig(...a)));
  }
  return { doc, calls };
}

function item(over: Partial<ReportItem> & Pick<ReportItem, 'checkId' | 'status' | 'systemId' | 'systemLabel'>): ReportItem {
  const m = CHECKS_BY_ID[over.checkId];
  return {
    key: `${over.systemId}:${over.checkId}`, title: m.title, description: m.description, provider: m.provider, domain: m.domain, severity: m.severity,
    summary: 'x', resources: [], evidence: null, remediation: m.remediation, references: [], iso: m.frameworks.iso27001, effort: m.effort,
    providerLabel: m.provider, systemIdentity: null, systemKey: `${m.provider}:${over.systemId}`, triage: null, currentTriage: null, isNew: false, ...over,
  };
}

/** Two AWS systems: root MFA fails on production and passes on the sandbox. */
function twoSystemModel(): ReportModel {
  const items = [
    item({ checkId: 'aws.root-mfa', status: 'fail', systemId: 'p', systemLabel: 'AWS production', systemIdentity: 'AWS account 111122223333', resources: [{ id: 'root', url: 'https://console.aws.amazon.com/iam/home#/security_credentials' }] }),
    item({ checkId: 'aws.root-mfa', status: 'pass', systemId: 's', systemLabel: 'AWS sandbox', systemIdentity: 'AWS account 444455556666' }),
  ];
  const inputs = (xs: ReportItem[]) => xs.map((i) => ({ checkId: i.checkId, status: i.status, severity: i.severity, systemId: i.systemId }));
  const m = fakeModel(computeScore(inputs(items), CHECKS_BY_ID));
  const sys = (id: string, label: string, identity: string) => ({
    id, provider: 'aws' as const, providerLabel: 'AWS', label, systemKey: `aws:${id}`, identity, credentialsStored: false, credentialsExpireAt: null, authMode: 'role',
    summary: computeScore(inputs(items.filter((i) => i.systemId === id)), CHECKS_BY_ID),
  });
  m.systems = [sys('p', 'AWS production', 'AWS account 111122223333'), sys('s', 'AWS sandbox', 'AWS account 444455556666')];
  m.findings = items.filter((i) => i.status === 'fail');
  m.passed = items.filter((i) => i.status === 'pass');
  m.topRisks = m.findings;
  return m;
}

describe('PDF icons, systems and ISO evidence', () => {
  it('draws every provider icon from the shared geometry as vectors', () => {
    for (const p of PROVIDERS) {
      const { doc, calls } = spyDoc();
      drawProviderIcon(doc, p, 50, 50, 12);
      const kinds = PROVIDER_ICONS[p].shapes.map((sh) => ({ rect: 'roundedRect', path: 'path', circle: 'circle', text: 'text' })[sh.kind]);
      for (const k of kinds) expect(calls.some(([c]) => c === k), `${p} ${k}`).toBe(true);
      if (p === 'aws') expect(calls).toContainEqual(['text', 'aws']);
      doc.end();
    }
  });

  it('lists systems with icon, identity and grade', () => {
    const { doc, calls } = spyDoc();
    systemsTable(doc, twoSystemModel());
    const texts = calls.filter(([k]) => k === 'text').map(([, v]) => v);
    expect(texts).toEqual(expect.arrayContaining(['AWS production', 'AWS account 111122223333', 'AWS sandbox', 'Warnings']));
    expect(texts.some((t) => typeof t === 'string' && /^[A-F] \(\d+\)/.test(t))).toBe(true);
    expect(calls.filter(([k]) => k === 'roundedRect').length).toBeGreaterThanOrEqual(2); // AWS icon background per row
    doc.end();
  });

  it('shows the evidence column, the limited-evidence verdict with legend and the not covered list', () => {
    const m = fakeModel();
    m.summary.controls = [
      { id: '5.14', title: 'Information transfer', verdict: 'no_issues_limited', evidence: 'limited', score: 100, checks: [], failed: 0, passed: 1 },
      { id: '8.5', title: 'Secure authentication', verdict: 'not_effective', evidence: 'strong', score: 0, checks: [{ checkId: 'aws.root-mfa', systemId: 'p', status: 'fail', primary: true, triage: null }], failed: 1, passed: 0 },
    ];
    m.summary.notCovered = ['8.23'];
    m.systems = twoSystemModel().systems;
    const { doc, calls } = spyDoc();
    isoPage(doc, m);
    notCoveredList(doc, m);
    const texts = calls.filter(([k]) => k === 'text').map(([, v]) => String(v));
    expect(texts).toContain('Evidence');
    expect(texts).toContain('No issues, limited');
    expect(texts).toContain(`1  ${VERDICT_LABELS.no_issues_limited.toUpperCase()}`);
    expect(texts).toContain('Limited');
    expect(texts).toContain('Strong');
    expect(texts).toContain('Issues on: AWS production');
    expect(texts.some((t) => t.includes(`${ISO_ASSESSABLE.length - 1} of ${ISO_ASSESSABLE.length} assessable Annex A controls`))).toBe(true);
    expect(texts).toContain('Annex A controls not covered by automated checks');
    expect(texts).toContain('Web filtering');
    doc.end();
  });

  it('renders a full report with systems, icons and resource links', async () => {
    const pdf = await renderPdf(twoSystemModel(), null);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/URI');
  });
});

describe('system identity', () => {
  it('describes accounts, tenants, subscriptions and organisations', () => {
    expect(systemIdentity('aws', { accountId: '111122223333' }, null)).toBe('AWS account 111122223333');
    expect(systemIdentity('aws', { roleArn: 'arn:aws:iam::444455556666:role/x' }, {})).toBe('AWS account 444455556666');
    expect(systemIdentity('m365', {}, { tenantId: 'g-1', displayName: 'noordkust.example' })).toBe('Tenant noordkust.example (g-1)');
    expect(systemIdentity('github', { org: 'acme' }, null)).toBe('github.com/acme');
    expect(systemIdentity('azure', { tenantId: 'g-1' }, { subscriptions: [{ id: 's1', name: 'prod' }, { id: 's2', name: 's2' }] })).toBe('Tenant g-1; subscriptions: prod (s1), s2');
    expect(systemIdentity('azure', { subscriptionIds: ['a'] }, null)).toBe('subscription: a');
    expect(systemIdentity('m365', {}, null)).toBeNull();
  });
});

describe('CSV columns', () => {
  it('adds identity, system key and resource URLs to findings, evidence and per-system results to controls', () => {
    const m = twoSystemModel();
    m.summary.notCovered = ['8.23'];
    const f = findingsCsv(m).split('\r\n');
    expect(f[0]).toContain('"Identity","System key"');
    expect(f[0]).toContain('"Resource URLs"');
    expect(f[1]).toContain('"AWS account 111122223333","aws:p"');
    expect(f[1]).toContain('https://console.aws.amazon.com/iam/home#/security_credentials');
    const c = controlsCsv(m);
    expect(c).toContain('"Evidence"');
    expect(c).toContain('"Results per system"');
    expect(c).toContain('AWS production: fail; AWS sandbox: pass');
    expect(c).toContain('"A.8.23","Web filtering","Not covered by automated checks"');
  });
});

describe('CSV labels', () => {
  it('uses readable status and triage labels', () => {
    expect(statusText('fail', { status: 'accepted', note: '' })).toBe('fail (risk accepted)');
    expect(statusText('warn', { status: 'false_positive', note: '' })).toBe('warning (not applicable / false positive)');
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

  beforeAll(async () => {
    await runMigrations(db);
    ({ app, ctx } = await buildApp(config, db));
    [{ id: customerId }] = await db.insert(customers).values({ name: `Report Co ${randomToken(3)}`, context: {} }).returning();
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
      .values({ customerId, name: 'Scan', status, context: {}, riskProfile: {}, retentionMode: 'days', retentionDays: 14, startedAt: new Date(at - 60_000), finishedAt: new Date(at) })
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
    expect(m).not.toHaveProperty('riskProfile');
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

    // Per-system attribution and summaries.
    const prodSys = m.systems.find((s) => s.systemKey === 'aws:111122223333')!;
    const sandSys = m.systems.find((s) => s.systemKey === 'aws:444455556666')!;
    expect(prodSys.identity).toBe('AWS account 111122223333');
    expect(root('aws:111122223333').systemIdentity).toBe('AWS account 111122223333');
    expect(root('aws:111122223333').providerLabel).toBe('Amazon Web Services');
    expect(prodSys.summary.counts).toMatchObject({ fail: 1, pass: 1, error: 1 });
    expect(prodSys.summary.coverage).toEqual({ assessed: 2, inScope: 3 });
    expect(sandSys.summary.counts).toMatchObject({ accepted: 1, fail: 0 });
    expect(sandSys.summary.grade).toBeNull(); // only an accepted risk: nothing scored
    const rootCtrl = m.summary.controls.find((c) => c.id === CHECKS_BY_ID['aws.root-mfa'].frameworks.iso27001[0])!;
    expect(new Set(rootCtrl.checks.filter((x) => x.checkId === 'aws.root-mfa').map((x) => x.systemId))).toEqual(new Set([prodSys.id, sandSys.id]));
    expect(rootCtrl.evidence).toBeDefined();
    expect(Array.isArray(m.summary.notCovered)).toBe(true);
    expect(controlsCsv(m)).toContain('Production AWS: fail; Sandbox AWS: fail (risk accepted)');

    expect(findingsCsv(m2)).toContain('"fail (risk accepted)"');
    expect(controlsCsv(m2)).toContain('[aws.root-mfa]');
    const pdf = await renderPdf(m2, null);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('derives evidence, attribution and not covered controls for summaries frozen before they existed', async () => {
    const id = await makeScan([{ ...prodAws, results: [['aws.root-mfa', 'fail'], ['aws.cloudtrail', 'pass']] }]);
    const s = await storeScanScore(ctx, id);
    // A legacy stored summary: no evidence, no systemId, no notCovered.
    const legacy = { ...s, notCovered: undefined, controls: s.controls.map(({ evidence: _e, ...c }) => ({ ...c, checks: c.checks.map(({ systemId: _s, ...x }) => x) })) };
    await db.update(scans).set({ summary: legacy }).where(eq(scans.id, id));
    const m = await buildReport(ctx, id);
    expect(m.scan.frozen).toBe(true);
    expect(m.summary.score).toBe(s.score);
    expect(m.summary.notCovered).toEqual(s.notCovered);
    expect(m.summary.controls.every((c) => c.evidence)).toBe(true);
    expect(m.summary.controls.flatMap((c) => c.checks).every((x) => x.systemId === m.systems[0].id)).toBe(true);
  });

  it('still lists checks excluded by the former criteria step in old reports', async () => {
    const id = await makeScan([{ ...prodAws, results: [['aws.root-mfa', 'pass']] }]);
    await db.insert(scanCriteria).values([
      { scanId: id, checkId: 'aws.kms-rotation', included: false, reason: 'Only AWS managed keys' },
      { scanId: id, checkId: 'aws.root-mfa', included: true, reason: '' },
    ]);
    await storeScanScore(ctx, id);
    const m = await buildReport(ctx, id);
    expect(m.excluded).toEqual([{ checkId: 'aws.kms-rotation', title: CHECKS_BY_ID['aws.kms-rotation'].title, provider: 'aws', reason: 'Only AWS managed keys' }]);
    expect((await renderPdf(m, null)).length).toBeGreaterThan(1000);
  });

  it('lists providers per scan and pages the audit log with a limit', async () => {
    const id = await makeScan([
      { ...prodAws, results: [['aws.root-mfa', 'pass']] },
      { label: 'GitHub', provider: 'github', config: { org: 'acme' }, results: [['gh.org-2fa', 'pass']] },
    ]);
    const [u] = await db.insert(users).values({ email: `lister-${randomToken(4)}@test.local`, name: 'Admin', role: 'admin' }).returning();
    const token = randomToken();
    await db.insert(sessions).values({ idHash: sha256(token), userId: u.id, csrfToken: randomToken(), authMethod: 'test', expiresAt: new Date(Date.now() + 3600_000) });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: `qs_session=${token}` } });
    const list = (await get('/api/scans')).json() as { id: string; providers: string[] }[];
    expect(list.find((s) => s.id === id)?.providers).toEqual(['aws', 'github']);
    for (let i = 0; i < 3; i++) await get(`/api/scans/${id}/report.csv`);
    const page = (await get('/api/audit?limit=2')).json();
    expect(page).toHaveLength(2);
    const next = (await get(`/api/audit?limit=2&before=${page[1].id}`)).json();
    expect(next[0].id).toBeLessThan(page[1].id);
    expect((await get('/api/audit?limit=0')).statusCode).toBe(400);
    expect((await get('/api/audit?limit=101')).statusCode).toBe(400);
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
