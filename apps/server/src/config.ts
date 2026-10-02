import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    PORT: z.coerce.number().int().default(8080),
    APP_URL: z.url().transform((u) => u.replace(/\/$/, '')),
    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: bool,
    /** 32 random bytes, base64. Generate with: openssl rand -base64 32 */
    MASTER_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY must be 32 bytes, base64 encoded'),
    /** Optional previous key, used only by the key rotation command. */
    MASTER_KEY_PREVIOUS: z.string().optional(),
    MODE: z.enum(['all', 'api', 'worker']).default('all'),
    TRUST_PROXY: z.string().default('true'),
    COOKIE_SECURE: z.string().default('true').transform((v) => v !== 'false'),

    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    /** Require the Entra token to show MFA was performed (amr claim). */
    ENTRA_REQUIRE_MFA: bool,
    BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),

    BREAKGLASS_ENABLED: bool,
    BREAKGLASS_USERNAME: z.string().optional(),
    BREAKGLASS_PASSWORD_HASH: z.string().optional(),
    BREAKGLASS_TOTP_SECRET: z.string().optional(),

    SCANNER_AWS_ACCESS_KEY_ID: z.string().optional(),
    SCANNER_AWS_SECRET_ACCESS_KEY: z.string().optional(),
    SCANNER_MS_CLIENT_ID: z.string().optional(),
    SCANNER_MS_CLIENT_SECRET: z.string().optional(),

    DEMO_MODE: bool,
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(480).default(30),
    SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(8),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((c, ctx) => {
    const entra = c.ENTRA_TENANT_ID && c.ENTRA_CLIENT_ID && c.ENTRA_CLIENT_SECRET;
    if (!entra && !c.BREAKGLASS_ENABLED) ctx.addIssue({ code: 'custom', message: 'Configure ENTRA_* variables (or enable break glass) so someone can sign in' });
    if (c.BREAKGLASS_ENABLED && !(c.BREAKGLASS_USERNAME && c.BREAKGLASS_PASSWORD_HASH && c.BREAKGLASS_TOTP_SECRET)) {
      ctx.addIssue({ code: 'custom', message: 'BREAKGLASS_ENABLED requires BREAKGLASS_USERNAME, BREAKGLASS_PASSWORD_HASH and BREAKGLASS_TOTP_SECRET' });
    }
    if (c.ENTRA_TENANT_ID && ['common', 'organizations', 'consumers'].includes(c.ENTRA_TENANT_ID.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: 'ENTRA_TENANT_ID must be your own tenant ID, not a multi-tenant alias' });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return r.data;
}

export const entraEnabled = (c: Config) => Boolean(c.ENTRA_TENANT_ID && c.ENTRA_CLIENT_ID && c.ENTRA_CLIENT_SECRET);

export function scannerEnv(c: Config) {
  return {
    aws: c.SCANNER_AWS_ACCESS_KEY_ID && c.SCANNER_AWS_SECRET_ACCESS_KEY ? { accessKeyId: c.SCANNER_AWS_ACCESS_KEY_ID, secretAccessKey: c.SCANNER_AWS_SECRET_ACCESS_KEY } : undefined,
    ms: c.SCANNER_MS_CLIENT_ID && c.SCANNER_MS_CLIENT_SECRET ? { clientId: c.SCANNER_MS_CLIENT_ID, clientSecret: c.SCANNER_MS_CLIENT_SECRET } : undefined,
  };
}
