import type { ScannerEnv } from '@qs/checks';
import { PASSWORD_DEFAULT_MIN_LENGTH, PASSWORD_MIN_LENGTH, type SecretState, type SettingSource } from '@qs/shared';
import { inArray, sql } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { sha256 } from '../crypto/envelope.js';
import { settings } from '../db/schema.js';

/**
 * Application settings managed in the UI, with the old environment variables as fallback:
 * effective value = saved in the app (settings table) if present, else environment variable, else default.
 *
 * Secrets are stored envelope-encrypted (crypto/envelope.ts) with the AAD bound to the setting key and field,
 * never logged and never returned by the API (only SecretState). A field missing from a saved row falls back to
 * the environment; a field saved as null means "explicitly not set" (no fallback).
 */

export const SETTING_KEYS = {
  entra: 'auth.entra',
  password: 'auth.password',
  scannerMs: 'scanner.ms',
  scannerAws: 'scanner.aws',
  general: 'general',
} as const;
const ALL_KEYS = Object.values(SETTING_KEYS);

/** Every encrypted field in the settings table (also used by the rotate-master-key CLI). */
export const SECRET_FIELDS = [
  { key: SETTING_KEYS.entra, field: 'clientSecret' },
  { key: SETTING_KEYS.scannerMs, field: 'clientSecret' },
  { key: SETTING_KEYS.scannerAws, field: 'secretAccessKey' },
] as const;

export const secretAad = (key: string, field: string) => `settings:${key}.${field}`;

/** Encrypted secret as stored in the jsonb value. `hint` is the last 4 characters (or null for short values). */
export interface StoredSecret {
  blob: string;
  hint: string | null;
  setAt: string;
}

export interface EntraStored {
  enabled?: boolean;
  tenantId?: string | null;
  clientId?: string | null;
  clientSecret?: StoredSecret | null;
  requireMfa?: boolean;
}
export interface PasswordStored {
  enabled?: boolean;
  minLength?: number;
}
export interface ScannerMsStored {
  clientId?: string | null;
  clientSecret?: StoredSecret | null;
}
export interface ScannerAwsStored {
  accessKeyId?: string | null;
  secretAccessKey?: StoredSecret | null;
}
export interface GeneralStored {
  sessionIdleMinutes?: number;
  sessionMaxHours?: number;
  auditRetentionMonths?: number;
  demoMode?: boolean;
}

export interface StoredSettings {
  [SETTING_KEYS.entra]?: EntraStored;
  [SETTING_KEYS.password]?: PasswordStored;
  [SETTING_KEYS.scannerMs]?: ScannerMsStored;
  [SETTING_KEYS.scannerAws]?: ScannerAwsStored;
  [SETTING_KEYS.general]?: GeneralStored;
}

export interface EffectiveSecret {
  value: string | null;
  state: SecretState;
}

export interface Runtime {
  entra: {
    enabled: boolean;
    tenantId: string | null;
    clientId: string | null;
    clientSecret: EffectiveSecret;
    requireMfa: boolean;
    source: SettingSource;
    /** Tenant, client ID and secret are all present. */
    configured: boolean;
    /** Enabled and configured: Microsoft sign-in is offered. */
    usable: boolean;
    /** Changes whenever tenant, client ID or secret change (keys the OIDC discovery cache). */
    version: string;
  };
  password: { enabled: boolean; minLength: number; source: SettingSource };
  scanner: {
    ms: { clientId: string | null; clientSecret: EffectiveSecret; source: SettingSource };
    aws: { accessKeyId: string | null; secretAccessKey: EffectiveSecret; source: SettingSource };
    /** What the check runner needs (only complete identities). */
    env: ScannerEnv;
  };
  general: {
    sessionIdleMinutes: number;
    sessionMaxHours: number;
    auditRetentionMonths: number;
    demoMode: boolean;
    sources: Record<keyof GeneralStored, SettingSource>;
  };
  /** Environment only: first administrator created at their first Microsoft sign-in (legacy, first-run setup replaces it). */
  bootstrapAdminEmail: string | null;
}

