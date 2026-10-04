import { awsPrincipalArn } from '@qs/checks';
import {
  CONFIRM_REQUIRED,
  entraSettingsInput,
  generalSettingsInput,
  passwordSettingsInput,
  scannerSettingsInput,
  type AuthSettingsView,
  type GeneralSettingsView,
  type ScannerSettingsView,
  type TestResult,
} from '@qs/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { oidcDiscovery, oidcErrorCode } from '../auth/routes.js';
import { requireRecentAuth, requireRole } from '../auth/session.js';
import { adminsByMethod } from '../auth/setup.js';
import { badRequest, forbidden, HttpError, type AppCtx } from '../context.js';
import { sessions, users } from '../db/schema.js';
import { seedDemo } from '../demo/seed.js';
import {
  computeRuntime,
  readStoredSettings,
  sealSecret,
  SETTING_KEYS,
  writeSetting,
  type EntraStored,
  type GeneralStored,
  type PasswordStored,
  type Runtime,
  type ScannerAwsStored,
  type ScannerMsStored,
  type StoredSecret,
} from '../settings/runtime.js';
import { parse } from './helpers.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AWS_KEY_ID = /^[A-Z0-9]{16,128}$/;

/** Admin, but never the shared demo visitor account. */
function requireAdmin(req: FastifyRequest) {
  const me = requireRole(req, 'admin');
  if (me.isDemo) throw forbidden();
  return me;
}

/** Optional ID field: undefined keeps the saved value, empty or null clears it, anything else must match. */
function idField(v: string | null | undefined, re: RegExp, label: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!re.test(v)) throw badRequest(`${label} is not valid`);
  return v;
}

/** New stored secret: undefined keeps it, '' clears it, anything else is encrypted. */
function secretField(ctx: AppCtx, key: string, field: string, v: string | undefined, current: StoredSecret | null | undefined) {
  if (v === undefined) return { value: current, change: 'unchanged' as const };
  if (v === '') return { value: null, change: 'cleared' as const };
  return { value: sealSecret(ctx, key, field, v), change: 'changed' as const };
}

