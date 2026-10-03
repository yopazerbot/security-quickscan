import { EC2Client } from '@aws-sdk/client-ec2';
import { IAMClient } from '@aws-sdk/client-iam';
import { KMSClient } from '@aws-sdk/client-kms';
import { STSClient } from '@aws-sdk/client-sts';
import { runSystem, testConnection } from '@qs/checks';
import type { CheckOutcome, Provider } from '@qs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** DNS answers for the email-auth check: TXT records per name, or an error code. */
const dnsAnswers = vi.hoisted(() => new Map<string, string[] | string>());
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    async resolveTxt(name: string) {
      const a = dnsAnswers.get(name);
      if (a === undefined) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      if (typeof a === 'string') throw Object.assign(new Error(`queryTxt ${a} ${name}`), { code: a });
      return a.map((t) => [t]);
    }
  },
}));

type Route = unknown | ((url: string) => Response);
/** A canned non-200 response. */
const reply = (status: number, body?: unknown, headers?: Record<string, string>) => () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

/** Routes fetch calls to canned responses (first key contained in the URL wins). */
function mockFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: URL | string) => {
    const url = String(input);
    if (url.includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'eyJ.fake.token' }), { status: 200 });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error: { code: 'NotFound', message: url } }), { status: 404 });
    const r = routes[key];
    return typeof r === 'function' ? (r as (u: string) => Response)(url) : new Response(JSON.stringify(r), { status: 200 });
  });
}

const M365 = { authMode: 'app_secret', tenantId: 'contoso.onmicrosoft.com', clientId: '00000000-0000-0000-0000-000000000002' };

async function runAs(provider: Provider, config: unknown, secret: unknown, checkIds: string[], routes: Record<string, Route> = {}) {
  vi.stubGlobal('fetch', mockFetch(routes));
  const out: Record<string, CheckOutcome> = {};
  await runSystem({
    systemId: '00000000-0000-0000-0000-000000000001',
    provider,
    config,
    secret,
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

const run = (checkIds: string[], routes: Record<string, Route>) => runAs('m365', M365, { clientSecret: 'x'.repeat(20) }, checkIds, routes);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dnsAnswers.clear();
});

describe('Microsoft 365 checks', () => {
  it('passes MFA when an enabled CA policy requires MFA for all users and apps', async () => {
    const r = await run(['m365.mfa-all-users'], {
      identitySecurityDefaultsEnforcementPolicy: { isEnabled: false },
      'conditionalAccess/policies': {
        value: [{ id: '1', displayName: 'MFA all', state: 'enabled', conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } }, grantControls: { builtInControls: ['mfa'] } }],
      },
    });
    expect(r['m365.mfa-all-users'].status).toBe('pass');
  });

  it('warns when the MFA policy is report-only and fails when absent', async () => {
    const reportOnly = await run(['m365.mfa-all-users'], {
      identitySecurityDefaultsEnforcementPolicy: { isEnabled: false },
      'conditionalAccess/policies': {
        value: [{ id: '1', displayName: 'MFA all', state: 'enabledForReportingButNotEnforced', conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } }, grantControls: { builtInControls: ['mfa'] } }],
      },
    });
    expect(reportOnly['m365.mfa-all-users'].status).toBe('warn');
    const none = await run(['m365.mfa-all-users'], { identitySecurityDefaultsEnforcementPolicy: { isEnabled: false }, 'conditionalAccess/policies': { value: [] } });
    expect(none['m365.mfa-all-users'].status).toBe('fail');
  });

  it('flags legacy user consent and too many global admins', async () => {
    const r = await run(['m365.user-consent', 'm365.global-admin-count'], {
      authorizationPolicy: { defaultUserRolePermissions: { permissionGrantPoliciesAssigned: ['ManagePermissionGrantsForSelf.microsoft-user-default-legacy'] } },
      '/directoryRoles/r1/members': { value: Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, userPrincipalName: `admin${i}@contoso.com` })) },
      '/directoryRoles': { value: [{ id: 'r1', roleTemplateId: '62e90394-69f5-4237-9190-012177145e10' }] },
    });
    expect(r['m365.user-consent'].status).toBe('fail');
    expect(r['m365.global-admin-count'].status).toBe('fail');
    expect(r['m365.global-admin-count'].resources).toHaveLength(6);
  });

  it('reports every check as error when sign-in fails, without leaking secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }), { status: 401 })));
    const out: Record<string, CheckOutcome> = {};
    await runSystem({
      systemId: 's',
      provider: 'm365',
      config: { authMode: 'app_secret', tenantId: 'contoso.onmicrosoft.com', clientId: '00000000-0000-0000-0000-000000000002' },
      secret: { clientSecret: 'super-secret-value' },
      checkIds: ['m365.pim', 'm365.legacy-auth'],
      env: {},
      onStart: async () => {},
      onResult: async (id, o) => {
        out[id] = o;
      },
      shouldStop: async () => false,
    });
    expect(Object.values(out).every((o) => o.status === 'error')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('super-secret-value');
  });
});

