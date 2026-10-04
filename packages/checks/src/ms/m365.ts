import { Resolver } from 'node:dns/promises';

const dns = new Resolver({ timeout: 3000, tries: 2 });
import type { CheckOutcome, ResourceRef } from '@qs/shared';
import { entraPageUrl, entraUrl } from '../links.js';
import type { ProviderModule } from '../types.js';
import { applyCoverage, applyTruncation, CheckError, fail, failIfAny, mapLimit, na, NotApplicable, pass, warn } from '../util.js';
import { blocks, builtIn, caOutcome, describeExclusions, evaluateCa, exclusionRefs, hasMfaGrant, isBreakGlassOnly, nearMisses, orBypass, policyRef, type CaEvaluation, type CaMatch, type CaPolicy } from './ca.js';
import { graph, graphAll, GraphError, msAppCredentials, msToken, type MsCtx } from './client.js';
import { CIS_ADMIN_ROLES, ROLE, roleName, TIER0_ROLES } from './roles.js';

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

const MAX_MAIL_DOMAINS = 50;
const DMARC_POLICIES = new Set(['none', 'quarantine', 'reject']);
/** DNS answers that mean "no such record"; anything else (timeouts, SERVFAIL, refused) means the record could not be checked. */
const DNS_MISSING = new Set(['ENODATA', 'ENOTFOUND']);
const SPF_LOOKUP_LIMIT = 10;
/** Two-label public suffixes, so the organisational domain of mail.contoso.co.uk is contoso.co.uk. */
const MULTI_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'co.jp', 'com.mx', 'com.tr', 'com.cn', 'co.in', 'com.sg', 'com.hk', 'co.kr']);

const GLOBAL_ADMIN = ROLE.globalAdmin;
const PHISHING_RESISTANT_STRENGTH = '00000000-0000-0000-0000-000000000004';
const PHISHING_RESISTANT_METHODS = new Set(['fido2', 'windowsHelloForBusiness', 'x509CertificateMultiFactor']);
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

/** Graph permissions that allow taking over the tenant: always a fail. */
const TIER0_PERMISSIONS = new Set(['RoleManagement.ReadWrite.Directory', 'AppRoleAssignment.ReadWrite.All', 'Application.ReadWrite.All', 'Directory.ReadWrite.All']);
/** Tenant-wide write permissions. */
const HIGH_PERMISSIONS = new Set([
  'Mail.ReadWrite',
  'Mail.Send',
  'Files.ReadWrite.All',
  'Sites.FullControl.All',
  'Sites.ReadWrite.All',
  'User.ReadWrite.All',
  'Group.ReadWrite.All',
  'Policy.ReadWrite.ConditionalAccess',
  'UserAuthenticationMethod.ReadWrite.All',
  'Domain.ReadWrite.All',
]);
/** Tenant-wide read access to content (mail, files, chats): medium risk. */
const READ_ALL_PERMISSIONS = new Set([
  'Mail.Read',
  'Mail.ReadBasic.All',
  'Files.Read.All',
  'Sites.Read.All',
  'Calendars.Read',
  'Contacts.Read',
  'Chat.Read.All',
  'ChannelMessage.Read.All',
  'Notes.Read.All',
  'MailboxSettings.Read',
]);

const USER_SELECT = 'id,displayName,userPrincipalName,accountEnabled,onPremisesSyncEnabled,userType';
const M365_ADMIN_DOMAIN_URL = (d: string) => `https://admin.microsoft.com/#/Domains/Details/${encodeURIComponent(d)}`;
const AUTH_METHODS_URL = entraPageUrl('Microsoft_AAD_IAM/AuthenticationMethodsMenuBlade/~/AdminAuthMethods');

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/** A 403 on a permission the customer may not have granted: could not be evaluated, with a hint (never a fail). */
async function needs<T>(perm: string, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GraphError && (e.status === 403 || e.status === 401)) {
      throw new CheckError(`Access denied (${e.code}). Grant the ${perm} application permission to the scanner app and consent again.`, e.status);
    }
    throw e;
  }
}

async function txtRecords(name: string): Promise<{ records: string[] } | { error: string }> {
  try {
    return { records: (await dns.resolveTxt(name)).map((r) => r.join('')) };
  } catch (e: any) {
    if (DNS_MISSING.has(e?.code)) return { records: [] };
    return { error: String(e?.code ?? 'DNS error') };
  }
}

/** true: a CNAME exists, false: none, null: could not be checked. */
async function hasCname(name: string): Promise<boolean | null> {
  try {
    return (await dns.resolveCname(name)).length > 0;
  } catch (e: any) {
    if (DNS_MISSING.has(e?.code)) return false;
    return null;
  }
}

/** SPF must end in -all or ~all (or delegate with redirect=); +all, a bare "all" or ?all let anyone send. */
function spfProblem(spf: string): { text: string; severe: boolean } | null {
  const terms = spf.trim().toLowerCase().split(/\s+/).slice(1);
  const all = terms.find((t) => /^[-~?+]?all$/.test(t));
  if (all === '-all' || all === '~all') return null;
  if (all === 'all' || all === '+all') return { text: `SPF "${all}" allows any sender`, severe: true };
  if (all === '?all') return { text: 'SPF ?all (neutral) does not reject other senders', severe: false };
  if (terms.some((t) => t.startsWith('redirect='))) return null;
  return { text: 'SPF without -all or ~all', severe: false };
}

/** Number of DNS lookups an SPF record needs (include, a, mx, ptr, exists, redirect; nested includes counted). */
async function spfLookups(record: string, cache: Map<string, string | null>, depth = 0): Promise<number> {
  let count = 0;
  for (const term of record.trim().toLowerCase().split(/\s+/).slice(1)) {
    const t = term.replace(/^[-~?+]/, '');
    const target = t.startsWith('include:') ? t.slice(8) : t.startsWith('redirect=') ? t.slice(9) : null;
    if (target !== null || /^(a|mx|ptr)([:/]|$)/.test(t) || t.startsWith('exists:')) count++;
    if (target && !target.includes('%') && depth < 5 && count <= SPF_LOOKUP_LIMIT) {
      if (!cache.has(target)) {
        const r = await txtRecords(target);
        cache.set(target, 'records' in r ? (r.records.find((x) => x.toLowerCase().startsWith('v=spf1')) ?? null) : null);
      }
      const nested = cache.get(target);
      if (nested) count += await spfLookups(nested, cache, depth + 1);
    }
    if (count > SPF_LOOKUP_LIMIT) break;
  }
  return count;
}

const dmarcTag = (rec: string, tag: string) => rec.match(new RegExp(`(?:^|;)\\s*${tag}\\s*=\\s*([^;\\s]+)`, 'i'))?.[1]?.toLowerCase();

export function organisationalDomain(domain: string): string {
  const parts = domain.toLowerCase().split('.');
  const n = MULTI_LABEL_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}

const caPolicies = (ctx: MsCtx) => ctx.memo.get('ca', () => needs('Policy.Read.All', graphAll<CaPolicy>(ctx, '/identity/conditionalAccess/policies')));
const securityDefaults = (ctx: MsCtx) =>
  ctx.memo.get('secdef', async () => Boolean((await needs('Policy.Read.All', graph(ctx, '/policies/identitySecurityDefaultsEnforcementPolicy'))).isEnabled));
const authzPolicy = (ctx: MsCtx) =>
  ctx.memo.get('authz', async () => {
    const p: any = await needs('Policy.Read.All', graph(ctx, '/policies/authorizationPolicy'));
    return Array.isArray(p.value) ? p.value[0] : p;
  });
