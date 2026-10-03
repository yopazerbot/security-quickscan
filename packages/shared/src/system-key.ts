import type { Provider } from './types.js';

/**
 * Stable identity of a scanned system across scans and rescans (system rows are re-created per scan).
 * Triage decisions are stored per (organisation, check, system key). '*' is the legacy "every system" key.
 */
export const ALL_SYSTEMS_KEY = '*';

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
  }
  id = id.trim().toLowerCase();
  return id ? `${provider}:${id}` : `${provider}:label:${(label ?? '').trim().toLowerCase()}`;
}
