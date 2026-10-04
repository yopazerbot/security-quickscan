import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');
/** Like bool, but undefined when not set (moved settings: unset means "no environment fallback"). */
const optBool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

/** Docker: the /data volume. Elsewhere (local development): .data/ in the working directory. */
function defaultKeyFile() {
  return existsSync('/.dockerenv') ? '/data/master.key' : '.data/master.key';
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    PORT: z.coerce.number().int().default(8080),
    APP_URL: z.url().transform((u) => u.replace(/\/$/, '')),
    DATABASE_URL: z.string().min(1),
    /** 'true' = TLS with certificate verification, 'no-verify' = TLS without verification (not recommended). */
    DATABASE_SSL: z.enum(['true', 'false', '1', '0', 'no-verify']).optional(),
    /** 32 random bytes, base64. Generate with: openssl rand -base64 32 */
    MASTER_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY must be 32 bytes, base64 encoded'),
    /** Previous key during a rotation: still accepted for decryption until rotate-master-key has re-wrapped everything. */
    MASTER_KEY_PREVIOUS: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY_PREVIOUS must be 32 bytes, base64 encoded')
      .optional(),
    MODE: z.enum(['all', 'api', 'worker']).default('all'),
    /**
     * Single-user local installation (e.g. Docker on a laptop): no login, only reachable via localhost,
     * master key generated and stored in KEY_FILE.
     */
    LOCAL_MODE: bool,
    /**
     * Local mode only: require the one-time startup link (?local_token=...) before the first local session is
     * created. Defaults to true inside a container, where the peer address cannot be checked.
     */
    LOCAL_REQUIRE_TOKEN: bool,
    KEY_FILE: z.string().default(defaultKeyFile()),
    HOST: z.string().optional(),
    /**
     * Number of reverse-proxy hops to trust for the client IP. Default: 1 on Railway (RAILWAY_ENVIRONMENT set),
     * otherwise 'false' so clients cannot spoof their IP with X-Forwarded-For. Set it to 1 behind your own proxy.
     */
    TRUST_PROXY: z.string().default('false'),
    COOKIE_SECURE: z.string().default('true').transform((v) => v !== 'false'),

    /*
     * Moved to the application settings (Settings in the UI). These variables remain supported as a fallback:
     * the effective value is the saved app setting, else the variable, else the default (see settings/runtime.ts).
     */
    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    /** Require the Entra token to show MFA was performed (amr claim). */
    ENTRA_REQUIRE_MFA: optBool,
    /** Legacy: first administrator created at their first Microsoft sign-in. First-run setup (/setup) replaces it. */
    BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
    SCANNER_AWS_ACCESS_KEY_ID: z.string().optional(),
    SCANNER_AWS_SECRET_ACCESS_KEY: z.string().optional(),
    SCANNER_MS_CLIENT_ID: z.string().optional(),
    SCANNER_MS_CLIENT_SECRET: z.string().optional(),
    DEMO_MODE: optBool,
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(480).optional(),
    SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).optional(),
    /** Audit log entries older than this are deleted by housekeeping (at most once a day). */
    AUDIT_RETENTION_MONTHS: z.coerce.number().int().min(1).max(240).optional(),

    /** Emergency access (recovery), always configured through the environment. */
    BREAKGLASS_ENABLED: bool,
    BREAKGLASS_USERNAME: z.string().optional(),
    BREAKGLASS_PASSWORD_HASH: z.string().optional(),
    BREAKGLASS_TOTP_SECRET: z.string().optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((c, ctx) => {
    if (c.LOCAL_MODE) {
      // Without login the app must never be reachable from other machines.
      if (!LOOPBACK.has(new URL(c.APP_URL).hostname)) ctx.addIssue({ code: 'custom', message: 'LOCAL_MODE requires APP_URL on localhost (e.g. http://localhost:8080)' });
      return;
    }
    // No sign-in method is required here: without an administrator, first-run setup (/setup) creates one.
    if (c.BREAKGLASS_ENABLED && !(c.BREAKGLASS_USERNAME && c.BREAKGLASS_PASSWORD_HASH && c.BREAKGLASS_TOTP_SECRET)) {
      ctx.addIssue({ code: 'custom', message: 'BREAKGLASS_ENABLED requires BREAKGLASS_USERNAME, BREAKGLASS_PASSWORD_HASH and BREAKGLASS_TOTP_SECRET' });
    }
    if (c.ENTRA_TENANT_ID && ['common', 'organizations', 'consumers'].includes(c.ENTRA_TENANT_ID.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: 'ENTRA_TENANT_ID must be your own tenant ID, not a multi-tenant alias' });
    }
  });

export type Config = z.infer<typeof schema>;

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isTrue = (v?: string) => v === 'true' || v === '1';

/** Local mode: read the master key from KEY_FILE, creating it (0600) on first start. */
function localMasterKey(file: string): string {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const key = randomBytes(32).toString('base64');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values (e.g. "APP_URL=" in a .env file) count as unset so defaults apply.
  env = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  if (isTrue(env.LOCAL_MODE)) {
    const port = env.PORT ?? '8080';
    env = {
      APP_URL: `http://localhost:${port}`,
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
      LOCAL_REQUIRE_TOKEN: existsSync('/.dockerenv') ? 'true' : 'false',
      ...env,
    };
    if (!env.MASTER_KEY) env = { ...env, MASTER_KEY: localMasterKey(env.KEY_FILE || defaultKeyFile()) };
  }
  if (!env.TRUST_PROXY) env = { ...env, TRUST_PROXY: env.RAILWAY_ENVIRONMENT ? '1' : 'false' };
  const r = schema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return r.data;
}
