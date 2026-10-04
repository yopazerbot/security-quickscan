import { PROVIDER_LABELS, systemKey, type Provider } from '@qs/shared';

/** Up to four names, then "and N more". */
const listNames = (xs: string[], max = 4) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));

/**
 * Who the system is in the provider (account, tenant or organisation), from the connection test details with the
 * configuration as fallback. Same wording as the report model on the server; null when nothing is known yet.
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
  const tenant = d.displayName ? `Tenant ${d.displayName}${tenantId ? ` (${tenantId})` : ''}` : tenantId ? `Tenant ${tenantId}` : null;
  if (provider === 'm365') return tenant;
  const subs: string[] = Array.isArray(d.subscriptions)
    ? d.subscriptions.map((x: any) => (x?.name && x?.id && x.name !== x.id ? `${x.name} (${x.id})` : String(x?.name || x?.id || ''))).filter(Boolean)
    : Array.isArray(c.subscriptionIds)
      ? c.subscriptionIds.map(String)
      : [];
  const subText = subs.length ? `${subs.length === 1 ? 'subscription' : 'subscriptions'}: ${listNames(subs)}` : null;
  return [tenant, subText].filter(Boolean).join('; ') || null;
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
