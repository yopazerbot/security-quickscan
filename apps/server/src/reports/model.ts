import {
  CHECKS_BY_ID,
  computeScore,
  PROVIDER_LABELS,
  SEVERITIES,
  type Branding,
  type CustomerContext,
  type Provider,
  type ResourceRef,
  type ResultStatus,
  type RiskProfile,
  type ScoreInput,
  type ScoreSummary,
  type Severity,
} from '@qs/shared';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { checkResults, credentials, customers, findingTriage, scanCriteria, scans, scanSystems } from '../db/schema.js';
import { getBranding } from '../routes/admin.js';
import { frozenSummary, scanSystemKey, scoreScan, triageKey, type TriageDecision } from '../scoring.js';
import { triageLookup } from '../triage.js';


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
  /** Scan system row id; matches systems[].id and summary.controls[].checks[].systemId. */
  systemId: string;
  systemLabel: string;
  providerLabel: string;
  /** Human readable account, tenant or organisation of the system, e.g. 'AWS account 111122223333'. */
  systemIdentity: string | null;
  /** Stable identity of the system (provider plus account, tenant or org); triage is stored per (checkId, systemKey). */
  systemKey: string;
  /** Triage in effect for this report (frozen with the score once the scan finished). */
  triage: TriageDecision | null;
  /** Current triage decision for this check on this system; applies to scans that finish from now on. */
  currentTriage: TriageDecision | null;
  isNew: boolean;
}

export interface ReportComparison {
  previousScanId: string;
  previousDate: Date | null;
  previousScore: number | null;
  previousGrade: string | null;
  /** True when the previous scan covered other systems too or missed some of this scan's systems. Only checks on shared systems are compared; hide the score delta. */
  differentScope: boolean;
  /** Number of this scan's systems that were also in the previous scan. */
  sharedSystems: number;
  /** Item ids as `${systemKey}|${checkId}`, only for systems present in both scans. */
  newFindings: string[];
  resolved: string[];
  persisting: string[];
}

export interface ReportModel {
  generatedAt: string;
  scan: {
    id: string;
    name: string;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    retentionMode: string;
    /** Set when retentionMode is 'days'. */
    retentionDays: number | null;
    /** True when the score was stored when the scan finished and later triage does not change it. */
    frozen: boolean;
  };
  /** context is the organisation context at scan time. */
  customer: { id: string; name: string; country: string; context: CustomerContext };
  riskProfile: RiskProfile;
  branding: Branding;
  systems: {
    id: string;
    provider: Provider;
    providerLabel: string;
    label: string;
    systemKey: string;
    identity: string | null;
    credentialsStored: boolean;
    /** When the stored secret is deleted automatically; null when not stored or kept until deleted manually. */
    credentialsExpireAt: Date | null;
    authMode: string;
    /** Score, grade, coverage and counts over this system's results only (same domain weights as the scan). */
    summary: ScoreSummary;
  }[];
  summary: ScoreSummary;
  findings: ReportItem[];
  passed: ReportItem[];
  notAssessed: ReportItem[];
  excluded: { checkId: string; title: string; provider: Provider; reason: string }[];
  topRisks: ReportItem[];
  quickWins: ReportItem[];
  comparison: ReportComparison | null;
}

const sevRank = (s: Severity) => SEVERITIES.indexOf(s);

const listNames = (xs: string[], max = 4) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));

/**
 * Human readable identity of a scanned system from its connection details (what the provider reported) with the
 * configuration as fallback: 'AWS account 111122223333', 'Tenant Contoso (GUID)', 'github.com/acme',
 * 'Tenant GUID; subscriptions: prod, dev'.
 */
