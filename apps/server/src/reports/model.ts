import {
  CHECKS_BY_ID,
  PROVIDER_LABELS,
  SEVERITIES,
  type Authorization,
  type Branding,
  type CustomerContext,
  type Provider,
  type ResourceRef,
  type ResultStatus,
  type RiskProfile,
  type ScoreSummary,
  type Severity,
} from '@qs/shared';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { checkResults, credentials, customers, findingTriage, scanCriteria, scans, scanSystems } from '../db/schema.js';
import { getBranding } from '../routes/admin.js';
import { scoreScan } from '../scoring.js';

export interface ReportItem {
  key: string;
  checkId: string;
  title: string;
  description: string;
  provider: Provider;
  domain: string;
  severity: Severity;
  status: ResultStatus;
  summary: string;
  resources: ResourceRef[];
  evidence: Record<string, unknown> | null;
  remediation: string;
  references: string[];
  iso: string[];
  cis?: string;
  nis2?: string;
  effort: string;
  systemId: string;
  systemLabel: string;
  triage: { status: 'open' | 'accepted' | 'false_positive'; note: string } | null;
  isNew: boolean;
}

export interface ReportModel {
  generatedAt: string;
  scan: { id: string; name: string; status: string; startedAt: Date | null; finishedAt: Date | null; retentionMode: string; authorization: Authorization | null };
  customer: { id: string; name: string; country: string; context: CustomerContext };
  riskProfile: RiskProfile;
  branding: Branding;
  systems: { id: string; provider: Provider; providerLabel: string; label: string; identity: string | null; credentialsStored: boolean; authMode: string }[];
  summary: ScoreSummary;
  findings: ReportItem[];
  passed: ReportItem[];
  notAssessed: ReportItem[];
  excluded: { checkId: string; title: string; provider: Provider; reason: string }[];
  topRisks: ReportItem[];
  quickWins: ReportItem[];
  comparison: { previousScanId: string; previousDate: Date | null; previousScore: number | null; previousGrade: string | null; newFindings: string[]; resolved: string[]; persisting: string[] } | null;
}

const sevRank = (s: Severity) => SEVERITIES.indexOf(s);

