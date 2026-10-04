import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppCtx, SessionUser } from '../context.js';
import { checkResults, customerAssignments, customers, findingTriage, scanCriteria, scans, scanSystems, users } from '../db/schema.js';
import { FINAL_STATUSES } from '../scoring.js';
import { APP_VERSION } from '../version.js';
import { EXPORT_FORMAT, remapSummarySystems, SCHEMA_VERSION, type ExportOrganisation, type ExportPayload, type ExportScan } from './format.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Builds the export payload for the given organisations (access is checked by the caller). Only finished scans are
 * included. Never included: stored credentials, their hints and expiry, settings, accounts, sessions and the audit log.
 * Who has access (owner, shares) and who made triage decisions is only included for organisations `manage` lists:
 * the same need-to-know rule as the organisation page.
 */
export async function buildExport(ctx: AppCtx, user: SessionUser, organisationIds: string[], scope: ExportPayload['scope'], manage: Set<string>): Promise<ExportPayload> {
  const { db } = ctx;
  const orgs = organisationIds.length ? await db.select().from(customers).where(inArray(customers.id, organisationIds)).orderBy(asc(customers.name)) : [];
  const emailOf = new Map<string, string>();
  const userIds = new Set<string>();
  const out: ExportOrganisation[] = [];

  const triageByOrg = new Map<string, (typeof findingTriage.$inferSelect)[]>();
  const sharesByOrg = new Map<string, { userId: string; permission: 'view' | 'edit' }[]>();
  if (orgs.length) {
    for (const t of await db.select().from(findingTriage).where(inArray(findingTriage.customerId, orgs.map((o) => o.id)))) {
      triageByOrg.set(t.customerId, [...(triageByOrg.get(t.customerId) ?? []), t]);
      if (t.updatedBy) userIds.add(t.updatedBy);
    }
    for (const s of await db.select().from(customerAssignments).where(inArray(customerAssignments.customerId, orgs.map((o) => o.id)))) {
      sharesByOrg.set(s.customerId, [...(sharesByOrg.get(s.customerId) ?? []), { userId: s.userId, permission: s.permission }]);
      userIds.add(s.userId);
    }
    for (const o of orgs) if (o.ownerId) userIds.add(o.ownerId);
    if (userIds.size) {
      for (const u of await db.select({ id: users.id, email: users.email, isDemo: users.isDemo }).from(users).where(inArray(users.id, [...userIds]))) {
        // The shared demo visitor account is not a person: never carried into an export.
        if (!u.isDemo) emailOf.set(u.id, u.email);
      }
    }
  }

  for (const o of orgs) {
    const canManage = manage.has(o.id);
    const scanRows = await db
      .select()
      .from(scans)
      .where(and(eq(scans.customerId, o.id), inArray(scans.status, [...FINAL_STATUSES])))
      .orderBy(asc(scans.createdAt));
    const exported: ExportScan[] = [];
    for (const s of scanRows) {
      const systems = await db.select().from(scanSystems).where(eq(scanSystems.scanId, s.id)).orderBy(asc(scanSystems.createdAt));
      const results = await db.select().from(checkResults).where(eq(checkResults.scanId, s.id)).orderBy(asc(checkResults.id));
      const criteria = await db.select().from(scanCriteria).where(eq(scanCriteria.scanId, s.id));
      // System rows are re-created on import: their own id is the export id inside this scan.
      const ids = new Map(systems.map((x) => [x.id, x.id]));
      exported.push({
        exportId: s.originId ?? s.id,
        name: s.name,
        status: s.status as ExportScan['status'],
        createdAt: s.createdAt.toISOString(),
        queuedAt: iso(s.queuedAt),
        startedAt: iso(s.startedAt),
        finishedAt: iso(s.finishedAt),
        score: s.score,
        grade: s.grade,
        summary: remapSummarySystems(obj(s.summary), ids),
        systems: systems.map((x) => ({
          exportId: x.id,
          provider: x.provider,
          label: x.label,
          environment: x.environment,
          config: obj(x.config) ?? {},
          startedConfig: obj(x.startedConfig),
          connectionOk: x.connectionOk,
          connectionMessage: x.connectionMessage,
          connectionDetails: obj(x.connectionDetails),
          connectionCheckedAt: iso(x.connectionCheckedAt),
          createdAt: x.createdAt.toISOString(),
        })),
        results: results.map((r) => ({
          system: r.systemId,
          checkId: r.checkId,
          status: r.status,
          summary: r.summary,
          resources: Array.isArray(r.resources) ? r.resources : [],
          evidence: obj(r.evidence),
          startedAt: iso(r.startedAt),
          finishedAt: iso(r.finishedAt),
        })),
        excludedChecks: criteria.filter((c) => !c.included).map((c) => ({ checkId: c.checkId, reason: c.reason })),
      });
    }
    out.push({
      exportId: o.originId ?? o.id,
      name: o.name,
      createdAt: o.createdAt.toISOString(),
      ownerEmail: canManage && o.ownerId ? (emailOf.get(o.ownerId) ?? null) : null,
      shares: canManage
        ? (sharesByOrg.get(o.id) ?? []).flatMap((s) => (emailOf.has(s.userId) ? [{ email: emailOf.get(s.userId)!, permission: s.permission }] : []))
        : [],
      triage: (triageByOrg.get(o.id) ?? []).map((t) => ({
        checkId: t.checkId,
        systemKey: t.systemKey,
        status: t.status,
        note: t.note,
        updatedAt: t.updatedAt.toISOString(),
        updatedByEmail: canManage && t.updatedBy ? (emailOf.get(t.updatedBy) ?? null) : null,
      })),
      scans: exported,
    });
  }

  return {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: { name: user.name, email: user.email },
    scope,
    organisations: out,
  };
}