describe('Microsoft 365 checks without Conditional Access licence', () => {
  const unlicensed = {
    identitySecurityDefaultsEnforcementPolicy: { isEnabled: false },
    'conditionalAccess/policies': reply(403, { error: { code: 'Forbidden', message: 'Tenant does not have a premium license (AadPremiumLicenseRequired).' } }),
  };

  it('fails MFA, legacy-auth and admin-MFA when Security Defaults are off, and keeps risk policies n/a', async () => {
    const r = await run(['m365.mfa-all-users', 'm365.legacy-auth', 'm365.admin-mfa', 'm365.risk-policies'], unlicensed);
    for (const id of ['m365.mfa-all-users', 'm365.legacy-auth', 'm365.admin-mfa']) {
      expect(r[id].status).toBe('fail');
      expect(r[id].summary).toContain('Security Defaults');
    }
    expect(r['m365.risk-policies'].status).toBe('na');
  });

  it('still passes MFA when Security Defaults are on', async () => {
    const r = await run(['m365.mfa-all-users'], { ...unlicensed, identitySecurityDefaultsEnforcementPolicy: { isEnabled: true } });
    expect(r['m365.mfa-all-users'].status).toBe('pass');
  });
});

describe('Microsoft 365 consent and pagination', () => {
  it('warns about unrecognised consent policies instead of reporting consent as disabled', async () => {
    const custom = await run(['m365.user-consent'], {
      authorizationPolicy: { defaultUserRolePermissions: { permissionGrantPoliciesAssigned: ['ManagePermissionGrantsForSelf.contoso-custom'] } },
    });
    expect(custom['m365.user-consent'].status).toBe('warn');
    expect(custom['m365.user-consent'].summary).toContain('contoso-custom');
    const off = await run(['m365.user-consent'], {
      authorizationPolicy: { defaultUserRolePermissions: { permissionGrantPoliciesAssigned: ['ManagePermissionGrantsForOwnedResource.microsoft-dynamically-managed-permissions-for-team'] } },
    });
    expect(off['m365.user-consent'].status).toBe('pass');
  });

  it('downgrades stale-accounts to warn when the user list is cut off', async () => {
    const loop = 'https://graph.microsoft.com/v1.0/users?$skiptoken=again';
    const user = { id: 'u1', userPrincipalName: 'a@contoso.com', accountEnabled: true, createdDateTime: new Date().toISOString(), userType: 'Member' };
    const r = await run(['m365.stale-accounts'], { '/users': { value: [user], '@odata.nextLink': loop } });
    expect(r['m365.stale-accounts'].status).toBe('warn');
    expect(r['m365.stale-accounts'].summary).toMatch(/Only the first 2 accounts/);
  });
});

describe('Microsoft 365 email authentication', () => {
  const domains = (...ids: string[]) => ({ '/domains': { value: ids.map((id) => ({ id, isVerified: true, supportedServices: ['Email'] })) } });

  it('treats DMARC without p= as none (warn) and flags a bare "all" in SPF (fail)', async () => {
    dnsAnswers.set('a.example', ['v=spf1 include:spf.protection.outlook.com -all']);
    dnsAnswers.set('_dmarc.a.example', ['v=DMARC1; rua=mailto:d@a.example']);
    const noPolicy = await run(['m365.email-auth'], domains('a.example'));
    expect(noPolicy['m365.email-auth'].status).toBe('warn');
    expect(noPolicy['m365.email-auth'].resources?.[0].detail).toContain('valid p=');

    dnsAnswers.set('a.example', ['v=spf1 include:spf.protection.outlook.com all']);
    dnsAnswers.set('_dmarc.a.example', ['v=DMARC1; p=reject']);
    const bareAll = await run(['m365.email-auth'], domains('a.example'));
    expect(bareAll['m365.email-auth'].status).toBe('fail');
    expect(bareAll['m365.email-auth'].resources?.[0].detail).toContain('allows any sender');
  });

  it('reports DNS timeouts as could not be checked rather than missing records', async () => {
    dnsAnswers.set('a.example', ['v=spf1 -all']);
    dnsAnswers.set('_dmarc.a.example', ['v=DMARC1; p=reject']);
    dnsAnswers.set('b.example', 'ETIMEOUT');
    dnsAnswers.set('_dmarc.b.example', 'ETIMEOUT');
    const partial = await run(['m365.email-auth'], domains('a.example', 'b.example'));
    expect(partial['m365.email-auth'].status).toBe('warn');
    expect(partial['m365.email-auth'].summary).toContain('1 of 2 mail domains could not be evaluated');
    const none = await run(['m365.email-auth'], domains('b.example'));
    expect(none['m365.email-auth'].status).toBe('error');
  });
});