export function systemIdentity(provider: Provider, config: unknown, details: unknown): string | null {
  const c = (config ?? {}) as Record<string, any>;
  const d = (details ?? {}) as Record<string, any>;
  if (provider === 'aws') {
    const fromArn = typeof c.roleArn === 'string' ? c.roleArn.split(':')[4] : '';
    const id = d.accountId || c.accountId || fromArn;
    return id ? `AWS account ${id}` : null;
  }
  if (provider === 'github') {
    const org = d.org || c.org;
    return org ? `github.com/${org}` : null;
  }
  const tenantId = d.tenantId || c.tenantId;
  const tenant = d.displayName ? `Tenant ${d.displayName}${tenantId ? ` (${tenantId})` : ''}` : tenantId ? `Tenant ${tenantId}` : null;
  if (provider === 'm365') return tenant;
  const subs: string[] = Array.isArray(d.subscriptions)
    ? d.subscriptions.map((x: any) => (x?.name && x?.id && x.name !== x.id ? `${x.name} (${x.id})` : String(x?.name || x?.id || ''))).filter(Boolean)
    : Array.isArray(c.subscriptionIds)
      ? c.subscriptionIds.map(String)
      : [];
  const subText = subs.length ? `${subs.length === 1 ? 'subscription' : 'subscriptions'} ${listNames(subs)}` : null;
  return [tenant, subText].filter(Boolean).join('; ') || null;
}

const failing = (status: string) => status === 'fail' || status === 'warn';