export const DEFAULTS = { sessionIdleMinutes: 30, sessionMaxHours: 8, auditRetentionMonths: 24 } as const;

type Ctx = Pick<AppCtx, 'config' | 'db' | 'envelope' | 'log'>;

/** Last 4 characters as a hint, only for values long enough that this reveals little. */
export function secretHint(value: string): string | null {
  return value.length >= 12 ? `…${value.slice(-4)}` : null;
}

export function sealSecret(ctx: Pick<AppCtx, 'envelope'>, key: string, field: string, value: string): StoredSecret {
  return {
    blob: ctx.envelope.encrypt(Buffer.from(value, 'utf8'), secretAad(key, field)).toString('base64'),
    hint: secretHint(value),
    setAt: new Date().toISOString(),
  };
}

function openSecret(ctx: Ctx, key: string, field: string, stored: StoredSecret | null | undefined, envValue: string | undefined): EffectiveSecret {
  if (stored === undefined) {
    return envValue ? { value: envValue, state: { set: true, hint: secretHint(envValue), source: 'env' } } : { value: null, state: { set: false, hint: null, source: 'none' } };
  }
  if (stored === null) return { value: null, state: { set: false, hint: null, source: 'none' } };
  try {
    const value = ctx.envelope.decrypt(Buffer.from(stored.blob, 'base64'), secretAad(key, field)).toString('utf8');
    return { value, state: { set: true, hint: stored.hint, source: 'app' } };
  } catch {
    // Never log the value; a wrong MASTER_KEY is the usual cause.
    ctx.log.error({ setting: `${key}.${field}` }, 'stored setting secret could not be decrypted (check MASTER_KEY)');
    return { value: null, state: { set: true, hint: stored.hint, source: 'app' } };
  }
}

/** Saved value if the field is present in the row, else the environment value. */
function pick<T>(row: object | undefined, field: string, envValue: T | undefined): { value: T | undefined; source: SettingSource } {
  if (row && field in row && (row as Record<string, unknown>)[field] !== undefined) {
    const v = (row as Record<string, unknown>)[field] as T | null;
    return { value: v ?? undefined, source: v === null ? 'none' : 'app' };
  }
  return envValue !== undefined && envValue !== '' ? { value: envValue, source: 'env' } : { value: undefined, source: 'none' };
}

const groupSource = (row: object | undefined, envSet: boolean): SettingSource => (row ? 'app' : envSet ? 'env' : 'none');

