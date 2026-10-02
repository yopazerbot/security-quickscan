import type { ScannerEnv } from '../types.js';
import { CheckError, fetchJson, MAX_PAGES, Memo, NotApplicable } from '../util.js';

export interface MsCtx {
  tenantId: string;
  token: string;
  memo: Memo;
  subscriptionIds: string[];
  signal?: AbortSignal;
}

export class GraphError extends CheckError {
  constructor(
    message: string,
    status: number,
    public readonly code: string,
  ) {
    super(message, status);
  }
}

export async function msToken(tenant: string, clientId: string, clientSecret: string, scope: string): Promise<string> {
  if (!/^[a-zA-Z0-9.-]+$/.test(tenant)) throw new CheckError('Invalid tenant');
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope }),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const desc = String(data.error_description ?? data.error ?? res.status).split('\r\n')[0].replace(/Trace ID.*$/s, '');
    throw new CheckError(`Microsoft sign-in failed: ${desc}`);
  }
  return data.access_token;
}

export function msAppCredentials(config: any, secret: any, env: ScannerEnv): { clientId: string; clientSecret: string } {
  if (config.authMode === 'admin_consent') {
    if (!env.ms) throw new CheckError('The platform scanner app is not configured (SCANNER_MS_CLIENT_ID / SCANNER_MS_CLIENT_SECRET).');
    return env.ms;
  }
  if (!config.clientId || !secret?.clientSecret) throw new CheckError('Client ID and client secret are required.');
  return { clientId: config.clientId, clientSecret: secret.clientSecret };
}

const LICENCE_HINTS = /licen[cs]e|premium|P1|P2|SKU|not supported for this tenant|Tenant is not a B2C|AadPremiumLicenseRequired|RequestFromNonPremiumTenant/i;

function toError(status: number, data: any): GraphError {
  const code = data?.error?.code ?? String(status);
  const msg = data?.error?.message ?? `HTTP ${status}`;
  return new GraphError(`${code}: ${msg}`, status, code);
}

const GRAPH_HOSTS = ['graph.microsoft.com'];
const ARM_HOSTS = ['management.azure.com'];

export async function graph<T = any>(ctx: MsCtx, path: string, beta = false): Promise<T> {
  const url = path.startsWith('https://') ? path : `https://graph.microsoft.com/${beta ? 'beta' : 'v1.0'}${path}`;
  const r = await fetchJson<T>({ url, token: ctx.token, allowedHosts: GRAPH_HOSTS, headers: { ConsistencyLevel: 'eventual' }, signal: ctx.signal });
  if (r.status >= 400) {
    const err = toError(r.status, r.data);
    if (r.status === 403 && LICENCE_HINTS.test(err.message)) throw new NotApplicable(`Not available in this tenant (licence): ${err.message}`);
    throw err;
  }
  return r.data;
}

export async function graphAll<T = any>(ctx: MsCtx, path: string, beta = false, max = 20000): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  const seen = new Set<string>();
  for (let pages = 0; next && out.length < max && pages < MAX_PAGES; pages++) {
    seen.add(next);
    const page: any = await graph(ctx, next, beta);
    const items = page.value ?? [];
    out.push(...items);
    next = items.length ? page['@odata.nextLink'] : undefined;
    if (next && seen.has(next)) break;
  }
  return out;
}

export async function arm<T = any>(ctx: MsCtx, path: string): Promise<T> {
  const url = path.startsWith('https://') ? path : `https://management.azure.com${path}`;
  const r = await fetchJson<T>({ url, token: ctx.token, allowedHosts: ARM_HOSTS, signal: ctx.signal });
  if (r.status >= 400) throw toError(r.status, r.data);
  return r.data;
}

export async function armAll<T = any>(ctx: MsCtx, path: string, max = 20000): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  const seen = new Set<string>();
  for (let pages = 0; next && out.length < max && pages < MAX_PAGES; pages++) {
    seen.add(next);
    const page: any = await arm(ctx, next);
    const items = page.value ?? [];
    out.push(...items);
    next = items.length ? page.nextLink : undefined;
    if (next && seen.has(next)) break;
  }
  return out;
}
