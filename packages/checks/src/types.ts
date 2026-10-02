import type { CheckOutcome } from '@qs/shared';
import type { Memo } from './util.js';

/** Credentials of the scanning platform itself (from environment variables). */
export interface ScannerEnv {
  aws?: { accessKeyId: string; secretAccessKey: string };
  ms?: { clientId: string; clientSecret: string };
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface ProviderModule<Ctx> {
  connect(config: any, secret: any, env: ScannerEnv, memo: Memo, systemId: string): Promise<Ctx>;
  identity(ctx: Ctx): Promise<ConnectionResult>;
  checks: Record<string, (ctx: Ctx) => Promise<CheckOutcome>>;
}