const authMethodsPolicy = (ctx: MsCtx) => ctx.memo.get('authMethods', () => needs('Policy.Read.All', graph<any>(ctx, '/policies/authenticationMethodsPolicy')));

/** Conditional Access policies, or null when the tenant has no Conditional Access licence. */
async function caPoliciesIfLicensed(ctx: MsCtx): Promise<CaPolicy[] | null> {
  try {
    return await caPolicies(ctx);
  } catch (e) {
    if (e instanceof NotApplicable) return null;
    throw e;
  }
}

/** Allowed method combinations of custom authentication strengths (empty when they cannot be read). */
const strengthCombos = (ctx: MsCtx) =>
  ctx.memo.get('authStrengths', async () => {
    const map = new Map<string, string[]>();
    try {
      for (const s of await graphAll<any>(ctx, '/identity/conditionalAccess/authenticationStrength/policies', true)) {
        map.set(s.id, Array.isArray(s.allowedCombinations) ? s.allowedCombinations : []);
      }
    } catch {
      // Unknown strengths are treated as plain MFA.
    }
    return map;
  });

async function phishingResistantCheck(ctx: MsCtx): Promise<(p: CaPolicy) => boolean> {
  const combos = await strengthCombos(ctx);
  return (p) => {
    const s = p.grantControls?.authenticationStrength;
    if (!s?.id) return false;
    if (s.id === PHISHING_RESISTANT_STRENGTH) return true;
    const allowed: string[] = Array.isArray(s.allowedCombinations) && s.allowedCombinations.length ? s.allowedCombinations : (combos.get(s.id) ?? []);
    return allowed.length > 0 && allowed.every((c) => PHISHING_RESISTANT_METHODS.has(c));
  };
}

const SD_HINT = 'Turn on Security Defaults (Entra admin center > Overview > Properties > Manage security defaults), or license Entra ID P1 and enforce the equivalent Conditional Access policies.';
/** Security Defaults off and no Conditional Access licence: nothing enforces the baseline. */
const unprotected = (what: string) =>
  fail(`Security Defaults are off and Conditional Access is not licensed: ${what}. ${SD_HINT}`, [], { securityDefaults: false, conditionalAccess: 'not licensed' });

// ---------------------------------------------------------------------------------------------------------------
// Directory roles: active members, PIM-eligible members, role-assignable groups expanded, disabled accounts skipped
// ---------------------------------------------------------------------------------------------------------------

type PrincipalKind = 'user' | 'group' | 'servicePrincipal';

interface Holder {
  id: string;
  name: string;
  kind: PrincipalKind;
  userType?: string;
  enabled: boolean;
  synced: boolean;
  assignment: 'active' | 'eligible';
  via?: string;
}

function kindOf(o: any): PrincipalKind {
  const t = String(o?.['@odata.type'] ?? '').toLowerCase();
  if (t.endsWith('.group')) return 'group';
  if (t.endsWith('.serviceprincipal')) return 'servicePrincipal';
  return 'user';
}

const toHolder = (o: any, assignment: Holder['assignment'], via?: string): Holder => ({
  id: o.id,
  name: o.userPrincipalName ?? o.displayName ?? o.id,
  kind: kindOf(o),
  userType: o.userType,
  enabled: o.accountEnabled !== false,
  synced: Boolean(o.onPremisesSyncEnabled),
  assignment,
  via,
});

const userDetail = (ctx: MsCtx, id: string) =>
  ctx.memo.get(`user:${id}`, () => graph<any>(ctx, `/users/${encodeURIComponent(id)}?$select=${USER_SELECT}`).catch(() => null));

const groupMembers = (ctx: MsCtx, id: string) =>
  ctx.memo.get(`groupMembers:${id}`, () => graphAll<any>(ctx, `/groups/${encodeURIComponent(id)}/transitiveMembers?$select=${USER_SELECT}`).catch(() => null));

const directoryRoles = (ctx: MsCtx) => ctx.memo.get('directoryRoles', () => needs('RoleManagement.Read.Directory', graphAll<any>(ctx, '/directoryRoles')));

async function activeMembers(ctx: MsCtx, templateId: string): Promise<any[]> {
  return ctx.memo.get(`role:${templateId}`, async () => {
    const role = (await directoryRoles(ctx)).find((r: any) => r.roleTemplateId === templateId);
    if (!role) return [];
    return needs('RoleManagement.Read.Directory', graphAll(ctx, `/directoryRoles/${role.id}/members?$select=${USER_SELECT}`));
  });
}

/** Raw PIM eligibility schedules (throws when PIM is not licensed or not readable). */
const eligibilitySchedules = (ctx: MsCtx) =>
  ctx.memo.get('eligibility', () => needs('RoleManagement.Read.Directory', graphAll<any>(ctx, '/roleManagement/directory/roleEligibilitySchedules?$expand=principal')));

/** Eligibility schedules, or a note explaining why eligible members are not included. */
async function eligibilityOrNote(ctx: MsCtx): Promise<{ items: any[]; note?: string }> {
  try {
    return { items: await eligibilitySchedules(ctx) };
  } catch (e) {
    if (e instanceof NotApplicable) return { items: [], note: 'PIM is not licensed, so there are no eligible assignments' };
    if (e instanceof CheckError && (e.status === 403 || e.status === 401)) return { items: [], note: 'PIM-eligible assignments could not be read (RoleManagement.Read.Directory missing)' };
    return { items: [], note: 'PIM-eligible assignments could not be read' };
  }
}

const tenantWide = (s: any) => (s?.directoryScopeId ?? '/') === '/';

/** Everyone who holds a role, active or eligible, with role-assignable groups expanded to their members. */
async function roleHolders(ctx: MsCtx, templateId: string): Promise<{ holders: Holder[]; note?: string }> {
  return ctx.memo.get(`holders:${templateId}`, async () => {
    const out = new Map<string, Holder>();
    const add = async (o: any, assignment: Holder['assignment']) => {
      if (!o?.id) return;
      if (kindOf(o) === 'group') {
        const members = await groupMembers(ctx, o.id);
        for (const m of members ?? []) {
          if (kindOf(m) === 'group') continue;
          const h = toHolder(m, assignment, o.displayName ?? o.id);
          if (!out.has(h.id) || (out.get(h.id)!.assignment === 'eligible' && assignment === 'active')) out.set(h.id, h);
        }
        return;
      }
      let obj = o;
      if (kindOf(o) === 'user' && (o.accountEnabled === undefined || o.onPremisesSyncEnabled === undefined) && assignment === 'eligible') {
        obj = { ...o, ...((await userDetail(ctx, o.id)) ?? {}) };
      }
      const h = toHolder(obj, assignment);
      if (!out.has(h.id) || (out.get(h.id)!.assignment === 'eligible' && assignment === 'active')) out.set(h.id, h);
    };
    for (const m of await activeMembers(ctx, templateId)) await add(m, 'active');
    const elig = await eligibilityOrNote(ctx);
    for (const s of elig.items.filter((x) => x.roleDefinitionId === templateId && tenantWide(x))) {
      await add(s.principal ?? { id: s.principalId }, 'eligible');
    }
    return { holders: [...out.values()], note: elig.note };
  });
}

const holderRef = (h: Holder, detail?: string): ResourceRef => ({
  id: h.id,
  name: h.name,
  detail: detail ?? [h.assignment === 'eligible' ? 'eligible (PIM)' : 'active', h.via && `via group ${h.via}`].filter(Boolean).join(', '),
  type: h.kind === 'servicePrincipal' ? 'Service principal' : h.kind === 'group' ? 'Group' : 'User',
  url: entraUrl(h.kind, h.id),
});

