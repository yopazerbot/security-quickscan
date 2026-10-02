import { IMPLEMENTED_CHECKS, testConnection, verifyMsConsent } from '@qs/checks';
import {
  authorizationSchema,
  awsSecretSchema,
  CHECKS,
  CHECKS_BY_ID,
  computeRiskProfile,
  computeScore,
  customerContextSchema,
  githubSecretSchema,
  msSecretSchema,
  retentionSchema,
  riskRank,
  systemInputSchema,
  type CustomerContext,
  type Provider,
  type RiskProfile,
} from '@qs/shared';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { assertCustomerAccess, sessionStillValid } from '../auth/session.js';
import { scannerEnv } from '../config.js';
import { badRequest, HttpError, notFound, type AppCtx } from '../context.js';
import { randomToken, sha256 } from '../crypto/envelope.js';
import { authStates, checkResults, credentials, customerAssignments, customers, msTenantBindings, findingTriage, scanCriteria, scans, scanSystems } from '../db/schema.js';
import { applyRetention } from '../retention.js';
import { loadScan, parse, uuidParam } from './helpers.js';

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
const docAad = (scanId: string) => `doc:${scanId}`;

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

function defaultIncluded(checkId: string, profile: RiskProfile) {
  const m = CHECKS_BY_ID[checkId];
  return Boolean(m) && riskRank(m.minRisk) <= riskRank(profile.level);
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

  async function loadSystem(scanId: string, req: any) {
    const sid = uuidParam(req, 'systemId');
    const s = (await db.select().from(scanSystems).where(and(eq(scanSystems.id, sid), eq(scanSystems.scanId, scanId))).limit(1))[0];
    if (!s) throw notFound();
    return s;
  }

  async function criteriaFor(scan: ScanRow) {
    const providers = new Set((await db.select({ p: scanSystems.provider }).from(scanSystems).where(eq(scanSystems.scanId, scan.id))).map((r) => r.p));
    const overrides = await db.select().from(scanCriteria).where(eq(scanCriteria.scanId, scan.id));
    const omap = new Map(overrides.map((o) => [o.checkId, o]));
    const profile = scan.riskProfile as RiskProfile;
    return CHECKS.filter((c) => providers.has(c.provider) && IMPLEMENTED_CHECKS.has(c.id)).map((c) => {
      const o = omap.get(c.id);
      const def = defaultIncluded(c.id, profile);
      return { checkId: c.id, included: o ? o.included : def, reason: o?.reason ?? '', defaultIncluded: def };
    });
  }

  /** Limits for the shared demo visitor account (anonymous PIN holders). */
  async function demoQuota(kind: 'scans' | 'running', customerId?: string) {
    if (kind === 'scans') {
      const n = (await db.select({ id: scans.id }).from(scans).where(eq(scans.customerId, customerId!))).length;
      if (n >= 25) throw new HttpError(429, 'Demo limit reached for this customer. An administrator can reset the demo data.');
    } else {
      const active = await db
        .select({ id: scans.id })
        .from(scans)
        .innerJoin(customers, eq(customers.id, scans.customerId))
        .where(and(eq(customers.isDemo, true), inArray(scans.status, ['queued', 'running'])));
      if (active.length >= 2) throw new HttpError(429, 'Two demo scans are already running. Please wait until one finishes.');
    }
  }

  /** A tenant that consented to the platform app belongs to one customer only. */
  async function bindTenant(tenantId: string, customerId: string, req: any) {
    const existing = (await db.select().from(msTenantBindings).where(eq(msTenantBindings.tenantId, tenantId)).limit(1))[0];
    if (existing && existing.customerId !== customerId) {
      await audit(ctx, req, 'consent.tenant_conflict', { type: 'customer', id: customerId }, { tenantId, boundTo: existing.customerId });
      throw new HttpError(409, 'This Microsoft tenant is already linked to another customer. Ask an administrator.');
    }
    if (!existing) await db.insert(msTenantBindings).values({ tenantId, customerId, createdBy: req.user?.id ?? null }).onConflictDoNothing();
  }

  /** Admin-consent systems may only use the platform app for a tenant bound to this scan's customer. */
  async function assertTenantBound(scan: ScanRow, s: SystemRow) {
    const cfg = s.config as any;
    if (cfg.authMode !== 'admin_consent') return;
    const tenant = String(cfg.tenantId ?? '').toLowerCase();
    const b = GUID_RE.test(tenant) ? (await db.select().from(msTenantBindings).where(eq(msTenantBindings.tenantId, tenant)).limit(1))[0] : undefined;
    if (!b || b.customerId !== scan.customerId) throw new HttpError(403, `Admin consent for ${s.label} has not been completed for this customer`);
  }

  // ---------- scan lifecycle ----------

  app.post('/api/customers/:customerId/scans', async (req) => {
    const customerId = uuidParam(req, 'customerId');
    const u = await assertCustomerAccess(ctx, req, customerId, true);
    if (u.isDemo) await demoQuota('scans', customerId);
    const c = (await db.select().from(customers).where(eq(customers.id, customerId)).limit(1))[0];
    if (!c) throw notFound();
    const { name } = parse(z.object({ name: z.string().trim().max(200).optional() }), req.body ?? {});
    const context = customerContextSchema.parse(c.context);
    const [s] = await db
      .insert(scans)
      .values({
        customerId,
        name: name || `Quick scan ${today()}`,
        context,
        riskProfile: computeRiskProfile(context),
        createdBy: u.id,
      })
      .returning();
    await audit(ctx, req, 'scan.create', { type: 'scan', id: s.id }, { customerId });
    return { id: s.id };
  });

  app.get('/api/scans/:scanId', async (req) => {
    const scan = await loadScan(ctx, req);
    const c = (await db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, scan.customerId)))[0];
    const { authorizationDoc, ...rest } = scan;
    return { ...rest, hasAuthorizationDoc: Boolean(authorizationDoc), customer: c, systems: await systemsOf(scan.id) };
  });

  const patchSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    context: customerContextSchema.optional(),
    retention: retentionSchema.optional(),
    authorization: authorizationSchema.optional(),
    wizardStep: z.number().int().min(0).max(10).optional(),
  });

  app.patch('/api/scans/:scanId', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const body = parse(patchSchema, req.body);
    const set: Partial<ScanRow> = {};
    if (body.name) set.name = body.name;
    if (body.wizardStep !== undefined) set.wizardStep = Math.max(scan.wizardStep, body.wizardStep);
    if (body.context) {
      set.context = body.context;
      set.riskProfile = computeRiskProfile(body.context as CustomerContext);
      // The customer record always reflects the latest known context.
      await db.update(customers).set({ context: body.context, updatedAt: new Date() }).where(eq(customers.id, scan.customerId));
    }
    if (body.retention) {
      set.retentionMode = body.retention.mode;
      set.retentionDays = body.retention.mode === 'days' ? (body.retention.days ?? 30) : null;
    }
    if (body.authorization) {
      if (body.authorization.validUntil < body.authorization.authorizedOn) throw badRequest('"Valid until" must be after the authorisation date');
      set.authorization = body.authorization;
    }
    const [updated] = await db.update(scans).set(set).where(eq(scans.id, scan.id)).returning();
    if (body.retention) {
      const ids = (await db.select({ id: scanSystems.id }).from(scanSystems).where(eq(scanSystems.scanId, scan.id))).map((r) => r.id);
      if (ids.length) await db.update(credentials).set({ expiresAt: credentialExpiry(updated) }).where(inArray(credentials.systemId, ids));
      await audit(ctx, req, 'scan.retention', { type: 'scan', id: scan.id }, body.retention);
    }
    if (body.context || body.name) await audit(ctx, req, 'scan.update', { type: 'scan', id: scan.id }, { name: body.name, contextChanged: Boolean(body.context) });
    if (body.authorization) await audit(ctx, req, 'scan.authorization', { type: 'scan', id: scan.id }, { authorizer: body.authorization.authorizerEmail, validUntil: body.authorization.validUntil });
    return { ok: true };
  });

  app.delete('/api/scans/:scanId', async (req) => {
    const scan = await loadScan(ctx, req, { write: true });
    if (scan.status === 'running' || scan.status === 'queued') throw new HttpError(409, 'Cancel the scan first');
    await db.delete(scans).where(eq(scans.id, scan.id));
    await audit(ctx, req, 'scan.delete', { type: 'scan', id: scan.id }, { customerId: scan.customerId });
    return { ok: true };
  });

  // ---------- systems & credentials ----------

  app.post('/api/scans/:scanId/systems', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const body = parse(systemInputSchema, req.body);
    if (body.config.authMode === 'demo' && !config.DEMO_MODE) throw badRequest('Demo systems are disabled');
    if (req.user!.isDemo && body.config.authMode !== 'demo') throw new HttpError(403, 'Demo visitors can only add simulated systems');
    const count = (await db.select({ id: scanSystems.id }).from(scanSystems).where(eq(scanSystems.scanId, scan.id))).length;
    if (count >= 20) throw badRequest('Too many systems in one scan');
    const cfg: Record<string, unknown> = { ...body.config };
    if (body.provider === 'aws') cfg.externalId = `qs-${randomToken(18)}`;
    const [s] = await db.insert(scanSystems).values({ scanId: scan.id, provider: body.provider, label: body.label, config: cfg }).returning();
    await audit(ctx, req, 'system.create', { type: 'system', id: s.id }, { scanId: scan.id, provider: body.provider });
    return systemView(s);
  });

  app.patch('/api/scans/:scanId/systems/:systemId', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s = await loadSystem(scan.id, req);
    const body = parse(systemInputSchema, { ...(req.body as object), provider: s.provider });
    if (body.config.authMode === 'demo' && !config.DEMO_MODE) throw badRequest('Demo systems are disabled');
    if (req.user!.isDemo && body.config.authMode !== 'demo') throw new HttpError(403, 'Demo visitors can only add simulated systems');
    const prev = s.config as any;
    const cfg: Record<string, unknown> = { ...body.config };
    if (s.provider === 'aws') cfg.externalId = prev.externalId;
    if (prev.consentGrantedAt && prev.tenantId === (body.config as any).tenantId) cfg.consentGrantedAt = prev.consentGrantedAt;
    const modeChanged = prev.authMode !== body.config.authMode;
    await db.update(scanSystems).set({ label: body.label, config: cfg, connectionOk: null, connectionMessage: null, connectionCheckedAt: null }).where(eq(scanSystems.id, s.id));
    if (modeChanged) await db.delete(credentials).where(eq(credentials.systemId, s.id));
    await audit(ctx, req, 'system.update', { type: 'system', id: s.id }, { scanId: scan.id, authMode: body.config.authMode, credentialsPurged: modeChanged });
    return { ok: true };
  });

  app.delete('/api/scans/:scanId/systems/:systemId', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s = await loadSystem(scan.id, req);
    await db.delete(scanSystems).where(eq(scanSystems.id, s.id));
    await audit(ctx, req, 'system.delete', { type: 'system', id: s.id }, { scanId: scan.id });
    return { ok: true };
  });

  app.put('/api/scans/:scanId/systems/:systemId/credentials', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s = await loadSystem(scan.id, req);
    if (req.user!.isDemo) throw new HttpError(403, 'Demo visitors cannot store credentials');
    const schema = secretSchemaFor(s.provider, (s.config as any).authMode);
    if (!schema) throw badRequest('This authentication mode does not take a secret');
    const secret = parse(schema, (req.body as any)?.secret);
    const blob = envelope.encryptJson(secret, credAad(scan.id, s.id));
    const values = { blob, hint: secretHint(s.provider, secret), createdBy: req.user!.id, createdAt: new Date(), expiresAt: credentialExpiry(scan), lastUsedAt: null };
    await db.insert(credentials).values({ systemId: s.id, ...values }).onConflictDoUpdate({ target: credentials.systemId, set: values });
    await db.update(scanSystems).set({ connectionOk: null, connectionMessage: null, connectionCheckedAt: null }).where(eq(scanSystems.id, s.id));
    await audit(ctx, req, 'credential.store', { type: 'system', id: s.id }, { scanId: scan.id, provider: s.provider, expiresAt: values.expiresAt });
    return { ok: true, hint: values.hint, expiresAt: values.expiresAt };
  });

  app.delete('/api/scans/:scanId/systems/:systemId/credentials', async (req) => {
    const scan = await loadScan(ctx, req, { write: true });
    const s = await loadSystem(scan.id, req);
    await db.delete(credentials).where(eq(credentials.systemId, s.id));
    await db.update(scanSystems).set({ connectionOk: null, connectionMessage: null, connectionCheckedAt: null }).where(eq(scanSystems.id, s.id));
    await audit(ctx, req, 'credential.purge', { type: 'system', id: s.id }, { scanId: scan.id, reason: 'manual' });
    return { ok: true };
  });

  app.post('/api/scans/:scanId/systems/:systemId/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s = await loadSystem(scan.id, req);
    const cfg = s.config as any;
    let secret: unknown = null;
    if (needsSecret(s.provider, cfg.authMode)) {
      const c = (await db.select().from(credentials).where(eq(credentials.systemId, s.id)).limit(1))[0];
      if (!c) throw badRequest('Store credentials first');
      secret = envelope.decryptJson(c.blob, credAad(scan.id, s.id));
      await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.systemId, s.id));
    }
    if (cfg.authMode === 'admin_consent' && !cfg.consentGrantedAt) throw badRequest('Admin consent has not been granted yet');
    await assertTenantBound(scan, s);
    const r = await testConnection(s.provider, cfg, secret, scannerEnv(config), s.id);
    secret = null;
    await db
      .update(scanSystems)
      .set({ connectionOk: r.ok, connectionMessage: r.message, connectionDetails: r.details ?? null, connectionCheckedAt: new Date() })
      .where(eq(scanSystems.id, s.id));
    await audit(ctx, req, 'system.test', { type: 'system', id: s.id }, { ok: r.ok });
    return r;
  });

  // ---------- Microsoft admin consent ----------

  app.post('/api/scans/:scanId/systems/:systemId/consent-url', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const s = await loadSystem(scan.id, req);
    const cfg = s.config as any;
    if (req.user!.isDemo) throw new HttpError(403, 'Not available for demo visitors');
    if (cfg.authMode !== 'admin_consent' || !config.SCANNER_MS_CLIENT_ID) throw badRequest('Admin consent is not available for this system');
    if (!cfg.tenantId) throw badRequest('Enter the customer tenant ID or domain first');
    const guid = await resolveTenantGuid(String(cfg.tenantId));
    if (!guid) throw badRequest('Microsoft tenant not found. Check the tenant ID or domain.');
    const bound = (await db.select().from(msTenantBindings).where(eq(msTenantBindings.tenantId, guid)).limit(1))[0];
    if (bound && bound.customerId !== scan.customerId) throw new HttpError(409, 'This Microsoft tenant is already linked to another customer. Ask an administrator.');
    await audit(ctx, req, 'consent.link_created', { type: 'system', id: s.id }, { tenant: guid });
    const state = randomToken(24);
    await db.insert(authStates).values({
      stateHash: sha256(state),
      kind: 'consent',
      data: { scanId: scan.id, systemId: s.id, userId: req.user!.id },
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/adminconsent`);
    url.searchParams.set('client_id', config.SCANNER_MS_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${config.APP_URL}/consent/callback`);
    url.searchParams.set('state', state);
    return { url: url.href, expiresInMinutes: 60 };
  });

  app.post('/api/consent/complete', async (req) => {
    const body = parse(
      z.object({ state: z.string().max(200), tenant: z.string().max(100).optional(), admin_consent: z.string().max(10).optional(), error: z.string().max(200).optional(), error_description: z.string().max(2000).optional() }),
      req.body,
    );
    const st = (
      await db
        .delete(authStates)
        .where(and(eq(authStates.stateHash, sha256(body.state)), eq(authStates.kind, 'consent'), gt(authStates.expiresAt, new Date())))
        .returning()
    )[0];
    if (!st) throw badRequest('This consent link has expired or was already used. Generate a new one.');
    const data = st.data as { scanId: string; systemId: string; userId: string };
    if (data.userId !== req.user?.id) throw badRequest('Consent was started by another user');
    // Re-check access: the user must still be allowed to edit this (draft) scan.
    const scan = (await db.select().from(scans).where(eq(scans.id, data.scanId)).limit(1))[0];
    if (!scan) throw notFound();
    await assertCustomerAccess(ctx, req, scan.customerId, true);
    if (scan.status !== 'draft') throw new HttpError(409, 'Scan is no longer a draft');
    const s = (await db.select().from(scanSystems).where(and(eq(scanSystems.id, data.systemId), eq(scanSystems.scanId, scan.id))).limit(1))[0];
    if (!s) throw notFound();
    if (body.error || body.admin_consent?.toLowerCase() !== 'true') {
      await audit(ctx, req, 'consent.denied', { type: 'system', id: s.id }, { error: body.error });
      return { ok: false, scanId: data.scanId, message: body.error_description?.split('\r\n')[0] ?? body.error ?? 'Consent was not granted' };
    }
    // The browser-supplied result is not trusted: resolve the tenant and verify the consent with Microsoft.
    const tenant = body.tenant?.toLowerCase() ?? '';
    if (!GUID_RE.test(tenant)) throw badRequest('Microsoft did not return a tenant ID');
    const cfg = { ...(s.config as any) };
    const configured = await resolveTenantGuid(String(cfg.tenantId ?? ''));
    if (!configured || configured !== tenant) {
      await audit(ctx, req, 'consent.tenant_mismatch', { type: 'system', id: s.id }, { configured: cfg.tenantId, returned: tenant });
      throw badRequest('Consent was granted in a different tenant than configured for this system');
    }
    if (!(await verifyMsConsent(scannerEnv(config), tenant))) throw badRequest('Microsoft does not confirm the consent for this tenant yet. Wait a minute and try again.');
    await bindTenant(tenant, scan.customerId, req);
    cfg.tenantId = tenant;
    cfg.consentGrantedAt = new Date().toISOString();
    await db.update(scanSystems).set({ config: cfg, connectionOk: null, connectionCheckedAt: null }).where(eq(scanSystems.id, s.id));
    await audit(ctx, req, 'consent.granted', { type: 'system', id: s.id }, { tenant });
    return { ok: true, scanId: data.scanId, systemId: s.id };
  });

  // ---------- authorisation document ----------

  app.put('/api/scans/:scanId/authorization-doc', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    if (req.user?.isDemo) throw new HttpError(403, 'Uploads are not available in a demo session');
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const { filename, contentBase64 } = parse(z.object({ filename: z.string().max(200), contentBase64: z.string().max(7_500_000) }), req.body);
    const buf = Buffer.from(contentBase64, 'base64');
    if (buf.length > 5 * 1024 * 1024) throw badRequest('File too large (max 5 MB)');
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('Only PDF files are accepted');
    const name = filename.replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'authorisation.pdf';
    await db.update(scans).set({ authorizationDoc: envelope.encrypt(buf, docAad(scan.id)), authorizationDocName: name }).where(eq(scans.id, scan.id));
    await audit(ctx, req, 'scan.authorization_doc', { type: 'scan', id: scan.id }, { filename: name, bytes: buf.length });
    return { ok: true };
  });

  app.get('/api/scans/:scanId/authorization-doc', async (req, reply) => {
    const scan = await loadScan(ctx, req);
    if (!scan.authorizationDoc) throw notFound();
    const pdf = envelope.decrypt(scan.authorizationDoc, docAad(scan.id));
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${scan.authorizationDocName ?? 'authorisation.pdf'}"`);
    return reply.send(pdf);
  });

  // ---------- criteria ----------

  app.get('/api/scans/:scanId/criteria', async (req) => {
    const scan = await loadScan(ctx, req);
    return criteriaFor(scan);
  });

  app.put('/api/scans/:scanId/criteria', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    const { items } = parse(
      z.object({ items: z.array(z.object({ checkId: z.string().max(100), included: z.boolean(), reason: z.string().max(1000).default('') })).max(500) }),
      req.body,
    );
    const valid = items.filter((i) => CHECKS_BY_ID[i.checkId]);
    if (valid.length) {
      await db.transaction(async (tx) => {
        for (const i of valid) {
          await tx
            .insert(scanCriteria)
            .values({ scanId: scan.id, ...i })
            .onConflictDoUpdate({ target: [scanCriteria.scanId, scanCriteria.checkId], set: { included: i.included, reason: i.reason } });
        }
      });
      await audit(ctx, req, 'scan.criteria', { type: 'scan', id: scan.id }, { excluded: valid.filter((i) => !i.included).map((i) => i.checkId) });
    }
    return { ok: true };
  });

  // ---------- run ----------

  app.post('/api/scans/:scanId/start', async (req) => {
    const scan = await loadScan(ctx, req, { write: true, draft: true });
    if (req.user!.isDemo) await demoQuota('running');
    const auth = authorizationSchema.safeParse(scan.authorization);
    if (!auth.success) throw badRequest('Record the customer authorisation before starting the scan');
    const d = today();
    if (d < auth.data.authorizedOn || d > auth.data.validUntil) throw badRequest('Today is outside the authorised testing window');
    const sys = await db.select().from(scanSystems).where(eq(scanSystems.scanId, scan.id));
    if (!sys.length) throw badRequest('Add at least one system to scan');
    const creds = new Set((await db.select({ id: credentials.systemId }).from(credentials).where(inArray(credentials.systemId, sys.map((s) => s.id)))).map((r) => r.id));
    for (const s of sys) {
      const mode = (s.config as any).authMode;
      if (mode === 'demo') continue;
      if (needsSecret(s.provider, mode) && !creds.has(s.id)) throw badRequest(`Credentials missing for ${s.label}`);
      await assertTenantBound(scan, s);
      if (!s.connectionOk) throw badRequest(`Run a successful connection test for ${s.label} first`);
    }
    const crit = await criteriaFor(scan);
    const included = crit.filter((c) => c.included);
    if (!included.length) throw badRequest('Select at least one evaluation criterion');

    await db.transaction(async (tx) => {
      const upd = await tx
        .update(scans)
        .set({ status: 'queued', queuedAt: new Date(), cancelRequested: false })
        .where(and(eq(scans.id, scan.id), eq(scans.status, 'draft')))
        .returning({ id: scans.id });
      if (!upd.length) throw new HttpError(409, 'Scan already started');
      for (const c of crit) {
        await tx
          .insert(scanCriteria)
          .values({ scanId: scan.id, checkId: c.checkId, included: c.included, reason: c.reason })
          .onConflictDoNothing();
      }
      const rows = sys.flatMap((s) => included.filter((c) => CHECKS_BY_ID[c.checkId].provider === s.provider).map((c) => ({ scanId: scan.id, systemId: s.id, checkId: c.checkId })));
      if (rows.length) await tx.insert(checkResults).values(rows);
    });
    await audit(ctx, req, 'scan.start', { type: 'scan', id: scan.id }, { systems: sys.length, checks: included.length });
    return { ok: true };
  });

  app.post('/api/scans/:scanId/cancel', async (req) => {
    const scan = await loadScan(ctx, req, { write: true });
    if (scan.status === 'queued') {
      await db.update(scans).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(scans.id, scan.id));
      await applyRetention(ctx, scan.id);
    } else if (scan.status === 'running') {
      await db.update(scans).set({ cancelRequested: true }).where(eq(scans.id, scan.id));
    } else throw new HttpError(409, 'Scan is not running');
    await audit(ctx, req, 'scan.cancel', { type: 'scan', id: scan.id });
    return { ok: true };
  });

  /** New draft with the same scope, criteria and (if still stored) credentials. */
  app.post('/api/scans/:scanId/rescan', async (req) => {
    const scan = await loadScan(ctx, req, { write: true });
    if (req.user!.isDemo) await demoQuota('scans', scan.customerId);
    const c = (await db.select().from(customers).where(eq(customers.id, scan.customerId)).limit(1))[0];
    const context = customerContextSchema.parse(c.context);
    const newId = await db.transaction(async (tx) => {
      const [n] = await tx
        .insert(scans)
        .values({
          customerId: scan.customerId,
          name: `Quick scan ${today()}`,
          context,
          riskProfile: computeRiskProfile(context),
          retentionMode: scan.retentionMode,
          retentionDays: scan.retentionDays,
          authorization: scan.authorization,
          createdBy: req.user!.id,
        })
        .returning();
      const sys = await tx.select().from(scanSystems).where(eq(scanSystems.scanId, scan.id));
      for (const s of sys) {
        const [ns] = await tx.insert(scanSystems).values({ scanId: n.id, provider: s.provider, label: s.label, config: s.config }).returning();
        const cred = (await tx.select().from(credentials).where(eq(credentials.systemId, s.id)).limit(1))[0];
        if (cred) {
          const blob = envelope.encrypt(envelope.decrypt(cred.blob, credAad(scan.id, s.id)), credAad(n.id, ns.id));
          // Keep the original expiry: a rescan must not extend how long a customer secret is stored.
          const fresh = credentialExpiry(n);
          const expiresAt = cred.expiresAt && (!fresh || cred.expiresAt < fresh) ? cred.expiresAt : fresh;
          await tx.insert(credentials).values({ systemId: ns.id, blob, hint: cred.hint, createdBy: req.user!.id, expiresAt });
        }
      }
      const crit = await tx.select().from(scanCriteria).where(eq(scanCriteria.scanId, scan.id));
      if (crit.length) await tx.insert(scanCriteria).values(crit.map((x) => ({ ...x, scanId: n.id })));
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
    const triage = await db.select().from(findingTriage).where(eq(findingTriage.customerId, scan.customerId));
    const tmap = new Map(triage.map((t) => [t.checkId, t.status]));
    const done = results.filter((r) => !['pending', 'running'].includes(r.status));
    const live = computeScore(
      done.map((r) => ({ checkId: r.checkId, status: r.status as any, severity: CHECKS_BY_ID[r.checkId]?.severity ?? 'low', triage: tmap.get(r.checkId) ?? null })),
      CHECKS_BY_ID,
      (scan.riskProfile as RiskProfile).domainWeights,
    );
    return {
      status: scan.status,
      cancelRequested: scan.cancelRequested,
      queuedAt: scan.queuedAt,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      results,
      live: { score: live.score, grade: live.grade, counts: live.counts, severityCounts: live.severityCounts },
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
    req.raw.on('close', () => {
      closed = true;
    });
    const MAX_TICKS = 60 * 60; // one hour, the client reconnects if needed
    while (!closed && ticks++ < MAX_TICKS) {
      try {
        // A revoked session or deactivated user must not keep streaming.
        if (ticks % 15 === 0 && !(await sessionStillValid(ctx, req.session!.idHash))) break;
        const snap = await snapshot(scan.id);
        const json = JSON.stringify(snap);
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
    res.end();
    release();
  });

  app.get('/api/scans', async (req) => {
    // Recent scans across accessible customers (dashboard).
    const u = req.user;
    if (!u) throw new HttpError(401, 'Not signed in');
    const all = u.role === 'admin' || u.allCustomers;
    const allowed = all ? null : (await db.select({ id: customerAssignments.customerId }).from(customerAssignments).where(eq(customerAssignments.userId, u.id))).map((r) => r.id);
    if (allowed && !allowed.length) return [];
    return db
      .select({ id: scans.id, name: scans.name, status: scans.status, score: scans.score, grade: scans.grade, createdAt: scans.createdAt, finishedAt: scans.finishedAt, customerId: scans.customerId, customerName: customers.name, isDemo: customers.isDemo })
      .from(scans)
      .innerJoin(customers, eq(customers.id, scans.customerId))
      .where(allowed ? inArray(scans.customerId, allowed) : undefined)
      .orderBy(desc(scans.createdAt))
      .limit(25);
  });
}
