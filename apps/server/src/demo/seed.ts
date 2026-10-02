import { demoOutcomeSync, DEMO_COMPANY, IMPLEMENTED_CHECKS } from '@qs/checks';
import { CHECKS, CHECKS_BY_ID, computeRiskProfile, riskRank, type CustomerContext, type Provider } from '@qs/shared';
import { eq, sql } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { AppCtx } from '../context.js';
import { randomToken } from '../crypto/envelope.js';
import { checkResults, customerAssignments, customers, findingTriage, scanCriteria, scans, scanSystems, users } from '../db/schema.js';
import { storeScanScore } from '../scoring.js';

const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export const DEMO_CONTEXT: CustomerContext = {
  industry: 'logistics',
  employees: '51-250',
  regulations: ['nis2_important', 'iso27001'],
  dataSensitivity: 'high',
  internetExposure: 'significant',
  remoteWork: 'hybrid',
  itManagement: 'mixed',
  developsSoftware: true,
  previousIncidents: true,
  securityMaturity: 'developing',
  crownJewels: 'Transport management system (TMS), EDI connections with shippers, driver planning data and invoicing. Ransomware on the TMS would stop operations within hours.',
};

/** Criteria excluded in the seeded scans, with the consultant's reason. */
const EXCLUSIONS: Record<string, string> = {
  'm365.device-compliance': 'Intune roll-out is planned for Q1 2027; agreed out of scope for this assessment.',
  'aws.kms-rotation': 'Only AWS managed keys are used for production data according to the customer.',
};

const TRIAGE = [
  {
    checkId: 'm365.weak-auth-methods',
    status: 'accepted' as const,
    note: 'SMS stays enabled for warehouse staff without company smartphones until Q2 2027. Compensating control: sign-in restricted to the warehouse network via Conditional Access.',
  },
  {
    checkId: 'azure.sql-public',
    status: 'false_positive' as const,
    note: 'The "Allow Azure services" rule is required for the Azure Data Factory managed runtime; the server only accepts Entra ID authentication.',
  },
];

function systemsFor(maturity: number) {
  const base = { authMode: 'demo', demoMaturity: maturity };
  const sys: { provider: Provider; label: string; config: Record<string, unknown>; details: Record<string, unknown> }[] = [
    {
      provider: 'm365',
      label: 'Noordkust Microsoft 365',
      config: { ...base, tenantId: DEMO_COMPANY.tenantId, subscriptionIds: [] },
      details: { tenantId: DEMO_COMPANY.tenantId, displayName: DEMO_COMPANY.name },
    },
    {
      provider: 'azure',
      label: 'Noordkust Azure',
      config: { ...base, tenantId: DEMO_COMPANY.tenantId, subscriptionIds: [] },
      details: { subscriptions: [{ id: 'noordkust-prod', name: 'noordkust-prod' }, { id: 'noordkust-dev', name: 'noordkust-dev' }] },
    },
    {
      provider: 'aws',
      label: 'AWS production',
      config: { ...base, accountId: DEMO_COMPANY.awsAccount, regions: [], externalId: `qs-${randomToken(18)}` },
      details: { accountId: DEMO_COMPANY.awsAccount, arn: `arn:aws:sts::${DEMO_COMPANY.awsAccount}:assumed-role/SecurityQuickScanReadOnly/demo` },
    },
    {
      provider: 'github',
      label: 'GitHub organisation',
      config: { ...base, org: DEMO_COMPANY.githubOrg },
      details: { org: DEMO_COMPANY.githubOrg, ownerView: true },
    },
  ];
  return sys;
}

function criteriaIds(level: ReturnType<typeof computeRiskProfile>['level'], providers: Provider[]) {
  return CHECKS.filter((c) => providers.includes(c.provider) && IMPLEMENTED_CHECKS.has(c.id)).map((c) => ({
    checkId: c.id,
    included: riskRank(c.minRisk) <= riskRank(level) && !EXCLUSIONS[c.id],
    reason: EXCLUSIONS[c.id] ?? '',
  }));
}

type Tx = Parameters<Parameters<AppCtx['db']['transaction']>[0]>[0];

