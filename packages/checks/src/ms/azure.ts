import type { CheckOutcome, ResourceRef } from '@qs/shared';
import type { ProviderModule } from '../types.js';
import { CheckError, fail, failIfAny, mapLimit, na, pass, warn } from '../util.js';
import { armAll, msAppCredentials, msToken, type MsCtx } from './client.js';

interface Sub {
  subscriptionId: string;
  displayName: string;
}

const OWNER_ROLE = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
const KEY_PLANS = ['VirtualMachines', 'StorageAccounts', 'KeyVaults', 'Arm', 'SqlServers'];
const MGMT_PORTS = [22, 3389];
const ANY_SOURCE = new Set(['*', 'internet', '0.0.0.0/0', 'any', '::/0']);

const subs = (ctx: MsCtx) =>
  ctx.memo.get('subs', async () => {
    const all = (await armAll<any>(ctx, '/subscriptions?api-version=2022-12-01')).filter((s) => s.state === 'Enabled');
    const wanted = ctx.subscriptionIds.map((s) => s.toLowerCase());
    return (wanted.length ? all.filter((s) => wanted.includes(s.subscriptionId.toLowerCase())) : all) as Sub[];
  });

/** Collect resources of a type across subscriptions. */
async function listAcross(ctx: MsCtx, provider: string, apiVersion: string) {
  return ctx.memo.get(`list:${provider}`, async () => {
    const out = await mapLimit(await subs(ctx), 4, async (s) =>
      (await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/${provider}?api-version=${apiVersion}`)).map((r) => ({ sub: s, r })),
    );
    return out.flat();
  });
}

function portCovered(range: string, port: number) {
  if (range === '*') return true;
  const [a, b] = range.split('-').map(Number);
  return b === undefined ? a === port : a <= port && port <= b;
}

async function perSub<T>(ctx: MsCtx, fn: (s: Sub) => Promise<T>) {
  const ss = await subs(ctx);
  if (!ss.length) throw new CheckError('No subscriptions visible to the scanner identity. Assign Reader on the subscriptions in scope.');
  return mapLimit(ss, 4, async (s) => ({ sub: s, value: await fn(s) }));
}

const subRef = (s: Sub, detail?: string): ResourceRef => ({ id: s.subscriptionId, name: s.displayName, detail });

const checks: Record<string, (ctx: MsCtx) => Promise<CheckOutcome>> = {
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
      const c = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Security/securityContacts?api-version=2020-01-01-preview`).catch(() => []);
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
    await mapLimit(servers, 4, async ({ r }) => {
      if (r.properties?.publicNetworkAccess === 'Disabled') return;
      const rules = await armAll<any>(ctx, `${r.id}/firewallRules?api-version=2023-08-01`);
      for (const fr of rules) {
        const { startIpAddress: s, endIpAddress: e } = fr.properties ?? {};
        if (s === '0.0.0.0' && e === '255.255.255.255') bad.push({ id: r.id, name: r.name, detail: `rule ${fr.name} allows all IPs` });
        else if (s === '0.0.0.0' && e === '0.0.0.0') azureServices++;
      }
    });
    if (bad.length) return fail(`${bad.length} SQL server firewall rule(s) allow the whole internet.`, bad);
    if (azureServices) return warn(`${azureServices} server(s) allow access from all Azure services (including other tenants).`);
    return pass(`None of ${servers.length} SQL servers are open to all IPs.`);
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

export const azureModule: ProviderModule<MsCtx> = {
  async connect(config, secret, env, memo) {
    const app = msAppCredentials(config, secret, env);
    const token = await msToken(config.tenantId, app.clientId, app.clientSecret, 'https://management.azure.com/.default');
    return { tenantId: config.tenantId, token, memo, subscriptionIds: config.subscriptionIds ?? [] };
  },
  async identity(ctx) {
    const ss = await subs(ctx);
    if (!ss.length) return { ok: false, message: 'Authenticated, but no subscriptions are visible. Assign Reader and Security Reader on the subscriptions in scope.' };
    return { ok: true, message: `Connected: ${ss.length} subscription(s) visible (${ss.map((s) => s.displayName).slice(0, 5).join(', ')}${ss.length > 5 ? ', ...' : ''}).`, details: { subscriptions: ss.map((s) => ({ id: s.subscriptionId, name: s.displayName })) } };
  },
  checks,
};