// ---------------------------------------------------------------------------------------------------------------
// Microsoft Graph application permissions
// ---------------------------------------------------------------------------------------------------------------

interface AppPerms {
  byPrincipal: Map<string, { name: string; perms: Set<string> }>;
  graphSpId: string | null;
  truncated: boolean;
  count: number;
}

const graphAppPerms = (ctx: MsCtx) =>
  ctx.memo.get('graphAppPerms', async (): Promise<AppPerms> => {
    const sps = await needs('Application.Read.All', graph<any>(ctx, `/servicePrincipals?$filter=appId eq '${GRAPH_APP_ID}'&$select=id,appRoles`));
    const graphSp = sps.value?.[0];
    if (!graphSp) return { byPrincipal: new Map(), graphSpId: null, truncated: false, count: 0 };
    const roleById = new Map<string, string>((graphSp.appRoles ?? []).map((r: any) => [r.id, r.value]));
    const assignments = await needs('Application.Read.All', graphAll<any>(ctx, `/servicePrincipals/${graphSp.id}/appRoleAssignedTo?$top=999`));
    const byPrincipal = new Map<string, { name: string; perms: Set<string> }>();
    for (const a of assignments) {
      const perm = roleById.get(a.appRoleId);
      if (!perm) continue;
      const e = byPrincipal.get(a.principalId) ?? { name: a.principalDisplayName ?? a.principalId, perms: new Set<string>() };
      e.perms.add(perm);
      byPrincipal.set(a.principalId, e);
    }
    return { byPrincipal, graphSpId: graphSp.id, truncated: assignments.truncated, count: assignments.length };
  });

const spName = (ctx: MsCtx, id: string) =>
  ctx.memo.get(`spName:${id}`, () =>
    graph<any>(ctx, `/servicePrincipals/${encodeURIComponent(id)}?$select=id,displayName,appId`)
      .then((s) => ({ name: String(s?.displayName ?? id), appId: s?.appId as string | undefined }))
      .catch(() => ({ name: id, appId: undefined })),
  );

const spByAppId = (ctx: MsCtx, appId: string) =>
  ctx.memo.get(`spByApp:${appId}`, () =>
    graph<any>(ctx, `/servicePrincipals(appId='${encodeURIComponent(appId)}')?$select=id`)
      .then((s) => (s?.id as string | undefined) ?? null)
      .catch(() => null),
  );

const spRef = (id: string, name: string, detail: string, appId?: string): ResourceRef => ({
  id,
  name,
  detail,
  type: 'Enterprise application',
  url: entraUrl('servicePrincipal', id, appId ? { appId } : undefined),
});

// ---------------------------------------------------------------------------------------------------------------
// Conditional Access requirements
// ---------------------------------------------------------------------------------------------------------------

/** Policies for user actions or authentication contexts are not baseline app policies. */
const appPolicy = (p: CaPolicy) =>
  !(p.conditions?.applications?.includeUserActions ?? []).length && !(p.conditions?.applications?.includeAuthenticationContextClassReferences ?? []).length;

const MFA_REQ = { purpose: (p: CaPolicy) => appPolicy(p) && hasMfaGrant(p) && !blocks(p), control: (p: CaPolicy) => orBypass(p, ['mfa']) };

const riskGrant = (p: CaPolicy) => (blocks(p) || hasMfaGrant(p) || builtIn(p).includes('passwordChange') ? null : 'no grant control (block, MFA or password change)');

/** Roles covered by enforced (or report-only) matches. */
const rolesOf = (ms: CaMatch[]) => new Set(ms.flatMap((m) => m.roles));
const adminExclusionsOk = (m: CaMatch) => isBreakGlassOnly({ ...m.exclusions, roles: [] });

const roleRef = (id: string, detail: string): ResourceRef => ({ id, name: roleName(id), detail, type: 'Directory role', url: entraUrl('role', id) });

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

