import { environmentKey, normalizeEnvironment, PROVIDER_LABELS, systemKey, type Provider } from '@qs/shared';

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
  environment?: string | null;
  systemKey?: string;
}

/** Stable system key of a scan system row from GET /api/scans/:id (same rule as the server). */
export function keyOfScanSystem(s: { provider: Provider; label: string; config?: Record<string, any> | null; connection?: { details?: Record<string, any> | null } | null }) {
  return systemKey(s.provider, s.config ?? {}, s.connection?.details ?? null, s.label);
}

/**
 * "aws:123456789012" to a provider and a readable id, for triage rows whose system is not in a loaded scan.
 * Azure keys scoped to subscriptions ("azure:<tenant>/<sub>,<sub>") read as "<tenant>; subscriptions: <sub>, <sub>";
 * a tenant-only Azure key reads as "<tenant>; all subscriptions".
 */
export function parseSystemKey(key: string): { provider: Provider | null; id: string } {
  const i = key.indexOf(':');
  const p = i > 0 ? key.slice(0, i) : '';
  const provider = p in PROVIDER_LABELS ? (p as Provider) : null;
  const rest = i > 0 ? key.slice(i + 1) : key;
  if (rest.startsWith('label:')) return { provider, id: rest.slice(6) };
  const slash = provider === 'azure' ? rest.indexOf('/') : -1;
  if (slash > 0) {
    const subs = rest.slice(slash + 1).split(',').filter(Boolean);
    return { provider, id: `${rest.slice(0, slash)}; ${subs.length === 1 ? 'subscription' : 'subscriptions'}: ${listNames(subs)}` };
  }
  // A tenant-only Azure key also applies to systems scoped to subscriptions in that tenant.
  return { provider, id: provider === 'azure' ? `${rest}; all subscriptions` : rest };
}

/** Systems grouped by environment (case-insensitive), as the report model sends them or derived from the systems. */
export interface EnvironmentGroup {
  /** Lower-case environment, '' for systems without one. */
  key: string;
  name: string | null;
  systemIds: string[];
  summary?: { score?: number | null; grade?: string | null; partial?: boolean; counts?: Partial<Record<string, number>> } | null;
}

/** Environment groups in system order, systems without an environment last. Uses the report model's summaries when present. */
export function environmentGroups(systems: { id: string; environment?: string | null }[], fromModel?: EnvironmentGroup[] | null): EnvironmentGroup[] {
  if (Array.isArray(fromModel) && fromModel.length) return fromModel;
  const groups = new Map<string, EnvironmentGroup>();
  for (const s of systems) {
    const name = normalizeEnvironment(s.environment);
    const key = environmentKey(name);
    const g = groups.get(key) ?? { key, name, systemIds: [] };
    g.systemIds.push(s.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0));
}
