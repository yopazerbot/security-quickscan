import { z } from 'zod';

/**
 * Contract between the server and the web app for application settings managed in the UI
 * (sign-in methods, scanner identities, sessions, audit retention, demo mode).
 * Secrets are write-only: the API never returns them, only whether one is set and a short hint.
 */

/** Where an effective value comes from: saved in the app, inherited from an environment variable, or not set. */
export const SETTING_SOURCES = ['app', 'env', 'none'] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

export interface SecretState {
  set: boolean;
  /** Last 4 characters, only when set (e.g. "…x9Qa"). */
  hint: string | null;
  source: SettingSource;
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_DEFAULT_MIN_LENGTH = 14;
export const PASSWORD_MAX_LENGTH = 256;

export interface AuthSettingsView {
  entra: {
    enabled: boolean;
    tenantId: string | null;
    clientId: string | null;
    clientSecret: SecretState;
    requireMfa: boolean;
    /** Redirect URI to register in the Entra app. */
    redirectUri: string;
    source: SettingSource;
  };
  password: {
    enabled: boolean;
    minLength: number;
  };
  /** Environment break-glass account (read-only, always configured through environment variables). */
  breakglass: { enabled: boolean };
  /** Admin accounts able to sign in per method, used by the UI to explain lockout guards. */
  adminsByMethod: { entra: number; password: number };
}

export const entraSettingsInput = z.object({
  enabled: z.boolean(),
  tenantId: z.string().trim().max(100).nullable().optional(),
  clientId: z.string().trim().max(100).nullable().optional(),
  /** Omitted or undefined = keep the current secret; empty string = clear it. */
  clientSecret: z.string().max(500).optional(),
  requireMfa: z.boolean(),
});
export type EntraSettingsInput = z.infer<typeof entraSettingsInput>;

export const passwordSettingsInput = z.object({
  enabled: z.boolean(),
  minLength: z.number().int().min(PASSWORD_MIN_LENGTH).max(64),
});
export type PasswordSettingsInput = z.infer<typeof passwordSettingsInput>;

export interface ScannerSettingsView {
  ms: { clientId: string | null; clientSecret: SecretState; source: SettingSource; consentRedirectUri: string };
  aws: { accessKeyId: string | null; secretAccessKey: SecretState; source: SettingSource; principalArn: string | null };
}

export const scannerSettingsInput = z.object({
  ms: z
    .object({ clientId: z.string().trim().max(100).nullable(), clientSecret: z.string().max(500).optional() })
    .optional(),
  aws: z
    .object({ accessKeyId: z.string().trim().max(128).nullable(), secretAccessKey: z.string().max(500).optional() })
    .optional(),
});
export type ScannerSettingsInput = z.infer<typeof scannerSettingsInput>;

export interface GeneralSettingsView {
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  auditRetentionMonths: number;
  demoMode: boolean;
  sources: Record<'sessionIdleMinutes' | 'sessionMaxHours' | 'auditRetentionMonths' | 'demoMode', SettingSource>;
}

export const generalSettingsInput = z.object({
  sessionIdleMinutes: z.number().int().min(5).max(480),
  sessionMaxHours: z.number().int().min(1).max(24),
  auditRetentionMonths: z.number().int().min(1).max(240),
  demoMode: z.boolean(),
});
export type GeneralSettingsInput = z.infer<typeof generalSettingsInput>;

export interface TestResult {
  ok: boolean;
  message: string;
}

/** Error code in a 403 body ({ error, code }) when a settings change needs a fresh sign-in. */
export const REAUTH_REQUIRED = 'reauth_required';
/** Minutes a sign-in (or re-authentication) counts as recent for sensitive settings. */
export const RECENT_AUTH_MINUTES = 15;

export const passwordLoginInput = z.object({
  email: z.string().trim().max(320),
  password: z.string().max(PASSWORD_MAX_LENGTH),
});

export const passwordChangeInput = z.object({
  currentPassword: z.string().max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().max(PASSWORD_MAX_LENGTH),
});

export const setupInput = z.object({
  token: z.string().max(200),
  email: z.email().max(320),
  name: z.string().trim().min(1).max(200),
  password: z.string().max(PASSWORD_MAX_LENGTH),
});

export const resetPasswordInput = z.object({ temporaryPassword: z.string().max(PASSWORD_MAX_LENGTH) });