const checks: Record<string, (ctx: MsCtx) => Promise<CheckOutcome>> = {
  async 'm365.mfa-all-users'(ctx) {
    if (await securityDefaults(ctx)) return pass('Security Defaults are enabled (MFA required for all users).');
    const policies = await caPoliciesIfLicensed(ctx);
    if (!policies) return unprotected('no MFA is enforced for users');
    return caOutcome(ctx, evaluateCa(policies, MFA_REQ), {
      enforced: 'MFA is enforced for all users and all cloud apps',
      subject: 'An all-users MFA policy',
      missing: 'No Security Defaults and no enabled Conditional Access policy requiring MFA for all users and all cloud apps without narrowing conditions.',
    });
  },

  async 'm365.legacy-auth'(ctx) {
    if (await securityDefaults(ctx)) return pass('Security Defaults block legacy authentication.');
    const policies = await caPoliciesIfLicensed(ctx);
    if (!policies) return unprotected('legacy authentication is not blocked');
    const ev = evaluateCa(policies, {
      purpose: (p) => {
        const types: string[] = p.conditions?.clientAppTypes ?? [];
        return types.includes('exchangeActiveSync') || types.includes('other');
      },
      control: (p) => (blocks(p) ? null : 'does not block access'),
      required: (p) => {
        const types: string[] = p.conditions?.clientAppTypes ?? [];
        const missing = ['exchangeActiveSync', 'other'].filter((t) => !types.includes(t));
        return missing.length ? `client app types miss ${missing.join(', ')}` : null;
      },
      allow: ['clientAppTypes'],
    });
    return caOutcome(ctx, ev, {
      enforced: 'Legacy authentication (Exchange ActiveSync and other clients) is blocked for all users and all cloud apps',
      subject: 'A legacy authentication block policy',
      missing: 'Legacy authentication is not blocked for all users and all cloud apps.',
    });
  },

  async 'm365.admin-mfa'(ctx) {
    if (await securityDefaults(ctx)) return warn('Security Defaults require MFA for admins, but not phishing-resistant MFA.');
    const all = await caPoliciesIfLicensed(ctx);
    if (!all) return unprotected('MFA is not enforced for administrators');
    const strong = await phishingResistantCheck(ctx);
    const ev = evaluateCa(all, { ...MFA_REQ, roles: CIS_ADMIN_ROLES });
    const mfaRoles = rolesOf(ev.enforced);
    const strongMatches = ev.enforced.filter((m) => strong(m.policy));
    const strongRoles = rolesOf(strongMatches);
    const reportRoles = rolesOf(ev.reportOnly);
    const evidence = { nearMisses: nearMisses.evidence(ev), rolesEvaluated: CIS_ADMIN_ROLES.length };
    const uncovered = CIS_ADMIN_ROLES.filter((r) => !mfaRoles.has(r));
    if (uncovered.length) {
      const refs = [...uncovered.map((r) => roleRef(r, reportRoles.has(r) ? 'MFA policy only in report-only mode' : 'no enforced MFA policy')), ...ev.reportOnly.map((m) => policyRef(m.policy)), ...nearMisses.refs(ev)];
      const ev2 = { ...evidence, uncoveredRoles: uncovered.map(roleName) };
      if (uncovered.length === CIS_ADMIN_ROLES.length) {
        if (ev.reportOnly.length) return warn(`MFA for administrator roles is only configured in report-only mode (${ev.reportOnly.map((m) => `'${m.policy.displayName}'`).join(', ')}).`, refs, ev2);
        return fail('No enabled Conditional Access policy requires MFA for administrator roles on all cloud apps.', refs, ev2);
      }
      const text = `${uncovered.length} of ${CIS_ADMIN_ROLES.length} administrator roles are not covered by an enforced MFA policy: ${uncovered.map(roleName).join(', ')}.`;
      return uncovered.includes(GLOBAL_ADMIN) ? fail(text, refs, ev2) : warn(text, refs, ev2);
    }
    const broad = ev.enforced.filter((m) => !adminExclusionsOk(m));
    const weak = CIS_ADMIN_ROLES.filter((r) => !strongRoles.has(r));
    if (weak.length) {
      return warn(
        `All administrator roles require MFA, but ${weak.length} role(s) are not held to a phishing-resistant authentication strength: ${weak.map(roleName).join(', ')}.`,
        [...ev.enforced.map((m) => policyRef(m.policy)), ...weak.map((r) => roleRef(r, 'MFA without phishing-resistant strength'))],
        evidence,
      );
    }
    const strongBroad = strongMatches.filter((m) => !adminExclusionsOk(m));
    if (strongBroad.length && strongBroad.length === strongMatches.length) {
      const m = strongBroad[0];
      const excluded = await exclusionRefs(ctx, m.exclusions, 'excluded');
      return warn(
        `Administrators must use phishing-resistant MFA ('${m.policy.displayName}'), but the policy excludes ${describeExclusions({ ...m.exclusions, roles: [] })}: more than break-glass accounts.`,
        [...strongMatches.map((x) => policyRef(x.policy)), ...excluded],
        evidence,
      );
    }
    const used = strongMatches.filter(adminExclusionsOk);
    const bg = used.find((m) => m.exclusions.users.length);
    const excluded = bg ? await exclusionRefs(ctx, { ...bg.exclusions, roles: [] }, 'break-glass exclusion') : [];
    return pass(
      `All ${CIS_ADMIN_ROLES.length} administrator roles must use phishing-resistant MFA (${used.map((m) => `'${m.policy.displayName}'`).join(', ')}).${excluded.length ? ` Break-glass exclusions: ${excluded.map((r) => r.name).join(', ')}.` : ''}`,
      { resources: [...used.map((m) => policyRef(m.policy)), ...excluded], evidence: { ...evidence, breakGlassExclusions: excluded.map((r) => r.name), broadExclusionPolicies: broad.map((m) => m.policy.displayName) } },
    );
  },

  async 'm365.admin-session-controls'(ctx) {
    const all = await caPolicies(ctx);
    const ev = evaluateCa(all, {
      roles: CIS_ADMIN_ROLES,
      purpose: (p) => appPolicy(p) && Boolean(p.sessionControls?.signInFrequency?.isEnabled || p.sessionControls?.persistentBrowser?.isEnabled),
    });
    const freqOk = (p: CaPolicy) => {
      const f = p.sessionControls?.signInFrequency;
      if (!f?.isEnabled) return false;
      if (f.frequencyInterval === 'everyTime') return true;
      return f.type === 'hours' && Number(f.value) <= 4;
    };
    const persistOk = (p: CaPolicy) => p.sessionControls?.persistentBrowser?.isEnabled && p.sessionControls.persistentBrowser.mode === 'never';
    const freqRoles = rolesOf(ev.enforced.filter((m) => freqOk(m.policy)));
    const anyFreqRoles = rolesOf(ev.enforced.filter((m) => m.policy.sessionControls?.signInFrequency?.isEnabled));
    const persistRoles = rolesOf(ev.enforced.filter((m) => persistOk(m.policy)));
    const evidence = { nearMisses: nearMisses.evidence(ev) };
    const gaps = CIS_ADMIN_ROLES.map((r) => {
      const missing = [!freqRoles.has(r) && (anyFreqRoles.has(r) ? 'sign-in frequency longer than 4 hours' : 'no sign-in frequency'), !persistRoles.has(r) && 'browser sessions may persist'].filter(Boolean);
      return { r, missing };
    }).filter((g) => g.missing.length);
    const refs = ev.enforced.map((m) => policyRef(m.policy));
    if (!gaps.length) return pass(`All ${CIS_ADMIN_ROLES.length} administrator roles have a sign-in frequency of 4 hours or less and no persistent browser sessions.`, { resources: refs, evidence });
    const gapRefs = gaps.map((g) => roleRef(g.r, g.missing.join(', ')));
    if (!ev.enforced.length) {
      if (ev.reportOnly.length) return warn('Session controls for administrators exist only in report-only mode.', [...ev.reportOnly.map((m) => policyRef(m.policy)), ...nearMisses.refs(ev)], evidence);
      return fail('No enforced Conditional Access session controls (sign-in frequency, no persistent browser) for administrator roles.', nearMisses.refs(ev), evidence);
    }
    return warn(`${gaps.length} of ${CIS_ADMIN_ROLES.length} administrator roles lack complete session controls.`, [...refs, ...gapRefs], evidence);
  },

  async 'm365.device-code-flow'(ctx) {
    const all = await caPolicies(ctx);
    const flows = (p: CaPolicy) => String(p.conditions?.authenticationFlows?.transferMethods ?? '').split(',').map((s) => s.trim());
    const ev = evaluateCa(all, {
      purpose: (p) => flows(p).includes('deviceCodeFlow'),
      control: (p) => (blocks(p) ? null : 'does not block access'),
      allow: ['authenticationFlows'],
    });
    return caOutcome(ctx, ev, {
      enforced: 'Device code flow is blocked for all users and all cloud apps',
      subject: 'A device code flow block policy',
      missing: 'Device code flow is not blocked by Conditional Access: attackers can use device code phishing to obtain tokens.',
    });
  },

  async 'm365.global-admin-count'(ctx) {
    const { holders, note } = await roleHolders(ctx, GLOBAL_ADMIN);
    const users = holders.filter((h) => h.kind === 'user' && h.enabled);
    const res = users.map((h) => holderRef(h));
    const eligible = users.filter((h) => h.assignment === 'eligible').length;
    const evidence = { active: users.length - eligible, eligible, disabledSkipped: holders.filter((h) => !h.enabled).length, ...(note ? { note } : {}) };
    const label = `${users.length} Global Administrator(s)${eligible ? ` (${eligible} PIM-eligible)` : ''}`;
    const suffix = note && note.includes('could not') ? ` Note: ${note}.` : '';
    if (users.length < 2) return warn(`Only ${label}: risk of lock-out. Ensure emergency access accounts exist.${suffix}`, res, evidence);
    if (users.length > 4) return fail(`${label}, recommended 2-4.${suffix}`, res, evidence);
    return pass(`${label}.${suffix}`, { resources: res, evidence });
  },

  async 'm365.admins-cloud-only'(ctx) {
    const seen = new Map<string, ResourceRef>();
    const notes = new Set<string>();
    for (const t of CIS_ADMIN_ROLES) {
      const { holders, note } = await roleHolders(ctx, t);
      if (note) notes.add(note);
      for (const h of holders) {
        if (h.kind === 'user' && h.enabled && h.synced && !seen.has(h.id)) seen.set(h.id, holderRef(h, `${roleName(t)}, synchronised from on-premises (${h.assignment === 'eligible' ? 'eligible' : 'active'})`));
      }
    }
    const o = failIfAny([...seen.values()], (n) => `${n} privileged account(s) are synchronised from on-premises AD.`, 'All active and eligible privileged role members are cloud-only accounts.');
    return notes.size ? { ...o, evidence: { ...o.evidence, notes: [...notes] } } : o;
  },

  async 'm365.privileged-guests'(ctx) {
    const PRIVILEGED = [...CIS_ADMIN_ROLES];
    const found = new Map<string, { h: Holder; roles: string[] }>();
    for (const t of PRIVILEGED) {
      for (const h of (await roleHolders(ctx, t)).holders) {
        const guest = h.kind === 'user' && (h.userType === 'Guest' || h.name.includes('#EXT#'));
        if (!guest && h.kind !== 'servicePrincipal') continue;
        if (!h.enabled) continue;
        const e = found.get(h.id) ?? { h, roles: [] };
        e.roles.push(t);
        found.set(h.id, e);
      }
    }
    const items = [...found.values()];
    const severe = items.filter((e) => e.h.kind === 'user' || e.roles.some((r) => TIER0_ROLES.has(r)));
    const res = items.map((e) => holderRef(e.h, `${e.h.kind === 'servicePrincipal' ? 'service principal' : 'guest'}: ${e.roles.map(roleName).join(', ')} (${e.h.assignment})`));
    if (!items.length) return pass('No guests or service principals hold privileged directory roles.');
    const guests = items.filter((e) => e.h.kind === 'user').length;
    const text = `${guests} guest(s) and ${items.length - guests} service principal(s) hold privileged directory roles.`;
    return severe.length ? fail(text, res) : warn(text, res);
  },

  async 'm365.mfa-registration'(ctx) {
    const rows = await needs('AuditLog.Read.All', graphAll<any>(ctx, '/reports/authenticationMethods/userRegistrationDetails?$top=999'));
    const members = rows.filter((r) => r.userType !== 'guest');
    const cut = (o: CheckOutcome) => applyTruncation(o, rows.truncated, rows.length, 'users');
    if (!members.length) return cut(na('No users found.'));
    const missing = members.filter((r) => !r.isMfaRegistered);
    const pct = Math.round(((members.length - missing.length) / members.length) * 100);
    const res = missing.map((r) => ({ id: r.id, name: r.userPrincipalName, type: 'User', url: entraUrl('user', r.id) }));
    const ev = { registered: members.length - missing.length, total: members.length, percentage: pct };
    if (pct >= 95) return cut(pass(`${pct}% of ${members.length} users are registered for MFA.`, { resources: res, evidence: ev }));
    if (pct >= 80) return cut(warn(`${pct}% of users registered for MFA (${missing.length} missing).`, res, ev));
    return cut(fail(`Only ${pct}% of users registered for MFA (${missing.length} missing).`, res, ev));
  },

  async 'm365.user-consent'(ctx) {
    const p = await authzPolicy(ctx);
    const assigned: string[] = p.defaultUserRolePermissions?.permissionGrantPoliciesAssigned ?? [];
    const self = assigned.filter((a) => a.startsWith('ManagePermissionGrantsForSelf.'));
    if (self.some((a) => a.endsWith('microsoft-user-default-legacy'))) return fail('Users can consent to any application requesting any delegated permission.', [], { assigned });
    if (!self.length) return pass('User consent to applications is disabled.', { evidence: { assigned } });
    const other = self.filter((a) => a !== 'ManagePermissionGrantsForSelf.microsoft-user-default-low');
    if (!other.length) return pass('User consent is limited to verified publishers and low-impact permissions.', { evidence: { assigned } });
    return warn(`User consent is governed by custom or unrecognised permission grant policies: ${other.join(', ')}. Review what they allow.`, [], { assigned });
  },

  async 'm365.user-app-registration'(ctx) {
    const p = await authzPolicy(ctx);
    return p.defaultUserRolePermissions?.allowedToCreateApps ? warn('All users can register applications.') : pass('Users cannot register applications.');
  },

  async 'm365.guest-invites'(ctx) {
    const v = (await authzPolicy(ctx)).allowInvitesFrom;
    if (v === 'everyone') return fail('Everyone, including guests, can invite external users.', [], { allowInvitesFrom: v });
    if (v === 'adminsGuestInvitersAndAllMembers') return warn('All member users can invite guests.', [], { allowInvitesFrom: v });
    if (v === 'adminsAndGuestInviters') return pass('Guest invitations are restricted to admins and users in the Guest Inviter role.', { evidence: { allowInvitesFrom: v } });
    if (v === 'none') return pass('Nobody can invite guests (invitations are disabled).', { evidence: { allowInvitesFrom: v } });
    if (v === undefined || v === null) throw new CheckError('The authorization policy did not return allowInvitesFrom, so guest invitation settings could not be evaluated. Check that Policy.Read.All is granted.');
    return warn(`Unrecognised guest invitation setting "${String(v)}": review it in External collaboration settings.`, [], { allowInvitesFrom: v });
  },

  async 'm365.guest-access'(ctx) {
    const id = (await authzPolicy(ctx)).guestUserRoleId;
    if (id === '2af84b1e-32c8-42b7-82bc-daa82404023b') return pass('Guest access is restricted to their own directory objects.');
    if (id === 'a0b1b346-4d3e-4e8b-98f8-753987be4970') return fail('Guests have the same directory access as members.');
    return warn('Guests have limited access to directory objects (default); consider the most restrictive setting.');
  },

  async 'm365.stale-accounts'(ctx) {
    const users = await needs('AuditLog.Read.All', graphAll<any>(ctx, '/users?$select=id,displayName,userPrincipalName,accountEnabled,signInActivity,createdDateTime,userType&$top=999'));
    const cutoff = Date.now() - 90 * 86_400_000;
    const lastOf = (u: any): string | undefined => u.signInActivity?.lastSuccessfulSignInDateTime ?? u.signInActivity?.lastSignInDateTime ?? undefined;
    const stale = users.filter((u) => {
      if (!u.accountEnabled || Date.parse(u.createdDateTime) > cutoff) return false;
      const last = lastOf(u);
      return !last || Date.parse(last) < cutoff;
    });
    const outcome = failIfAny(
      stale.map((u) => ({
        id: u.id,
        name: u.userPrincipalName,
        detail: `${u.userType ?? 'Member'}, last successful sign-in ${(lastOf(u) ?? 'never').slice(0, 10)}`,
        type: 'User',
        url: entraUrl('user', u.id),
      })),
      (n) => `${n} enabled account(s) without a successful sign-in for 90+ days.`,
      'No stale enabled accounts.',
      stale.length > 10 ? 'fail' : 'warn',
    );
    const evidence = stale.length
      ? { lastSuccessfulSignIn: Object.fromEntries(stale.slice(0, 200).map((u) => [u.userPrincipalName ?? u.id, lastOf(u) ?? null])) }
      : undefined;
    return applyTruncation(evidence ? { ...outcome, evidence: { ...outcome.evidence, ...evidence } } : outcome, users.truncated, users.length, 'accounts');
  },

  async 'm365.risky-app-permissions'(ctx) {
    const perms = await graphAppPerms(ctx);
    if (!perms.graphSpId) return na('Microsoft Graph service principal not found.');
    type Entry = { id: string; name: string; appId?: string; tier0: Set<string>; high: Set<string>; read: Set<string>; delegated: Set<string> };
    const apps = new Map<string, Entry>();
    const entry = (id: string, name: string): Entry => {
      let e = apps.get(id);
      if (!e) apps.set(id, (e = { id, name, tier0: new Set(), high: new Set(), read: new Set(), delegated: new Set() }));
      return e;
    };
    for (const [id, a] of perms.byPrincipal) {
      for (const p of a.perms) {
        if (TIER0_PERMISSIONS.has(p)) entry(id, a.name).tier0.add(p);
        else if (HIGH_PERMISSIONS.has(p)) entry(id, a.name).high.add(p);
        else if (READ_ALL_PERMISSIONS.has(p)) entry(id, a.name).read.add(p);
      }
    }
    // Delegated permissions consented for all users of the tenant.
    let grantsTruncated = false;
    let grantsNote: string | undefined;
    try {
      const grants = await graphAll<any>(ctx, `/oauth2PermissionGrants?$filter=consentType eq 'AllPrincipals'&$top=999`);
      grantsTruncated = grants.truncated;
      for (const g of grants) {
        if (g.consentType && g.consentType !== 'AllPrincipals') continue;
        if (g.resourceId && g.resourceId !== perms.graphSpId) continue;
        const risky = String(g.scope ?? '')
          .split(/\s+/)
          .filter((s) => TIER0_PERMISSIONS.has(s) || HIGH_PERMISSIONS.has(s) || READ_ALL_PERMISSIONS.has(s));
        if (!risky.length) continue;
        const e = entry(g.clientId, g.clientId);
        for (const s of risky) e.delegated.add(s);
      }
    } catch (e) {
      if (!(e instanceof GraphError)) throw e;
      grantsNote = `Delegated tenant-wide grants could not be read (${e.code}); Directory.Read.All is needed.`;
    }
    const list = [...apps.values()];
    let lookups = 0;
    for (const e of list) {
      if (e.name === e.id && lookups++ < 50) {
        const n = await spName(ctx, e.id);
        e.name = n.name;
        e.appId = n.appId;
      }
    }
    const describe = (e: Entry) =>
      [
        e.tier0.size && `Tier-0: ${[...e.tier0].join(', ')}`,
        e.high.size && `write: ${[...e.high].join(', ')}`,
        e.read.size && `read-all: ${[...e.read].join(', ')}`,
        e.delegated.size && `delegated for all users: ${[...e.delegated].join(', ')}`,
      ]
        .filter(Boolean)
        .join('; ');
    const res = list.map((e) => spRef(e.id, e.name, describe(e), e.appId));
    const tier0 = list.filter((e) => e.tier0.size);
    const high = list.filter((e) => e.high.size);
    const evidence: Record<string, unknown> = {
      tier0Apps: tier0.length,
      writeApps: high.length,
      readAllApps: list.filter((e) => e.read.size).length,
      delegatedTenantWideApps: list.filter((e) => e.delegated.size).length,
      ...(grantsNote ? { note: grantsNote } : {}),
    };
    let o: CheckOutcome;
    if (tier0.length) o = fail(`${tier0.length} application(s) hold Tier-0 Microsoft Graph permissions that allow taking over the tenant${high.length ? `, ${high.length} hold tenant-wide write permissions` : ''}.`, res, evidence);
    else if (high.length > 3) o = fail(`${high.length} application(s) hold tenant-wide write Microsoft Graph application permissions.`, res, evidence);
    else if (list.length) o = warn(`${list.length} application(s) hold high-impact or tenant-wide read Microsoft Graph permissions.`, res, evidence);
    else o = pass('No applications hold high-impact Microsoft Graph application permissions or tenant-wide delegated grants.', { evidence });
    if (grantsNote) o = { ...o, summary: `${o.summary} ${grantsNote}` };
    return applyTruncation(o, perms.truncated || grantsTruncated, perms.count, 'permission assignments');
  },

  async 'm365.app-credentials'(ctx) {
    const appsList = await needs('Application.Read.All', graphAll<any>(ctx, '/applications?$select=id,appId,displayName,signInAudience,passwordCredentials,keyCredentials&$top=999'));
    if (!appsList.length) return applyTruncation(na('No application registrations found.'), appsList.truncated, 0, 'applications');
    const now = Date.now();
    const YEAR = 366 * 86_400_000;
    let perms: AppPerms | null = null;
    try {
      perms = await graphAppPerms(ctx);
    } catch {
      perms = null;
    }
    const privileged = async (appId: string) => {
      if (!perms) return false;
      const spId = await spByAppId(ctx, appId);
      const p = spId ? perms.byPrincipal.get(spId) : undefined;
      return Boolean(p && [...p.perms].some((x) => TIER0_PERMISSIONS.has(x) || HIGH_PERMISSIONS.has(x)));
    };
    const severe: ResourceRef[] = [];
    const minor: ResourceRef[] = [];
    let lookups = 0;
    for (const a of appsList) {
      const secrets: any[] = a.passwordCredentials ?? [];
      const creds = [...secrets, ...(a.keyCredentials ?? [])];
      const longLived = secrets.filter((s) => Date.parse(s.endDateTime) > now && Date.parse(s.endDateTime) - Date.parse(s.startDateTime ?? s.endDateTime) > YEAR);
      const expired = creds.filter((c) => Date.parse(c.endDateTime) < now);
      const multiTenant = /Multiple|Personal/i.test(String(a.signInAudience ?? ''));
      const activeSecrets = secrets.filter((s) => Date.parse(s.endDateTime) > now);
      const priv = (longLived.length || (multiTenant && activeSecrets.length)) && lookups++ < 100 ? await privileged(a.appId) : false;
      const problems: string[] = [];
      if (longLived.length) problems.push(`${longLived.length} client secret(s) valid for more than 1 year (until ${longLived.map((s) => String(s.endDateTime).slice(0, 10)).join(', ')})`);
      if (multiTenant && activeSecrets.length && priv) problems.push('client secret on a multi-tenant app with high-impact Graph permissions');
      if (expired.length) problems.push(`${expired.length} expired credential(s) still present`);
      if (!problems.length) continue;
      const ref: ResourceRef = { id: a.id, name: a.displayName, detail: `${problems.join('; ')}${priv ? ' (privileged)' : ''}`, type: 'App registration', url: entraUrl('app', a.appId) };
      if (priv || (longLived.length && multiTenant)) severe.push(ref);
      else minor.push(ref);
    }
    const res = [...severe, ...minor];
    let o: CheckOutcome;
    if (severe.length) o = fail(`${severe.length} privileged or multi-tenant application(s) use long-lived client secrets.${minor.length ? ` ${minor.length} more have credential hygiene issues.` : ''}`, res);
    else if (minor.length) o = warn(`${minor.length} application(s) have long-lived client secrets or expired credentials.`, res);
    else o = pass(`None of ${appsList.length} application registrations have long-lived client secrets or expired credentials.`);
    return applyTruncation(o, appsList.truncated, appsList.length, 'applications');
  },

  async 'm365.pim'(ctx) {
    const eligible = (await eligibilitySchedules(ctx)).filter((s) => CIS_ADMIN_ROLES.includes(s.roleDefinitionId) && tenantWide(s));
    const instances = await needs('RoleManagement.Read.Directory', graphAll<any>(ctx, '/roleManagement/directory/roleAssignmentScheduleInstances?$expand=principal'));
    const permanent = instances.filter(
      (i) =>
        CIS_ADMIN_ROLES.includes(i.roleDefinitionId) &&
        tenantWide(i) &&
        (i.assignmentType ?? 'Assigned') === 'Assigned' &&
        !i.endDateTime &&
        (i.memberType ?? 'Direct') === 'Direct' &&
        kindOf(i.principal) !== 'servicePrincipal' &&
        i.principal?.accountEnabled !== false,
    );
    const name = (i: any) => i.principal?.userPrincipalName ?? i.principal?.displayName ?? i.principalId;
    const ref = (i: any): ResourceRef => {
      const kind = kindOf(i.principal);
      return { id: i.principalId, name: name(i), detail: `permanent ${roleName(i.roleDefinitionId)}${kind === 'group' ? ' (group)' : ''}`, type: kind === 'group' ? 'Group' : 'User', url: entraUrl(kind, i.principalId) };
    };
    const permGa = permanent.filter((i) => i.roleDefinitionId === GLOBAL_ADMIN);
    const permOther = permanent.filter((i) => i.roleDefinitionId !== GLOBAL_ADMIN);
    const evidence = { eligibleAssignments: eligible.length, permanentAssignments: permanent.length, permanentGlobalAdmins: permGa.length };
    const res = permanent.map(ref);
    if (permGa.length > 2) return fail(`${permGa.length} permanent Global Administrator assignments: only break-glass accounts (at most 2) should be permanent, the rest PIM-eligible.`, res, evidence);
    if (!eligible.length) return warn('No PIM-eligible assignments for privileged roles: privileged roles are permanently assigned.', res, evidence);
    if (permOther.length) return warn(`PIM is used (${eligible.length} eligible assignments), but ${permOther.length} permanent assignment(s) of other privileged roles remain.`, res, evidence);
    return pass(`PIM is used: ${eligible.length} eligible privileged assignment(s); permanent assignments limited to ${permGa.length} break-glass Global Administrator(s).`, { resources: res, evidence });
  },

  async 'm365.risk-policies'(ctx) {
    const all = await caPolicies(ctx);
    const signIn = evaluateCa(all, {
      purpose: (p) => (p.conditions?.signInRiskLevels ?? []).length > 0,
      control: riskGrant,
      required: (p) => ((p.conditions?.signInRiskLevels ?? []).includes('high') ? null : 'does not cover high sign-in risk'),
      allow: ['signInRisk'],
    });
    const user = evaluateCa(all, {
      purpose: (p) => (p.conditions?.userRiskLevels ?? []).length > 0,
      control: riskGrant,
      required: (p) => ((p.conditions?.userRiskLevels ?? []).includes('high') ? null : 'does not cover high user risk'),
      allow: ['userRisk'],
    });
    const state = (ev: CaEvaluation) => (ev.enforced.some((m) => isBreakGlassOnly(m.exclusions)) ? 'enforced' : ev.enforced.length ? 'broad exclusions' : ev.reportOnly.length ? 'report-only' : 'missing');
    const s = state(signIn);
    const u = state(user);
    const used = [...signIn.enforced, ...user.enforced, ...signIn.reportOnly, ...user.reportOnly];
    const refs = [...new Map(used.map((m) => [m.policy.id, policyRef(m.policy)])).values()];
    const near = [...nearMisses.refs(signIn), ...nearMisses.refs(user)];
    const evidence = { signInRisk: s, userRisk: u, nearMisses: [...nearMisses.evidence(signIn), ...nearMisses.evidence(user)] };
    if (s === 'enforced' && u === 'enforced') return pass('Sign-in risk and user risk Conditional Access policies are enforced for all users.', { resources: refs, evidence });
    if (s === 'missing' && u === 'missing') return fail(`No enforced sign-in or user risk Conditional Access policies for all users and apps.${near.length ? ` ${near.length} related policy(ies) do not count.` : ''}`, near, evidence);
    return warn(`Risk-based Conditional Access is incomplete: sign-in risk ${s}, user risk ${u}.`, [...refs, ...near], evidence);
  },

  async 'm365.device-compliance'(ctx) {
    const all = await caPolicies(ctx);
    const ev = evaluateCa(all, {
      purpose: (p) => appPolicy(p) && builtIn(p).some((g) => g === 'compliantDevice' || g === 'domainJoinedDevice'),
      allow: ['platforms', 'clientAppTypes'],
    });
    if (ev.enforced.length) return pass(`Conditional Access requires compliant or joined devices (${ev.enforced.map((m) => `'${m.policy.displayName}'`).join(', ')}).`, { resources: ev.enforced.map((m) => policyRef(m.policy)) });
    if (ev.reportOnly.length) return warn('Device-based policies exist in report-only mode.', ev.reportOnly.map((m) => policyRef(m.policy)));
    if (ev.nearMiss.length) return warn(`Device-based Conditional Access exists but does not cover all users and apps: ${ev.nearMiss.slice(0, 3).map((n) => `'${n.policy.displayName}' (${n.reason})`).join(', ')}.`, nearMisses.refs(ev));
    return fail('No Conditional Access policy requires managed devices.');
  },

  async 'm365.weak-auth-methods'(ctx) {
    const p = await authMethodsPolicy(ctx);
    const migration: string | undefined = p.policyMigrationState;
    const weak = (p.authenticationMethodConfigurations ?? []).filter((m: any) => ['Sms', 'Voice'].includes(m.id) && m.state === 'enabled');
    const evidence = { policyMigrationState: migration ?? null, enabled: weak.map((m: any) => m.id) };
    if (weak.length) return warn(`Weak methods enabled: ${weak.map((m: any) => m.id).join(', ')}.`, weak.map((m: any) => ({ id: m.id, name: m.id, type: 'Authentication method', url: AUTH_METHODS_URL })), evidence);
    if (migration && migration !== 'migrationComplete') {
      return warn(
        `SMS and voice are disabled in the Authentication methods policy, but the migration is "${migration}": the legacy MFA and SSPR policies still apply and may allow SMS or voice. Complete the migration.`,
        [],
        evidence,
      );
    }
    return pass('SMS and voice authentication are disabled.', { evidence });
  },

  async 'm365.authenticator-number-matching'(ctx) {
    const p = await authMethodsPolicy(ctx);
    let cfg = (p.authenticationMethodConfigurations ?? []).find((m: any) => String(m.id).toLowerCase() === 'microsoftauthenticator');
    if (cfg && !cfg.featureSettings) {
      cfg = await graph<any>(ctx, '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/MicrosoftAuthenticator').catch(() => cfg);
    }
    if (!cfg) throw new CheckError('The Microsoft Authenticator configuration was not returned by the Authentication methods policy.');
    if (cfg.state !== 'enabled') return na('Microsoft Authenticator is disabled in the Authentication methods policy.');
    const fs = cfg.featureSettings ?? {};
    const setting = (k: string) => ({ state: fs[k]?.state as string | undefined, target: fs[k]?.includeTarget?.id as string | undefined });
    const nm = setting('numberMatchingRequiredState');
    const app = setting('displayAppInformationRequiredState');
    const loc = setting('displayLocationInformationRequiredState');
    const evidence = { numberMatching: nm.state ?? 'default', applicationName: app.state ?? 'default', geographicLocation: loc.state ?? 'default' };
    const ref = [{ id: 'MicrosoftAuthenticator', name: 'Microsoft Authenticator', type: 'Authentication method', url: AUTH_METHODS_URL }];
    if (nm.state === 'disabled') return fail('Number matching is disabled for Microsoft Authenticator push notifications (MFA fatigue risk).', ref, evidence);
    const gaps: string[] = [];
    for (const [label, s] of [
      ['application name', app],
      ['geographic location', loc],
    ] as const) {
      if (s.state !== 'enabled') gaps.push(`${label} ${s.state ?? 'default'}`);
      else if (s.target && s.target !== 'all_users') gaps.push(`${label} only for some users`);
    }
    if (gaps.length) return warn(`Number matching is on, but additional context is not shown to all users: ${gaps.join(', ')}.`, ref, evidence);
    return pass('Microsoft Authenticator requires number matching and shows the application name and location.', { evidence });
  },

  async 'm365.email-auth'(ctx) {
    const all = (await graphAll<any>(ctx, '/domains')).filter(
      (d) => d.isVerified && !d.id.endsWith('.onmicrosoft.com') && (d.supportedServices ?? []).includes('Email'),
    );
    const domains = all.slice(0, MAX_MAIL_DOMAINS); // bounded DNS work
    if (!domains.length) return na('No verified custom mail domains.');
    const issues: ResourceRef[] = [];
    const unchecked: string[] = [];
    let severe = false;
    const spfCache = new Map<string, string | null>();
    await mapLimit(domains, 5, async (d: any) => {
      const domain = String(d.id).toLowerCase();
      const [spfTxt, dmarcTxt] = await Promise.all([txtRecords(domain), txtRecords(`_dmarc.${domain}`)]);
      if ('error' in spfTxt || 'error' in dmarcTxt) {
        unchecked.push(`${domain} (DNS lookup failed: ${'error' in spfTxt ? spfTxt.error : (dmarcTxt as { error: string }).error})`);
        return;
      }
      const problems: string[] = [];
      // SPF
      const spfs = spfTxt.records.filter((t) => t.toLowerCase().startsWith('v=spf1'));
      if (!spfs.length) {
        problems.push('no SPF');
        severe = true;
      } else if (spfs.length > 1) {
        problems.push(`${spfs.length} SPF records (SPF permerror)`);
        severe = true;
      } else {
        const p = spfProblem(spfs[0]);
        if (p) problems.push(p.text);
        if (p?.severe) severe = true;
        const lookups = await spfLookups(spfs[0], spfCache);
        if (lookups > SPF_LOOKUP_LIMIT) {
          problems.push(`SPF needs more than ${SPF_LOOKUP_LIMIT} DNS lookups (SPF permerror)`);
          severe = true;
        }
      }
      // DMARC (a subdomain without its own record inherits the organisational domain's sp=, or p=)
      const dmarcs = dmarcTxt.records.filter((t) => t.toLowerCase().startsWith('v=dmarc1'));
      if (dmarcs.length > 1) problems.push(`${dmarcs.length} DMARC records (receivers ignore DMARC)`);
      else if (dmarcs.length === 1) {
        const rec = dmarcs[0];
        const pol = dmarcTag(rec, 'p');
        if (!pol || !DMARC_POLICIES.has(pol)) problems.push('DMARC without a valid p= tag (treated as p=none)');
        else if (pol === 'none') problems.push('DMARC p=none');
        const pct = dmarcTag(rec, 'pct');
        if (pct !== undefined && Number(pct) < 100 && pol !== 'none') problems.push(`DMARC pct=${pct} (policy applies to only ${pct}% of mail)`);
        if (dmarcTag(rec, 'sp') === 'none' && pol !== 'none') problems.push('DMARC sp=none (subdomains not protected)');
      } else {
        const org = organisationalDomain(domain);
        const orgTxt = org !== domain ? await txtRecords(`_dmarc.${org}`) : { records: [] as string[] };
        const orgRec = 'records' in orgTxt ? orgTxt.records.find((t) => t.toLowerCase().startsWith('v=dmarc1')) : undefined;
        if (!orgRec) {
          problems.push('no DMARC');
          severe = true;
        } else {
          const inherited = dmarcTag(orgRec, 'sp') ?? dmarcTag(orgRec, 'p');
          if (!inherited || !DMARC_POLICIES.has(inherited) || inherited === 'none') problems.push(`inherits DMARC from ${org} with ${inherited ? `policy ${inherited}` : 'no valid policy'}`);
        }
      }
      // DKIM for Exchange Online: selector1/selector2 CNAMEs
      const [s1, s2] = await Promise.all([hasCname(`selector1._domainkey.${domain}`), hasCname(`selector2._domainkey.${domain}`)]);
      if (s1 === false && s2 === false) problems.push('DKIM not configured for Exchange Online (no selector1/selector2 CNAME)');
      if (problems.length) issues.push({ id: domain, name: domain, detail: problems.join(', '), type: 'Mail domain', url: M365_ADMIN_DOMAIN_URL(domain) });
    });
    const evaluated = domains.length - unchecked.length;
    const outcome = failIfAny(issues, (n) => `${n} of ${evaluated} mail domain(s) have SPF, DKIM or DMARC gaps.`, `All ${evaluated} mail domains have valid SPF, DKIM and enforcing DMARC.`, severe ? 'fail' : 'warn');
    const covered = applyCoverage(outcome, { evaluated, total: domains.length, skipped: unchecked, unit: 'mail domains', hint: 'DNS lookups failed; run the scan again later.' });
    return applyTruncation(covered, all.length > domains.length, domains.length, 'mail domains', all.length);
  },

  async 'm365.secure-score'(ctx) {
    const r = await needs('SecurityEvents.Read.All', graph<any>(ctx, '/security/secureScores?$top=1'));
    const s = r.value?.[0];
    if (!s) return na('Secure Score not available.');
    const pct = Math.round((s.currentScore / s.maxScore) * 100);
    const profiles = new Map<string, { title?: string; maxScore?: number }>();
    try {
      for (const p of await graphAll<any>(ctx, '/security/secureScoreControlProfiles?$top=999', false, 2000)) profiles.set(p.id, { title: p.title, maxScore: Number(p.maxScore) });
    } catch {
      // Without profiles the weakest controls are ranked by their percentage.
    }
    const controls = (s.controlScores ?? []).map((c: any) => {
      const prof = profiles.get(c.controlName);
      const max = prof?.maxScore && Number.isFinite(prof.maxScore) ? prof.maxScore : undefined;
      const score = Number(c.score ?? 0);
      const percent = Number.isFinite(Number(c.scoreInPercentage)) ? Number(c.scoreInPercentage) : max ? Math.round((score / max) * 100) : undefined;
      return { control: prof?.title ?? c.controlName, category: c.controlCategory, score, maxScore: max, percent, gap: max !== undefined ? max - score : undefined };
    });
    const weakest = controls
      .filter((c: any) => (c.gap ?? 1) > 0 && (c.percent ?? 0) < 100)
      .sort((a: any, b: any) => (b.gap ?? -1) - (a.gap ?? -1) || (a.percent ?? 0) - (b.percent ?? 0))
      .slice(0, 5);
    const ev = { currentScore: s.currentScore, maxScore: s.maxScore, percentage: pct, date: s.createdDateTime, weakestControls: weakest };
    const top = weakest.length ? ` Biggest gaps: ${weakest.slice(0, 3).map((c: any) => c.control).join(', ')}.` : '';
    const label = `${Math.round(s.currentScore)}/${Math.round(s.maxScore)}`;
    if (pct >= 70) return pass(`Secure Score is ${pct}% (${label}).${top}`, { evidence: ev });
    if (pct >= 45) return warn(`Secure Score is ${pct}% (${label}).${top}`, [], ev);
    return fail(`Secure Score is low: ${pct}% (${label}).${top}`, [], ev);
  },
};

