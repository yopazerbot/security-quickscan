import { CHECKS_BY_ID, normalizeEnvironment } from '@qs/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { AppCtx, SessionUser } from '../context.js';
import { randomToken } from '../crypto/envelope.js';
import { checkResults, customerAssignments, customers, findingTriage, scanCriteria, scans, scanSystems, users } from '../db/schema.js';
import type { Q, Tx } from '../routes/helpers.js';
import { ownerCandidateProblem } from '../routes/customers.js';
import { remapSummarySystems, type ExportOrganisation, type ExportPayload, type ExportScan } from './format.js';

export interface ImportPlanOrganisation {
  exportId: string;
  name: string;
  /** 'merge': into an existing organisation the importer may edit; 'new': a new organisation is created. */
  action: 'merge' | 'new';
  targetId: string | null;
  targetName: string | null;
  scans: number;
  newScans: number;
  existingScans: number;
  /** Earliest and latest scan date in the file (finished, else created). */
  from: string | null;
  to: string | null;
  notes: string[];
}

export interface ImportPlan {
  appVersion: string;
  exportedAt: string;
  exportedBy: { name: string; email: string };
  scope: ExportPayload['scope'];
  organisations: ImportPlanOrganisation[];
  totals: { organisations: number; newOrganisations: number; scans: number; newScans: number; existingScans: number };
}

