import { runSystem } from '@qs/checks';
import type { CheckOutcome } from '@qs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Routes fetch calls to canned Microsoft responses. */
function mockFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: URL | string) => {
    const url = String(input);
    if (url.includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'eyJ.fake.token' }), { status: 200 });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error: { code: 'NotFound', message: url } }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
}

async function run(checkIds: string[], routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', mockFetch(routes));
  const out: Record<string, CheckOutcome> = {};
  await runSystem({
    systemId: '00000000-0000-0000-0000-000000000001',
    provider: 'm365',
    config: { authMode: 'app_secret', tenantId: 'contoso.onmicrosoft.com', clientId: '00000000-0000-0000-0000-000000000002' },
    secret: { clientSecret: 'x'.repeat(20) },
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

afterEach(() => vi.unstubAllGlobals());

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