describe('Azure subscription coverage', () => {
  it('includes Warned subscriptions and warns about configured subscriptions it cannot see', async () => {
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'];
    const r = await runAs('azure', { ...M365, subscriptionIds: ids }, { clientSecret: 'x'.repeat(20) }, ['azure.activity-log-export'], {
      'diagnosticSettings': { value: [{ id: 'd1' }] },
      '/subscriptions?api-version': {
        value: [
          { subscriptionId: ids[0], displayName: 'prod', state: 'Enabled' },
          { subscriptionId: ids[1], displayName: 'dev', state: 'Warned' },
        ],
      },
    });
    const o = r['azure.activity-log-export'];
    expect(o.status).toBe('warn');
    expect(o.summary).toContain('1 of 3 subscriptions could not be evaluated');
    expect(JSON.stringify(o.evidence)).toContain(ids[2]);
  });
});

/** Route AWS SDK calls of the given clients to a handler (command name, input, region). */
function mockAws(handler: (command: string, input: any, region: string) => unknown) {
  for (const C of [STSClient, EC2Client, IAMClient, KMSClient] as any[]) {
    vi.spyOn(C.prototype, 'send').mockImplementation(async function (this: any, cmd: any) {
      const r = this.config.region;
      const region = typeof r === 'function' ? await r() : r;
      return handler(cmd.constructor.name, cmd.input, region);
    });
  }
}
const awsError = (name: string) => Object.assign(new Error(name), { name });
const AWS_SECRET = { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'x'.repeat(40) };
const awsBase = (command: string) => (command === 'GetCallerIdentityCommand' ? { Account: '111122223333', Arn: 'arn:aws:iam::111122223333:role/scan' } : undefined);

describe('AWS region and resource coverage', () => {
  it('warns when a region is skipped and errors when no region could be evaluated', async () => {
    mockAws((command, _input, region) => {
      if (command !== 'GetEbsEncryptionByDefaultCommand') return awsBase(command);
      if (region === 'ap-east-1') throw awsError('OptInRequired');
      return { EbsEncryptionByDefault: true };
    });
    const partial = await runAs('aws', { authMode: 'access_keys', regions: ['eu-west-1', 'ap-east-1'] }, AWS_SECRET, ['aws.ebs-encryption']);
    expect(partial['aws.ebs-encryption'].status).toBe('warn');
    expect(partial['aws.ebs-encryption'].summary).toContain('ap-east-1');
    const none = await runAs('aws', { authMode: 'access_keys', regions: ['ap-east-1'] }, AWS_SECRET, ['aws.ebs-encryption']);
    expect(none['aws.ebs-encryption'].status).toBe('error');
  });

  it('does not count KMS keys whose rotation status is denied as rotating', async () => {
    mockAws((command, input) => {
      if (command === 'ListKeysCommand') return { Keys: [{ KeyId: 'k1' }, { KeyId: 'k2' }] };
      if (command === 'DescribeKeyCommand') return { KeyMetadata: { Arn: `arn:${input.KeyId}`, KeyManager: 'CUSTOMER', KeyState: 'Enabled', KeySpec: 'SYMMETRIC_DEFAULT', Origin: 'AWS_KMS' } };
      if (command === 'GetKeyRotationStatusCommand') {
        if (input.KeyId === 'k2') throw awsError('AccessDeniedException');
        return { KeyRotationEnabled: true };
      }
      return awsBase(command);
    });
    const partial = await runAs('aws', { authMode: 'access_keys', regions: ['eu-west-1'] }, AWS_SECRET, ['aws.kms-rotation']);
    expect(partial['aws.kms-rotation'].status).toBe('warn');
    expect(partial['aws.kms-rotation'].summary).toContain('1 of 2 KMS keys could not be evaluated');
  });

  it('rejects unknown and not-opted-in regions in the connection test', async () => {
    mockAws((command) => {
      if (command === 'DescribeRegionsCommand') return { Regions: [{ RegionName: 'eu-west-1', OptInStatus: 'opt-in-not-required' }, { RegionName: 'ap-east-1', OptInStatus: 'not-opted-in' }] };
      return awsBase(command) ?? {};
    });
    const r = await testConnection('aws', { authMode: 'access_keys', regions: ['eu-west-1', 'ap-east-1', 'eu-wes-1'] }, AWS_SECRET, {}, 's');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('eu-wes-1');
    expect(r.message).toContain('ap-east-1');
    const ok = await testConnection('aws', { authMode: 'access_keys', regions: ['eu-west-1'] }, AWS_SECRET, {}, 's');
    expect(ok.ok).toBe(true);
  });
});

