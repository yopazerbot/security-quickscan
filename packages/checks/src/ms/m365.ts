import { Resolver } from 'node:dns/promises';

const dns = new Resolver({ timeout: 3000, tries: 2 });
import type { CheckOutcome, ResourceRef } from '@qs/shared';
import type { ProviderModule } from '../types.js';
import { fail, failIfAny, mapLimit, na, pass, warn } from '../util.js';
import { graph, graphAll, msAppCredentials, msToken, type MsCtx } from './client.js';

const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const PRIVILEGED_ROLES = [
  GLOBAL_ADMIN,
  'e8611ab8-c189-46e8-94e1-60213ab1f814', // Privileged Role Administrator
  '7be44c8a-adaf-4e2a-84d6-ab2649e08a13', // Privileged Authentication Administrator
  '194ae4cb-b126-40b2-bd5b-6091b380977d', // Security Administrator
  '29232cdf-9323-42fd-ade2-1d097af3e4de', // Exchange Administrator
  'f28a1f50-f6e7-4571-818b-6a12f2af6b6c', // SharePoint Administrator
  'fe930be7-5e62-47db-91af-98c3a49a38b1', // User Administrator
  'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9', // Conditional Access Administrator
  '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', // Application Administrator
  '158c047a-c907-4556-b7ef-446551a6b5f7', // Cloud Application Administrator
  '3a2c62db-5318-420d-8d74-23affee5d9d5', // Intune Administrator
];
const PHISHING_RESISTANT_STRENGTH = '00000000-0000-0000-0000-000000000004';
const RISKY_GRAPH_ROLES = new Set([
  'Directory.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
  'AppRoleAssignment.ReadWrite.All',
  'Application.ReadWrite.All',
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
  'full_access_as_app',
]);

interface CaPolicy {
  id: string;
  displayName: string;
  state: 'enabled' | 'disabled' | 'enabledForReportingButNotEnforced';
  conditions: any;
  grantControls: any;
}

const caPolicies = (ctx: MsCtx) => ctx.memo.get('ca', () => graphAll<CaPolicy>(ctx, '/identity/conditionalAccess/policies'));
const securityDefaults = (ctx: MsCtx) =>
  ctx.memo.get('secdef', async () => Boolean((await graph(ctx, '/policies/identitySecurityDefaultsEnforcementPolicy')).isEnabled));
const authzPolicy = (ctx: MsCtx) =>
  ctx.memo.get('authz', async () => {
    const p: any = await graph(ctx, '/policies/authorizationPolicy');
    return Array.isArray(p.value) ? p.value[0] : p;
  });

const grants = (p: CaPolicy): string[] => p.grantControls?.builtInControls ?? [];
const requiresMfa = (p: CaPolicy) => grants(p).includes('mfa') || Boolean(p.grantControls?.authenticationStrength);
const blocks = (p: CaPolicy) => grants(p).includes('block');
const allUsers = (p: CaPolicy) => (p.conditions?.users?.includeUsers ?? []).includes('All');
const allApps = (p: CaPolicy) => (p.conditions?.applications?.includeApplications ?? []).includes('All');
const ref = (p: CaPolicy): ResourceRef => ({ id: p.id, name: p.displayName, detail: p.state });

/** Evaluate CA policies matching a predicate: enabled -> pass, report-only -> warn, none -> null. */
function caVerdict(policies: CaPolicy[], pred: (p: CaPolicy) => boolean) {
  const match = policies.filter(pred);
  const enabled = match.filter((p) => p.state === 'enabled');
  const reportOnly = match.filter((p) => p.state === 'enabledForReportingButNotEnforced');
  return { enabled, reportOnly };
}

async function roleMembers(ctx: MsCtx, templateId: string): Promise<any[]> {
  return ctx.memo.get(`role:${templateId}`, async () => {
    const roles = await ctx.memo.get('directoryRoles', () => graphAll(ctx, '/directoryRoles'));
    const role = roles.find((r: any) => r.roleTemplateId === templateId);
    if (!role) return [];
    return graphAll(ctx, `/directoryRoles/${role.id}/members?$select=id,displayName,userPrincipalName,onPremisesSyncEnabled`);
  });
}