export interface ImportResult {
  organisations: { id: string; name: string; action: 'merge' | 'new'; added: number; skipped: number }[];
  totals: { organisations: number; newOrganisations: number; added: number; skipped: number };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const scanDate = (s: ExportScan) => s.finishedAt ?? s.createdAt;
const date = (v: string | null) => (v ? new Date(v) : null);

/**
 * Existing organisation an exported one merges into: same original identity (its id, or the id it was imported
 * from), not demo data, and editable by the importer (admins: any). Without edit access there is no match, so the
 * importer cannot learn that the organisation exists; a new one is created instead.
 */
async function matchOrganisation(q: Q, user: SessionUser, exportId: string) {
  const rows = await q
    .select({ id: customers.id, name: customers.name, ownerId: customers.ownerId, createdAt: customers.createdAt })
    .from(customers)
    .where(and(or(eq(customers.id, exportId), eq(customers.originId, exportId)), eq(customers.isDemo, false)))
    .orderBy(customers.createdAt);
  for (const c of rows) {
    if (user.role === 'admin' || c.ownerId === user.id) return c;
    const share = (
      await q
        .select({ permission: customerAssignments.permission })
        .from(customerAssignments)
        .where(and(eq(customerAssignments.customerId, c.id), eq(customerAssignments.userId, user.id)))
        .limit(1)
    )[0];
    if (share?.permission === 'edit' && user.role !== 'viewer') return c;
  }
  return null;
}

/** Original identities of the scans already in an organisation. */
async function existingScanIds(q: Q, customerId: string): Promise<Set<string>> {
  const rows = await q.select({ id: scans.id, originId: scans.originId }).from(scans).where(eq(scans.customerId, customerId));
  return new Set(rows.map((r) => r.originId ?? r.id));
}

function notesFor(o: ExportOrganisation, fresh: ExportScan[], user: SessionUser, action: 'merge' | 'new'): string[] {
  const notes: string[] = [];
  const systems = fresh.flatMap((s) => s.systems);
  const consent = systems.filter((s) => (s.provider === 'm365' || s.provider === 'azure') && s.config.authMode === 'admin_consent').length;
  if (consent) notes.push(`${plural(consent, 'Microsoft system')} used admin consent: grant consent again before scanning them in this installation.`);
  const aws = systems.filter((s) => s.provider === 'aws' && s.config.authMode === 'assume_role').length;
  if (aws) notes.push(`${plural(aws, 'AWS role system')} get a new external ID: update the role trust policy before scanning them again.`);
  const unknown = new Set(fresh.flatMap((s) => s.results.map((r) => r.checkId)).filter((id) => !CHECKS_BY_ID[id]));
  if (unknown.size) notes.push(`${plural(unknown.size, 'check')} unknown to this version: stored, shown once the catalog has them.`);
  if (action === 'new' && user.role !== 'admin' && (o.ownerEmail || o.shares.length)) notes.push('Who has access is not imported: only administrators restore owners and shares.');
  return notes;
}

/** Preview of an import: what merges, what is created, and how many scans are new or already present. */
export async function planImport(q: Q, user: SessionUser, payload: ExportPayload): Promise<ImportPlan> {
  const organisations: ImportPlanOrganisation[] = [];
  for (const o of payload.organisations) {
    const target = await matchOrganisation(q, user, o.exportId);
    const existing = target ? await existingScanIds(q, target.id) : new Set<string>();
    const fresh = o.scans.filter((s) => !existing.has(s.exportId));
    const dates = o.scans.map(scanDate).sort();
    const action = target ? 'merge' : 'new';
    organisations.push({
      exportId: o.exportId,
      name: o.name,
      action,
      targetId: target?.id ?? null,
      targetName: target?.name ?? null,
      scans: o.scans.length,
      newScans: fresh.length,
      existingScans: o.scans.length - fresh.length,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      notes: notesFor(o, fresh, user, action),
    });
  }
  const sum = (f: (o: ImportPlanOrganisation) => number) => organisations.reduce((n, o) => n + f(o), 0);
  return {
    appVersion: payload.appVersion,
    exportedAt: payload.exportedAt,
    exportedBy: payload.exportedBy,
    scope: payload.scope,
    organisations,
    totals: {
      organisations: organisations.length,
      newOrganisations: organisations.filter((o) => o.action === 'new').length,
      scans: sum((o) => o.scans),
      newScans: sum((o) => o.newScans),
      existingScans: sum((o) => o.existingScans),
    },
  };
}

/** Users by lower-case email, for owners, shares and triage authors. */
async function usersByEmail(tx: Tx, emails: string[]) {
  const wanted = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (!wanted.length) return new Map<string, typeof users.$inferSelect>();
  const rows = await tx.select().from(users).where(inArray(sql`lower(${users.email})`, wanted));
  return new Map(rows.map((u) => [u.email.toLowerCase(), u]));
}

/**
 * AWS role systems get a fresh external ID: the ID guards the customer's role against other users of the platform
 * (confused deputy), so a file must not be able to set one.
 */
function importedConfig(provider: string, config: Record<string, unknown>) {
  return provider === 'aws' && 'externalId' in config ? { ...config, externalId: `qs-${randomToken(18)}` } : config;
}

async function insertScan(tx: Tx, user: SessionUser, customerId: string, s: ExportScan, appVersion: string, now: Date) {
  const [row] = await tx
    .insert(scans)
    .values({
      customerId,
      name: s.name,
      status: s.status,
      // The questionnaire columns are kept for scans from before scans became purely best practice.
      context: {},
      riskProfile: {},
      // Imported history stays until it is deleted by hand.
      retentionMode: 'manual',
      retentionDays: null,
      score: s.score,
      grade: s.grade,
      createdBy: null,
      createdAt: new Date(s.createdAt),
      queuedAt: date(s.queuedAt),
      startedAt: date(s.startedAt),
      finishedAt: date(s.finishedAt),
      originId: s.exportId,
      importedAt: now,
      importedBy: user.id,
      importedFromVersion: appVersion,
    })
    .returning({ id: scans.id });
  const ids = new Map<string, string>();
  // One by one, in the exported order: reports list systems by creation time.
  for (const x of s.systems) {
    const [sys] = await tx
      .insert(scanSystems)
      .values({
        scanId: row.id,
        provider: x.provider,
        label: x.label,
        environment: normalizeEnvironment(x.environment),
        config: importedConfig(x.provider, x.config),
        startedConfig: x.startedConfig,
        connectionOk: x.connectionOk,
        connectionMessage: x.connectionMessage,
        connectionDetails: x.connectionDetails,
        connectionCheckedAt: date(x.connectionCheckedAt),
        createdAt: new Date(x.createdAt),
      })
      .returning({ id: scanSystems.id });
    ids.set(x.exportId, sys.id);
  }
  const results = s.results.map((r) => ({
    scanId: row.id,
    systemId: ids.get(r.system)!,
    checkId: r.checkId,
    status: r.status,
    summary: r.summary,
    resources: r.resources,
    evidence: r.evidence,
    startedAt: date(r.startedAt),
    finishedAt: date(r.finishedAt),
    updatedAt: date(r.finishedAt) ?? new Date(scanDate(s)),
  }));
  for (let i = 0; i < results.length; i += 1000) await tx.insert(checkResults).values(results.slice(i, i + 1000));
  if (s.excludedChecks.length) {
    await tx
      .insert(scanCriteria)
      .values(s.excludedChecks.map((c) => ({ scanId: row.id, checkId: c.checkId, included: false, reason: c.reason })))
      .onConflictDoNothing();
  }
  // The frozen score summary points at system rows: rewrite them to the new ones.
  await tx.update(scans).set({ summary: remapSummarySystems(s.summary, ids) }).where(eq(scans.id, row.id));
}

/** Triage merge per (check, system key): the newer decision wins. */
async function mergeTriage(tx: Tx, customerId: string, o: ExportOrganisation, byEmail: Map<string, typeof users.$inferSelect>) {
  const current = new Map(
    (await tx.select().from(findingTriage).where(eq(findingTriage.customerId, customerId))).map((t) => [`${t.checkId}|${t.systemKey}`, t]),
  );
  for (const t of o.triage) {
    const have = current.get(`${t.checkId}|${t.systemKey}`);
    const updatedAt = new Date(t.updatedAt);
    if (have && have.updatedAt >= updatedAt) continue;
    const values = { status: t.status, note: t.note, updatedAt, updatedBy: (t.updatedByEmail && byEmail.get(t.updatedByEmail.toLowerCase())?.id) || null };
    await tx
      .insert(findingTriage)
      .values({ customerId, checkId: t.checkId, systemKey: t.systemKey, ...values })
      .onConflictDoUpdate({ target: [findingTriage.customerId, findingTriage.checkId, findingTriage.systemKey], set: values });
  }
}

/**
 * Applies an import in one transaction: organisations are matched or created, new scans are inserted with fresh ids
 * and their original identity, scans already present are skipped, triage is merged. Importing the same file again
 * changes nothing. Never creates Microsoft tenant bindings: admin consent is given again in this installation.
 */
export async function applyImport(ctx: AppCtx, user: SessionUser, payload: ExportPayload): Promise<ImportResult> {
  return ctx.db.transaction(async (tx) => {
    // One import at a time, so two concurrent imports of the same file cannot both add its scans.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('qs-import'))`);
    const plan = await planImport(tx, user, payload);
    const isAdmin = user.role === 'admin';
    const byEmail = await usersByEmail(
      tx,
      payload.organisations.flatMap((o) => [
        ...(isAdmin ? [o.ownerEmail ?? '', ...o.shares.map((s) => s.email)] : []),
        ...o.triage.map((t) => t.updatedByEmail ?? ''),
      ]).filter(Boolean),
    );
    const now = new Date();
    const out: ImportResult['organisations'] = [];
    for (const [i, o] of payload.organisations.entries()) {
      const p = plan.organisations[i];
      let customerId = p.targetId;
      let ownerId: string | null = null;
      if (!customerId) {
        // New organisations belong to the importer; an administrator restores the original owner when that account exists here.
        const owner = isAdmin && o.ownerEmail ? byEmail.get(o.ownerEmail.toLowerCase()) : undefined;
        ownerId = owner && !ownerCandidateProblem(owner) ? owner.id : user.id;
        const [c] = await tx
          .insert(customers)
          .values({ name: o.name, context: {}, createdBy: user.id, ownerId, originId: o.exportId, createdAt: new Date(o.createdAt) })
          .returning({ id: customers.id });
        customerId = c.id;
      } else {
        ownerId = (await tx.select({ ownerId: customers.ownerId }).from(customers).where(eq(customers.id, customerId)).limit(1))[0]?.ownerId ?? null;
      }
      // Only administrators grant others access by importing; existing shares are never changed.
      if (isAdmin) {
        for (const s of o.shares) {
          const u = byEmail.get(s.email.toLowerCase());
          if (!u || !u.active || u.isDemo || u.isBreakglass || u.id === ownerId) continue;
          await tx
            .insert(customerAssignments)
            .values({ userId: u.id, customerId, permission: u.role === 'viewer' ? 'view' : s.permission, grantedBy: user.id })
            .onConflictDoNothing();
        }
      }
      await mergeTriage(tx, customerId, o, byEmail);
      const existing = await existingScanIds(tx, customerId);
      let added = 0;
      for (const s of o.scans) {
        if (existing.has(s.exportId)) continue;
        await insertScan(tx, user, customerId, s, payload.appVersion, now);
        existing.add(s.exportId);
        added++;
      }
      if (added) await tx.update(customers).set({ updatedAt: now }).where(eq(customers.id, customerId));
      out.push({ id: customerId, name: p.targetName ?? o.name, action: p.action, added, skipped: o.scans.length - added });
    }
    return {
      organisations: out,
      totals: {
        organisations: out.length,
        newOrganisations: out.filter((o) => o.action === 'new').length,
        added: out.reduce((n, o) => n + o.added, 0),
        skipped: out.reduce((n, o) => n + o.skipped, 0),
      },
    };
  });
}