export const m365Module: ProviderModule<MsCtx> = {
  async connect(config, secret, env, memo) {
    const app = msAppCredentials(config, secret, env);
    const token = await msToken(config.tenantId, app.clientId, app.clientSecret, 'https://graph.microsoft.com/.default');
    return { tenantId: config.tenantId, token, memo, subscriptionIds: [] };
  },
  async identity(ctx) {
    const org = await graph<any>(ctx, '/organization?$select=id,displayName,verifiedDomains');
    const o = org.value?.[0];
    const probes: Record<string, boolean> = {};
    for (const [name, path] of [
      ['Policy.Read.All', '/policies/authorizationPolicy'],
      ['RoleManagement.Read.Directory', '/directoryRoles?$top=1'],
      ['AuditLog.Read.All', '/reports/authenticationMethods/userRegistrationDetails?$top=1'],
      ['Application.Read.All', '/applications?$top=1&$select=id'],
    ] as const) {
      probes[name] = await graph(ctx, path).then(
        () => true,
        () => false,
      );
    }
    const missing = Object.entries(probes).filter(([, v]) => !v).map(([k]) => k);
    return {
      ok: true,
      message: `Connected to tenant "${o?.displayName}" (${o?.id}).${missing.length ? ` Limited: ${missing.join(', ')} not available, related checks may be skipped.` : ''}`,
      details: { tenantId: o?.id, displayName: o?.displayName, probes },
    };
  },
  checks,
};
