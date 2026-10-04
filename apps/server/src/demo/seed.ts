import { demoOutcomeSync, DEMO_COMPANY, IMPLEMENTED_CHECKS } from '@qs/checks';
import { CHECKS, type Provider } from '@qs/shared';
import { and, eq, sql } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { AppCtx } from '../context.js';
import { randomToken } from '../crypto/envelope.js';
import { DEMO_EMAIL } from './login.js';
import { checkResults, customerAssignments, customers, findingTriage, scans, scanSystems, users } from '../db/schema.js';
import { storeScanScore } from '../scoring.js';

const DAY = 86_400_000;

const TRIAGE = [
  {
    checkId: 'm365.weak-auth-methods',
    status: 'accepted' as const,
    note: 'SMS stays enabled for warehouse staff without company smartphones until Q2 2027. Compensating control: sign-in restricted to the warehouse network via Conditional Access.',
  },
  {
    checkId: 'm365.device-compliance',
    status: 'false_positive' as const,
    note: 'Not applicable for this assessment: the Intune roll-out is planned for Q1 2027.',
  },
  {
    checkId: 'azure.sql-public',
    status: 'false_positive' as const,
    note: 'The "Allow Azure services" rule is required for the Azure Data Factory managed runtime; the server only accepts Entra ID authentication.',
  },
];

/** Second AWS environment of the demo company (a documentation account ID, like the production one). */
export const DEMO_AWS_ACCEPTANCE = '444455556666';

/** Demo systems: production everywhere, plus an AWS acceptance account that is somewhat behind production. */
function systemsFor(maturity: number) {
  const base = { authMode: 'demo', demoMaturity: maturity };
  const sys: { provider: Provider; label: string; environment: string; config: Record<string, unknown>; details: Record<string, unknown> }[] = [
    {
      provider: 'm365',
      label: 'Noordkust Microsoft 365',
      environment: 'production',
      config: { ...base, tenantId: DEMO_COMPANY.tenantId, subscriptionIds: [] },
      details: { tenantId: DEMO_COMPANY.tenantId, displayName: DEMO_COMPANY.name },
    },
    {
      provider: 'azure',
      label: 'Noordkust Azure',
      environment: 'production',
      config: { ...base, tenantId: DEMO_COMPANY.tenantId, subscriptionIds: [] },
      details: { subscriptions: [{ id: 'noordkust-prod', name: 'noordkust-prod' }, { id: 'noordkust-dev', name: 'noordkust-dev' }] },
    },
    {
      provider: 'aws',
      label: 'AWS production',
      environment: 'production',
      config: { ...base, accountId: DEMO_COMPANY.awsAccount, regions: [], externalId: `qs-${randomToken(18)}` },
      details: { accountId: DEMO_COMPANY.awsAccount, arn: `arn:aws:sts::${DEMO_COMPANY.awsAccount}:assumed-role/SecurityQuickScanReadOnly/demo` },
    },
    {
      provider: 'aws',
      label: 'AWS acceptance',
      environment: 'acceptance',
      config: { ...base, demoMaturity: Math.max(0.1, maturity - 0.15), accountId: DEMO_AWS_ACCEPTANCE, regions: [], externalId: `qs-${randomToken(18)}` },
      details: { accountId: DEMO_AWS_ACCEPTANCE, arn: `arn:aws:sts::${DEMO_AWS_ACCEPTANCE}:assumed-role/SecurityQuickScanReadOnly/demo` },
    },
    {
      provider: 'github',
      label: 'GitHub organisation',
      environment: 'production',
      config: { ...base, org: DEMO_COMPANY.githubOrg },
      details: { org: DEMO_COMPANY.githubOrg, ownerView: true },
    },
  ];
  return sys;
}

/** Every implemented check for the providers in scope runs; there is no selection of criteria. */
const checksFor = (provider: Provider) => CHECKS.filter((c) => c.provider === provider && IMPLEMENTED_CHECKS.has(c.id));

type Tx = Parameters<Parameters<AppCtx['db']['transaction']>[0]>[0];

