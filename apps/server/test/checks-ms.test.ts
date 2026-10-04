import { runSystem } from '@qs/checks';
import type { CheckOutcome, Provider } from '@qs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** DNS answers for the email-auth check: TXT / CNAME records per name, or an error code. */
const dnsTxt = vi.hoisted(() => new Map<string, string[] | string>());
const dnsCname = vi.hoisted(() => new Map<string, string[] | string>());
vi.mock('node:dns/promises', () => {
  const answer = (map: Map<string, string[] | string>, name: string, kind: string) => {
    const a = map.get(name);
    if (a === undefined) throw Object.assign(new Error(`query${kind} ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    if (typeof a === 'string') throw Object.assign(new Error(`query${kind} ${a} ${name}`), { code: a });
    return a;
  };
  return {
    Resolver: class {
      async resolveTxt(name: string) {
        return answer(dnsTxt, name, 'Txt').map((t) => [t]);
      }
      async resolveCname(name: string) {
        return answer(dnsCname, name, 'Cname');
      }
    },
  };
});

type Route = unknown | ((url: string) => Response);
const reply = (status: number, body?: unknown) => () => new Response(body === undefined ? null : JSON.stringify(body), { status });

/** Routes fetch calls to canned responses (first key contained in the decoded URL wins). */
function mockFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: URL | string) => {
    const url = decodeURIComponent(String(input));
    if (url.includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'eyJ.fake.token' }), { status: 200 });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error: { code: 'NotFound', message: url } }), { status: 404 });
    const r = routes[key];
    return typeof r === 'function' ? (r as (u: string) => Response)(url) : new Response(JSON.stringify(r), { status: 200 });
  });
}

const M365 = { authMode: 'app_secret', tenantId: 'contoso.onmicrosoft.com', clientId: '00000000-0000-0000-0000-000000000002' };
const SECRET = { clientSecret: 'x'.repeat(20) };

async function runAs(provider: Provider, config: unknown, checkIds: string[], routes: Record<string, Route>) {
  vi.stubGlobal('fetch', mockFetch(routes));
  const out: Record<string, CheckOutcome> = {};
  await runSystem({
    systemId: '00000000-0000-0000-0000-000000000001',
    provider,
    config,
    secret: SECRET,
    checkIds,
    env: {},
    onStart: async () => {},
    onResult: async (id, o) => {
      out[id] = o;
    },
    shouldStop: async () => false,
  });
  return out;
}

const m365 = async (id: string, routes: Record<string, Route>) => (await runAs('m365', M365, [id], routes))[id];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dnsTxt.clear();
  dnsCname.clear();
});

// ---------------------------------------------------------------------------------------------------------------
// Conditional Access
// ---------------------------------------------------------------------------------------------------------------

const GA = '62e90394-69f5-4237-9190-012177145e10';
const CIS_ROLES = [
  GA,
  'e8611ab8-c189-46e8-94e1-60213ab1f814',
  '194ae4cb-b126-40b2-bd5b-6091b380977d',
  '29232cdf-9323-42fd-ade2-1d097af3e4de',
  'f28a1f50-f6e7-4571-818b-6a12f2af6b6c',
  'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9',
  '729827e3-9c14-49f7-bb1b-9608f156bbb8',
  'b0f54661-2d74-4c50-afa3-1ec803f12efe',
  'fe930be7-5e62-47db-91af-98c3a49a38b1',
  'c4e39bd9-1100-46d3-8c65-fb160da0071f',
  '7be44c8a-adaf-4e2a-84d6-ab2649e08a13',
  '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
  '158c047a-c907-4556-b7ef-446551a6b5f7',
  '3a2c62db-5318-420d-8d74-23affee5d9d5',
];

function policy(over: { users?: any; apps?: any; conditions?: any; grant?: any; session?: any; state?: string; id?: string; name?: string } = {}) {
  return {
    id: over.id ?? 'p1',
    displayName: over.name ?? 'CA policy',
    state: over.state ?? 'enabled',
    conditions: { users: { includeUsers: ['All'], ...over.users }, applications: { includeApplications: ['All'], ...over.apps }, clientAppTypes: ['all'], ...over.conditions },
    grantControls: over.grant === undefined ? { operator: 'OR', builtInControls: ['mfa'] } : over.grant,
    sessionControls: over.session ?? null,
  };
}

const ca = (...policies: unknown[]) => ({
  identitySecurityDefaultsEnforcementPolicy: { isEnabled: false },
  'conditionalAccess/policies': { value: policies },
});

describe('Conditional Access evaluator (m365.mfa-all-users)', () => {
  it('passes with break-glass exclusions and lists them', async () => {
    const o = await m365('m365.mfa-all-users', { '/users/bg1': { id: 'bg1', userPrincipalName: 'bg1@contoso.com' }, ...ca(policy({ users: { excludeUsers: ['bg1', 'bg2'] } })) });
    expect(o.status).toBe('pass');
    expect(o.summary).toContain('break-glass');
    const bg = o.resources?.find((r) => r.id === 'bg1');
    expect(bg?.name).toBe('bg1@contoso.com');
    expect(bg?.detail).toBe('break-glass exclusion');
    expect(o.resources?.find((r) => r.id === 'p1')?.url).toContain('PolicyBlade');
    expect(o.evidence?.breakGlassExclusions).toEqual(['bg1@contoso.com', 'bg2']);
  });

  it('warns when exclusions go beyond break-glass accounts (3 users, or any group)', async () => {
    const users = await m365('m365.mfa-all-users', ca(policy({ users: { excludeUsers: ['a', 'b', 'c'] } })));
    expect(users.status).toBe('warn');
    expect(users.summary).toContain('3 user(s)');
    expect(users.resources?.filter((r) => r.type === 'User')).toHaveLength(3);
    const group = await m365('m365.mfa-all-users', ca(policy({ users: { excludeGroups: ['g1'] } })));
    expect(group.status).toBe('warn');
    expect(group.resources?.some((r) => r.type === 'Group' && r.id === 'g1')).toBe(true);
  });

  it('does not count policies narrowed by location or risk, and attaches them as near misses', async () => {
    const loc = await m365('m365.mfa-all-users', ca(policy({ conditions: { locations: { includeLocations: ['All'], excludeLocations: ['AllTrusted'] } } })));
    expect(loc.status).toBe('fail');
    expect(loc.resources?.[0].detail).toContain('location');
    expect(loc.resources?.[0].type).toBe('Conditional Access policy');
    const risk = await m365('m365.mfa-all-users', ca(policy({ conditions: { signInRiskLevels: ['high'] } })));
    expect(risk.status).toBe('fail');
    expect(risk.resources?.[0].detail).toContain('sign-in risk');
    const someUsers = await m365('m365.mfa-all-users', ca(policy({ users: { includeUsers: [], includeGroups: ['g1'] } })));
    expect(someUsers.status).toBe('fail');
  });

  it('does not count an OR grant with a weaker alternative, but counts AND', async () => {
    const or = await m365('m365.mfa-all-users', ca(policy({ grant: { operator: 'OR', builtInControls: ['mfa', 'compliantDevice'] } })));
    expect(or.status).toBe('fail');
    expect(or.resources?.[0].detail).toContain('OR');
    const and = await m365('m365.mfa-all-users', ca(policy({ grant: { operator: 'AND', builtInControls: ['mfa', 'compliantDevice'] } })));
    expect(and.status).toBe('pass');
  });

  it('warns for report-only and ignores disabled policies', async () => {
    expect((await m365('m365.mfa-all-users', ca(policy({ state: 'enabledForReportingButNotEnforced' })))).status).toBe('warn');
    const disabled = await m365('m365.mfa-all-users', ca(policy({ state: 'disabled' })));
    expect(disabled.status).toBe('fail');
    expect(disabled.resources?.[0].detail).toContain('disabled');
  });
});

describe('m365.legacy-auth', () => {
  const legacy = (over: Parameters<typeof policy>[0] = {}) => policy({ grant: { operator: 'OR', builtInControls: ['block'] }, conditions: { clientAppTypes: ['exchangeActiveSync', 'other'] }, ...over });
  it('requires all apps and both legacy client types', async () => {
    expect((await m365('m365.legacy-auth', ca(legacy()))).status).toBe('pass');
    expect((await m365('m365.legacy-auth', ca(legacy({ apps: { includeApplications: ['Office365'] } })))).status).toBe('fail');
    const partial = await m365('m365.legacy-auth', ca(legacy({ conditions: { clientAppTypes: ['other'] } })));
    expect(partial.status).toBe('fail');
    expect(partial.resources?.[0].detail).toContain('exchangeActiveSync');
  });
});

describe('m365.admin-mfa', () => {
  const strengths = (combos: string[]) => ({ 'authenticationStrength/policies': { value: [{ id: 'custom1', allowedCombinations: combos }] } });
  const adminPolicy = (grant: any, over: Parameters<typeof policy>[0] = {}) => policy({ users: { includeUsers: [], includeRoles: CIS_ROLES }, grant, ...over });

  it('accepts a custom authentication strength with only phishing-resistant methods', async () => {
    const o = await m365('m365.admin-mfa', { ...strengths(['fido2', 'windowsHelloForBusiness']), ...ca(adminPolicy({ operator: 'OR', authenticationStrength: { id: 'custom1' } })) });
    expect(o.status).toBe('pass');
  });

  it('warns for a custom strength that allows weaker methods, or plain MFA', async () => {
    const weak = await m365('m365.admin-mfa', { ...strengths(['fido2', 'password,microsoftAuthenticatorPush']), ...ca(adminPolicy({ operator: 'OR', authenticationStrength: { id: 'custom1' } })) });
    expect(weak.status).toBe('warn');
    expect(weak.summary).toContain('phishing-resistant');
    const mfa = await m365('m365.admin-mfa', ca(adminPolicy({ operator: 'OR', builtInControls: ['mfa'] })));
    expect(mfa.status).toBe('warn');
  });

  it('passes with the built-in phishing-resistant strength and warns when only Global Admin is covered', async () => {
    const builtin = { operator: 'OR', authenticationStrength: { id: '00000000-0000-0000-0000-000000000004' } };
    expect((await m365('m365.admin-mfa', ca(adminPolicy(builtin)))).status).toBe('pass');
    const gaOnly = await m365('m365.admin-mfa', ca(adminPolicy(builtin, { users: { includeUsers: [], includeRoles: [GA] } })));
    expect(gaOnly.status).toBe('warn');
    expect(gaOnly.summary).toContain('13 of 14');
    expect(gaOnly.resources?.some((r) => r.type === 'Directory role' && r.name === 'Billing Administrator')).toBe(true);
  });

  it('treats report-only like the other checks', async () => {
    const o = await m365('m365.admin-mfa', ca(adminPolicy({ operator: 'OR', builtInControls: ['mfa'] }, { state: 'enabledForReportingButNotEnforced' })));
    expect(o.status).toBe('warn');
    expect(o.summary).toContain('report-only');
  });
});

describe('m365.risk-policies', () => {
  const signIn = policy({ id: 's', conditions: { signInRiskLevels: ['high', 'medium'] } });
  const user = policy({ id: 'u', conditions: { userRiskLevels: ['high'] }, grant: { operator: 'AND', builtInControls: ['mfa', 'passwordChange'] } });
  it('requires both sign-in and user risk coverage with a grant', async () => {
    expect((await m365('m365.risk-policies', ca(signIn, user))).status).toBe('pass');
    const one = await m365('m365.risk-policies', ca(signIn));
    expect(one.status).toBe('warn');
    expect(one.summary).toContain('user risk missing');
    expect((await m365('m365.risk-policies', ca())).status).toBe('fail');
  });
});

describe('new Conditional Access checks', () => {
  it('device code flow: pass when blocked, fail when not, n/a without licence', async () => {
    const block = policy({ grant: { operator: 'OR', builtInControls: ['block'] }, conditions: { authenticationFlows: { transferMethods: 'deviceCodeFlow' } } });
    expect((await m365('m365.device-code-flow', ca(block))).status).toBe('pass');
    expect((await m365('m365.device-code-flow', ca(policy()))).status).toBe('fail');
    const unlicensed = await m365('m365.device-code-flow', {
      'conditionalAccess/policies': reply(403, { error: { code: 'Forbidden', message: 'Tenant does not have a premium license (AadPremiumLicenseRequired).' } }),
    });
    expect(unlicensed.status).toBe('na');
  });

  it('admin session controls: pass at 4 hours and never persistent, warn at 12 hours, fail without', async () => {
    const session = (value: number) => policy({ users: { includeUsers: [], includeRoles: CIS_ROLES }, grant: null, session: { signInFrequency: { isEnabled: true, type: 'hours', value }, persistentBrowser: { isEnabled: true, mode: 'never' } } });
    expect((await m365('m365.admin-session-controls', ca(session(4)))).status).toBe('pass');
    const long = await m365('m365.admin-session-controls', ca(session(12)));
    expect(long.status).toBe('warn');
    expect(long.resources?.some((r) => r.detail?.includes('longer than 4 hours'))).toBe(true);
    expect((await m365('m365.admin-session-controls', ca(policy()))).status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Directory roles, PIM, applications
// ---------------------------------------------------------------------------------------------------------------

const roleRoutes = (members: unknown[], extra: Record<string, Route> = {}) => ({
  ...extra,
  '/directoryRoles/r1/members': { value: members },
  '/directoryRoles': { value: [{ id: 'r1', roleTemplateId: GA }] },
});

describe('m365.global-admin-count and privileged role holders', () => {
  const members = [
    { id: 'u1', userPrincipalName: 'a@contoso.com', accountEnabled: true },
    { '@odata.type': '#microsoft.graph.group', id: 'g1', displayName: 'Tier0 Admins' },
    { id: 'u2', userPrincipalName: 'disabled@contoso.com', accountEnabled: false },
  ];
  const groupAndPim = (eligible: unknown[]) => ({
    '/groups/g1/transitiveMembers': { value: [{ id: 'u3', userPrincipalName: 'c@contoso.com', accountEnabled: true }, { id: 'u4', userPrincipalName: 'd@contoso.com', accountEnabled: true, onPremisesSyncEnabled: true }] },
    roleEligibilitySchedules: { value: eligible },
  });

  it('counts PIM-eligible members and role-assignable group members, and skips disabled accounts', async () => {
    const eligible = [{ roleDefinitionId: GA, directoryScopeId: '/', principal: { id: 'u5', userPrincipalName: 'e@contoso.com', accountEnabled: true } }];
    const o = await m365('m365.global-admin-count', roleRoutes(members, groupAndPim(eligible)));
    expect(o.status).toBe('pass');
    expect(o.summary).toContain('4 Global Administrator(s) (1 PIM-eligible)');
    expect(o.resources?.find((r) => r.id === 'u3')?.detail).toContain('via group Tier0 Admins');
    expect(o.resources?.some((r) => r.id === 'u2')).toBe(false);
    const more = [...eligible, { roleDefinitionId: GA, directoryScopeId: '/', principal: { id: 'u6', userPrincipalName: 'f@contoso.com', accountEnabled: true } }];
    expect((await m365('m365.global-admin-count', roleRoutes(members, groupAndPim(more)))).status).toBe('fail');
  });

  it('flags synchronised accounts reached through a role-assignable group', async () => {
    const o = await m365('m365.admins-cloud-only', roleRoutes(members, groupAndPim([])));
    expect(o.status).toBe('fail');
    expect(o.resources?.map((r) => r.id)).toEqual(['u4']);
  });

  it('privileged guests: fails for a guest Global Administrator, passes otherwise', async () => {
    const guest = [{ id: 'gx', userPrincipalName: 'p_partner.example#EXT#@contoso.com', userType: 'Guest', accountEnabled: true }];
    const bad = await m365('m365.privileged-guests', roleRoutes(guest, { roleEligibilitySchedules: { value: [] } }));
    expect(bad.status).toBe('fail');
    expect(bad.resources?.[0].detail).toContain('Global Administrator');
    const ok = await m365('m365.privileged-guests', roleRoutes([{ id: 'u1', userPrincipalName: 'a@contoso.com', userType: 'Member' }], { roleEligibilitySchedules: { value: [] } }));
    expect(ok.status).toBe('pass');
  });
});

describe('m365.pim', () => {
  const permanent = (id: string, role = GA) => ({ roleDefinitionId: role, directoryScopeId: '/', assignmentType: 'Assigned', memberType: 'Direct', endDateTime: null, principalId: id, principal: { id, userPrincipalName: `${id}@contoso.com`, accountEnabled: true } });
  const eligible = { value: [{ roleDefinitionId: GA, directoryScopeId: '/', principal: { id: 'e1' } }] };
  it('fails with more than 2 permanent Global Administrators and passes with break-glass only', async () => {
    const bad = await m365('m365.pim', { roleEligibilitySchedules: eligible, roleAssignmentScheduleInstances: { value: [permanent('a'), permanent('b'), permanent('c')] } });
    expect(bad.status).toBe('fail');
    const ok = await m365('m365.pim', { roleEligibilitySchedules: eligible, roleAssignmentScheduleInstances: { value: [permanent('a'), permanent('b')] } });
    expect(ok.status).toBe('pass');
    const other = await m365('m365.pim', { roleEligibilitySchedules: eligible, roleAssignmentScheduleInstances: { value: [permanent('a'), permanent('h', '729827e3-9c14-49f7-bb1b-9608f156bbb8')] } });
    expect(other.status).toBe('warn');
  });
});

describe('application permissions and credentials', () => {
  const graphSp = (roles: Record<string, string>, assignments: { principalId: string; role: string }[], extra: Record<string, Route> = {}) => ({
    ...extra,
    '/servicePrincipals?$filter=appId': { value: [{ id: 'graph', appRoles: Object.entries(roles).map(([id, value]) => ({ id, value })) }] },
    '/appRoleAssignedTo': { value: assignments.map((a) => ({ principalId: a.principalId, principalDisplayName: `App ${a.principalId}`, appRoleId: a.role })) },
  });

  it('always fails on Tier-0 permissions and warns on read-all and delegated tenant-wide grants', async () => {
    const tier0 = await m365('m365.risky-app-permissions', graphSp({ r1: 'RoleManagement.ReadWrite.Directory' }, [{ principalId: 'sp1', role: 'r1' }], { oauth2PermissionGrants: { value: [] } }));
    expect(tier0.status).toBe('fail');
    expect(tier0.resources?.[0].detail).toContain('Tier-0');
    expect(tier0.resources?.[0].url).toContain('ManagedAppMenuBlade');
    const read = await m365('m365.risky-app-permissions', graphSp({ r2: 'Files.Read.All' }, [{ principalId: 'sp2', role: 'r2' }], { oauth2PermissionGrants: { value: [] } }));
    expect(read.status).toBe('warn');
    expect(read.resources?.[0].detail).toContain('read-all');
    const delegated = await m365(
      'm365.risky-app-permissions',
      graphSp({}, [], { oauth2PermissionGrants: { value: [{ clientId: 'sp3', consentType: 'AllPrincipals', resourceId: 'graph', scope: 'openid User.Read Mail.ReadWrite' }] }, '/servicePrincipals/sp3': { id: 'sp3', displayName: 'Mail App' } }),
    );
    expect(delegated.status).toBe('warn');
    expect(delegated.resources?.[0].name).toBe('Mail App');
    expect(delegated.resources?.[0].detail).toContain('delegated for all users: Mail.ReadWrite');
    const none = await m365('m365.risky-app-permissions', graphSp({ r3: 'User.Read.All' }, [{ principalId: 'sp4', role: 'r3' }], { oauth2PermissionGrants: { value: [] } }));
    expect(none.status).toBe('pass');
  });

  it('flags long-lived secrets, expired credentials and privileged multi-tenant secrets', async () => {
    const day = 86_400_000;
    const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
    const app = (id: string, over: Record<string, unknown>) => ({ id, appId: `app-${id}`, displayName: id, signInAudience: 'AzureADMyOrg', passwordCredentials: [], keyCredentials: [], ...over });
    const longLived = await m365('m365.app-credentials', { '/applications': { value: [app('a1', { passwordCredentials: [{ startDateTime: iso(-10), endDateTime: iso(700) }] })] } });
    expect(longLived.status).toBe('warn');
    expect(longLived.resources?.[0].detail).toContain('more than 1 year');
    expect(longLived.resources?.[0].url).toContain('ApplicationMenuBlade');
    const expired = await m365('m365.app-credentials', { '/applications': { value: [app('a2', { keyCredentials: [{ startDateTime: iso(-400), endDateTime: iso(-5) }] })] } });
    expect(expired.status).toBe('warn');
    expect(expired.resources?.[0].detail).toContain('expired');
    const priv = await m365(
      'm365.app-credentials',
      graphSp({ r1: 'Mail.ReadWrite' }, [{ principalId: 'sp9', role: 'r1' }], {
        '/applications': { value: [app('a3', { signInAudience: 'AzureADMultipleOrgs', passwordCredentials: [{ startDateTime: iso(-10), endDateTime: iso(100) }] })] },
        "servicePrincipals(appId='app-a3')": { id: 'sp9' },
      }),
    );
    expect(priv.status).toBe('fail');
    expect(priv.resources?.[0].detail).toContain('multi-tenant');
    const clean = await m365('m365.app-credentials', { '/applications': { value: [app('a4', { passwordCredentials: [{ startDateTime: iso(-10), endDateTime: iso(170) }] })] } });
    expect(clean.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Authentication methods, guests, secure score, e-mail
// ---------------------------------------------------------------------------------------------------------------

describe('authentication methods policy', () => {
  const methods = (over: Record<string, unknown> = {}, authenticator?: unknown) => ({
    authenticationMethodsPolicy: {
      policyMigrationState: 'migrationComplete',
      authenticationMethodConfigurations: [{ id: 'Sms', state: 'disabled' }, { id: 'Voice', state: 'disabled' }, ...(authenticator ? [authenticator] : [])],
      ...over,
    },
  });
  const authenticator = (nm: string, app: string, loc: string) => ({
    id: 'MicrosoftAuthenticator',
    state: 'enabled',
    featureSettings: {
      numberMatchingRequiredState: { state: nm, includeTarget: { id: 'all_users' } },
      displayAppInformationRequiredState: { state: app, includeTarget: { id: 'all_users' } },
      displayLocationInformationRequiredState: { state: loc, includeTarget: { id: 'all_users' } },
    },
  });

  it('weak-auth-methods honours the migration state', async () => {
    expect((await m365('m365.weak-auth-methods', methods())).status).toBe('pass');
    const migrating = await m365('m365.weak-auth-methods', methods({ policyMigrationState: 'migrationInProgress' }));
    expect(migrating.status).toBe('warn');
    expect(migrating.summary).toContain('migrationInProgress');
  });

  it('number matching: pass with full context, warn on Microsoft-managed defaults, fail when disabled', async () => {
    expect((await m365('m365.authenticator-number-matching', methods({}, authenticator('enabled', 'enabled', 'enabled')))).status).toBe('pass');
    expect((await m365('m365.authenticator-number-matching', methods({}, authenticator('default', 'default', 'enabled')))).status).toBe('warn');
    expect((await m365('m365.authenticator-number-matching', methods({}, authenticator('disabled', 'enabled', 'enabled')))).status).toBe('fail');
  });
});

describe('guest invites and secure score', () => {
  it('reports an error instead of a pass when allowInvitesFrom is missing', async () => {
    const o = await m365('m365.guest-invites', { authorizationPolicy: { guestUserRoleId: 'x' } });
    expect(o.status).toBe('error');
    expect((await m365('m365.guest-invites', { authorizationPolicy: { allowInvitesFrom: 'adminsAndGuestInviters' } })).status).toBe('pass');
  });

  it('includes the weakest control scores in the evidence', async () => {
    const o = await m365('m365.secure-score', {
      secureScoreControlProfiles: { value: [{ id: 'MFARegistrationV2', title: 'Ensure all users can complete MFA', maxScore: 9 }, { id: 'BlockLegacyAuthentication', title: 'Block legacy authentication', maxScore: 8 }] },
      secureScores: { value: [{ currentScore: 50, maxScore: 100, createdDateTime: '2026-10-01', controlScores: [{ controlName: 'MFARegistrationV2', controlCategory: 'Identity', score: 0 }, { controlName: 'BlockLegacyAuthentication', controlCategory: 'Identity', score: 8 }] }] },
    });
    expect(o.status).toBe('warn');
    const weakest = o.evidence?.weakestControls as any[];
    expect(weakest).toHaveLength(1);
    expect(weakest[0].control).toBe('Ensure all users can complete MFA');
    expect(o.summary).toContain('Biggest gaps');
  });
});

describe('m365.email-auth', () => {
  const domains = (...ids: string[]) => ({ '/domains': { value: ids.map((id) => ({ id, isVerified: true, supportedServices: ['Email'] })) } });
  const dkim = (d: string) => {
    dnsCname.set(`selector1._domainkey.${d}`, [`selector1-x._domainkey.contoso.onmicrosoft.com`]);
    dnsCname.set(`selector2._domainkey.${d}`, [`selector2-x._domainkey.contoso.onmicrosoft.com`]);
  };

  it('passes a fully configured domain and flags missing DKIM', async () => {
    dnsTxt.set('a.example', ['v=spf1 include:spf.protection.outlook.com -all']);
    dnsTxt.set('_dmarc.a.example', ['v=DMARC1; p=reject']);
    dkim('a.example');
    expect((await m365('m365.email-auth', domains('a.example'))).status).toBe('pass');
    dnsCname.clear();
    const noDkim = await m365('m365.email-auth', domains('a.example'));
    expect(noDkim.status).toBe('warn');
    expect(noDkim.resources?.[0].detail).toContain('DKIM');
  });

  it('flags DMARC pct below 100 and sp=none', async () => {
    dnsTxt.set('a.example', ['v=spf1 -all']);
    dnsTxt.set('_dmarc.a.example', ['v=DMARC1; p=quarantine; pct=50; sp=none']);
    dkim('a.example');
    const o = await m365('m365.email-auth', domains('a.example'));
    expect(o.status).toBe('warn');
    expect(o.resources?.[0].detail).toContain('pct=50');
    expect(o.resources?.[0].detail).toContain('sp=none');
  });

  it('fails on multiple SPF records and on more than 10 DNS lookups', async () => {
    dnsTxt.set('a.example', ['v=spf1 -all', 'v=spf1 include:x.example -all']);
    dnsTxt.set('_dmarc.a.example', ['v=DMARC1; p=reject']);
    dkim('a.example');
    const multi = await m365('m365.email-auth', domains('a.example'));
    expect(multi.status).toBe('fail');
    expect(multi.resources?.[0].detail).toContain('2 SPF records');

    const includes = Array.from({ length: 6 }, (_, i) => `include:i${i}.example`).join(' ');
    dnsTxt.set('a.example', [`v=spf1 ${includes} -all`]);
    for (let i = 0; i < 6; i++) dnsTxt.set(`i${i}.example`, ['v=spf1 a mx -all']);
    const many = await m365('m365.email-auth', domains('a.example'));
    expect(many.status).toBe('fail');
    expect(many.resources?.[0].detail).toContain('more than 10 DNS lookups');
  });

  it('lets a subdomain inherit the organisational domain DMARC policy (sp, then p)', async () => {
    dnsTxt.set('mail.a.example', ['v=spf1 -all']);
    dnsTxt.set('_dmarc.a.example', ['v=DMARC1; p=reject']);
    dkim('mail.a.example');
    expect((await m365('m365.email-auth', domains('mail.a.example'))).status).toBe('pass');
    dnsTxt.set('_dmarc.a.example', ['v=DMARC1; p=reject; sp=none']);
    const weak = await m365('m365.email-auth', domains('mail.a.example'));
    expect(weak.status).toBe('warn');
    expect(weak.resources?.[0].detail).toContain('inherits DMARC from a.example');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------------------------------------------

const SUB = '11111111-1111-1111-1111-111111111111';
const subsRoute = { '/subscriptions?api-version': { value: [{ subscriptionId: SUB, displayName: 'prod', state: 'Enabled' }] } };
const azure = async (id: string, routes: Record<string, Route>) => (await runAs('azure', { ...M365, subscriptionIds: [] }, [id], { ...routes, ...subsRoute }))[id];
const rid = (provider: string, name: string) => `/subscriptions/${SUB}/resourceGroups/rg/providers/${provider}/${name}`;

describe('Azure storage', () => {
  const account = (props: Record<string, unknown>, name = 'st1') => ({ id: rid('Microsoft.Storage/storageAccounts', name), name, location: 'westeurope', properties: props });
  const accounts = (...a: unknown[]) => ({ 'Microsoft.Storage/storageAccounts?api-version': { value: a } });

  it('storage-transport fails when TLS or HTTPS-only properties are missing', async () => {
    const ok = await azure('azure.storage-transport', accounts(account({ supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2' })));
    expect(ok.status).toBe('pass');
    const missing = await azure('azure.storage-transport', accounts(account({})));
    expect(missing.status).toBe('fail');
    expect(missing.resources?.[0].detail).toContain('minimum TLS version not set');
    expect(missing.resources?.[0].url).toContain('portal.azure.com');
    expect(missing.resources?.[0].account).toBe('prod');
    const old = await azure('azure.storage-transport', accounts(account({ supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_1' })));
    expect(old.status).toBe('fail');
  });

  it('storage-network fails for accounts open to all networks and warns for shared keys or no soft delete', async () => {
    const blob = (enabled: boolean) => ({ '/blobServices/default': { properties: { deleteRetentionPolicy: { enabled } } } });
    const open = await azure('azure.storage-network', { ...blob(true), ...accounts(account({ publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Allow' }, allowSharedKeyAccess: false })) });
    expect(open.status).toBe('fail');
    const keys = await azure('azure.storage-network', { ...blob(false), ...accounts(account({ networkAcls: { defaultAction: 'Deny' } })) });
    expect(keys.status).toBe('warn');
    expect(keys.resources?.[0].detail).toContain('shared key');
    expect(keys.resources?.[0].detail).toContain('soft delete');
    const ok = await azure('azure.storage-network', { ...blob(true), ...accounts(account({ publicNetworkAccess: 'Disabled', allowSharedKeyAccess: false })) });
    expect(ok.status).toBe('pass');
  });
});

describe('Azure Defender and logging', () => {
  const pricing = (plans: Record<string, string>) => ({ 'Microsoft.Security/pricings': { value: Object.entries(plans).map(([name, pricingTier]) => ({ name, properties: { pricingTier } })) } });
  const resources = (...types: string[]) => ({ '/resources?api-version': { value: types.map((type, i) => ({ id: `r${i}`, type })) } });

  it('only requires Defender plans for deployed workloads', async () => {
    const plans = { Arm: 'Standard', CloudPosture: 'Standard', StorageAccounts: 'Standard', VirtualMachines: 'Free', SqlServers: 'Free' };
    const storageOnly = await azure('azure.defender-plans', { ...pricing(plans), ...resources('Microsoft.Storage/storageAccounts') });
    expect(storageOnly.status).toBe('pass');
    const withVm = await azure('azure.defender-plans', { ...pricing(plans), ...resources('Microsoft.Storage/storageAccounts', 'Microsoft.Compute/virtualMachines') });
    expect(withVm.status).toBe('warn');
    expect(withVm.resources?.[0].detail).toContain('VirtualMachines');
    expect(withVm.resources?.[0].id).toBe(`/subscriptions/${SUB}`);
  });

  it('activity-log-export fails when required categories are missing', async () => {
    const setting = (cats: string[]) => ({ diagnosticSettings: { value: [{ id: 'd', properties: { workspaceId: '/w', logs: cats.map((category) => ({ category, enabled: true })) } }] } });
    const partial = await azure('azure.activity-log-export', setting(['Administrative', 'Security']));
    expect(partial.status).toBe('fail');
    expect(partial.resources?.[0].detail).toContain('Alert, Policy');
    expect((await azure('azure.activity-log-export', setting(['Administrative', 'Alert', 'Policy', 'Security']))).status).toBe('pass');
    const all = await azure('azure.activity-log-export', { diagnosticSettings: { value: [{ id: 'd', properties: { workspaceId: '/w', logs: [{ categoryGroup: 'allLogs', enabled: true }] } }] } });
    expect(all.status).toBe('pass');
  });

  it('defender-recommendations fails on unhealthy high-severity assessments only', async () => {
    const assessment = (code: string, severity: string) => ({ id: 'a', name: 'a', properties: { displayName: 'Machines should have vulnerability findings resolved', status: { code }, metadata: { severity }, resourceDetails: { Id: rid('Microsoft.Compute/virtualMachines', 'vm1') } } });
    const bad = await azure('azure.defender-recommendations', { 'Microsoft.Security/assessments': { value: [assessment('Unhealthy', 'High'), assessment('Unhealthy', 'Low')] } });
    expect(bad.status).toBe('fail');
    expect(bad.resources).toHaveLength(1);
    expect(bad.resources?.[0].name).toBe('vm1');
    const ok = await azure('azure.defender-recommendations', { 'Microsoft.Security/assessments': { value: [assessment('Healthy', 'High'), assessment('Unhealthy', 'Medium')] } });
    expect(ok.status).toBe('pass');
  });
});

describe('Azure network', () => {
  const rule = (name: string, priority: number, access: string, source: string, port: string) => ({
    id: `${rid('Microsoft.Network/networkSecurityGroups', 'nsg1')}/securityRules/${name}`,
    name,
    properties: { direction: 'Inbound', protocol: 'Tcp', priority, access, sourceAddressPrefix: source, destinationPortRange: port },
  });
  const nsg = (...rules: unknown[]) => ({ 'Microsoft.Network/networkSecurityGroups?api-version': { value: [{ id: rid('Microsoft.Network/networkSecurityGroups', 'nsg1'), name: 'nsg1', properties: { securityRules: rules } }] } });

  it('honours a higher-priority Deny and flags broad prefixes and the Internet tag', async () => {
    expect((await azure('azure.nsg-admin-ports', nsg(rule('allow-rdp', 300, 'Allow', '*', '3389')))).status).toBe('fail');
    expect((await azure('azure.nsg-admin-ports', nsg(rule('deny-rdp', 100, 'Deny', 'Internet', '3389'), rule('allow-rdp', 300, 'Allow', '*', '3389')))).status).toBe('pass');
    // A Deny with a lower priority (higher number) does not override.
    expect((await azure('azure.nsg-admin-ports', nsg(rule('deny-rdp', 400, 'Deny', '*', '3389'), rule('allow-rdp', 300, 'Allow', '*', '3389')))).status).toBe('fail');
    const broad = await azure('azure.nsg-admin-ports', nsg(rule('db', 200, 'Allow', '10.0.0.0/8', '5432')));
    expect(broad.status).toBe('fail');
    expect(broad.resources?.[0].detail).toContain('5432');
    expect((await azure('azure.nsg-admin-ports', nsg(rule('db', 200, 'Allow', '192.168.0.0/16', '5432')))).status).toBe('pass');
    const range = await azure('azure.nsg-admin-ports', nsg(rule('mgmt', 200, 'Allow', 'Internet', '5980-5990')));
    expect(range.resources?.[0].detail).toContain('5985, 5986');
  });

  it('sql-public catches broad ranges and reports each server once', async () => {
    const server = { id: rid('Microsoft.Sql/servers', 'sql1'), name: 'sql1', properties: {} };
    const o = await azure('azure.sql-public', {
      '/firewallRules': { value: [{ name: 'wide', properties: { startIpAddress: '0.0.0.0', endIpAddress: '127.255.255.255' } }, { name: 'all', properties: { startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' } }] },
      'Microsoft.Sql/servers?api-version': { value: [server, server] },
    });
    expect(o.status).toBe('fail');
    expect(o.resources).toHaveLength(1);
    expect(o.resources?.[0].detail).toContain('wide');
    expect(o.summary).toContain('1 of 1 SQL server(s)');
  });
});

describe('Azure SQL, Key Vault, backup and owners', () => {
  it('sql-auditing-tde fails without auditing or TDE and warns without an Entra admin', async () => {
    const server = (admin: boolean) => ({ 'Microsoft.Sql/servers?api-version': { value: [{ id: rid('Microsoft.Sql/servers', 'sql1'), name: 'sql1', properties: admin ? { administrators: { login: 'sql-admins' } } : {} }] } });
    const routes = (audit: string, tde: string) => ({
      '/auditingSettings/default': { properties: { state: audit } },
      '/transparentDataEncryption/current': { properties: { state: tde } },
      '/databases?api-version': { value: [{ id: `${rid('Microsoft.Sql/servers', 'sql1')}/databases/db1`, name: 'db1' }, { id: 'master', name: 'master' }] },
    });
    expect((await azure('azure.sql-auditing-tde', { ...routes('Enabled', 'Enabled'), ...server(true) })).status).toBe('pass');
    const noTde = await azure('azure.sql-auditing-tde', { ...routes('Enabled', 'Disabled'), ...server(true) });
    expect(noTde.status).toBe('fail');
    expect(noTde.resources?.[0].detail).toContain('TDE off on db1');
    expect((await azure('azure.sql-auditing-tde', { ...routes('Disabled', 'Enabled'), ...server(true) })).status).toBe('fail');
    expect((await azure('azure.sql-auditing-tde', { ...routes('Enabled', 'Enabled'), '/administrators': { value: [] }, ...server(false) })).status).toBe('warn');
  });

  it('keyvault-protection checks soft delete, purge protection and RBAC', async () => {
    const vault = (p: Record<string, unknown>) => ({ 'Microsoft.KeyVault/vaults?api-version': { value: [{ id: rid('Microsoft.KeyVault/vaults', 'kv1'), name: 'kv1', properties: p }] } });
    expect((await azure('azure.keyvault-protection', vault({ enableSoftDelete: true, enablePurgeProtection: true, enableRbacAuthorization: true }))).status).toBe('pass');
    expect((await azure('azure.keyvault-protection', vault({ enableSoftDelete: true, enablePurgeProtection: true }))).status).toBe('warn');
    expect((await azure('azure.keyvault-protection', vault({ enableRbacAuthorization: true }))).status).toBe('fail');
  });

  it('backup-vaults fails on soft delete off and warns without immutability', async () => {
    const vault = (sec: Record<string, unknown>) => ({
      'Microsoft.RecoveryServices/vaults?api-version': { value: [{ id: rid('Microsoft.RecoveryServices/vaults', 'rsv1'), name: 'rsv1', properties: { securitySettings: sec } }] },
      'Microsoft.DataProtection/backupVaults?api-version': { value: [] },
    });
    expect((await azure('azure.backup-vaults', vault({ softDeleteSettings: { softDeleteState: 'Disabled' } }))).status).toBe('fail');
    expect((await azure('azure.backup-vaults', vault({ softDeleteSettings: { softDeleteState: 'Enabled' }, immutabilitySettings: { state: 'Disabled' } }))).status).toBe('warn');
    expect((await azure('azure.backup-vaults', vault({ softDeleteSettings: { softDeleteState: 'AlwaysON' }, immutabilitySettings: { state: 'Locked' } }))).status).toBe('pass');
    expect((await azure('azure.backup-vaults', { 'Microsoft.RecoveryServices/vaults?api-version': { value: [] }, 'Microsoft.DataProtection/backupVaults?api-version': { value: [] } })).status).toBe('na');
  });

  it('subscription-owners requires 2 or 3 owners, counts User Access Administrators and lists groups', async () => {
    const OWNER = '/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
    const UAA = '/providers/Microsoft.Authorization/roleDefinitions/18d7d88d-d35e-4fb5-a5c3-7773c20a72d9';
    const ra = (principalId: string, role: string, principalType = 'User') => ({ properties: { principalId, roleDefinitionId: role, principalType } });
    const run = (...a: unknown[]) => azure('azure.subscription-owners', { roleAssignments: { value: a } });
    expect((await run(ra('u1', OWNER), ra('u2', OWNER))).status).toBe('pass');
    const single = await run(ra('u1', OWNER));
    expect(single.status).toBe('warn');
    expect(single.summary).toContain('fewer than 2');
    const many = await run(ra('u1', OWNER), ra('g1', OWNER, 'Group'), ra('u3', OWNER), ra('sp1', UAA, 'ServicePrincipal'));
    expect(many.status).toBe('warn');
    expect(many.resources?.find((r) => r.id === 'g1')?.type).toBe('Group');
    expect(many.resources?.[0].detail).toContain('1 group');
  });
});
