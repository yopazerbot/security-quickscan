import type { CheckOutcome, Provider } from '@qs/shared';
import { awsModule } from './aws/index.js';
import { demoOutcome } from './demo.js';
import { githubModule } from './github/index.js';
import { azureModule } from './ms/azure.js';
import { m365Module } from './ms/m365.js';
import type { ConnectionResult, ProviderModule, ScannerEnv } from './types.js';
import { msToken } from './ms/client.js';
import { mapLimit, Memo, NotApplicable, withTimeout } from './util.js';

export const MODULES: Record<Provider, ProviderModule<any>> = {
  aws: awsModule,
  m365: m365Module,
  azure: azureModule,
  github: githubModule,
};

export const IMPLEMENTED_CHECKS = new Set(Object.values(MODULES).flatMap((m) => Object.keys(m.checks)));

const CHECK_TIMEOUT_MS = 5 * 60_000;

/**
 * Errors can contain upstream API text: keep them short and strip anything token-like,
 * plus the exact secret values of the system being scanned.
 */
export function safeError(e: unknown, secrets: string[] = []): string {
  let msg = e instanceof Error ? `${e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}` : String(e);
  for (const s of secrets) if (s.length >= 8) msg = msg.split(s).join('[redacted]');
  return msg
    .replace(/(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+)/g, '[redacted]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(ghp_|github_pat_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\bIQoJ[A-Za-z0-9+/=]{20,}/g, '[redacted]') // AWS session tokens
    .replace(/\b[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{30,}/g, '[redacted]') // Entra client secrets
    .slice(0, 600);
}

/** All string values of a secret object (for exact-match redaction). */
const secretValues = (secret: unknown): string[] =>
  secret && typeof secret === 'object' ? Object.values(secret as Record<string, unknown>).filter((v): v is string => typeof v === 'string') : [];

export interface RunSystemInput {
  systemId: string;
  provider: Provider;
  config: any;
  secret: any;
  checkIds: string[];
  env: ScannerEnv;
  onStart(checkId: string): Promise<void>;
  onResult(checkId: string, outcome: CheckOutcome, error?: string): Promise<void>;
  shouldStop(): Promise<boolean>;
}

export async function runSystem(input: RunSystemInput): Promise<void> {
  const mod = MODULES[input.provider];
  const demo = input.config?.authMode === 'demo';
  const secrets = secretValues(input.secret);
  let ctx: unknown;
  if (!demo) {
    try {
      ctx = await withTimeout(mod.connect(input.config, input.secret, input.env, new Memo(), input.systemId), 60_000, 'Connecting');
    } catch (e) {
      const err = safeError(e, secrets);
      for (const id of input.checkIds) await input.onResult(id, { status: 'error', summary: `Could not connect: ${err}` }, err);
      return;
    }
  }
  await mapLimit(input.checkIds, demo ? 4 : 3, async (checkId) => {
    if (await input.shouldStop()) return;
    await input.onStart(checkId);
    // Each check gets its own abort signal: on timeout the API calls really stop (they hold live credentials).
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`${checkId} timed out`)), CHECK_TIMEOUT_MS);
    try {
      const impl = mod.checks[checkId];
      const outcome = demo
        ? await demoOutcome(input.systemId, checkId, { maturity: typeof input.config?.demoMaturity === 'number' ? input.config.demoMaturity : undefined })
        : impl
          ? await withTimeout(impl({ ...(ctx as object), signal: abort.signal }), CHECK_TIMEOUT_MS, checkId)
          : { status: 'error' as const, summary: 'Check not implemented.' };
      await input.onResult(checkId, outcome);
    } catch (e) {
      if (e instanceof NotApplicable) return input.onResult(checkId, { status: 'na', summary: safeError(new Error(e.message), secrets) });
      const err = safeError(e, secrets);
      await input.onResult(checkId, { status: 'error', summary: `The check could not be completed: ${err}` }, err);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  });
}

export async function testConnection(provider: Provider, config: any, secret: any, env: ScannerEnv, systemId: string): Promise<ConnectionResult> {
  if (config?.authMode === 'demo') return { ok: true, message: 'Demo system: no real connection is made.' };
  const mod = MODULES[provider];
  try {
    const ctx = await withTimeout(mod.connect(config, secret, env, new Memo(), systemId), 45_000, 'Connecting');
    return await withTimeout(mod.identity(ctx), 45_000, 'Verifying permissions');
  } catch (e) {
    return { ok: false, message: safeError(e) };
  }
}

let principalCache: { arn: string; at: number } | null = null;
/** ARN of the platform AWS identity, used in the customer's role trust policy. */
export async function awsPrincipalArn(env: ScannerEnv): Promise<string | null> {
  if (!env.aws) return null;
  if (principalCache && Date.now() - principalCache.at < 3600_000) return principalCache.arn;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const id = await new STSClient({ region: 'us-east-1', credentials: env.aws }).send(new GetCallerIdentityCommand({}));
  principalCache = { arn: id.Arn!, at: Date.now() };
  return id.Arn!;
}

/** True when the platform scanner app can obtain a token for the tenant, i.e. admin consent really exists. */
export async function verifyMsConsent(env: ScannerEnv, tenantId: string): Promise<boolean> {
  if (!env.ms) return false;
  try {
    await msToken(tenantId, env.ms.clientId, env.ms.clientSecret, 'https://graph.microsoft.com/.default');
    return true;
  } catch {
    return false;
  }
}