describe('GitHub coverage', () => {
  const GH = { authMode: 'token', org: 'acme' };
  const TOKEN = { token: `ghp_${'a'.repeat(36)}` };
  const repo = (name: string, extra: Record<string, unknown> = {}) => ({
    full_name: `acme/${name}`,
    default_branch: 'main',
    size: 10,
    visibility: 'private',
    security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
    ...extra,
  });
  const gh = (checkIds: string[], routes: Record<string, Route>) => runAs('github', GH, TOKEN, checkIds, routes);

  it('fails Dependabot when alerts are not enabled on any repository and warns on partial enablement', async () => {
    const off = await gh(['gh.dependabot-alerts'], {
      '/orgs/acme/repos': [repo('a'), repo('b')],
      '/vulnerability-alerts': reply(404, { message: 'Vulnerability alerts are disabled.' }),
      '/orgs/acme/dependabot/alerts': [],
    });
    expect(off['gh.dependabot-alerts'].status).toBe('fail');
    expect(off['gh.dependabot-alerts'].summary).toContain('not enabled on any');

    const partial = await gh(['gh.dependabot-alerts'], {
      '/orgs/acme/repos': [repo('a'), repo('b')],
      'acme/a/vulnerability-alerts': reply(204),
      '/vulnerability-alerts': reply(404, { message: 'Vulnerability alerts are disabled.' }),
      '/orgs/acme/dependabot/alerts': [],
    });
    expect(partial['gh.dependabot-alerts'].status).toBe('warn');
    expect(partial['gh.dependabot-alerts'].summary).toContain('not enabled on 1 of 2 repositories');
  });

  it('fails code scanning when no repository has analyses', async () => {
    const r = await gh(['gh.code-scanning-alerts'], {
      '/orgs/acme/repos': [repo('a')],
      '/code-scanning/analyses': reply(404, { message: 'no analysis found' }),
      '/orgs/acme/code-scanning/alerts': [],
    });
    expect(r['gh.code-scanning-alerts'].status).toBe('fail');
  });

  it('warns "first X of Y" when more repositories exist than are evaluated', async () => {
    const many = Array.from({ length: 201 }, (_, i) => repo(`r${i}`));
    const r = await gh(['gh.branch-protection'], { '/orgs/acme/repos': many, '/branches/main': { protected: true } });
    expect(r['gh.branch-protection'].status).toBe('warn');
    expect(r['gh.branch-protection'].summary).toContain('first 200 of 201 repositories');
  });

  it('compares secret scanning against every listed repository', async () => {
    const r = await gh(['gh.secret-scanning', 'gh.push-protection'], { '/orgs/acme/repos': [repo('a'), repo('b', { security_and_analysis: undefined })] });
    expect(r['gh.secret-scanning'].status).toBe('warn');
    expect(r['gh.secret-scanning'].summary).toContain('1 of 2 repositories could not be evaluated');
    const hidden = await gh(['gh.push-protection'], { '/orgs/acme/repos': [repo('b', { security_and_analysis: undefined })] });
    expect(hidden['gh.push-protection'].status).toBe('error');
  });

  it('warns below two owners and errors when no owner is visible', async () => {
    const one = await gh(['gh.owner-count'], { '/orgs/acme/members': [{ id: 1, login: 'boss' }] });
    expect(one['gh.owner-count'].status).toBe('warn');
    const none = await gh(['gh.owner-count'], { '/orgs/acme/members': [] });
    expect(none['gh.owner-count'].status).toBe('error');
  });
});