export async function buildReport(ctx: AppCtx, scanId: string): Promise<ReportModel> {
  const { db } = ctx;
  const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  const customer = (await db.select().from(customers).where(eq(customers.id, scan.customerId)).limit(1))[0];
  const systems = await db.select().from(scanSystems).where(eq(scanSystems.scanId, scanId));
  const creds = systems.length ? await db.select({ id: credentials.systemId }).from(credentials).where(inArray(credentials.systemId, systems.map((s) => s.id))) : [];
  const results = await db.select().from(checkResults).where(eq(checkResults.scanId, scanId));
  const triage = await db.select().from(findingTriage).where(eq(findingTriage.customerId, scan.customerId));
  const criteria = await db.select().from(scanCriteria).where(eq(scanCriteria.scanId, scanId));
  const tmap = new Map(triage.map((t) => [t.checkId, t]));
  const sysLabel = new Map(systems.map((s) => [s.id, s.label]));

  // Previous completed scan of the same customer, for trend comparison.
  const prev = scan.finishedAt
    ? (
        await db
          .select()
          .from(scans)
          .where(and(eq(scans.customerId, scan.customerId), eq(scans.status, 'completed'), lt(scans.finishedAt, scan.finishedAt)))
          .orderBy(desc(scans.finishedAt))
          .limit(1)
      )[0]
    : undefined;
  const prevFailing = new Set<string>();
  if (prev) {
    const pr = await db.select({ checkId: checkResults.checkId, status: checkResults.status }).from(checkResults).where(eq(checkResults.scanId, prev.id));
    for (const r of pr) if (r.status === 'fail' || r.status === 'warn') prevFailing.add(r.checkId);
  }

  const items: ReportItem[] = results
    .filter((r) => CHECKS_BY_ID[r.checkId])
    .map((r) => {
      const m = CHECKS_BY_ID[r.checkId];
      const t = tmap.get(r.checkId);
      return {
        key: `${r.systemId}:${r.checkId}`,
        checkId: r.checkId,
        title: m.title,
        description: m.description,
        provider: m.provider,
        domain: m.domain,
        severity: m.severity,
        status: r.status as ResultStatus,
        summary: r.summary,
        resources: (r.resources as ResourceRef[]) ?? [],
        evidence: (r.evidence as Record<string, unknown>) ?? null,
        remediation: m.remediation,
        references: m.references,
        iso: m.frameworks.iso27001,
        cis: m.frameworks.cis,
        nis2: m.frameworks.nis2,
        effort: m.effort,
        systemId: r.systemId,
        systemLabel: sysLabel.get(r.systemId) ?? '',
        triage: t ? { status: t.status, note: t.note } : null,
        isNew: Boolean(prev) && !prevFailing.has(r.checkId),
      };
    });

  const isFinding = (i: ReportItem) => i.status === 'fail' || i.status === 'warn';
  const bySeverity = (a: ReportItem, b: ReportItem) =>
    sevRank(a.severity) - sevRank(b.severity) || (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1) || a.title.localeCompare(b.title);
  const findings = items.filter(isFinding).sort(bySeverity);
  const open = findings.filter((f) => f.triage?.status !== 'accepted' && f.triage?.status !== 'false_positive');

  const currentFailing = new Set(findings.map((f) => f.checkId));
  const summary = await scoreScan(ctx, scanId);

  return {
    generatedAt: new Date().toISOString(),
    scan: {
      id: scan.id,
      name: scan.name,
      status: scan.status,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      retentionMode: scan.retentionMode,
      authorization: (scan.authorization as Authorization) ?? null,
    },
    customer: { id: customer.id, name: customer.name, country: customer.country, context: customer.context as CustomerContext },
    riskProfile: scan.riskProfile as RiskProfile,
    branding: await getBranding(ctx),
    systems: systems.map((s) => {
      const d = (s.connectionDetails ?? {}) as Record<string, any>;
      const identity = d.accountId ? `AWS account ${d.accountId}` : d.displayName ? `${d.displayName} (${d.tenantId})` : d.org ? `github.com/${d.org}` : d.subscriptions ? `${d.subscriptions.length} subscription(s)` : null;
      return {
        id: s.id,
        provider: s.provider,
        providerLabel: PROVIDER_LABELS[s.provider],
        label: s.label,
        identity,
        credentialsStored: creds.some((c) => c.id === s.id),
        authMode: (s.config as any).authMode,
      };
    }),
    summary,
    findings,
    passed: items.filter((i) => i.status === 'pass').sort(bySeverity),
    notAssessed: items.filter((i) => i.status === 'na' || i.status === 'error').sort(bySeverity),
    excluded: criteria
      .filter((c) => !c.included && CHECKS_BY_ID[c.checkId])
      .map((c) => ({ checkId: c.checkId, title: CHECKS_BY_ID[c.checkId].title, provider: CHECKS_BY_ID[c.checkId].provider, reason: c.reason })),
    topRisks: open.filter((f) => f.severity !== 'info').slice(0, 10),
    quickWins: open.filter((f) => f.effort === 'low' && ['critical', 'high', 'medium'].includes(f.severity)).slice(0, 6),
    comparison: prev
      ? {
          previousScanId: prev.id,
          previousDate: prev.finishedAt,
          previousScore: prev.score,
          previousGrade: prev.grade,
          newFindings: [...currentFailing].filter((c) => !prevFailing.has(c)),
          resolved: [...prevFailing].filter((c) => !currentFailing.has(c) && items.some((i) => i.checkId === c && i.status === 'pass')),
          persisting: [...currentFailing].filter((c) => prevFailing.has(c)),
        }
      : null,
  };
}
