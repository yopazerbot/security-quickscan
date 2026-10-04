import { PROVIDER_LABELS, systemKey, type Provider } from '@qs/shared';

/** Up to two names, then "and N more". */
function names(list: string[]) {
  return list.length <= 2 ? list.join(', ') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
}

/**
 * Who the system is in the provider (account, tenant or organisation), from the connection test details and the
 * system configuration. Mirrors the report model; null when nothing is known yet.
 */
export function systemIdentity(provider: Provider, details?: Record<string, any> | null, config?: Record<string, any> | null): string | null {
  const d = details ?? {};
  const c = config ?? {};
  if (provider === 'aws') {
    const fromArn = typeof c.roleArn === 'string' ? c.roleArn.split(':')[4] : '';
    const id = d.accountId || c.accountId || fromArn;
    return id ? `AWS account ${id}` : null;
  }
  if (provider === 'github') {
    const org = d.org || c.org;
    return org ? `github.com/${org}` : null;
  }
  const tenantId = d.tenantId || c.tenantId;
  if (provider === 'azure' && Array.isArray(d.subscriptions) && d.subscriptions.length) {
    const subs = names(d.subscriptions.map((s: any) => String(s?.name || s?.id || s)));
    return tenantId ? `Tenant ${tenantId}, ${subs}` : subs;
  }
  if (d.displayName) return tenantId ? `${d.displayName} (${tenantId})` : String(d.displayName);
  return tenantId ? `Tenant ${tenantId}` : null;
}

/** A system as the report and the scan pages know it. */
export interface SystemRef {
  id: string;
  provider: Provider;
  label: string;
  identity?: string | null;
  systemKey?: string;
}

/** Stable system key of a scan system row from GET /api/scans/:id (same rule as the server). */
export function keyOfScanSystem(s: { provider: Provider; label: string; config?: Record<string, any> | null; connection?: { details?: Record<string, any> | null } | null }) {
  return systemKey(s.provider, s.config ?? {}, s.connection?.details ?? null, s.label);
}

/** "aws:123456789012" to a provider and a readable id, for triage rows whose system is not in a loaded scan. */
export function parseSystemKey(key: string): { provider: Provider | null; id: string } {
  const i = key.indexOf(':');
  const p = i > 0 ? key.slice(0, i) : '';
  const provider = p in PROVIDER_LABELS ? (p as Provider) : null;
  const rest = i > 0 ? key.slice(i + 1) : key;
  return { provider, id: rest.startsWith('label:') ? rest.slice(6) : rest };
}