/** Pure merge of saved rows, environment and defaults. */
export function computeRuntime(ctx: Ctx, rows: StoredSettings): Runtime {
  const c = ctx.config;
  const e = rows[SETTING_KEYS.entra];
  const tenantId = pick(e, 'tenantId', c.ENTRA_TENANT_ID).value ?? null;
  const clientId = pick(e, 'clientId', c.ENTRA_CLIENT_ID).value ?? null;
  const clientSecret = openSecret(ctx, SETTING_KEYS.entra, 'clientSecret', e?.clientSecret, c.ENTRA_CLIENT_SECRET);
  const configured = Boolean(tenantId && clientId && clientSecret.value);
  const envEntra = Boolean(c.ENTRA_TENANT_ID && c.ENTRA_CLIENT_ID && c.ENTRA_CLIENT_SECRET);
  // Without a saved row, a complete environment configuration counts as enabled (previous behaviour).
  const entraEnabled = e?.enabled ?? envEntra;

  const p = rows[SETTING_KEYS.password];
  const minLength = Math.min(Math.max(p?.minLength ?? PASSWORD_DEFAULT_MIN_LENGTH, PASSWORD_MIN_LENGTH), 64);

  const ms = rows[SETTING_KEYS.scannerMs];
  const msClientId = pick(ms, 'clientId', c.SCANNER_MS_CLIENT_ID).value ?? null;
  const msSecret = openSecret(ctx, SETTING_KEYS.scannerMs, 'clientSecret', ms?.clientSecret, c.SCANNER_MS_CLIENT_SECRET);
  const aws = rows[SETTING_KEYS.scannerAws];
  const awsKeyId = pick(aws, 'accessKeyId', c.SCANNER_AWS_ACCESS_KEY_ID).value ?? null;
  const awsSecret = openSecret(ctx, SETTING_KEYS.scannerAws, 'secretAccessKey', aws?.secretAccessKey, c.SCANNER_AWS_SECRET_ACCESS_KEY);

  const g = rows[SETTING_KEYS.general];
  const idle = pick(g, 'sessionIdleMinutes', c.SESSION_IDLE_MINUTES);
  const maxH = pick(g, 'sessionMaxHours', c.SESSION_MAX_HOURS);
  const ret = pick(g, 'auditRetentionMonths', c.AUDIT_RETENTION_MONTHS);
  const demo = pick(g, 'demoMode', c.DEMO_MODE);

  return {
    entra: {
      enabled: entraEnabled,
      tenantId,
      clientId,
      clientSecret,
      requireMfa: pick(e, 'requireMfa', c.ENTRA_REQUIRE_MFA).value ?? false,
      source: groupSource(e, Boolean(c.ENTRA_TENANT_ID || c.ENTRA_CLIENT_ID || c.ENTRA_CLIENT_SECRET)),
      configured,
      usable: entraEnabled && configured,
      version: sha256(`${tenantId}|${clientId}|${clientSecret.value ?? ''}`).slice(0, 16),
    },
    password: { enabled: p?.enabled ?? false, minLength, source: p ? 'app' : 'none' },
    scanner: {
      ms: { clientId: msClientId, clientSecret: msSecret, source: groupSource(ms, Boolean(c.SCANNER_MS_CLIENT_ID || c.SCANNER_MS_CLIENT_SECRET)) },
      aws: { accessKeyId: awsKeyId, secretAccessKey: awsSecret, source: groupSource(aws, Boolean(c.SCANNER_AWS_ACCESS_KEY_ID || c.SCANNER_AWS_SECRET_ACCESS_KEY)) },
      env: {
        ms: msClientId && msSecret.value ? { clientId: msClientId, clientSecret: msSecret.value } : undefined,
        aws: awsKeyId && awsSecret.value ? { accessKeyId: awsKeyId, secretAccessKey: awsSecret.value } : undefined,
      },
    },
    general: {
      sessionIdleMinutes: idle.value ?? DEFAULTS.sessionIdleMinutes,
      sessionMaxHours: maxH.value ?? DEFAULTS.sessionMaxHours,
      auditRetentionMonths: ret.value ?? DEFAULTS.auditRetentionMonths,
      demoMode: demo.value ?? false,
      sources: { sessionIdleMinutes: idle.source, sessionMaxHours: maxH.source, auditRetentionMonths: ret.source, demoMode: demo.source },
    },
    bootstrapAdminEmail: c.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || null,
  };
}

export async function readStoredSettings(ctx: Pick<AppCtx, 'db'>): Promise<StoredSettings> {
  const rows = await ctx.db.select().from(settings).where(inArray(settings.key, ALL_KEYS));
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as StoredSettings;
}

/**
 * Short cache: the API and a separate worker process (MODE=worker) read the same rows, so a change made in
 * one process reaches the other within TTL_MS. Writes in this process invalidate immediately.
 */
const TTL_MS = 5000;
let generation = 0;
const cache = new WeakMap<object, { at: number; gen: number; value: Promise<Runtime> }>();

export function getRuntime(ctx: Ctx): Promise<Runtime> {
  const hit = cache.get(ctx);
  if (hit && hit.gen === generation && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = readStoredSettings(ctx).then((rows) => computeRuntime(ctx, rows));
  cache.set(ctx, { at: Date.now(), gen: generation, value });
  value.catch(() => cache.delete(ctx));
  return value;
}

export function invalidateRuntime() {
  generation++;
}

/** Upserts one settings row and invalidates the cache. */
export async function writeSetting(ctx: Pick<AppCtx, 'db'>, key: string, value: object) {
  await ctx.db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } });
  invalidateRuntime();
}

/** Scanner identities for the check runner and consent flows. */
export async function scannerEnv(ctx: Ctx): Promise<ScannerEnv> {
  return (await getRuntime(ctx)).scanner.env;
}
