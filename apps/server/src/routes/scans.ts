import { IMPLEMENTED_CHECKS, testConnection, verifyMsConsentSince } from '@qs/checks';
import {
  awsSecretSchema,
  CHECKS,
  githubSecretSchema,
  msSecretSchema,
  PROVIDERS,
  retentionSchema,
  systemInputSchema,
  type Provider,
} from '@qs/shared';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { accessibleCustomerIds, assertCustomerAccess, customerAccess, requireUser, sessionStillValid } from '../auth/session.js';
import { getRuntime, scannerEnv } from '../settings/runtime.js';
import { badRequest, HttpError, notFound, type AppCtx } from '../context.js';
import { randomToken, sha256 } from '../crypto/envelope.js';
import { authStates, checkResults, credentials, customers, msTenantBindings, scanCriteria, scans, scanSystems } from '../db/schema.js';
import { applyRetention, settleOpenChecks } from '../retention.js';
import { scoreScan, storeScanScore } from '../scoring.js';
import { loadScan, parse, uuidParam, withDraftLock, type Q } from './helpers.js';

type ScanRow = typeof scans.$inferSelect;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Resolves a tenant GUID or verified domain to the tenant GUID via Microsoft's public OIDC metadata. */
export async function resolveTenantGuid(tenantRef: string): Promise<string | null> {
  const ref = tenantRef.trim().toLowerCase();
  if (GUID_RE.test(ref)) return ref;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ref)) return null;
  try {
    const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(ref)}/v2.0/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!r.ok) return null;
    const issuer = String(((await r.json()) as { issuer?: string }).issuer ?? '');
    const m = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/.exec(issuer);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
type SystemRow = typeof scanSystems.$inferSelect;

export const credAad = (scanId: string, systemId: string) => `cred:${scanId}:${systemId}`;

export const TENANT_CONFLICT = 'This Microsoft tenant is already linked to another organisation in Security QuickScan. An administrator can review tenant links under Settings.';

/**
 * Whether a Microsoft tenant is bound to this organisation. A binding whose organisation was deleted
 * (customer_id null) stays reserved until an admin releases it, so it counts as a conflict.
 */
export async function tenantBindingState(q: Q, tenantRef: unknown, customerId: string): Promise<'bound' | 'unbound' | 'conflict'> {
  const tenant = String(tenantRef ?? '').toLowerCase();
  if (!GUID_RE.test(tenant)) return 'unbound';
  const b = (await q.select().from(msTenantBindings).where(eq(msTenantBindings.tenantId, tenant)).limit(1))[0];
  if (!b) return 'unbound';
  return b.customerId === customerId ? 'bound' : 'conflict';
}

/** Fields that decide which account, tenant or organisation a system points at. */
const TARGET_FIELDS: Record<Provider, string[]> = { aws: ['accountId', 'roleArn'], m365: ['tenantId', 'clientId'], azure: ['tenantId', 'clientId'], github: ['org'] };
const targetOf = (provider: Provider, cfg: Record<string, unknown>) =>
  Object.fromEntries(TARGET_FIELDS[provider].map((k) => [k, typeof cfg[k] === 'string' ? (cfg[k] as string).toLowerCase() : (cfg[k] ?? null)]));
const stableJson = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v as object)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`)
        .join(',')}}`
    : JSON.stringify(v ?? null);

export function needsSecret(provider: Provider, mode: string) {
  return (provider === 'aws' && mode === 'access_keys') || ((provider === 'm365' || provider === 'azure') && mode === 'app_secret') || (provider === 'github' && mode === 'token');
}

function secretSchemaFor(provider: Provider, mode: string) {
  if (provider === 'aws' && mode === 'access_keys') return awsSecretSchema;
  if ((provider === 'm365' || provider === 'azure') && mode === 'app_secret') return msSecretSchema;
  if (provider === 'github' && mode === 'token') return githubSecretSchema;
  return null;
}

function secretHint(provider: Provider, secret: any): string {
  if (provider === 'aws') return `${secret.accessKeyId.slice(0, 4)}...${secret.accessKeyId.slice(-4)}${secret.sessionToken ? ' (temporary)' : ''}`;
  if (provider === 'github') return `${secret.token.startsWith('github_pat_') ? 'fine-grained' : 'classic'} token`;
  return 'client secret';
}

export function credentialExpiry(scan: Pick<ScanRow, 'retentionMode' | 'retentionDays'>): Date | null {
  const days = scan.retentionMode === 'manual' ? null : scan.retentionMode === 'days' ? (scan.retentionDays ?? 30) : 7;
  return days === null ? null : new Date(Date.now() + days * 86_400_000);
}

/** Every implemented check for the given providers: scans are best-practice baselines, not risk based. */
export function checksFor(providers: Iterable<Provider>) {
  const set = new Set(providers);
  return CHECKS.filter((c) => set.has(c.provider) && IMPLEMENTED_CHECKS.has(c.id));
}

