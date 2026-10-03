import type { CheckOutcome, ResourceRef } from '@qs/shared';
import type { ProviderModule } from '../types.js';
import { applyCoverage, applyTruncation, CheckError, fail, failIfAny, mapLimit, na, pass, warn } from '../util.js';
import { armAll, GraphError, msAppCredentials, msToken, type MsCtx } from './client.js';

interface Sub {
  subscriptionId: string;
  displayName: string;
}

const OWNER_ROLE = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
const KEY_PLANS = ['VirtualMachines', 'StorageAccounts', 'KeyVaults', 'Arm', 'SqlServers'];
const MGMT_PORTS = [22, 3389];
const ANY_SOURCE = new Set(['*', 'internet', '0.0.0.0/0', 'any', '::/0']);

/** Subscription states the scanner still evaluates (Warned and PastDue subscriptions keep running resources). */
const LIVE_STATES = new Set(['Enabled', 'Warned', 'PastDue']);
const NO_SUBS = 'No subscriptions visible to the scanner identity. Assign Reader on the subscriptions in scope.';

/** Subscriptions in scope plus configured subscription IDs the scanner cannot see (or that are disabled). */
const subScope = (ctx: MsCtx) =>
  ctx.memo.get('subs', async () => {
    const all = (await armAll<any>(ctx, '/subscriptions?api-version=2022-12-01')).filter((s) => LIVE_STATES.has(s.state));
    const wanted = ctx.subscriptionIds.map((s) => s.toLowerCase());
    const visible = (wanted.length ? all.filter((s) => wanted.includes(s.subscriptionId.toLowerCase())) : all) as Sub[];
    const seen = new Set(visible.map((s) => s.subscriptionId.toLowerCase()));
    return { visible, invisible: wanted.filter((w) => !seen.has(w)) };
  });
const subs = async (ctx: MsCtx) => (await subScope(ctx)).visible;

/** Per check run: subscriptions that were denied and lists that were cut off. */
interface AzCtx extends MsCtx {
  skippedSubs: Set<string>;
  truncatedLists: Set<string>;
}

const deniedSub = (e: unknown) => e instanceof GraphError && (e.status === 403 || e.status === 401 || /AuthorizationFailed|InvalidAuthenticationToken/i.test(e.code));