async function createScan(
  tx: Tx,
  customerId: string,
  opts: { name: string; maturity: number; finishedAt?: Date; draft?: boolean },
) {
  const startedAt = opts.finishedAt ? new Date(opts.finishedAt.getTime() - 6 * 60_000) : null;
  const [scan] = await tx
    .insert(scans)
    .values({
      customerId,
      name: opts.name,
      status: opts.draft ? 'draft' : 'completed',
      // Stored steps count the former context step as 0: 3 is Review (Scope 1, Access 2, Review 3).
      wizardStep: 3,
      context: {},
      riskProfile: {},
      createdAt: startedAt ? new Date(startedAt.getTime() - 3 * DAY) : new Date(),
      queuedAt: startedAt,
      startedAt,
      finishedAt: opts.finishedAt ?? null,
    })
    .returning();

  const systems = systemsFor(opts.maturity);

  for (const [n, s] of systems.entries()) {
    // One millisecond apart, so the systems keep this order wherever they are listed by creation.
    const created = new Date((startedAt ?? new Date()).getTime() + n);
    const [row] = await tx
      .insert(scanSystems)
      .values({
        scanId: scan.id,
        provider: s.provider,
        label: s.label,
        environment: s.environment,
        config: s.config,
        connectionOk: true,
        connectionMessage: 'Demo system: no real connection is made.',
        connectionDetails: s.details,
        connectionCheckedAt: startedAt ?? new Date(),
        createdAt: created,
      })
      .returning();
    if (opts.draft || !startedAt) continue;
    await tx.insert(checkResults).values(
      checksFor(s.provider).map((c, i) => {
        const cfg = s.config as { demoMaturity: number; accountId?: string };
        const o = demoOutcomeSync(c.id, cfg.demoMaturity, { awsAccount: cfg.accountId });
        const t = new Date(startedAt.getTime() + (i + 1) * 4000);
        return {
          scanId: scan.id,
          systemId: row.id,
          checkId: c.id,
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

/** Creates the fictional demo organisation with history. Returns false when demo data already exists. */
export async function seedDemo(ctx: AppCtx): Promise<boolean> {
  const now = Date.now();
  const firstScan = new Date(now - 124 * DAY);

  const completed = await ctx.db.transaction(async (tx) => {
    // Serialise concurrent seeders (several replicas starting at once).
    await tx.execute(sql`select pg_advisory_xact_lock(727274)`);
    const existing = await tx.select({ id: customers.id }).from(customers).where(eq(customers.isDemo, true)).limit(1);
    if (existing.length) return null;

    const [c] = await tx
      .insert(customers)
      .values({
        name: DEMO_COMPANY.name,
        context: {},
        isDemo: true,
        createdAt: new Date(firstScan.getTime() - 10 * DAY),
        updatedAt: new Date(now - 14 * DAY),
      })
      .returning();

    const first = await createScan(tx, c.id, { name: 'Baseline quick scan', maturity: 0.25, finishedAt: firstScan });
    const second = await createScan(tx, c.id, { name: 'Follow-up quick scan', maturity: 0.55, finishedAt: new Date(now - 14 * DAY) });
    await createScan(tx, c.id, { name: 'Quarterly quick scan (ready to run)', maturity: 0.75, draft: true });
    await tx.insert(findingTriage).values(TRIAGE.map((t) => ({ customerId: c.id, ...t, updatedAt: new Date(now - 13 * DAY) })));
    return { customerId: c.id, scanIds: [first, second] };
  });

  if (!completed) return false;
  // Give an existing demo visitor account access to the new demo customer.
  const visitor = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.isDemo, true), eq(users.email, DEMO_EMAIL))).limit(1);
  if (visitor.length) await ctx.db.insert(customerAssignments).values({ userId: visitor[0].id, customerId: completed.customerId, permission: 'edit' }).onConflictDoNothing();
  for (const id of completed.scanIds) await storeScanScore(ctx, id);
  await audit(ctx, null, 'demo.seed', { type: 'customer', id: completed.customerId }, { name: DEMO_COMPANY.name }, { id: '', email: 'system' });
  ctx.log.info({ customerId: completed.customerId }, 'demo data seeded');
  return true;
}

/** Deletes all demo organisations (cascade) and seeds them again. */
export async function resetDemo(ctx: AppCtx) {
  await ctx.db.delete(customers).where(eq(customers.isDemo, true));
  await seedDemo(ctx);
}