const today = () => new Date().toISOString().slice(0, 10);

function systemView(s: SystemRow, cred?: { hint: string; expiresAt: Date | null; createdAt: Date }) {
  const mode = (s.config as any).authMode as string;
  return {
    id: s.id,
    provider: s.provider,
    label: s.label,
    config: s.config,
    needsSecret: needsSecret(s.provider, mode),
    credential: cred ? { hint: cred.hint, expiresAt: cred.expiresAt, createdAt: cred.createdAt } : null,
    connection: s.connectionCheckedAt ? { ok: s.connectionOk, message: s.connectionMessage, details: s.connectionDetails, checkedAt: s.connectionCheckedAt } : null,
  };
}

const MAX_STREAMS_PER_USER = 5;
const MAX_STREAMS_TOTAL = 100;
const streamsPerUser = new Map<string, number>();
let streamsTotal = 0;

export function scanRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db, envelope, config } = ctx;

  // Progress streams are ended when the server closes, so a deploy does not wait for them.
  const openStreams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const stop of openStreams) stop();
    openStreams.clear();
  });

  async function systemsOf(scanId: string) {
    const sys = await db.select().from(scanSystems).where(eq(scanSystems.scanId, scanId)).orderBy(asc(scanSystems.createdAt));
    const creds = sys.length
      ? await db
          .select({ systemId: credentials.systemId, hint: credentials.hint, expiresAt: credentials.expiresAt, createdAt: credentials.createdAt })
          .from(credentials)
          .where(inArray(credentials.systemId, sys.map((s) => s.id)))
      : [];
    return sys.map((s) => systemView(s, creds.find((c) => c.systemId === s.id)));
  }

  async function loadSystem(scanId: string, req: any, q: Q = db) {
    const sid = uuidParam(req, 'systemId');
    const s = (await q.select().from(scanSystems).where(and(eq(scanSystems.id, sid), eq(scanSystems.scanId, scanId))).limit(1))[0];
    if (!s) throw notFound();
    return s;
  }

  /** Limits for the shared demo visitor account (anonymous PIN holders). */
  async function demoQuota(kind: 'scans' | 'running', customerId?: string) {
    if (kind === 'scans') {
      const n = (await db.select({ id: scans.id }).from(scans).where(eq(scans.customerId, customerId!))).length;
      if (n >= 25) throw new HttpError(429, 'Demo limit reached for this organisation. An administrator can reset the demo data.');
    } else {
      const active = await db
        .select({ id: scans.id })
        .from(scans)
        .innerJoin(customers, eq(customers.id, scans.customerId))
        .where(and(eq(customers.isDemo, true), inArray(scans.status, ['queued', 'running'])));
      if (active.length >= 2) throw new HttpError(429, 'Two demo scans are already running. Please wait until one finishes.');
    }
  }

  async function tenantConflict(req: FastifyRequest, tenantId: string, customerId: string, systemId: string, step: string): Promise<never> {
    const b = (await db.select({ c: msTenantBindings.customerId }).from(msTenantBindings).where(eq(msTenantBindings.tenantId, tenantId.toLowerCase())).limit(1))[0];
    await audit(ctx, req, 'consent.tenant_conflict', { type: 'system', id: systemId }, { tenantId: tenantId.toLowerCase(), customerId, boundTo: b?.c ?? null, step });
    throw new HttpError(409, TENANT_CONFLICT);
  }

  /** A tenant that consented to the platform app belongs to one organisation only. */
  async function bindTenant(tx: Q, tenantId: string, customerId: string, req: FastifyRequest, systemId: string) {
    await tx.insert(msTenantBindings).values({ tenantId, customerId, createdBy: req.user?.id ?? null }).onConflictDoNothing();
    if ((await tenantBindingState(tx, tenantId, customerId)) !== 'bound') await tenantConflict(req, tenantId, customerId, systemId, 'complete');
  }

  /** Admin-consent systems may only use the platform app for a tenant bound to this scan's organisation. */
  async function assertTenantBound(scan: ScanRow, s: SystemRow, req: FastifyRequest, step: string) {
    const cfg = s.config as any;
    if (cfg.authMode !== 'admin_consent') return;
    const state = await tenantBindingState(db, cfg.tenantId, scan.customerId);
    if (state === 'conflict') await tenantConflict(req, String(cfg.tenantId), scan.customerId, s.id, step);
    if (state !== 'bound' || !cfg.consentGrantedAt) throw new HttpError(403, `Admin consent for ${s.label} has not been completed for this organisation`);
  }

  async function isDemoOrg(customerId: string) {
    return Boolean((await db.select({ d: customers.isDemo }).from(customers).where(eq(customers.id, customerId)).limit(1))[0]?.d);
  }

  /** Demo organisations hold simulated systems only (for every user); demo visitors only run simulated systems. */
  async function assertDemoRules(req: FastifyRequest, customerId: string, modes: string[], action: 'add' | 'run') {
    if (modes.every((m) => m === 'demo')) return;
    if (await isDemoOrg(customerId)) throw new HttpError(403, 'Demo organisations can only contain simulated systems');
    if (req.user!.isDemo) throw new HttpError(403, action === 'add' ? 'Demo visitors can only add simulated systems' : 'Demo visitors can only scan simulated systems');
  }

  // ---------- scan lifecycle ----------

  app.post('/api/customers/:customerId/scans', async (req) => {
    const customerId = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, customerId, true);
    if (u.isDemo) await demoQuota('scans', customerId);
    const c = (await db.select().from(customers).where(eq(customers.id, customerId)).limit(1))[0];
    if (!c) throw notFound();
    const { name } = parse(z.object({ name: z.string().trim().max(200).optional() }), req.body ?? {});
    // context and risk_profile are kept for scans from before scans became purely best practice; new scans store {}.
    const [s] = await db
      .insert(scans)
      .values({
        customerId,
        name: name || `Quick scan ${today()}`,
        context: {},
        riskProfile: {},
        createdBy: u.id,
      })
      .returning();
    await audit(ctx, req, 'scan.create', { type: 'scan', id: s.id }, { customerId });
    return { id: s.id };
  });

  app.get('/api/scans/:scanId', async (req) => {
    const scan = await loadScan(ctx, req);
    const c = (await db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, scan.customerId)))[0];
    return { ...scan, customer: { ...c, myAccess: await customerAccess(ctx, req.user!, scan.customerId) }, systems: await systemsOf(scan.id) };
  });

  const patchSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    retention: retentionSchema.optional(),
    wizardStep: z.number().int().min(0).max(10).optional(),
  });

  app.patch('/api/scans/:scanId', async (req) => {
    const scan0 = await loadScan(ctx, req, { write: true, draft: true });
    const body = parse(patchSchema, req.body);
    const scan = await withDraftLock(ctx, scan0.id, async (tx, scan) => {
      const set: Partial<ScanRow> = {};
      if (body.name) set.name = body.name;
      if (body.wizardStep !== undefined) set.wizardStep = Math.max(scan.wizardStep, body.wizardStep);
      if (body.retention) {
        set.retentionMode = body.retention.mode;
        set.retentionDays = body.retention.mode === 'days' ? (body.retention.days ?? 30) : null;
      }
      const [updated] = Object.keys(set).length ? await tx.update(scans).set(set).where(eq(scans.id, scan.id)).returning() : [scan];
      if (body.retention) {
        const ids = (await tx.select({ id: scanSystems.id }).from(scanSystems).where(eq(scanSystems.scanId, scan.id))).map((r) => r.id);
        if (ids.length) await tx.update(credentials).set({ expiresAt: credentialExpiry(updated) }).where(inArray(credentials.systemId, ids));
      }
      return updated;
    });
    if (body.retention) {
      await audit(ctx, req, 'scan.retention', { type: 'scan', id: scan.id }, body.retention);
    }
    if (body.name) await audit(ctx, req, 'scan.update', { type: 'scan', id: scan.id }, { name: body.name });
    return { ok: true };
  });

  app.delete('/api/scans/:scanId', async (req) => {
    const scan = await loadScan(ctx, req, { write: true });
    if (scan.status === 'running' || scan.status === 'queued') throw new HttpError(409, 'Cancel the scan first');
    // Discarding a draft needs edit access; deleting scan history needs the owner (or an admin).
    if (scan.status !== 'draft') await assertCustomerAccess(ctx, req, scan.customerId, 'manage');
    const del = await db
      .delete(scans)
      .where(and(eq(scans.id, scan.id), eq(scans.status, scan.status)))
      .returning({ id: scans.id });
    if (!del.length) throw new HttpError(409, 'The scan changed in the meantime. Reload and try again.');
    await audit(ctx, req, 'scan.delete', { type: 'scan', id: scan.id }, { customerId: scan.customerId });
    return { ok: true };
  });

  // ---------- systems & credentials ----------

  app.post('/api/scans/:scanId/systems', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const body = parse(systemInputSchema, req.body);
    if (body.config.authMode === 'demo' && !(await getRuntime(ctx)).general.demoMode) throw badRequest('Demo systems are disabled');
    await assertDemoRules(req, scan.customerId, [body.config.authMode], 'add');
    const cfg: Record<string, unknown> = { ...body.config };
    if (body.provider === 'aws') cfg.externalId = `qs-${randomToken(18)}`;
    const s = await withDraftLock(ctx, scan.id, async (tx) => {
      const count = (await tx.select({ id: scanSystems.id }).from(scanSystems).where(eq(scanSystems.scanId, scan.id))).length;
      if (count >= 20) throw badRequest('Too many systems in one scan');
      return (await tx.insert(scanSystems).values({ scanId: scan.id, provider: body.provider, label: body.label, config: cfg }).returning())[0];
    });
    await audit(ctx, req, 'system.create', { type: 'system', id: s.id }, { scanId: scan.id, provider: body.provider });
    return systemView(s);
  });

  app.patch('/api/scans/:scanId/systems/:systemId', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s0 = await loadSystem(scan.id, req);
    const body = parse(systemInputSchema, { ...(req.body as object), provider: s0.provider });
    if (body.config.authMode === 'demo' && !(await getRuntime(ctx)).general.demoMode) throw badRequest('Demo systems are disabled');
    await assertDemoRules(req, scan.customerId, [body.config.authMode], 'add');
    const r = await withDraftLock(ctx, scan.id, async (tx) => {
      const s = await loadSystem(scan.id, req, tx);
      const prev = s.config as any;
      const cfg: Record<string, unknown> = { ...body.config };
      if (s.provider === 'aws') cfg.externalId = prev.externalId;
      if (prev.consentGrantedAt && prev.tenantId === (body.config as any).tenantId) cfg.consentGrantedAt = prev.consentGrantedAt;
      const before = targetOf(s.provider, prev);
      const after = targetOf(s.provider, cfg);
      const modeChanged = prev.authMode !== body.config.authMode;
      const targetChanged = stableJson(before) !== stableJson(after);
      // A label-only edit keeps the connection test; any other change needs a new test.
      const connectionChanged = stableJson(prev) !== stableJson(cfg);
      await tx
        .update(scanSystems)
        .set({ label: body.label, config: cfg, ...(connectionChanged ? { connectionOk: null, connectionMessage: null, connectionDetails: null, connectionCheckedAt: null } : {}) })
        .where(eq(scanSystems.id, s.id));
      // A stored secret belongs to one access method and one target: never point it at another account.
      const purged = modeChanged || targetChanged ? (await tx.delete(credentials).where(eq(credentials.systemId, s.id)).returning({ id: credentials.systemId })).length > 0 : false;
      return { id: s.id, before, after, targetChanged, connectionChanged, purged };
    });
    await audit(ctx, req, 'system.update', { type: 'system', id: r.id }, {
      scanId: scan.id,
      authMode: body.config.authMode,
      credentialsPurged: r.purged,
      connectionReset: r.connectionChanged,
      ...(r.targetChanged ? { targetBefore: r.before, targetAfter: r.after } : {}),
    });
    return { ok: true, connectionReset: r.connectionChanged, credentialsPurged: r.purged };
  });

  app.delete('/api/scans/:scanId/systems/:systemId', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s = await withDraftLock(ctx, scan.id, async (tx) => {
      const s = await loadSystem(scan.id, req, tx);
      await tx.delete(scanSystems).where(eq(scanSystems.id, s.id));
      return s;
    });
    await audit(ctx, req, 'system.delete', { type: 'system', id: s.id }, { scanId: scan.id });
    return { ok: true };
  });

  app.put('/api/scans/:scanId/systems/:systemId/credentials', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const scan0 = await loadScan(ctx, req, { write: true, draft: true });
    if (req.user!.isDemo) throw new HttpError(403, 'Demo visitors cannot store credentials');
    const { s, scan, values } = await withDraftLock(ctx, scan0.id, async (tx, scan) => {
      const s = await loadSystem(scan.id, req, tx);
      const schema = secretSchemaFor(s.provider, (s.config as any).authMode);
      if (!schema) throw badRequest('This authentication mode does not take a secret');
      const secret = parse(schema, (req.body as any)?.secret);
      const blob = envelope.encryptJson(secret, credAad(scan.id, s.id));
      const values = { blob, hint: secretHint(s.provider, secret), createdBy: req.user!.id, createdAt: new Date(), expiresAt: credentialExpiry(scan), lastUsedAt: null };
      await tx.insert(credentials).values({ systemId: s.id, ...values }).onConflictDoUpdate({ target: credentials.systemId, set: values });
      await tx.update(scanSystems).set({ connectionOk: null, connectionMessage: null, connectionCheckedAt: null }).where(eq(scanSystems.id, s.id));
      return { s, scan, values };
    });
    await audit(ctx, req, 'credential.store', { type: 'system', id: s.id }, { scanId: scan.id, provider: s.provider, expiresAt: values.expiresAt });
    return { ok: true, hint: values.hint, expiresAt: values.expiresAt };
  });

  app.delete('/api/scans/:scanId/systems/:systemId/credentials', async (req) => {
    const scan = await loadScan(ctx, req, { write: true });
    // Allowed after the scan too (honouring a deletion request); in a draft it also invalidates the connection test.
    const purge = async (q: Q, draft: boolean) => {
      const s = await loadSystem(scan.id, req, q);
      await q.delete(credentials).where(eq(credentials.systemId, s.id));
      if (draft) await q.update(scanSystems).set({ connectionOk: null, connectionMessage: null, connectionCheckedAt: null }).where(eq(scanSystems.id, s.id));
      return s;
    };
    const s = scan.status === 'draft' ? await withDraftLock(ctx, scan.id, (tx) => purge(tx, true)) : await purge(db, false);
    await audit(ctx, req, 'credential.purge', { type: 'system', id: s.id }, { scanId: scan.id, reason: 'manual' });
    return { ok: true };
  });

  app.post('/api/scans/:scanId/systems/:systemId/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s = await loadSystem(scan.id, req);
    const cfg = s.config as any;
    await assertDemoRules(req, scan.customerId, [cfg.authMode], 'run');
    let secret: unknown = null;
    let credAt: number | null = null;
    if (needsSecret(s.provider, cfg.authMode)) {
      const c = (await db.select().from(credentials).where(eq(credentials.systemId, s.id)).limit(1))[0];
      if (!c) throw badRequest('Store credentials first');
      credAt = c.createdAt.getTime();
      try {
        secret = envelope.decryptJson(c.blob, credAad(scan.id, s.id));
      } catch {
        throw badRequest('The stored credential could not be decrypted. Store it again.');
      }
      await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.systemId, s.id));
    }
    if (cfg.authMode === 'admin_consent' && !cfg.consentGrantedAt) throw badRequest('Admin consent has not been granted yet');
    await assertTenantBound(scan, s, req, 'test');
    const r = await testConnection(s.provider, cfg, secret, await scannerEnv(ctx), s.id);
    secret = null;
    // Store the result only for the configuration that was actually tested.
    await withDraftLock(ctx, scan.id, async (tx) => {
      const now = await loadSystem(scan.id, req, tx);
      const c = credAt === null ? null : (await tx.select({ at: credentials.createdAt }).from(credentials).where(eq(credentials.systemId, s.id)).limit(1))[0];
      if (stableJson(now.config) !== stableJson(s.config) || (credAt !== null && c?.at.getTime() !== credAt)) {
        throw new HttpError(409, 'The system was changed during the test. Run the test again.');
      }
      await tx
        .update(scanSystems)
        .set({ connectionOk: r.ok, connectionMessage: r.message, connectionDetails: r.details ?? null, connectionCheckedAt: new Date() })
        .where(eq(scanSystems.id, s.id));
    });
    await audit(ctx, req, 'system.test', { type: 'system', id: s.id }, { ok: r.ok });
    return r;
  });

  // ---------- Microsoft admin consent ----------

  app.post('/api/scans/:scanId/systems/:systemId/consent-url', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s = await loadSystem(scan.id, req);
    const cfg = s.config as any;
    if (req.user!.isDemo) throw new HttpError(403, 'Not available for demo visitors');
    const msClientId = (await getRuntime(ctx)).scanner.ms.clientId;
    if (cfg.authMode !== 'admin_consent' || !msClientId) throw badRequest('Admin consent is not available for this system');
    if (!cfg.tenantId) throw badRequest('Enter the tenant ID or domain first');
    const guid = await resolveTenantGuid(String(cfg.tenantId));
    if (!guid) throw badRequest('Microsoft tenant not found. Check the tenant ID or domain.');
    // A binding to another organisation is not revealed here (no probing which tenants are scanned);
    // it is enforced when consent completes, at the connection test and at start.
    if ((await tenantBindingState(db, guid, scan.customerId)) === 'conflict') {
      await audit(ctx, req, 'consent.tenant_conflict', { type: 'system', id: s.id }, { tenantId: guid, customerId: scan.customerId, step: 'link' });
    }
    const state = randomToken(24);
    await withDraftLock(ctx, scan.id, async (tx) => {
      await loadSystem(scan.id, req, tx);
      await tx.insert(authStates).values({
        stateHash: sha256(state),
        kind: 'consent',
        data: { scanId: scan.id, systemId: s.id, userId: req.user!.id, issuedAt: new Date().toISOString() },
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
    });
    await audit(ctx, req, 'consent.link_created', { type: 'system', id: s.id }, { tenant: guid });
    const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/adminconsent`);
    url.searchParams.set('client_id', msClientId);
    url.searchParams.set('redirect_uri', `${config.APP_URL}/consent/callback`);
    url.searchParams.set('state', state);
    return { url: url.href, expiresInMinutes: 60 };
  });

  app.post('/api/consent/complete', async (req) => {
    const body = parse(
      z.object({ state: z.string().max(200), tenant: z.string().max(100).optional(), admin_consent: z.string().max(10).optional(), error: z.string().max(200).optional(), error_description: z.string().max(2000).optional() }),
      req.body,
    );
    const stateWhere = and(eq(authStates.stateHash, sha256(body.state)), eq(authStates.kind, 'consent'), gt(authStates.expiresAt, new Date()));
    const st = (await db.select().from(authStates).where(stateWhere).limit(1))[0];
    if (!st) throw badRequest('This consent link has expired or was already used. Generate a new one.');
    const data = st.data as { scanId: string; systemId: string; userId: string; issuedAt?: string };
    if (data.userId !== req.user?.id) throw badRequest('Consent was started by another user');
    // The state is consumed once the outcome is final; a not-yet-visible consent can be retried with the same link.
    const consume = async () => {
      if (!(await db.delete(authStates).where(stateWhere).returning({ h: authStates.stateHash })).length) {
        throw badRequest('This consent link has expired or was already used. Generate a new one.');
      }
    };
    // Re-check access: the user must still be allowed to edit this (draft) scan.
    const scan = (await db.select().from(scans).where(eq(scans.id, data.scanId)).limit(1))[0];
    if (!scan) throw notFound();
    await assertCustomerAccess(ctx, req, scan.customerId, true);
    if (scan.status !== 'draft') throw new HttpError(409, 'Scan is no longer a draft');
    const s = (await db.select().from(scanSystems).where(and(eq(scanSystems.id, data.systemId), eq(scanSystems.scanId, scan.id))).limit(1))[0];
    if (!s) throw notFound();
    if (body.error || body.admin_consent?.toLowerCase() !== 'true') {
      await consume();
      await audit(ctx, req, 'consent.denied', { type: 'system', id: s.id }, { error: body.error });
      return { ok: false, scanId: data.scanId, message: body.error_description?.split('\r\n')[0] ?? body.error ?? 'Consent was not granted' };
    }
    // The browser-supplied result is not trusted: resolve the tenant and verify the consent with Microsoft.
    const tenant = body.tenant?.toLowerCase() ?? '';
    if (!GUID_RE.test(tenant)) throw badRequest('Microsoft did not return a tenant ID');
    const cfg = { ...(s.config as any) };
    const configured = await resolveTenantGuid(String(cfg.tenantId ?? ''));
    if (!configured || configured !== tenant) {
      await consume();
      await audit(ctx, req, 'consent.tenant_mismatch', { type: 'system', id: s.id }, { configured: cfg.tenantId, returned: tenant });
      throw badRequest('Consent was granted in a different tenant than configured for this system');
    }
    if ((await tenantBindingState(db, tenant, scan.customerId)) === 'conflict') {
      await consume();
      await tenantConflict(req, tenant, scan.customerId, s.id, 'complete');
    }
    // Proof that this flow produced the consent: the platform app's service principal (or its newest app role
    // assignment) in the tenant must be newer than the consent link. The browser-supplied result alone is not trusted.
    const issuedAt = data.issuedAt ? new Date(data.issuedAt) : new Date(st.expiresAt.getTime() - 60 * 60_000);
    const proof = await verifyMsConsentSince(await scannerEnv(ctx), tenant, issuedAt);
    if (!proof.ok) {
      await audit(ctx, req, 'consent.unverified', { type: 'system', id: s.id }, { tenant, reason: proof.reason });
      if (proof.reason === 'stale') {
        await consume();
        throw badRequest(
          'Microsoft shows an earlier consent for this tenant, not one given with this link. Ask a Global Administrator of the tenant to open a new consent link and accept it.',
        );
      }
      throw badRequest('Microsoft does not confirm the consent for this tenant yet. Wait a minute and try again.');
    }
    await consume();
    cfg.tenantId = tenant;
    cfg.consentGrantedAt = new Date().toISOString();
    await withDraftLock(ctx, scan.id, async (tx) => {
      const cur = (await tx.select().from(scanSystems).where(and(eq(scanSystems.id, s.id), eq(scanSystems.scanId, scan.id))).limit(1))[0];
      if (!cur) throw notFound();
      // The system must still point at the tenant that consented.
      if (stableJson(cur.config) !== stableJson(s.config)) throw badRequest('The system was changed while consent was pending. Generate a new consent link.');
      await bindTenant(tx, tenant, scan.customerId, req, s.id);
      await tx.update(scanSystems).set({ config: cfg, connectionOk: null, connectionCheckedAt: null }).where(eq(scanSystems.id, s.id));
    });
    await audit(ctx, req, 'consent.granted', { type: 'system', id: s.id }, { tenant });
    return { ok: true, scanId: data.scanId, systemId: s.id };
  });

  // ---------- run ----------

  app.post('/api/scans/:scanId/start', async (req) => {
    const scan0 = await loadScan(ctx, req, { write: true, draft: true });
    if (req.user!.isDemo) await demoQuota('running');
    // Validation and the status change happen under the scan lock: no system edit can slip in between.
    const { sys, included } = await withDraftLock(ctx, scan0.id, async (tx, scan) => {
      const sys = await tx.select().from(scanSystems).where(eq(scanSystems.scanId, scan.id));
      if (!sys.length) throw badRequest('Add at least one system to scan');
      await assertDemoRules(req, scan.customerId, sys.map((s) => (s.config as any).authMode), 'run');
      const creds = new Set((await tx.select({ id: credentials.systemId }).from(credentials).where(inArray(credentials.systemId, sys.map((s) => s.id)))).map((r) => r.id));
      for (const s of sys) {
        const mode = (s.config as any).authMode;
        if (mode === 'demo') continue;
        if (needsSecret(s.provider, mode) && !creds.has(s.id)) throw badRequest(`Credentials missing for ${s.label}`);
        await assertTenantBound(scan, s, req, 'start');
        if (!s.connectionOk) throw badRequest(`Run a successful connection test for ${s.label} first`);
      }
      const included = checksFor(sys.map((s) => s.provider));
      if (!included.length) throw badRequest('No checks are available for the systems in this scan');

      const upd = await tx
        .update(scans)
        .set({ status: 'queued', queuedAt: new Date(), cancelRequested: false })
        .where(and(eq(scans.id, scan.id), eq(scans.status, 'draft')))
        .returning({ id: scans.id });
      if (!upd.length) throw new HttpError(409, 'Scan already started');
      // Exclusions stored by the former criteria step no longer apply: every check runs. Old scans keep theirs for their reports.
      await tx.delete(scanCriteria).where(eq(scanCriteria.scanId, scan.id));
      // Freeze the validated configuration: the worker scans exactly this.
      for (const s of sys) await tx.update(scanSystems).set({ startedConfig: s.config }).where(eq(scanSystems.id, s.id));
      const rows = sys.flatMap((s) => included.filter((c) => c.provider === s.provider).map((c) => ({ scanId: scan.id, systemId: s.id, checkId: c.id })));
      if (rows.length) await tx.insert(checkResults).values(rows);
      return { sys, included };
    });
    await audit(ctx, req, 'scan.start', { type: 'scan', id: scan0.id }, { systems: sys.length, checks: included.length });
    return { ok: true };
  });

  app.post('/api/scans/:scanId/cancel', async (req) => {
    const scan = await loadScan(ctx, req, { write: true });
    // Conditional transitions: a worker may claim the scan between the read above and this write.
    const dequeued = await db
      .update(scans)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(scans.id, scan.id), eq(scans.status, 'queued')))
      .returning({ id: scans.id });
    if (dequeued.length) {
      await settleOpenChecks(ctx, scan.id, 'na', 'Not run: the scan was cancelled.');
      await storeScanScore(ctx, scan.id);
      await applyRetention(ctx, scan.id);
    } else {
      const flagged = await db
        .update(scans)
        .set({ cancelRequested: true })
        .where(and(eq(scans.id, scan.id), eq(scans.status, 'running')))
        .returning({ id: scans.id });
      if (!flagged.length) throw new HttpError(409, 'Scan is not running');
    }
    await audit(ctx, req, 'scan.cancel', { type: 'scan', id: scan.id });
    return { ok: true };
  });

  /** New draft with the same scope and (if still stored) credentials. */
  app.post('/api/scans/:scanId/rescan', async (req) => {
    const scan = await loadScan(ctx, req, { write: true });
    // Only finished scans: a running purge-on-completion scan must not hand its secret to a new draft.
    if (!['completed', 'failed', 'cancelled'].includes(scan.status)) throw new HttpError(409, 'Only a finished scan can be scanned again');
    const sourceModes = (await db.select({ c: scanSystems.config }).from(scanSystems).where(eq(scanSystems.scanId, scan.id))).map((r) => (r.c as any).authMode);
    await assertDemoRules(req, scan.customerId, sourceModes, 'run');
    if (req.user!.isDemo) await demoQuota('scans', scan.customerId);
    const newId = await db.transaction(async (tx) => {
      const [n] = await tx
        .insert(scans)
        .values({
          customerId: scan.customerId,
          name: `Quick scan ${today()}`,
          context: {},
          riskProfile: {},
          retentionMode: scan.retentionMode,
          retentionDays: scan.retentionDays,
          createdBy: req.user!.id,
        })
        .returning();
      const sys = await tx.select().from(scanSystems).where(eq(scanSystems.scanId, scan.id));
      for (const s of sys) {
        const [ns] = await tx.insert(scanSystems).values({ scanId: n.id, provider: s.provider, label: s.label, config: s.config }).returning();
        const cred = (await tx.select().from(credentials).where(eq(credentials.systemId, s.id)).limit(1))[0];
        let plain: Buffer | null = null;
        try {
          plain = cred ? envelope.decrypt(cred.blob, credAad(scan.id, s.id)) : null;
        } catch {
          plain = null; // unreadable secret: the new draft asks for it again
        }
        if (cred && plain) {
          const blob = envelope.encrypt(plain, credAad(n.id, ns.id));
          plain.fill(0);
          // Keep the original expiry: a rescan must not extend how long a customer secret is stored.
          const fresh = credentialExpiry(n);
          const expiresAt = cred.expiresAt && (!fresh || cred.expiresAt < fresh) ? cred.expiresAt : fresh;
          await tx.insert(credentials).values({ systemId: ns.id, blob, hint: cred.hint, createdBy: req.user!.id, expiresAt });
        }
      }
      return n.id;
    });
    await audit(ctx, req, 'scan.rescan', { type: 'scan', id: newId }, { from: scan.id });
    return { id: newId };
  });

  // ---------- progress ----------

  async function snapshot(scanId: string) {
    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
    const results = await db
      .select({ systemId: checkResults.systemId, checkId: checkResults.checkId, status: checkResults.status, summary: checkResults.summary, finishedAt: checkResults.finishedAt })
      .from(checkResults)
      .where(eq(checkResults.scanId, scanId));
    // Same scoring path as the stored score: triage per (check, system key) with the legacy '*' fallback.
    const live = await scoreScan(ctx, scanId);
    return {
      status: scan.status,
      cancelRequested: scan.cancelRequested,
      queuedAt: scan.queuedAt,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      results,
      live: { score: live.score, grade: live.grade, counts: live.counts, severityCounts: live.severityCounts, coverage: live.coverage, partial: live.partial },
    };
  }

  app.get('/api/scans/:scanId/progress', async (req) => {
    const scan = await loadScan(ctx, req);
    return snapshot(scan.id);
  });

  app.get('/api/scans/:scanId/events', async (req, reply) => {
    const scan = await loadScan(ctx, req);
    const uid = req.user!.id;
    if ((streamsPerUser.get(uid) ?? 0) >= MAX_STREAMS_PER_USER || streamsTotal >= MAX_STREAMS_TOTAL) {
      throw new HttpError(429, 'Too many open progress streams');
    }
    streamsPerUser.set(uid, (streamsPerUser.get(uid) ?? 0) + 1);
    streamsTotal++;
    const release = () => {
      streamsPerUser.set(uid, (streamsPerUser.get(uid) ?? 1) - 1);
      if (!streamsPerUser.get(uid)) streamsPerUser.delete(uid);
      streamsTotal--;
    };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    let last = '';
    let ticks = 0;
    const stop = () => {
      closed = true;
      if (!res.writableEnded) res.end();
    };
    openStreams.add(stop);
    req.raw.on('close', () => {
      closed = true;
    });
    const MAX_TICKS = 60 * 60; // one hour, the client reconnects if needed
    while (!closed && ticks++ < MAX_TICKS) {
      try {
        // Stop streaming once the session ends or access to the organisation is withdrawn, and tell the client why.
        if (ticks % 15 === 0) {
          const reason = !(await sessionStillValid(ctx, req.session!.idHash)) ? 'session' : !(await customerAccess(ctx, req.user!, scan.customerId)) ? 'access' : null;
          if (reason) {
            if (!closed && !res.writableEnded) res.write(`event: access_revoked\ndata: ${JSON.stringify({ reason })}\n\n`);
            break;
          }
        }
        if (closed) break;
        const snap = await snapshot(scan.id);
        const json = JSON.stringify(snap);
        if (closed || res.writableEnded) break;
        if (json !== last) {
          res.write(`event: progress\ndata: ${json}\n\n`);
          last = json;
        } else if (ticks % 15 === 0) res.write(': keep-alive\n\n');
        if (['completed', 'failed', 'cancelled', 'draft'].includes(snap.status)) break;
      } catch (e) {
        req.log.error({ err: e }, 'sse snapshot failed');
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    openStreams.delete(stop);
    if (!res.writableEnded) res.end();
    release();
  });

  app.get('/api/scans', async (req) => {
    // Recent scans across accessible customers (dashboard).
    const u = requireUser(req);
    const allowed = await accessibleCustomerIds(ctx, u);
    if (allowed && !allowed.length) return [];
    const rows = await db
      .select({ id: scans.id, name: scans.name, status: scans.status, score: scans.score, grade: scans.grade, createdAt: scans.createdAt, finishedAt: scans.finishedAt, customerId: scans.customerId, customerName: customers.name, isDemo: customers.isDemo })
      .from(scans)
      .innerJoin(customers, eq(customers.id, scans.customerId))
      .where(allowed ? inArray(scans.customerId, allowed) : undefined)
      .orderBy(desc(scans.createdAt))
      .limit(25);
    // Distinct providers per scan (in PROVIDERS order) for the provider icons on the dashboard.
    const sys = rows.length
      ? await db.select({ scanId: scanSystems.scanId, provider: scanSystems.provider }).from(scanSystems).where(inArray(scanSystems.scanId, rows.map((r) => r.id)))
      : [];
    return rows.map((r) => {
      const mine = new Set(sys.filter((s) => s.scanId === r.id).map((s) => s.provider));
      return { ...r, providers: PROVIDERS.filter((p) => mine.has(p)) };
    });
  });
}