/** Collect resources of a type across subscriptions; subscriptions that deny the listing are reported as skipped. */
async function listAcross(ctx: AzCtx, provider: string, apiVersion: string) {
  const res = await ctx.memo.get(`list:${provider}`, async () => {
    const ss = await subs(ctx);
    if (!ss.length) throw new CheckError(NO_SUBS);
    const skipped: string[] = [];
    let truncated = false;
    const out = await mapLimit(ss, 4, async (s) => {
      try {
        const items = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/${provider}?api-version=${apiVersion}`);
        truncated ||= items.truncated;
        return items.map((r) => ({ sub: s, r }));
      } catch (e) {
        if (!deniedSub(e)) throw e;
        skipped.push(s.displayName || s.subscriptionId);
        return [];
      }
    });
    return { items: out.flat(), skipped, truncated };
  });
  for (const s of res.skipped) ctx.skippedSubs.add(s);
  if (res.truncated) ctx.truncatedLists.add(provider);
  return res.items;
}

function portCovered(range: string, port: number) {
  if (range === '*') return true;
  const [a, b] = range.split('-').map(Number);
  return b === undefined ? a === port : a <= port && port <= b;
}

async function perSub<T>(ctx: AzCtx, fn: (s: Sub) => Promise<T>) {
  const ss = await subs(ctx);
  if (!ss.length) throw new CheckError(NO_SUBS);
  const out = await mapLimit(ss, 4, async (s): Promise<{ sub: Sub; value: T } | null> => {
    try {
      return { sub: s, value: await fn(s) };
    } catch (e) {
      if (!deniedSub(e)) throw e;
      ctx.skippedSubs.add(s.displayName || s.subscriptionId);
      return null;
    }
  });
  return out.filter((x): x is { sub: Sub; value: T } => x !== null);
}

const subRef = (s: Sub, detail?: string): ResourceRef => ({ id: s.subscriptionId, name: s.displayName, detail });

const rawChecks: Record<string, (ctx: AzCtx) => Promise<CheckOutcome>> = {
  async 'azure.defender-plans'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const p = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Security/pricings?api-version=2024-01-01`);
      return KEY_PLANS.filter((k) => p.find((x) => x.name === k)?.properties?.pricingTier !== 'Standard');
    });
    const none = res.filter((r) => r.value.length === KEY_PLANS.length);
    const partial = res.filter((r) => r.value.length > 0 && r.value.length < KEY_PLANS.length);
    const refs = [...none, ...partial].map((r) => subRef(r.sub, `not enabled: ${r.value.join(', ')}`));
    if (none.length) return fail(`${none.length} subscription(s) have no key Defender plans enabled.`, refs);
    return failIfAny(refs, (n) => `${n} subscription(s) miss some Defender plans.`, 'Key Defender for Cloud plans are enabled on all subscriptions.', 'warn');
  },

  async 'azure.security-contact'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const c = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Security/securityContacts?api-version=2020-01-01-preview`).catch((e) => {
        if (deniedSub(e)) throw e;
        return [];
      });
      return c.some((x) => x.properties?.email || x.properties?.emails);
    });
    return failIfAny(res.filter((r) => !r.value).map((r) => subRef(r.sub)), (n) => `${n} subscription(s) without a security contact.`, 'Security contacts are configured.', 'warn');
  },

  async 'azure.activity-log-export'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const d = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview`);
      return d.length > 0;
    });
    return failIfAny(res.filter((r) => !r.value).map((r) => subRef(r.sub)), (n) => `${n} subscription(s) do not export the activity log.`, 'Activity logs are exported on all subscriptions.');
  },

  async 'azure.storage-public'(ctx) {
    const accts = await listAcross(ctx, 'Microsoft.Storage/storageAccounts', '2023-05-01');
    if (!accts.length) return na('No storage accounts found.');
    return failIfAny(
      accts.filter((a) => a.r.properties?.allowBlobPublicAccess !== false).map((a) => ({ id: a.r.id, name: a.r.name, detail: a.sub.displayName })),
      (n) => `${n} of ${accts.length} storage accounts allow anonymous blob access.`,
      `All ${accts.length} storage accounts disallow anonymous blob access.`,
    );
  },

  async 'azure.storage-transport'(ctx) {
    const accts = await listAcross(ctx, 'Microsoft.Storage/storageAccounts', '2023-05-01');
    if (!accts.length) return na('No storage accounts found.');
    const bad = accts
      .map((a): ResourceRef | null => {
        const p: string[] = [];
        if (a.r.properties?.supportsHttpsTrafficOnly === false) p.push('HTTP allowed');
        if (['TLS1_0', 'TLS1_1'].includes(a.r.properties?.minimumTlsVersion)) p.push(`min ${a.r.properties.minimumTlsVersion}`);
        return p.length ? { id: a.r.id, name: a.r.name, detail: p.join(', ') } : null;
      })
      .filter((x): x is ResourceRef => x !== null);
    return failIfAny(bad, (n) => `${n} storage account(s) allow insecure transport.`, 'All storage accounts enforce HTTPS and TLS 1.2+.');
  },

  async 'azure.keyvault-protection'(ctx) {
    const vaults = await listAcross(ctx, 'Microsoft.KeyVault/vaults', '2023-07-01');
    if (!vaults.length) return na('No Key Vaults found.');
    return failIfAny(
      vaults.filter((v) => !v.r.properties?.enablePurgeProtection).map((v) => ({ id: v.r.id, name: v.r.name, detail: v.sub.displayName })),
      (n) => `${n} of ${vaults.length} Key Vaults without purge protection.`,
      `All ${vaults.length} Key Vaults have purge protection.`,
      'warn',
    );
  },

  async 'azure.nsg-admin-ports'(ctx) {
    const nsgs = await listAcross(ctx, 'Microsoft.Network/networkSecurityGroups', '2024-05-01');
    if (!nsgs.length) return na('No network security groups found.');
    const bad: ResourceRef[] = [];
    for (const { r } of nsgs) {
      for (const rule of r.properties?.securityRules ?? []) {
        const p = rule.properties ?? {};
        if (p.direction !== 'Inbound' || p.access !== 'Allow') continue;
        const sources = [p.sourceAddressPrefix, ...(p.sourceAddressPrefixes ?? [])].filter(Boolean).map((x: string) => x.toLowerCase());
        if (!sources.some((s) => ANY_SOURCE.has(s))) continue;
        const ranges: string[] = [p.destinationPortRange, ...(p.destinationPortRanges ?? [])].filter(Boolean);
        const ports = MGMT_PORTS.filter((port) => ranges.some((rg) => portCovered(rg, port)));
        if (ports.length) bad.push({ id: rule.id, name: `${r.name}/${rule.name}`, detail: `ports ${ports.join(', ')} from any` });
      }
    }
    return failIfAny(bad, (n) => `${n} NSG rule(s) open RDP/SSH to the internet.`, 'No NSG rules open RDP/SSH to the internet.');
  },

  async 'azure.sql-public'(ctx) {
    const servers = await listAcross(ctx, 'Microsoft.Sql/servers', '2023-08-01');
    if (!servers.length) return na('No Azure SQL servers found.');
    const bad: ResourceRef[] = [];
    let azureServices = 0;
    const denied: string[] = [];
    await mapLimit(servers, 4, async ({ r }) => {
      if (r.properties?.publicNetworkAccess === 'Disabled') return;
      const rules = await armAll<any>(ctx, `${r.id}/firewallRules?api-version=2023-08-01`).catch((e) => {
        if (!deniedSub(e)) throw e;
        denied.push(r.name);
        return [];
      });
      for (const fr of rules) {
        const { startIpAddress: s, endIpAddress: e } = fr.properties ?? {};
        if (s === '0.0.0.0' && e === '255.255.255.255') bad.push({ id: r.id, name: r.name, detail: `rule ${fr.name} allows all IPs` });
        else if (s === '0.0.0.0' && e === '0.0.0.0') azureServices++;
      }
    });
    const cov = { evaluated: servers.length - denied.length, total: servers.length, skipped: denied, unit: 'SQL servers' };
    if (bad.length) return applyCoverage(fail(`${bad.length} SQL server firewall rule(s) allow the whole internet.`, bad), cov);
    if (azureServices) return applyCoverage(warn(`${azureServices} server(s) allow access from all Azure services (including other tenants).`), cov);
    return applyCoverage(pass(`None of ${servers.length - denied.length} SQL servers are open to all IPs.`), cov);
  },

  async 'azure.subscription-owners'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const ra = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`);
      return ra.filter((a) => String(a.properties?.roleDefinitionId).toLowerCase().endsWith(OWNER_ROLE)).length;
    });
    return failIfAny(
      res.filter((r) => r.value > 3).map((r) => subRef(r.sub, `${r.value} Owner assignments`)),
      (n) => `${n} subscription(s) have more than 3 Owner assignments.`,
      'All subscriptions have 3 or fewer Owner assignments.',
      'warn',
    );
  },
};

/** Every Azure check reports subscriptions it could not evaluate (configured but invisible, or denied) and cut-off lists. */
const checks: Record<string, (ctx: MsCtx) => Promise<CheckOutcome>> = Object.fromEntries(
  Object.entries(rawChecks).map(([id, fn]) => [
    id,
    async (base: MsCtx) => {
      const ctx: AzCtx = { ...base, skippedSubs: new Set(), truncatedLists: new Set() };
      const outcome = await fn(ctx);
      const { visible, invisible } = await subScope(ctx);
      const skipped = [...invisible.map((id) => `${id} (not visible or disabled)`), ...[...ctx.skippedSubs].map((n) => `${n} (access denied)`)];
      let o = applyCoverage(outcome, {
        evaluated: visible.length - ctx.skippedSubs.size,
        total: visible.length + invisible.length,
        skipped,
        unit: 'subscriptions',
        hint: 'Assign Reader and Security Reader on the subscriptions in scope.',
      });
      if (ctx.truncatedLists.size) o = applyTruncation(o, true, 20000, `items per subscription (${[...ctx.truncatedLists].join(', ')})`);
      return o;
    },
  ]),
);

export const azureModule: ProviderModule<MsCtx> = {
  async connect(config, secret, env, memo) {
    const app = msAppCredentials(config, secret, env);
    const token = await msToken(config.tenantId, app.clientId, app.clientSecret, 'https://management.azure.com/.default');
    return { tenantId: config.tenantId, token, memo, subscriptionIds: config.subscriptionIds ?? [] };
  },
  async identity(ctx) {
    const { visible: ss, invisible } = await subScope(ctx);
    if (invisible.length) {
      return {
        ok: false,
        message: `Configured subscription(s) not visible to the scanner identity or not active: ${invisible.join(', ')}. Assign Reader and Security Reader on them, or remove them from the system.`,
        details: { invisible, subscriptions: ss.map((s) => ({ id: s.subscriptionId, name: s.displayName })) },
      };
    }
    if (!ss.length) return { ok: false, message: 'Authenticated, but no subscriptions are visible. Assign Reader and Security Reader on the subscriptions in scope.' };
    return { ok: true, message: `Connected: ${ss.length} subscription(s) visible (${ss.map((s) => s.displayName).slice(0, 5).join(', ')}${ss.length > 5 ? ', ...' : ''}).`, details: { subscriptions: ss.map((s) => ({ id: s.subscriptionId, name: s.displayName })) } };
  },
  checks,
};