export async function buildReport(ctx: AppCtx, scanId: string): Promise<ReportModel> {
  const { db } = ctx;
  const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  const customer = (await db.select().from(customers).where(eq(customers.id, scan.customerId)).limit(1))[0];
  const systems = await db.select().from(scanSystems).where(eq(scanSystems.scanId, scanId));
  const creds = systems.length
    ? await db.select({ id: credentials.systemId, expiresAt: credentials.expiresAt }).from(credentials).where(inArray(credentials.systemId, systems.map((s) => s.id)))
    : [];
  const results = await db.select().from(checkResults).where(eq(checkResults.scanId, scanId));
  const triage = await db.select().from(findingTriage).where(eq(findingTriage.customerId, scan.customerId));
  const criteria = await db.select().from(scanCriteria).where(eq(scanCriteria.scanId, scanId));
  const lookup = triageLookup(triage);
  const sysLabel = new Map(systems.map((s) => [s.id, s.label]));
  const sysIdentity = new Map(systems.map((s) => [s.id, systemIdentity(s.provider, s.startedConfig ?? s.config, s.connectionDetails)]));
  const sysKey = new Map(systems.map((s) => [s.id, scanSystemKey(s)]));
  const myKeys = new Set(sysKey.values());

  const frozen = frozenSummary(scan);
  const summary: ScoreSummary = frozen ? (({ triage: _t, ...rest }) => rest)(frozen) : await scoreScan(ctx, scanId);

  // Previous completed scan of the same organisation that shares at least one system, for trend comparison.
  let prev: (typeof scans.$inferSelect & { keys: Map<string, string> }) | undefined;
  if (scan.finishedAt && myKeys.size) {
    const earlier = await db
      .select()
      .from(scans)
      .where(and(eq(scans.customerId, scan.customerId), eq(scans.status, 'completed'), lt(scans.finishedAt, scan.finishedAt)))
      .orderBy(desc(scans.finishedAt))
      .limit(25);
    const earlierSystems = earlier.length ? await db.select().from(scanSystems).where(inArray(scanSystems.scanId, earlier.map((p) => p.id))) : [];
    for (const p of earlier) {
      const keys = new Map(earlierSystems.filter((s) => s.scanId === p.id).map((s) => [s.id, scanSystemKey(s)]));
      if ([...keys.values()].some((k) => myKeys.has(k))) {
        prev = { ...p, keys };
        break;
      }
    }
  }
  const prevKeys = new Set(prev ? prev.keys.values() : []);
  const shared = new Set([...myKeys].filter((k) => prevKeys.has(k)));
  const prevFailing = new Set<string>();
  if (prev) {
    const pr = await db
      .select({ systemId: checkResults.systemId, checkId: checkResults.checkId, status: checkResults.status })
      .from(checkResults)
      .where(eq(checkResults.scanId, prev.id));
    for (const r of pr) {
      const k = prev.keys.get(r.systemId);
      if (k && shared.has(k) && failing(r.status)) prevFailing.add(triageKey(k, r.checkId));
    }
  }

  const items: ReportItem[] = results
    .filter((r) => CHECKS_BY_ID[r.checkId])
    .map((r) => {
      const m = CHECKS_BY_ID[r.checkId];
      const key = sysKey.get(r.systemId) ?? '';
      const t = lookup(r.checkId, key);
      const current = t ? { status: t.status, note: t.note } : null;
      // In a frozen report the triage is what the score was computed with; otherwise it is the current decision.
      const effective = frozen?.triage ? (frozen.triage[triageKey(key, r.checkId)] ?? null) : current;
      // A finished scan has no running checks: anything left pending or running was not assessed.
      const unfinished = r.status === 'pending' || r.status === 'running';
      return {
        key: `${r.systemId}:${r.checkId}`,
        checkId: r.checkId,
        title: m.title,
        description: m.description,
        provider: m.provider,
        domain: m.domain,
        severity: m.severity,
        status: (unfinished ? 'error' : r.status) as ResultStatus,
        summary: unfinished ? r.summary || 'Not run: the scan ended before this check ran.' : r.summary,
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
        providerLabel: PROVIDER_LABELS[m.provider],
        systemIdentity: sysIdentity.get(r.systemId) ?? null,
        systemKey: key,
        triage: effective,
        currentTriage: current,
        isNew: shared.has(key) && failing(r.status) && !prevFailing.has(triageKey(key, r.checkId)),
      };
    });

  // Scores per system and for legacy frozen summaries use the triage this report shows (frozen or current).
  const weights = (scan.riskProfile as RiskProfile).domainWeights;
  const toInput = (i: ReportItem): ScoreInput => ({
    checkId: i.checkId,
    status: i.status,
    severity: i.severity,
    triage: i.triage?.status ?? null,
    systemId: i.systemId,
  });
  // Summaries frozen before evidence strength and per-system attribution existed keep their score, grade and counts;
  // the control assessments and the not-covered list are derived again so every report has the same shape.
  if (frozen && (!Array.isArray(summary.notCovered) || summary.controls.some((c) => !c.evidence))) {
    const again = computeScore(items.map(toInput), CHECKS_BY_ID, weights);
    summary.controls = again.controls;
    summary.notCovered = again.notCovered;
  }

  const isFinding = (i: ReportItem) => failing(i.status);
  const bySeverity = (a: ReportItem, b: ReportItem) =>
    sevRank(a.severity) - sevRank(b.severity) || (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1) || a.title.localeCompare(b.title);
  const findings = items.filter(isFinding).sort(bySeverity);
  const open = findings.filter((f) => f.triage?.status !== 'accepted' && f.triage?.status !== 'false_positive');

  const currentFailing = new Set(findings.filter((f) => shared.has(f.systemKey)).map((f) => triageKey(f.systemKey, f.checkId)));
  const currentPassing = new Set(items.filter((i) => i.status === 'pass').map((i) => triageKey(i.systemKey, i.checkId)));
  const differentScope = Boolean(prev) && (shared.size !== myKeys.size || shared.size !== prevKeys.size);
  const scanContext = (scan.context as CustomerContext | null) ?? (customer.context as CustomerContext);

  return {
    generatedAt: new Date().toISOString(),
    scan: {
      id: scan.id,
      name: scan.name,
      status: scan.status,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      retentionMode: scan.retentionMode,
      retentionDays: scan.retentionMode === 'days' ? scan.retentionDays : null,
      frozen: Boolean(frozen),
    },
    customer: { id: customer.id, name: customer.name, country: customer.country, context: scanContext },
    riskProfile: scan.riskProfile as RiskProfile,
    branding: await getBranding(ctx),
    systems: systems.map((s) => {
      const identity = sysIdentity.get(s.id) ?? null;
      const cred = creds.find((c) => c.id === s.id);
      return {
        id: s.id,
        provider: s.provider,
        providerLabel: PROVIDER_LABELS[s.provider],
        label: s.label,
        systemKey: sysKey.get(s.id) ?? '',
        identity,
        credentialsStored: Boolean(cred),
        credentialsExpireAt: cred?.expiresAt ?? null,
        authMode: (s.config as any).authMode,
        summary: computeScore(items.filter((i) => i.systemId === s.id).map(toInput), CHECKS_BY_ID, weights),
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
          differentScope,
          sharedSystems: shared.size,
          newFindings: [...currentFailing].filter((c) => !prevFailing.has(c)),
          resolved: [...prevFailing].filter((c) => !currentFailing.has(c) && currentPassing.has(c)),
          persisting: [...currentFailing].filter((c) => prevFailing.has(c)),
        }
      : null,
  };
}
