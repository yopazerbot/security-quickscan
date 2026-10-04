import type { CheckOutcome, ResourceRef } from '@qs/shared';
import { azurePortalUrl, azureSubscriptionId } from '../links.js';
import type { ProviderModule } from '../types.js';
import { applyCoverage, applyTruncation, CheckError, fail, failIfAny, mapLimit, na, pass, warn } from '../util.js';
import { arm, armAll, GraphError, msAppCredentials, msToken, type MsCtx } from './client.js';

interface Sub {
  subscriptionId: string;
  displayName: string;
}

const OWNER_ROLE = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
const USER_ACCESS_ADMIN_ROLE = '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9';

/** Defender plans always expected (subscription-level), and plans expected when the matching workload is deployed. */
const ALWAYS_PLANS = ['Arm', 'CloudPosture'];
const WORKLOAD_PLANS: Record<string, string[]> = {
  VirtualMachines: ['microsoft.compute/virtualmachines', 'microsoft.compute/virtualmachinescalesets', 'microsoft.hybridcompute/machines'],
  StorageAccounts: ['microsoft.storage/storageaccounts'],
  KeyVaults: ['microsoft.keyvault/vaults'],
  SqlServers: ['microsoft.sql/servers', 'microsoft.sql/managedinstances'],
  AppServices: ['microsoft.web/sites'],
  Containers: ['microsoft.containerservice/managedclusters', 'microsoft.containerregistry/registries'],
  OpenSourceRelationalDatabases: [
    'microsoft.dbforpostgresql/servers',
    'microsoft.dbforpostgresql/flexibleservers',
    'microsoft.dbformysql/servers',
    'microsoft.dbformysql/flexibleservers',
    'microsoft.dbformariadb/servers',
  ],
  CosmosDbs: ['microsoft.documentdb/databaseaccounts'],
};

/** Same administrative and database ports as the AWS security group check. */
export const ADMIN_PORTS = [21, 22, 23, 445, 1433, 1521, 3306, 3389, 5432, 5984, 5985, 5986, 6379, 9200, 27017];
const ANY_SOURCE = new Set(['*', 'internet', '0.0.0.0/0', 'any', '::/0']);
const ACTIVITY_LOG_CATEGORIES = ['Administrative', 'Alert', 'Policy', 'Security'];

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

const subRef = (s: Sub, detail?: string): ResourceRef => {
  const id = azureSubscriptionId(s.subscriptionId);
  return { id, name: s.displayName, detail, type: 'Subscription', account: s.displayName || s.subscriptionId, url: azurePortalUrl(id) };
};

const armRef = (r: any, sub: Sub, type: string, detail?: string, name?: string): ResourceRef => ({
  id: r.id,
  name: name ?? r.name,
  detail,
  type,
  region: r.location,
  account: sub.displayName || sub.subscriptionId,
  url: azurePortalUrl(r.id),
});

