import type { Provider } from './types.js';

/**
 * Stable identity of a scanned system across scans and rescans (system rows are re-created per scan).
 * Triage decisions are stored per (organisation, check, system key). '*' is the legacy "every system" key.
 */
export const ALL_SYSTEMS_KEY = '*';

/** Organisation a simulated GitHub system gets when none is entered; not an identity of its own. */
const DEMO_GITHUB_ORG = 'demo-org';

/**
 * Keys look like `aws:111122223333`, `m365:<tenant>`, `github:<org>`, `azure:<tenant>` (all subscriptions) or
 * `azure:<tenant>/<sub1>,<sub2>` (scoped to subscriptions, sorted and lower case), so production and acceptance
 * subscriptions in one tenant are separate systems. Without a known identity the key is `<provider>:label:<label>`;
 * that is also how a simulated GitHub system without an organisation of its own is told apart.
 */
export function systemKey(provider: Provider, config: Record<string, any> | null | undefined, details?: Record<string, any> | null, label?: string): string {
  const c = config ?? {};
  const d = details ?? {};
  let id = '';
  if (provider === 'aws') {
    const fromArn = typeof c.roleArn === 'string' ? (c.roleArn.split(':')[4] ?? '') : '';
    id = String(c.accountId || fromArn || d.accountId || '');
  } else if (provider === 'm365' || provider === 'azure') {
    id = String(d.tenantId || c.tenantId || '');
  } else if (provider === 'github') {
    id = String(c.org || d.org || '');
    if (c.authMode === 'demo' && id.trim().toLowerCase() === DEMO_GITHUB_ORG) id = '';
  }
  id = id.trim().toLowerCase();
  if (!id) return `${provider}:label:${(label ?? '').trim().toLowerCase()}`;
  if (provider === 'azure') {
    const subs = Array.isArray(c.subscriptionIds) ? [...new Set(c.subscriptionIds.map((s: unknown) => String(s).trim().toLowerCase()).filter(Boolean))].sort() : [];
    if (subs.length) return `azure:${id}/${subs.join(',')}`;
  }
  return `${provider}:${id}`;
}

/**
 * Keys to look triage up under, most specific first, before the legacy '*' rows. Azure systems scoped to
 * subscriptions were keyed by tenant only before; decisions stored under that tenant key still apply to them.
 */
export function systemKeyFallbacks(key: string): string[] {
  if (key.startsWith('azure:') && !key.startsWith('azure:label:')) {
    const slash = key.indexOf('/');
    if (slash > 0) return [key, key.slice(0, slash)];
  }
  return [key];
}

/** True when the key names a real account, tenant or organisation (not a display name). */
export const isIdentityKey = (key: string) => !/^[a-z0-9]+:label:/.test(key);

/** Free-text environment of a system (production, acceptance, test...): trimmed, at most 40 characters, empty is none. */
export const ENVIRONMENT_MAX = 40;
export function normalizeEnvironment(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, ENVIRONMENT_MAX).trim();
  return s || null;
}

/** Grouping key of an environment: case-insensitive, '' for systems without one. */
export const environmentKey = (v: string | null | undefined) => (normalizeEnvironment(v) ?? '').toLowerCase();

/** "AWS (acceptance)" for text output; the environment is left out when the label already names it ("AWS production"). */
export function systemDisplayName(label: string, environment: string | null | undefined): string {
  const env = normalizeEnvironment(environment);
  if (!env || label.toLowerCase().includes(env.toLowerCase())) return label;
  return `${label} (${env})`;
}