/** Writes only the fields that are defined (undefined = not saved, so the environment keeps applying). */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Short, safe outcome of a client-credentials token request (never contains the secret). */
async function clientCredentialsTest(tenantId: string, clientId: string, secret: string): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'https://graph.microsoft.com/.default' }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (res.ok && data.access_token) return { ok: true };
    return { ok: false, code: oidcErrorCode(data) };
  } catch (e) {
    return { ok: false, code: (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

const AADSTS_HINTS: Record<string, string> = {
  AADSTS7000215: 'The client secret is not valid.',
  AADSTS7000222: 'The client secret has expired.',
  AADSTS700016: 'The application (client ID) was not found in this tenant.',
  AADSTS90002: 'The tenant was not found.',
  AADSTS900023: 'The tenant ID is not valid.',
};
const tokenFailure = (code: string) => `${AADSTS_HINTS[code] ?? 'Microsoft rejected the request.'} (${code})`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);
}

export function settingsRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { config } = ctx;
  const testLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  async function load() {
    const rows = await readStoredSettings(ctx);
    return { rows, rt: computeRuntime(ctx, rows) };
  }

  async function authView(rt?: Runtime): Promise<AuthSettingsView> {
    rt ??= (await load()).rt;
    return {
      entra: {
        enabled: rt.entra.enabled,
        tenantId: rt.entra.tenantId,
        clientId: rt.entra.clientId,
        clientSecret: rt.entra.clientSecret.state,
        requireMfa: rt.entra.requireMfa,
        redirectUri: `${config.APP_URL}/api/auth/callback`,
        source: rt.entra.source,
      },
      password: { enabled: rt.password.enabled, minLength: rt.password.minLength },
      breakglass: { enabled: config.BREAKGLASS_ENABLED },
      adminsByMethod: await adminsByMethod(ctx),
    };
  }

  /**
   * Lockout guards. A change must not leave the instance without a sign-in method that an active administrator
   * can use (break-glass is recovery and does not count). Switching off the method of the current session also
   * needs { confirm: true }. Local mode has no sign-in, so nothing to guard.
   */
  async function guard(req: FastifyRequest, before: Runtime, after: Runtime, confirm?: boolean) {
    if (config.LOCAL_MODE) return;
    const admins = await adminsByMethod(ctx);
    const wayIn = (r: Runtime) => (r.entra.usable && admins.entra > 0) || (r.password.enabled && admins.password > 0);
    if (wayIn(before) && !wayIn(after)) {
      throw badRequest('This change would leave no sign-in method that an active administrator can use. Enable another method for an administrator first.');
    }
    const m = req.session?.authMethod;
    const losesOwn = (m === 'entra' && before.entra.usable && !after.entra.usable) || (m === 'password' && before.password.enabled && !after.password.enabled);
    if (losesOwn && !confirm) throw new HttpError(409, 'This switches off the sign-in method you are using now. Confirm to continue.', CONFIRM_REQUIRED);
  }

  // ---------- sign-in methods ----------

  app.get('/api/admin/settings/auth', async (req) => {
    requireAdmin(req);
    return authView();
  });

  app.put('/api/admin/settings/auth/entra', async (req) => {
    requireAdmin(req);
    requireRecentAuth(ctx, req);
    const body = parse(entraSettingsInput, req.body);
    const { rows, rt: before } = await load();
    const cur: EntraStored = rows[SETTING_KEYS.entra] ?? {};
    const secret = secretField(ctx, SETTING_KEYS.entra, 'clientSecret', body.clientSecret, cur.clientSecret);
    const next: EntraStored = {
      ...cur,
      ...defined({
        enabled: body.enabled,
        requireMfa: body.requireMfa,
        tenantId: idField(body.tenantId, GUID, 'Tenant ID (use the directory ID, a GUID)'),
        clientId: idField(body.clientId, GUID, 'Client ID'),
        clientSecret: secret.value,
      }),
    };
    if (secret.change === 'unchanged' && cur.clientSecret === undefined) delete next.clientSecret;
    const after = computeRuntime(ctx, { ...rows, [SETTING_KEYS.entra]: next });
    if (body.enabled && !after.entra.configured) throw badRequest('Enter the tenant ID, client ID and client secret to enable Microsoft sign-in');
    await guard(req, before, after, body.confirm);
    await writeSetting(ctx, SETTING_KEYS.entra, next);
    // Never the secret itself: only whether it changed.
    await audit(ctx, req, 'settings.auth_entra', undefined, {
      enabled: after.entra.enabled,
      tenantId: after.entra.tenantId,
      clientId: after.entra.clientId,
      requireMfa: after.entra.requireMfa,
      clientSecret: secret.change,
    });
    return authView(after);
  });

  app.put('/api/admin/settings/auth/password', async (req) => {
    requireAdmin(req);
    requireRecentAuth(ctx, req);
    const body = parse(passwordSettingsInput, req.body);
    const { rows, rt: before } = await load();
    const next: PasswordStored = { ...(rows[SETTING_KEYS.password] ?? {}), enabled: body.enabled, minLength: body.minLength };
    const after = computeRuntime(ctx, { ...rows, [SETTING_KEYS.password]: next });
    await guard(req, before, after, body.confirm);
    await writeSetting(ctx, SETTING_KEYS.password, next);
    await audit(ctx, req, 'settings.auth_password', undefined, { enabled: body.enabled, minLength: body.minLength });
    return authView(after);
  });

  /** Checks the tenant (OIDC discovery) and the client secret (client-credentials token) without saving anything. */
  app.post('/api/admin/settings/auth/entra/test', testLimit, async (req): Promise<TestResult> => {
    requireAdmin(req);
    const body = parse(entraSettingsInput.partial(), req.body ?? {});
    const { rt } = await load();
    const tenantId = body.tenantId !== undefined ? body.tenantId || null : rt.entra.tenantId;
    const clientId = body.clientId !== undefined ? body.clientId || null : rt.entra.clientId;
    const secret = body.clientSecret ? body.clientSecret : rt.entra.clientSecret.value;
    let result: TestResult;
    if (!tenantId || !clientId || !secret) result = { ok: false, message: 'Enter the tenant ID, client ID and client secret first.' };
    else if (!GUID.test(tenantId) || !GUID.test(clientId)) result = { ok: false, message: 'Tenant ID and client ID must be GUIDs.' };
    else {
      try {
        await withTimeout(oidcDiscovery.discover(tenantId, clientId, secret), 15_000);
        const t = await clientCredentialsTest(tenantId, clientId, secret);
        result = t.ok ? { ok: true, message: 'The tenant was found and Microsoft accepted the client ID and secret.' } : { ok: false, message: tokenFailure(t.code) };
      } catch (e) {
        result = { ok: false, message: `The tenant could not be found or reached (${oidcErrorCode(e)}).` };
      }
    }
    await audit(ctx, req, 'settings.auth_entra_test', undefined, { ok: result.ok });
    return result;
  });

  // ---------- scanner identities ----------

  async function scannerView(rt?: Runtime): Promise<ScannerSettingsView> {
    rt ??= (await load()).rt;
    let principalArn: string | null = null;
    try {
      principalArn = await withTimeout(awsPrincipalArn(rt.scanner.env), 8000);
    } catch {
      principalArn = null;
    }
    return {
      ms: { clientId: rt.scanner.ms.clientId, clientSecret: rt.scanner.ms.clientSecret.state, source: rt.scanner.ms.source, consentRedirectUri: `${config.APP_URL}/consent/callback` },
      aws: { accessKeyId: rt.scanner.aws.accessKeyId, secretAccessKey: rt.scanner.aws.secretAccessKey.state, source: rt.scanner.aws.source, principalArn },
    };
  }

  app.get('/api/admin/settings/scanner', async (req) => {
    requireAdmin(req);
    return scannerView();
  });

  app.put('/api/admin/settings/scanner', async (req) => {
    requireAdmin(req);
    requireRecentAuth(ctx, req);
    const body = parse(scannerSettingsInput, req.body);
    const { rows } = await load();
    const changes: Record<string, unknown> = {};
    const next = { ...rows };
    if (body.ms) {
      const cur: ScannerMsStored = rows[SETTING_KEYS.scannerMs] ?? {};
      const secret = secretField(ctx, SETTING_KEYS.scannerMs, 'clientSecret', body.ms.clientSecret, cur.clientSecret);
      const v: ScannerMsStored = { ...cur, ...defined({ clientId: idField(body.ms.clientId, GUID, 'Microsoft scanner client ID'), clientSecret: secret.value }) };
      if (secret.change === 'unchanged' && cur.clientSecret === undefined) delete v.clientSecret;
      next[SETTING_KEYS.scannerMs] = v;
      changes.ms = { clientId: v.clientId ?? null, clientSecret: secret.change };
    }
    if (body.aws) {
      const cur: ScannerAwsStored = rows[SETTING_KEYS.scannerAws] ?? {};
      const secret = secretField(ctx, SETTING_KEYS.scannerAws, 'secretAccessKey', body.aws.secretAccessKey, cur.secretAccessKey);
      const v: ScannerAwsStored = { ...cur, ...defined({ accessKeyId: idField(body.aws.accessKeyId, AWS_KEY_ID, 'AWS access key ID'), secretAccessKey: secret.value }) };
      if (secret.change === 'unchanged' && cur.secretAccessKey === undefined) delete v.secretAccessKey;
      next[SETTING_KEYS.scannerAws] = v;
      changes.aws = { accessKeyId: v.accessKeyId ?? null, secretAccessKey: secret.change };
    }
    if (body.ms) await writeSetting(ctx, SETTING_KEYS.scannerMs, next[SETTING_KEYS.scannerMs]!);
    if (body.aws) await writeSetting(ctx, SETTING_KEYS.scannerAws, next[SETTING_KEYS.scannerAws]!);
    await audit(ctx, req, 'settings.scanner', undefined, changes);
    return scannerView(computeRuntime(ctx, next));
  });

  app.post('/api/admin/settings/scanner/test', testLimit, async (req): Promise<TestResult> => {
    requireAdmin(req);
    // tenantId (optional): tenant for the Microsoft token request; defaults to the sign-in tenant.
    const body = parse(z.object({ provider: z.enum(['ms', 'aws']), tenantId: z.string().trim().max(100).optional() }), req.body);
    const { rt } = await load();
    let result: TestResult;
    if (body.provider === 'aws') {
      if (!rt.scanner.env.aws) result = { ok: false, message: 'Enter the AWS access key ID and secret access key first.' };
      else {
        try {
          const arn = await withTimeout(awsPrincipalArn(rt.scanner.env, { fresh: true }), 15_000);
          result = { ok: true, message: `AWS accepted the credentials. Scanner identity: ${arn}` };
        } catch {
          result = { ok: false, message: 'AWS rejected the credentials or could not be reached.' };
        }
      }
    } else {
      const tenant = body.tenantId || rt.entra.tenantId;
      if (!rt.scanner.env.ms) result = { ok: false, message: 'Enter the Microsoft scanner client ID and secret first.' };
      else if (!tenant || !GUID.test(tenant)) result = { ok: false, message: 'Enter the tenant ID where the scanner app is registered to test it.' };
      else {
        const t = await clientCredentialsTest(tenant, rt.scanner.env.ms.clientId, rt.scanner.env.ms.clientSecret);
        result = t.ok ? { ok: true, message: 'Microsoft accepted the scanner client ID and secret.' } : { ok: false, message: tokenFailure(t.code) };
      }
    }
    await audit(ctx, req, 'settings.scanner_test', undefined, { provider: body.provider, ok: result.ok });
    return result;
  });

  // ---------- general ----------

  const generalView = (rt: Runtime): GeneralSettingsView => ({
    sessionIdleMinutes: rt.general.sessionIdleMinutes,
    sessionMaxHours: rt.general.sessionMaxHours,
    auditRetentionMonths: rt.general.auditRetentionMonths,
    demoMode: rt.general.demoMode,
    sources: rt.general.sources,
  });

  app.get('/api/admin/settings/general', async (req) => {
    requireAdmin(req);
    return generalView((await load()).rt);
  });

  app.put('/api/admin/settings/general', async (req) => {
    requireAdmin(req);
    const body = parse(generalSettingsInput, req.body);
    const { rows, rt: before } = await load();
    const next: GeneralStored = { ...(rows[SETTING_KEYS.general] ?? {}), ...body };
    const after = computeRuntime(ctx, { ...rows, [SETTING_KEYS.general]: next });
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(body) as (keyof GeneralStored)[]) {
      if (before.general[k] !== after.general[k]) changes[k] = { from: before.general[k], to: after.general[k] };
    }
    await writeSetting(ctx, SETTING_KEYS.general, next);
    if (!before.general.demoMode && after.general.demoMode) {
      await seedDemo(ctx).catch((e) => ctx.log.error({ err: e }, 'demo seeding failed'));
    }
    if (before.general.demoMode && !after.general.demoMode) {
      // Demo visitor sessions end with demo mode (loadSession checks it too).
      await ctx.db.delete(sessions).where(inArray(sessions.userId, ctx.db.select({ id: users.id }).from(users).where(eq(users.isDemo, true))));
    }
    await audit(ctx, req, 'settings.general', undefined, { changes });
    return generalView(after);
  });

  // ---------- environment import ----------

  /**
   * Copies the moved environment variables that are set into the app settings (secrets encrypted), so they can be
   * removed from the environment afterwards. Values already saved in the app are kept.
   */
  app.post('/api/admin/settings/import-env', async (req) => {
    requireAdmin(req);
    requireRecentAuth(ctx, req);
    const { rows } = await load();
    const imported: string[] = [];
    const take = <T extends object>(row: T, field: keyof T & string, envName: string, value: unknown) => {
      if (value === undefined || value === '' || row[field] !== undefined) return;
      (row as Record<string, unknown>)[field] = value;
      imported.push(envName);
    };
    const c = config;

    const entra: EntraStored = { ...(rows[SETTING_KEYS.entra] ?? {}) };
    take(entra, 'tenantId', 'ENTRA_TENANT_ID', c.ENTRA_TENANT_ID);
    take(entra, 'clientId', 'ENTRA_CLIENT_ID', c.ENTRA_CLIENT_ID);
    take(entra, 'clientSecret', 'ENTRA_CLIENT_SECRET', c.ENTRA_CLIENT_SECRET && sealSecret(ctx, SETTING_KEYS.entra, 'clientSecret', c.ENTRA_CLIENT_SECRET));
    take(entra, 'requireMfa', 'ENTRA_REQUIRE_MFA', c.ENTRA_REQUIRE_MFA);
    if (entra.enabled === undefined && c.ENTRA_TENANT_ID && c.ENTRA_CLIENT_ID && c.ENTRA_CLIENT_SECRET) entra.enabled = true;

    const ms: ScannerMsStored = { ...(rows[SETTING_KEYS.scannerMs] ?? {}) };
    take(ms, 'clientId', 'SCANNER_MS_CLIENT_ID', c.SCANNER_MS_CLIENT_ID);
    take(ms, 'clientSecret', 'SCANNER_MS_CLIENT_SECRET', c.SCANNER_MS_CLIENT_SECRET && sealSecret(ctx, SETTING_KEYS.scannerMs, 'clientSecret', c.SCANNER_MS_CLIENT_SECRET));
    const aws: ScannerAwsStored = { ...(rows[SETTING_KEYS.scannerAws] ?? {}) };
    take(aws, 'accessKeyId', 'SCANNER_AWS_ACCESS_KEY_ID', c.SCANNER_AWS_ACCESS_KEY_ID);
    take(aws, 'secretAccessKey', 'SCANNER_AWS_SECRET_ACCESS_KEY', c.SCANNER_AWS_SECRET_ACCESS_KEY && sealSecret(ctx, SETTING_KEYS.scannerAws, 'secretAccessKey', c.SCANNER_AWS_SECRET_ACCESS_KEY));

    const general: GeneralStored = { ...(rows[SETTING_KEYS.general] ?? {}) };
    take(general, 'sessionIdleMinutes', 'SESSION_IDLE_MINUTES', c.SESSION_IDLE_MINUTES);
    take(general, 'sessionMaxHours', 'SESSION_MAX_HOURS', c.SESSION_MAX_HOURS);
    take(general, 'auditRetentionMonths', 'AUDIT_RETENTION_MONTHS', c.AUDIT_RETENTION_MONTHS);
    take(general, 'demoMode', 'DEMO_MODE', c.DEMO_MODE);

    const has = (prefix: string) => imported.some((n) => n.startsWith(prefix));
    if (has('ENTRA_')) await writeSetting(ctx, SETTING_KEYS.entra, entra);
    if (has('SCANNER_MS_')) await writeSetting(ctx, SETTING_KEYS.scannerMs, ms);
    if (has('SCANNER_AWS_')) await writeSetting(ctx, SETTING_KEYS.scannerAws, aws);
    if (imported.some((n) => ['SESSION_IDLE_MINUTES', 'SESSION_MAX_HOURS', 'AUDIT_RETENTION_MONTHS', 'DEMO_MODE'].includes(n))) await writeSetting(ctx, SETTING_KEYS.general, general);
    // Variable names only, never values.
    await audit(ctx, req, 'settings.import_env', undefined, { imported });
    return { imported };
  });
}