async function createScan(
  tx: Tx,
  customerId: string,
  opts: { name: string; maturity: number; finishedAt?: Date; draft?: boolean; authorization: Record<string, unknown> },
) {
  const profile = computeRiskProfile(DEMO_CONTEXT);
  const startedAt = opts.finishedAt ? new Date(opts.finishedAt.getTime() - 6 * 60_000) : null;
  const [scan] = await tx
    .insert(scans)
    .values({
      customerId,
      name: opts.name,
      status: opts.draft ? 'draft' : 'completed',
      wizardStep: opts.draft ? 4 : 4,
      context: DEMO_CONTEXT,
      riskProfile: profile,
      authorization: opts.authorization,
      createdAt: startedAt ? new Date(startedAt.getTime() - 3 * DAY) : new Date(),
      queuedAt: startedAt,
      startedAt,
      finishedAt: opts.finishedAt ?? null,
    })
    .returning();

  const systems = systemsFor(opts.maturity);
  const crit = criteriaIds(profile.level, systems.map((s) => s.provider));
  await tx.insert(scanCriteria).values(crit.map((c) => ({ scanId: scan.id, ...c })));

  for (const s of systems) {
    const [row] = await tx
      .insert(scanSystems)
      .values({
        scanId: scan.id,
        provider: s.provider,
        label: s.label,
        config: s.config,
        connectionOk: true,
        connectionMessage: 'Demo system: no real connection is made.',
        connectionDetails: s.details,
        connectionCheckedAt: startedAt ?? new Date(),
        createdAt: startedAt ?? new Date(),
      })
      .returning();
    if (opts.draft || !startedAt) continue;
    const included = crit.filter((c) => c.included && CHECKS_BY_ID[c.checkId].provider === s.provider);
    await tx.insert(checkResults).values(
      included.map((c, i) => {
        const o = demoOutcomeSync(c.checkId, opts.maturity);
        const t = new Date(startedAt.getTime() + (i + 1) * 4000);
        return {
          scanId: scan.id,
          systemId: row.id,
          checkId: c.checkId,
          status: o.status,
          summary: o.summary,
          resources: o.resources ?? [],
          evidence: o.evidence ?? null,
          startedAt: new Date(t.getTime() - 1500),
          finishedAt: t,
          updatedAt: t,
        };
      }),
    );
  }
  return scan.id;
}

/** Creates the fictional demo customer with history. Returns false when demo data already exists. */
export async function seedDemo(ctx: AppCtx): Promise<boolean> {
  const now = Date.now();
  const firstScan = new Date(now - 124 * DAY);
  const authorization = {
    authorizerName: 'Els Vandenberghe',
    authorizerRole: 'CEO',
    authorizerEmail: `els.vandenberghe@${DEMO_COMPANY.domain}`,
    authorizedOn: isoDate(new Date(firstScan.getTime() - 7 * DAY)),
    validUntil: isoDate(new Date(now + 90 * DAY)),
    confirmed: true,
  };

  const completed = await ctx.db.transaction(async (tx) => {
    // Serialise concurrent seeders (several replicas starting at once).
    await tx.execute(sql`select pg_advisory_xact_lock(727274)`);
    const existing = await tx.select({ id: customers.id }).from(customers).where(eq(customers.isDemo, true)).limit(1);
    if (existing.length) return null;

    const [c] = await tx
      .insert(customers)
      .values({
        name: DEMO_COMPANY.name,
        contactName: 'Els Vandenberghe',
        contactEmail: `els.vandenberghe@${DEMO_COMPANY.domain}`,
        country: 'Belgium',
        notes:
          'Fictional demo customer. Regional logistics company (road transport and warehousing, 140 employees, 3 sites). IT partly outsourced to an MSP; in-house team builds the route planner and driver app. Preparing for NIS2 and ISO 27001 certification in 2027.',
        context: DEMO_CONTEXT,
        isDemo: true,
        createdAt: new Date(firstScan.getTime() - 10 * DAY),
        updatedAt: new Date(now - 14 * DAY),
      })
      .returning();

    const first = await createScan(tx, c.id, { name: 'Baseline quick scan', maturity: 0.25, finishedAt: firstScan, authorization });
    const second = await createScan(tx, c.id, { name: 'Follow-up quick scan', maturity: 0.55, finishedAt: new Date(now - 14 * DAY), authorization });
    await createScan(tx, c.id, { name: 'Quarterly quick scan (ready to run)', maturity: 0.75, draft: true, authorization });
    await tx.insert(findingTriage).values(TRIAGE.map((t) => ({ customerId: c.id, ...t, updatedAt: new Date(now - 13 * DAY) })));
    return { customerId: c.id, scanIds: [first, second] };
  });

  if (!completed) return false;
  // Give an existing demo visitor account access to the new demo customer.
  const visitor = await ctx.db.select({ id: users.id }).from(users).where(eq(users.isDemo, true)).limit(1);
  if (visitor.length) await ctx.db.insert(customerAssignments).values({ userId: visitor[0].id, customerId: completed.customerId }).onConflictDoNothing();
  for (const id of completed.scanIds) await storeScanScore(ctx, id);
  await audit(ctx, null, 'demo.seed', { type: 'customer', id: completed.customerId }, { name: DEMO_COMPANY.name }, { id: '', email: 'system' });
  ctx.log.info({ customerId: completed.customerId }, 'demo data seeded');
  return true;
}

/** Deletes all demo customers (cascade) and seeds them again. */
export async function resetDemo(ctx: AppCtx) {
  await ctx.db.delete(customers).where(eq(customers.isDemo, true));
  await seedDemo(ctx);
}