/** Resource types deployed in a subscription (lower-case), for workload-aware checks. */
const resourceTypes = (ctx: MsCtx, s: Sub) =>
  ctx.memo.get(`types:${s.subscriptionId}`, async () => {
    const items = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/resources?api-version=2021-04-01`);
    return { types: new Set(items.map((r) => String(r.type).toLowerCase())), truncated: items.truncated };
  });

// ---------------------------------------------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------------------------------------------

function portCovered(range: string, port: number) {
  const r = String(range).trim();
  if (r === '*') return true;
  const [a, b] = r.split('-').map(Number);
  return b === undefined ? a === port : a <= port && port <= b;
}

/** Source prefixes that mean "the internet": any, the Internet tag, or IPv4 prefixes of /8 or wider. */
function broadSource(src: string): boolean {
  const s = src.toLowerCase();
  if (ANY_SOURCE.has(s)) return true;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(s);
  if (m) return Number(m[2]) <= 8;
  const v6 = /^[0-9a-f:]+\/(\d{1,3})$/.exec(s);
  return v6 ? Number(v6[1]) <= 8 : false;
}
const anySource = (src: string) => ANY_SOURCE.has(src.toLowerCase());

const ruleSources = (p: any): string[] => [p.sourceAddressPrefix, ...(p.sourceAddressPrefixes ?? [])].filter(Boolean).map(String);
const rulePorts = (p: any): string[] => [p.destinationPortRange, ...(p.destinationPortRanges ?? [])].filter(Boolean).map(String);
const tcp = (p: any) => ['*', 'tcp', 'any'].includes(String(p.protocol ?? '*').toLowerCase());

/**
 * Admin ports reachable from the internet in an NSG, evaluated per port in priority order:
 * the first inbound rule matching the port and an internet source decides (an overriding Deny protects the port).
 */
export function openAdminPorts(nsg: any): { rule: any; ports: number[]; sources: string[] }[] {
  const rules = [...(nsg.properties?.securityRules ?? []), ...(nsg.properties?.defaultSecurityRules ?? [])]
    .filter((r: any) => r.properties?.direction === 'Inbound' && tcp(r.properties))
    .sort((a: any, b: any) => Number(a.properties?.priority ?? 65535) - Number(b.properties?.priority ?? 65535));
  const hits = new Map<string, { rule: any; ports: number[]; sources: string[] }>();
  for (const port of ADMIN_PORTS) {
    for (const r of rules) {
      const p = r.properties;
      if (!rulePorts(p).some((rg) => portCovered(rg, port))) continue;
      const sources = ruleSources(p);
      if (p.access === 'Deny') {
        if (sources.some(anySource)) break; // internet traffic to this port is denied before any lower-priority allow
        continue;
      }
      const broad = sources.filter(broadSource);
      if (!broad.length) continue;
      const key = r.id ?? r.name;
      const h = hits.get(key) ?? { rule: r, ports: [], sources: broad };
      h.ports.push(port);
      hits.set(key, h);
      break;
    }
  }
  return [...hits.values()];
}

const ipNum = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const VALID_IP = /^\d{1,3}(\.\d{1,3}){3}$/;

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

const rawChecks: Record<string, (ctx: AzCtx) => Promise<CheckOutcome>> = {
  async 'azure.defender-plans'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const [pricings, deployed] = await Promise.all([
        armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Security/pricings?api-version=2024-01-01`),
        resourceTypes(ctx, s),
      ]);
      const workloads = Object.entries(WORKLOAD_PLANS)
        .filter(([, types]) => types.some((t) => deployed.types.has(t)))
        .map(([plan]) => plan);
      const required = [...ALWAYS_PLANS, ...workloads];
      const missing = required.filter((k) => pricings.find((x) => x.name === k)?.properties?.pricingTier !== 'Standard');
      return { required, missing };
    });
    const none = res.filter((r) => r.value.missing.length === r.value.required.length);
    const partial = res.filter((r) => r.value.missing.length > 0 && r.value.missing.length < r.value.required.length);
    const refs = [...none, ...partial].map((r) => subRef(r.sub, `not enabled: ${r.value.missing.join(', ')} (required: ${r.value.required.join(', ')})`));
    const evidence = { required: Object.fromEntries(res.map((r) => [r.sub.displayName || r.sub.subscriptionId, r.value.required])) };
    if (none.length) return fail(`${none.length} subscription(s) have none of the Defender plans their workloads need.`, refs, evidence);
    if (partial.length) return warn(`${partial.length} subscription(s) miss Defender plans for deployed workloads.`, refs, evidence);
    return pass('Defender for Cloud plans are enabled for every deployed workload type (plus Resource Manager and CSPM).', { evidence });
  },

  async 'azure.security-contact'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const c = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Security/securityContacts?api-version=2020-01-01-preview`).catch((e) => {
        if (deniedSub(e)) throw e;
        return [];
      });
      return c.some((x) => x.properties?.email || x.properties?.emails);
    });
    return failIfAny(res.filter((r) => !r.value).map((r) => subRef(r.sub, 'no security contact e-mail')), (n) => `${n} subscription(s) without a security contact.`, 'Security contacts are configured.', 'warn');
  },

  async 'azure.activity-log-export'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const d = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview`);
      const exported = new Set<string>();
      for (const setting of d) {
        const p = setting.properties ?? {};
        if (!(p.workspaceId || p.storageAccountId || p.eventHubAuthorizationRuleId || p.marketplacePartnerId)) continue;
        for (const l of p.logs ?? []) {
          if (!l.enabled) continue;
          if (l.categoryGroup === 'allLogs') ACTIVITY_LOG_CATEGORIES.forEach((c) => exported.add(c));
          if (l.category) exported.add(l.category);
        }
      }
      return { settings: d.length, missing: ACTIVITY_LOG_CATEGORIES.filter((c) => !exported.has(c)) };
    });
    const none = res.filter((r) => r.value.missing.length === ACTIVITY_LOG_CATEGORIES.length);
    const partial = res.filter((r) => r.value.missing.length && r.value.missing.length < ACTIVITY_LOG_CATEGORIES.length);
    const refs = [
      ...none.map((r) => subRef(r.sub, r.value.settings ? 'diagnostic setting exports none of the required categories' : 'no diagnostic setting')),
      ...partial.map((r) => subRef(r.sub, `missing categories: ${r.value.missing.join(', ')}`)),
    ];
    if (!refs.length) return pass(`Activity logs (${ACTIVITY_LOG_CATEGORIES.join(', ')}) are exported on all subscriptions.`);
    const parts = [none.length && `${none.length} subscription(s) do not export the activity log`, partial.length && `${partial.length} subscription(s) miss required categories`].filter(Boolean);
    return fail(`${parts.join('; ')} (required: ${ACTIVITY_LOG_CATEGORIES.join(', ')}).`, refs);
  },

  async 'azure.storage-public'(ctx) {
    const accts = await listAcross(ctx, 'Microsoft.Storage/storageAccounts', '2023-05-01');
    if (!accts.length) return na('No storage accounts found.');
    return failIfAny(
      accts.filter((a) => a.r.properties?.allowBlobPublicAccess !== false).map((a) => armRef(a.r, a.sub, 'Storage account', 'anonymous blob access allowed')),
      (n) => `${n} of ${accts.length} storage accounts allow anonymous blob access.`,
      `All ${accts.length} storage accounts disallow anonymous blob access.`,
    );
  },

  async 'azure.storage-transport'(ctx) {
    const accts = await listAcross(ctx, 'Microsoft.Storage/storageAccounts', '2023-05-01');
    if (!accts.length) return na('No storage accounts found.');
    const bad = accts
      .map((a): ResourceRef | null => {
        const props = a.r.properties ?? {};
        const p: string[] = [];
        if (props.supportsHttpsTrafficOnly !== true) p.push(props.supportsHttpsTrafficOnly === false ? 'HTTP allowed' : 'secure transfer not explicitly required');
        if (!['TLS1_2', 'TLS1_3'].includes(props.minimumTlsVersion)) p.push(props.minimumTlsVersion ? `minimum ${props.minimumTlsVersion}` : 'minimum TLS version not set');
        return p.length ? armRef(a.r, a.sub, 'Storage account', p.join(', ')) : null;
      })
      .filter((x): x is ResourceRef => x !== null);
    return failIfAny(bad, (n) => `${n} of ${accts.length} storage account(s) do not enforce HTTPS and TLS 1.2+.`, `All ${accts.length} storage accounts enforce HTTPS and TLS 1.2+.`);
  },

  async 'azure.storage-network'(ctx) {
    const accts = await listAcross(ctx, 'Microsoft.Storage/storageAccounts', '2023-05-01');
    if (!accts.length) return na('No storage accounts found.');
    const denied: string[] = [];
    let open = 0;
    const bad: ResourceRef[] = [];
    await mapLimit(accts, 4, async ({ r, sub }) => {
      const props = r.properties ?? {};
      const p: string[] = [];
      const publicAccess = props.publicNetworkAccess !== 'Disabled';
      if (publicAccess && (props.networkAcls?.defaultAction ?? 'Allow') === 'Allow') {
        p.push('reachable from all networks');
        open++;
      }
      if (props.allowSharedKeyAccess !== false) p.push('shared key access allowed');
      try {
        const blob = await arm<any>(ctx, `${r.id}/blobServices/default?api-version=2023-05-01`);
        if (!blob?.properties?.deleteRetentionPolicy?.enabled) p.push('blob soft delete off');
      } catch (e) {
        if (!deniedSub(e)) throw e;
        denied.push(r.name);
      }
      if (p.length) bad.push(armRef(r, sub, 'Storage account', p.join(', ')));
    });
    const cov = { evaluated: accts.length - denied.length, total: accts.length, skipped: denied.map((n) => `${n} (blob service settings denied)`), unit: 'storage accounts' };
    let o: CheckOutcome;
    if (open) o = fail(`${open} of ${accts.length} storage account(s) are reachable from all networks${bad.length > open ? `; ${bad.length - open} more allow shared keys or lack soft delete` : ''}.`, bad);
    else if (bad.length) o = warn(`${bad.length} of ${accts.length} storage account(s) allow shared key access or lack blob soft delete.`, bad);
    else o = pass(`All ${accts.length} storage accounts restrict network access, disable shared keys and keep blob soft delete on.`);
    return applyCoverage(o, cov);
  },

  async 'azure.keyvault-protection'(ctx) {
    const vaults = await listAcross(ctx, 'Microsoft.KeyVault/vaults', '2023-07-01');
    if (!vaults.length) return na('No Key Vaults found.');
    let severe = 0;
    const bad = vaults
      .map(({ r, sub }) => {
        const p = r.properties ?? {};
        const problems: string[] = [];
        if (p.enableSoftDelete === false) problems.push('soft delete off');
        if (!p.enablePurgeProtection) problems.push('no purge protection');
        if (problems.length) severe++;
        if (p.enableRbacAuthorization !== true) problems.push('access policies instead of RBAC');
        return problems.length ? armRef(r, sub, 'Key Vault', problems.join(', ')) : null;
      })
      .filter((x): x is ResourceRef => x !== null);
    if (severe) return fail(`${severe} of ${vaults.length} Key Vaults lack soft delete or purge protection${bad.length > severe ? `; ${bad.length - severe} more use access policies instead of RBAC` : ''}.`, bad);
    return failIfAny(bad, (n) => `${n} of ${vaults.length} Key Vaults use access policies instead of RBAC authorization.`, `All ${vaults.length} Key Vaults have soft delete, purge protection and RBAC authorization.`, 'warn');
  },

  async 'azure.nsg-admin-ports'(ctx) {
    const nsgs = await listAcross(ctx, 'Microsoft.Network/networkSecurityGroups', '2024-05-01');
    if (!nsgs.length) return na('No network security groups found.');
    const bad = new Map<string, ResourceRef>();
    for (const { r, sub } of nsgs) {
      for (const hit of openAdminPorts(r)) {
        const id = hit.rule.id ?? `${r.id}/securityRules/${hit.rule.name}`;
        bad.set(id, {
          id,
          name: `${r.name}/${hit.rule.name}`,
          detail: `ports ${hit.ports.join(', ')} from ${hit.sources.join(', ')} (priority ${hit.rule.properties?.priority})`,
          type: 'NSG rule',
          region: r.location,
          account: sub.displayName || sub.subscriptionId,
          url: azurePortalUrl(r.id),
        });
      }
    }
    return failIfAny([...bad.values()], (n) => `${n} NSG rule(s) expose administrative or database ports to the internet or very broad ranges.`, `None of ${nsgs.length} NSGs expose administrative or database ports to the internet.`);
  },

  async 'azure.sql-public'(ctx) {
    const servers = await listAcross(ctx, 'Microsoft.Sql/servers', '2023-08-01');
    if (!servers.length) return na('No Azure SQL servers found.');
    const unique = [...new Map(servers.map((s) => [String(s.r.id).toLowerCase(), s])).values()];
    const bad: ResourceRef[] = [];
    const azureServices: ResourceRef[] = [];
    const denied: string[] = [];
    await mapLimit(unique, 4, async ({ r, sub }) => {
      if (r.properties?.publicNetworkAccess === 'Disabled') return;
      const rules = await armAll<any>(ctx, `${r.id}/firewallRules?api-version=2023-08-01`).catch((e) => {
        if (!deniedSub(e)) throw e;
        denied.push(r.name);
        return null;
      });
      if (!rules) return;
      const open: string[] = [];
      let allAzure = false;
      for (const fr of rules) {
        const { startIpAddress: s, endIpAddress: e } = fr.properties ?? {};
        if (!VALID_IP.test(String(s)) || !VALID_IP.test(String(e))) continue;
        if (s === '0.0.0.0' && e === '0.0.0.0') {
          allAzure = true;
          continue;
        }
        const size = ipNum(e) - ipNum(s) + 1;
        if (size >= 2 ** 24) open.push(`${fr.name} (${s}-${e})`);
      }
      if (open.length) bad.push(armRef(r, sub, 'SQL server', `firewall rules open to the internet or very broad ranges: ${open.join(', ')}`));
      else if (allAzure) azureServices.push(armRef(r, sub, 'SQL server', 'allows access from all Azure services'));
    });
    const evaluated = unique.length - denied.length;
    const cov = { evaluated, total: unique.length, skipped: denied, unit: 'SQL servers' };
    if (bad.length) return applyCoverage(fail(`${bad.length} of ${evaluated} SQL server(s) have firewall rules open to the internet or very broad IP ranges.`, [...bad, ...azureServices]), cov);
    if (azureServices.length) return applyCoverage(warn(`${azureServices.length} of ${evaluated} SQL server(s) allow access from all Azure services (including other tenants).`, azureServices), cov);
    return applyCoverage(pass(`None of the ${evaluated} SQL servers are open to the internet or all Azure services.`), cov);
  },

  async 'azure.sql-auditing-tde'(ctx) {
    const servers = await listAcross(ctx, 'Microsoft.Sql/servers', '2023-08-01');
    if (!servers.length) return na('No Azure SQL servers found.');
    const unique = [...new Map(servers.map((s) => [String(s.r.id).toLowerCase(), s])).values()];
    const severe: ResourceRef[] = [];
    const minor: ResourceRef[] = [];
    const denied: string[] = [];
    await mapLimit(unique, 3, async ({ r, sub }) => {
      try {
        const problems: string[] = [];
        const audit = await arm<any>(ctx, `${r.id}/auditingSettings/default?api-version=2021-11-01`);
        if (audit?.properties?.state !== 'Enabled') problems.push('auditing off');
        const dbs = (await armAll<any>(ctx, `${r.id}/databases?api-version=2023-08-01`, 200)).filter((d) => d.name !== 'master');
        const noTde: string[] = [];
        await mapLimit(dbs.slice(0, 50), 4, async (d) => {
          const tde = await arm<any>(ctx, `${d.id}/transparentDataEncryption/current?api-version=2023-08-01`);
          if (tde?.properties?.state !== 'Enabled') noTde.push(d.name);
        });
        if (noTde.length) problems.push(`TDE off on ${noTde.join(', ')}`);
        let entraAdmin = Boolean(r.properties?.administrators?.login);
        if (!entraAdmin) {
          const admins = await armAll<any>(ctx, `${r.id}/administrators?api-version=2023-08-01`).catch((e) => {
            if (deniedSub(e)) throw e;
            return [];
          });
          entraAdmin = admins.some((a) => a.properties?.login);
        }
        if (problems.length) severe.push(armRef(r, sub, 'SQL server', [...problems, !entraAdmin && 'no Entra admin'].filter(Boolean).join(', ')));
        else if (!entraAdmin) minor.push(armRef(r, sub, 'SQL server', 'no Microsoft Entra admin configured'));
      } catch (e) {
        if (!deniedSub(e)) throw e;
        denied.push(r.name);
      }
    });
    const evaluated = unique.length - denied.length;
    const cov = { evaluated, total: unique.length, skipped: denied, unit: 'SQL servers' };
    if (severe.length) return applyCoverage(fail(`${severe.length} of ${evaluated} SQL server(s) lack auditing or transparent data encryption.`, [...severe, ...minor]), cov);
    if (minor.length) return applyCoverage(warn(`${minor.length} of ${evaluated} SQL server(s) have no Microsoft Entra admin configured.`, minor), cov);
    return applyCoverage(pass(`All ${evaluated} SQL servers have auditing, TDE on every database and a Microsoft Entra admin.`), cov);
  },

  async 'azure.defender-recommendations'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const items = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Security/assessments?api-version=2021-06-01&$expand=metadata`);
      if (items.truncated) ctx.truncatedLists.add('Microsoft.Security/assessments');
      return items.filter((a) => a.properties?.status?.code === 'Unhealthy' && String(a.properties?.metadata?.severity ?? '').toLowerCase() === 'high');
    });
    const all = res.flatMap((r) => r.value.map((a) => ({ a, sub: r.sub })));
    const byRec = new Map<string, number>();
    for (const { a } of all) byRec.set(a.properties?.displayName ?? a.name, (byRec.get(a.properties?.displayName ?? a.name) ?? 0) + 1);
    const refs = all.slice(0, 200).map(({ a, sub }) => {
      const target = a.properties?.resourceDetails?.Id ?? a.properties?.resourceDetails?.id ?? a.id;
      return {
        id: target,
        name: String(target).split('/').pop() || target,
        detail: a.properties?.displayName ?? a.name,
        type: 'Defender recommendation',
        account: sub.displayName || sub.subscriptionId,
        url: azurePortalUrl(target),
      } satisfies ResourceRef;
    });
    const evidence = { highSeverityUnhealthy: all.length, byRecommendation: Object.fromEntries([...byRec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) };
    if (!all.length) return pass('No unhealthy high-severity Defender for Cloud recommendations.', { evidence });
    return fail(`${all.length} unhealthy high-severity Defender for Cloud recommendation(s) across ${byRec.size} recommendation type(s).`, refs, evidence);
  },

  async 'azure.backup-vaults'(ctx) {
    const [rsv, bv] = await Promise.all([
      listAcross(ctx, 'Microsoft.RecoveryServices/vaults', '2024-04-01'),
      listAcross(ctx, 'Microsoft.DataProtection/backupVaults', '2024-04-01'),
    ]);
    const vaults = [...rsv.map((v) => ({ ...v, kind: 'Recovery Services vault' })), ...bv.map((v) => ({ ...v, kind: 'Backup vault' }))];
    if (!vaults.length) return na('No Recovery Services or Backup vaults found.');
    let severe = 0;
    const bad: ResourceRef[] = [];
    for (const { r, sub, kind } of vaults) {
      const sec = r.properties?.securitySettings ?? {};
      const soft = String(sec.softDeleteSettings?.softDeleteState ?? sec.softDeleteSettings?.state ?? '').toLowerCase();
      const immut = String(sec.immutabilitySettings?.state ?? 'Disabled').toLowerCase();
      const problems: string[] = [];
      if (soft === 'disabled' || soft === 'off') {
        problems.push('soft delete off');
        severe++;
      }
      if (immut === 'disabled' || immut === '') problems.push('immutability off');
      if (problems.length) bad.push(armRef(r, sub, kind, problems.join(', ')));
    }
    if (severe) return fail(`${severe} of ${vaults.length} backup vault(s) have soft delete disabled.`, bad);
    return failIfAny(bad, (n) => `${n} of ${vaults.length} backup vault(s) do not have immutability enabled.`, `All ${vaults.length} backup vaults have soft delete and immutability enabled.`, 'warn');
  },

  async 'azure.subscription-owners'(ctx) {
    const res = await perSub(ctx, async (s) => {
      const ra = await armAll<any>(ctx, `/subscriptions/${s.subscriptionId}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`);
      const role = (a: any) => String(a.properties?.roleDefinitionId ?? '').toLowerCase();
      const owners = new Map<string, string>();
      const uaa = new Map<string, string>();
      for (const a of ra) {
        const pid = a.properties?.principalId;
        if (!pid) continue;
        if (role(a).endsWith(OWNER_ROLE)) owners.set(pid, a.properties?.principalType ?? 'Unknown');
        else if (role(a).endsWith(USER_ACCESS_ADMIN_ROLE)) uaa.set(pid, a.properties?.principalType ?? 'Unknown');
      }
      for (const k of owners.keys()) uaa.delete(k);
      return { owners, uaa };
    });
    const describe = (m: Map<string, string>) => {
      const groups = [...m.values()].filter((t) => t === 'Group').length;
      return `${m.size}${groups ? ` (${groups} group${groups > 1 ? 's' : ''})` : ''}`;
    };
    const refs: ResourceRef[] = [];
    let few = 0;
    let many = 0;
    for (const { sub, value } of res) {
      const total = value.owners.size + value.uaa.size;
      const low = value.owners.size < 2;
      const high = total > 3;
      if (!low && !high) continue;
      if (low) few++;
      if (high) many++;
      const detail = `${describe(value.owners)} Owner(s), ${describe(value.uaa)} User Access Administrator(s)${low ? ': fewer than 2 owners' : ''}${high ? ': more than 3 privileged principals' : ''}`;
      refs.push(subRef(sub, detail));
      for (const [pid, type] of [...value.owners, ...value.uaa]) {
        refs.push({ id: pid, name: `${pid} (${type})`, detail: `${value.owners.has(pid) ? 'Owner' : 'User Access Administrator'}${type === 'Group' ? ', group: members inherit the role' : ''}`, type: type === 'Group' ? 'Group' : type === 'ServicePrincipal' ? 'Service principal' : 'User', account: sub.displayName || sub.subscriptionId });
      }
    }
    const evidence = Object.fromEntries(res.map((r) => [r.sub.displayName || r.sub.subscriptionId, { owners: r.value.owners.size, userAccessAdministrators: r.value.uaa.size, groups: [...r.value.owners.values(), ...r.value.uaa.values()].filter((t) => t === 'Group').length }]));
    if (!refs.length) return pass('All subscriptions have 2 or 3 Owners and no more than 3 Owner or User Access Administrator principals.', { evidence });
    const parts = [many && `${many} subscription(s) have more than 3 Owner or User Access Administrator principals`, few && `${few} subscription(s) have fewer than 2 Owners`].filter(Boolean);
    return warn(`${parts.join('; ')}.`, refs, evidence);
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