const checks: Record<string, (ctx: MsCtx) => Promise<CheckOutcome>> = {
  async 'm365.mfa-all-users'(ctx) {
    if (await securityDefaults(ctx)) return pass('Security Defaults are enabled (MFA required for all users).');
    const { enabled, reportOnly } = caVerdict(await caPolicies(ctx), (p) => requiresMfa(p) && allUsers(p) && allApps(p));
    if (enabled.length) return pass(`MFA enforced for all users by: ${enabled.map((p) => p.displayName).join(', ')}.`, { resources: enabled.map(ref) });
    if (reportOnly.length) return warn('An all-users MFA policy exists but is in report-only mode.', reportOnly.map(ref));
    return fail('No Security Defaults and no enabled Conditional Access policy requiring MFA for all users and all apps.');
  },

  async 'm365.legacy-auth'(ctx) {
    if (await securityDefaults(ctx)) return pass('Security Defaults block legacy authentication.');
    const { enabled, reportOnly } = caVerdict(await caPolicies(ctx), (p) => {
      const types: string[] = p.conditions?.clientAppTypes ?? [];
      return blocks(p) && allUsers(p) && types.includes('exchangeActiveSync') && types.includes('other');
    });
    if (enabled.length) return pass('Legacy authentication is blocked by Conditional Access.', { resources: enabled.map(ref) });
    if (reportOnly.length) return warn('A legacy authentication block policy exists in report-only mode.', reportOnly.map(ref));
    return fail('Legacy authentication is not blocked for all users.');
  },

  async 'm365.admin-mfa'(ctx) {
    if (await securityDefaults(ctx)) return warn('Security Defaults require MFA for admins, but not phishing-resistant MFA.');
    const policies = (await caPolicies(ctx)).filter((p) => p.state === 'enabled' && allApps(p));
    const coversAdmins = (p: CaPolicy) => allUsers(p) || (p.conditions?.users?.includeRoles ?? []).includes(GLOBAL_ADMIN);
    const strong = policies.filter((p) => coversAdmins(p) && p.grantControls?.authenticationStrength?.id === PHISHING_RESISTANT_STRENGTH);
    if (strong.length) return pass('Administrators must use phishing-resistant MFA.', { resources: strong.map(ref) });
    const mfa = policies.filter((p) => coversAdmins(p) && requiresMfa(p));
    if (mfa.length) return warn('Administrators require MFA, but not a phishing-resistant authentication strength.', mfa.map(ref));
    return fail('No enabled Conditional Access policy requires MFA for administrator roles.');
  },

  async 'm365.global-admin-count'(ctx) {
    const members = await roleMembers(ctx, GLOBAL_ADMIN);
    const res = members.map((m: any) => ({ id: m.id, name: m.userPrincipalName ?? m.displayName }));
    if (members.length < 2) return warn(`Only ${members.length} active Global Administrator(s): risk of lock-out. Ensure emergency access accounts exist.`, res);
    if (members.length > 4) return fail(`${members.length} active Global Administrators (recommended 2-4).`, res);
    return pass(`${members.length} active Global Administrators.`, { resources: res });
  },

  async 'm365.admins-cloud-only'(ctx) {
    const seen = new Map<string, ResourceRef>();
    for (const t of PRIVILEGED_ROLES) {
      for (const m of await roleMembers(ctx, t)) {
        if (m.onPremisesSyncEnabled) seen.set(m.id, { id: m.id, name: m.userPrincipalName ?? m.displayName, detail: 'synchronised from on-premises' });
      }
    }
    return failIfAny([...seen.values()], (n) => `${n} privileged account(s) are synchronised from on-premises AD.`, 'All privileged role members are cloud-only accounts.');
  },

  async 'm365.mfa-registration'(ctx) {
    const rows = await graphAll<any>(ctx, '/reports/authenticationMethods/userRegistrationDetails?$top=999');
    const members = rows.filter((r) => r.userType !== 'guest');
    if (!members.length) return na('No users found.');
    const missing = members.filter((r) => !r.isMfaRegistered);
    const pct = Math.round(((members.length - missing.length) / members.length) * 100);
    const res = missing.map((r) => ({ id: r.id, name: r.userPrincipalName }));
    const ev = { registered: members.length - missing.length, total: members.length, percentage: pct };
    if (pct >= 95) return pass(`${pct}% of ${members.length} users are registered for MFA.`, { resources: res, evidence: ev });
    if (pct >= 80) return warn(`${pct}% of users registered for MFA (${missing.length} missing).`, res, ev);
    return fail(`Only ${pct}% of users registered for MFA (${missing.length} missing).`, res, ev);
  },

  async 'm365.user-consent'(ctx) {
    const p = await authzPolicy(ctx);
    const assigned: string[] = p.defaultUserRolePermissions?.permissionGrantPoliciesAssigned ?? [];
    const legacy = assigned.find((a) => a.endsWith('microsoft-user-default-legacy'));
    if (legacy) return fail('Users can consent to any application requesting any delegated permission.', [], { assigned });
    if (assigned.some((a) => a.includes('microsoft-user-default-low'))) return pass('User consent is limited to verified publishers and low-impact permissions.', { evidence: { assigned } });
    return pass('User consent to applications is disabled.', { evidence: { assigned } });
  },

  async 'm365.user-app-registration'(ctx) {
    const p = await authzPolicy(ctx);
    return p.defaultUserRolePermissions?.allowedToCreateApps ? warn('All users can register applications.') : pass('Users cannot register applications.');
  },

  async 'm365.guest-invites'(ctx) {
    const v = (await authzPolicy(ctx)).allowInvitesFrom;
    if (v === 'everyone') return fail('Everyone, including guests, can invite external users.', [], { allowInvitesFrom: v });
    if (v === 'adminsGuestInvitersAndAllMembers') return warn('All member users can invite guests.', [], { allowInvitesFrom: v });
    return pass(`Guest invitations restricted (${v}).`);
  },

  async 'm365.guest-access'(ctx) {
    const id = (await authzPolicy(ctx)).guestUserRoleId;
    if (id === '2af84b1e-32c8-42b7-82bc-daa82404023b') return pass('Guest access is restricted to their own directory objects.');
    if (id === 'a0b1b346-4d3e-4e8b-98f8-753987be4970') return fail('Guests have the same directory access as members.');
    return warn('Guests have limited access to directory objects (default); consider the most restrictive setting.');
  },

  async 'm365.stale-accounts'(ctx) {
    const users = await graphAll<any>(ctx, '/users?$select=id,displayName,userPrincipalName,accountEnabled,signInActivity,createdDateTime,userType&$top=999');
    const cutoff = Date.now() - 90 * 86_400_000;
    const stale = users.filter((u) => {
      if (!u.accountEnabled || Date.parse(u.createdDateTime) > cutoff) return false;
      const last = u.signInActivity?.lastSuccessfulSignInDateTime ?? u.signInActivity?.lastSignInDateTime;
      return !last || Date.parse(last) < cutoff;
    });
    return failIfAny(
      stale.map((u) => ({ id: u.id, name: u.userPrincipalName, detail: `${u.userType}, last sign-in ${(u.signInActivity?.lastSignInDateTime ?? 'never').slice(0, 10)}` })),
      (n) => `${n} enabled account(s) without sign-in for 90+ days.`,
      'No stale enabled accounts.',
      stale.length > 10 ? 'fail' : 'warn',
    );
  },

  async 'm365.risky-app-permissions'(ctx) {
    const sps = await graph<any>(ctx, "/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'&$select=id,appRoles");
    const graphSp = sps.value?.[0];
    if (!graphSp) return na('Microsoft Graph service principal not found.');
    const roleById = new Map<string, string>(graphSp.appRoles.map((r: any) => [r.id, r.value]));
    const assignments = await graphAll<any>(ctx, `/servicePrincipals/${graphSp.id}/appRoleAssignedTo?$top=999`);
    const byApp = new Map<string, { name: string; perms: Set<string> }>();
    for (const a of assignments) {
      const perm = roleById.get(a.appRoleId);
      if (!perm || !RISKY_GRAPH_ROLES.has(perm)) continue;
      const e = byApp.get(a.principalId) ?? { name: a.principalDisplayName, perms: new Set() };
      e.perms.add(perm);
      byApp.set(a.principalId, e);
    }
    const res = [...byApp.entries()].map(([id, e]) => ({ id, name: e.name, detail: [...e.perms].join(', ') }));
    return failIfAny(res, (n) => `${n} application(s) hold high-impact Microsoft Graph application permissions.`, 'No applications hold high-impact Graph application permissions.', res.length > 3 ? 'fail' : 'warn');
  },

  async 'm365.pim'(ctx) {
    const elig = await graph<any>(ctx, '/roleManagement/directory/roleEligibilitySchedules?$top=50');
    const n = elig.value?.length ?? 0;
    return n > 0 ? pass(`PIM is used (${n}${elig['@odata.nextLink'] ? '+' : ''} eligible role assignments).`) : warn('No PIM eligible role assignments: privileged roles are permanently assigned.');
  },

  async 'm365.risk-policies'(ctx) {
    const { enabled, reportOnly } = caVerdict(
      await caPolicies(ctx),
      (p) => (p.conditions?.signInRiskLevels ?? []).length > 0 || (p.conditions?.userRiskLevels ?? []).length > 0,
    );
    if (enabled.length) return pass('Risk-based Conditional Access policies are enabled.', { resources: enabled.map(ref) });
    if (reportOnly.length) return warn('Risk-based policies exist in report-only mode.', reportOnly.map(ref));
    return fail('No sign-in or user risk Conditional Access policies.');
  },

  async 'm365.device-compliance'(ctx) {
    const { enabled, reportOnly } = caVerdict(await caPolicies(ctx), (p) => grants(p).some((g) => g === 'compliantDevice' || g === 'domainJoinedDevice'));
    if (enabled.length) return pass('Conditional Access requires compliant or joined devices.', { resources: enabled.map(ref) });
    if (reportOnly.length) return warn('Device-based policies exist in report-only mode.', reportOnly.map(ref));
    return fail('No Conditional Access policy requires managed devices.');
  },

  async 'm365.weak-auth-methods'(ctx) {
    const p = await graph<any>(ctx, '/policies/authenticationMethodsPolicy');
    const weak = (p.authenticationMethodConfigurations ?? []).filter((m: any) => ['Sms', 'Voice'].includes(m.id) && m.state === 'enabled');
    return failIfAny(weak.map((m: any) => ({ id: m.id, name: m.id })), () => `Weak methods enabled: ${weak.map((m: any) => m.id).join(', ')}.`, 'SMS and voice authentication are disabled.', 'warn');
  },

  async 'm365.email-auth'(ctx) {
    const domains = (await graphAll<any>(ctx, '/domains')).filter(
      (d) => d.isVerified && !d.id.endsWith('.onmicrosoft.com') && (d.supportedServices ?? []).includes('Email'),
    );
    domains.splice(50); // bounded DNS work
    if (!domains.length) return na('No verified custom mail domains.');
    const issues: ResourceRef[] = [];
    await mapLimit(domains, 5, async (d: any) => {
      const txt = async (n: string) => (await dns.resolveTxt(n).catch(() => [] as string[][])).map((r) => r.join(''));
      const spf = (await txt(d.id)).find((t) => t.toLowerCase().startsWith('v=spf1'));
      const dmarc = (await txt(`_dmarc.${d.id}`)).find((t) => t.toLowerCase().startsWith('v=dmarc1'));
      const problems: string[] = [];
      if (!spf) problems.push('no SPF');
      else if (/[+?]all\b/.test(spf)) problems.push('SPF too permissive');
      const pol = dmarc?.match(/\bp=(\w+)/i)?.[1]?.toLowerCase();
      if (!dmarc) problems.push('no DMARC');
      else if (pol === 'none') problems.push('DMARC p=none');
      if (problems.length) issues.push({ id: d.id, name: d.id, detail: problems.join(', ') });
    });
    const severe = issues.some((i) => /no (SPF|DMARC)/.test(i.detail ?? ''));
    return failIfAny(issues, (n) => `${n} of ${domains.length} mail domain(s) lack SPF/DMARC enforcement.`, `All ${domains.length} mail domains have SPF and enforcing DMARC.`, severe ? 'fail' : 'warn');
  },

  async 'm365.secure-score'(ctx) {
    const r = await graph<any>(ctx, '/security/secureScores?$top=1');
    const s = r.value?.[0];
    if (!s) return na('Secure Score not available.');
    const pct = Math.round((s.currentScore / s.maxScore) * 100);
    const ev = { currentScore: s.currentScore, maxScore: s.maxScore, percentage: pct, date: s.createdDateTime };
    if (pct >= 70) return pass(`Secure Score is ${pct}% (${Math.round(s.currentScore)}/${Math.round(s.maxScore)}).`, { evidence: ev });
    if (pct >= 45) return warn(`Secure Score is ${pct}% (${Math.round(s.currentScore)}/${Math.round(s.maxScore)}).`, [], ev);
    return fail(`Secure Score is low: ${pct}%.`, [], ev);
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
