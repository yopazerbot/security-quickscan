import { awsConsoleUrl, azurePortalUrl, entraUrl, githubOrgSettingsUrl, githubRepoUrl, githubUrl, runSystem } from '@qs/checks';
import { CHECKS_BY_ID, type CheckOutcome } from '@qs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Route = unknown | ((url: string) => Response);
const reply = (status: number, body?: unknown, headers?: Record<string, string>) => () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

/** Routes fetch calls to canned responses (first key contained in the URL wins). */
function mockFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: URL | string) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const r = routes[key];
    return typeof r === 'function' ? (r as (u: string) => Response)(url) : new Response(JSON.stringify(r), { status: 200 });
  });
}

const GH = { authMode: 'token', org: 'acme' };
const TOKEN = { token: `ghp_${'a'.repeat(36)}` };

async function gh(checkIds: string[], routes: Record<string, Route>) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  const out: Record<string, CheckOutcome> = {};
  await runSystem({
    systemId: '00000000-0000-0000-0000-000000000001',
    provider: 'github',
    config: GH,
    secret: TOKEN,
    checkIds,
    env: {},
    onStart: async () => {},
    onResult: async (id, o) => {
      out[id] = o;
    },
    shouldStop: async () => false,
  });
  return Object.assign(out, { calls: fetchMock.mock.calls.map((c) => String(c[0])) });
}

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  full_name: `acme/${name}`,
  default_branch: 'main',
  size: 10,
  visibility: 'private',
  security_and_analysis: {
    secret_scanning: { status: 'enabled' },
    secret_scanning_push_protection: { status: 'enabled' },
    dependabot_security_updates: { status: 'enabled' },
  },
  ...extra,
});

const FULL_CLASSIC = {
  required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('links', () => {
  it('builds Entra admin center links', () => {
    expect(entraUrl('user', 'u-1')).toBe('https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/u-1');
    expect(entraUrl('group', 'g-1')).toContain('GroupDetailsMenuBlade/~/Overview/groupId/g-1');
    expect(entraUrl('app', 'app-1')).toContain('Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/app-1');
    expect(entraUrl('servicePrincipal', 'sp-1', { appId: 'app-1' })).toContain('ManagedAppMenuBlade/~/Overview/objectId/sp-1/appId/app-1');
    expect(entraUrl('caPolicy', 'p-1')).toBe('https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/PolicyBlade/policyId/p-1');
    expect(entraUrl('role', 'r-1')).toContain('RoleMenuBlade/~/RoleMembers/objectId/r-1');
    expect(entraUrl('user', '')).toBeUndefined();
  });

  it('builds Azure portal links from ARM ids only', () => {
    const id = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st1';
    expect(azurePortalUrl(id)).toBe(`https://portal.azure.com/#@/resource${id}`);
    expect(azurePortalUrl('subscriptions/s1')).toBe('https://portal.azure.com/#@/resource/subscriptions/s1');
    expect(azurePortalUrl('st1')).toBeUndefined();
  });

  it('builds AWS console links with the region', () => {
    expect(awsConsoleUrl('s3', 'eu-west-1', 'arn:aws:s3:::my-bucket')).toBe('https://s3.console.aws.amazon.com/s3/buckets/my-bucket?region=eu-west-1');
    expect(awsConsoleUrl('iam-user', undefined, 'arn:aws:iam::111122223333:user/ops/alice')).toBe('https://us-east-1.console.aws.amazon.com/iam/home#/users/details/alice');
    expect(awsConsoleUrl('iam-role', undefined, 'deployer')).toBe('https://us-east-1.console.aws.amazon.com/iam/home#/roles/details/deployer');
    expect(awsConsoleUrl('iam-policy', undefined, 'arn:aws:iam::111122223333:policy/p')).toContain('#/policies/details/arn%3Aaws%3Aiam%3A%3A111122223333%3Apolicy%2Fp');
    expect(awsConsoleUrl('ec2-sg', 'eu-west-1', 'sg-1')).toBe('https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#SecurityGroup:groupId=sg-1');
    expect(awsConsoleUrl('rds', 'eu-west-1', 'arn:aws:rds:eu-west-1:1:db:reporting')).toContain('#database:id=reporting;is-cluster=false');
    expect(awsConsoleUrl('guardduty', 'eu-central-1', '')).toBe('https://eu-central-1.console.aws.amazon.com/guardduty/home?region=eu-central-1#/summary');
    expect(awsConsoleUrl('ec2-instance', undefined, 'i-1')).toBeUndefined();
    expect(awsConsoleUrl('ec2-instance', 'not a region', 'i-1')).toBeUndefined();
  });

  it('builds github.com links with encoded path segments', () => {
    expect(githubUrl('acme/api')).toBe('https://github.com/acme/api');
    expect(githubUrl('/acme/my repo/settings')).toBe('https://github.com/acme/my%20repo/settings');
    expect(githubUrl('acme/api/security?tab=x')).toBe('https://github.com/acme/api/security?tab=x');
    expect(githubRepoUrl('acme/api', 'settings/rules')).toBe('https://github.com/acme/api/settings/rules');
    expect(githubOrgSettingsUrl('acme', 'actions')).toBe('https://github.com/organizations/acme/settings/actions');
  });
});

describe('GitHub catalog mapping', () => {
  it('uses the corrected ISO mappings and has the new checks', () => {
    expect(CHECKS_BY_ID['gh.public-repos'].frameworks.iso27001).toEqual(['8.12']);
    expect(CHECKS_BY_ID['gh.actions-allowed'].frameworks.iso27001).toEqual(['5.21', '8.25']);
    expect(CHECKS_BY_ID['gh.dependabot-alerts'].frameworks.iso27001).toEqual(['8.8', '5.21', '8.25']);
    expect(CHECKS_BY_ID['gh.secret-scanning-alerts']).toMatchObject({ severity: 'critical', frameworks: { iso27001: ['8.28', '5.17'] } });
    expect(CHECKS_BY_ID['gh.members-without-2fa']).toMatchObject({ severity: 'high', frameworks: { iso27001: ['8.5'] } });
    expect(CHECKS_BY_ID['gh.app-installations']).toMatchObject({ severity: 'medium', frameworks: { iso27001: ['5.21', '5.19'] } });
    expect(CHECKS_BY_ID['gh.security-defaults']).toMatchObject({ severity: 'low', frameworks: { iso27001: ['8.9', '8.25'] } });
  });
});

describe('GitHub branch protection content', () => {
  it('passes complete classic protection and links the repository', async () => {
    const r = await gh(['gh.branch-protection'], {
      '/orgs/acme/repos': [repo('a')],
      '/repos/acme/a/branches/main/protection': FULL_CLASSIC,
      '/repos/acme/a/branches/main': { protected: true },
    });
    expect(r['gh.branch-protection'].status).toBe('pass');
  });

  it('warns on partial protection and lists the missing parts', async () => {
    const r = await gh(['gh.branch-protection'], {
      '/orgs/acme/repos': [repo('a')],
      '/repos/acme/a/branches/main/protection': { ...FULL_CLASSIC, required_pull_request_reviews: { required_approving_review_count: 1 }, allow_force_pushes: { enabled: true } },
      '/repos/acme/a/branches/main': { protected: true },
    });
    const o = r['gh.branch-protection'];
    expect(o.status).toBe('warn');
    expect(o.resources?.[0]).toMatchObject({ id: 'acme/a', type: 'Repository', account: 'acme', url: 'https://github.com/acme/a/settings/rules' });
    expect(o.resources?.[0].detail).toContain('stale approvals dismissed');
    expect(o.resources?.[0].detail).toContain('force pushes blocked');
    expect(o.resources?.[0].detail).not.toContain('required approving review');
  });

  it('fails an unprotected branch and explains a ruleset in evaluate mode', async () => {
    const r = await gh(['gh.branch-protection'], {
      '/orgs/acme/repos': [repo('a')],
      '/repos/acme/a/rulesets': [{ id: 3, name: 'Protect main', target: 'branch', enforcement: 'evaluate' }],
      '/repos/acme/a/branches/main': { protected: false },
    });
    expect(r['gh.branch-protection'].status).toBe('fail');
    expect(r['gh.branch-protection'].resources?.[0].detail).toContain('evaluate mode');
  });

  it('never reports unprotected on 403: the repository is not evaluated', async () => {
    const r = await gh(['gh.branch-protection'], {
      '/orgs/acme/repos': [repo('a'), repo('b')],
      '/repos/acme/a/branches/main/protection': FULL_CLASSIC,
      '/repos/acme/a/branches/main': { protected: true },
      '/repos/acme/b/branches/main': reply(403, { message: 'Resource not accessible by personal access token' }),
    });
    expect(r['gh.branch-protection'].status).toBe('warn');
    expect(r['gh.branch-protection'].summary).toContain('1 of 2 repositories could not be evaluated');
    const hiddenOnly = await gh(['gh.branch-protection'], {
      '/orgs/acme/repos': [repo('b')],
      '/repos/acme/b/branches/main/protection': reply(403, { message: 'Resource not accessible by personal access token' }),
      '/repos/acme/b/branches/main': { protected: true },
    });
    expect(hiddenOnly['gh.branch-protection'].status).toBe('error');
  });

  it('evaluates rulesets: bypass actors fail the admin requirement, no bypass passes', async () => {
    const rules = [
      { type: 'pull_request', ruleset_id: 7, parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } },
      { type: 'non_fast_forward', ruleset_id: 7 },
      { type: 'deletion', ruleset_id: 7 },
    ];
    const withBypass = await gh(['gh.branch-protection'], {
      '/orgs/acme/repos': [repo('a')],
      '/repos/acme/a/rules/branches/main': rules,
      '/repos/acme/a/rulesets/7': { id: 7, enforcement: 'active', bypass_actors: [{ actor_type: 'OrganizationAdmin', bypass_mode: 'always' }] },
      '/repos/acme/a/branches/main': { protected: true },
    });
    expect(withBypass['gh.branch-protection'].status).toBe('warn');
    expect(withBypass['gh.branch-protection'].resources?.[0].detail).toContain('administrators');
    const noBypass = await gh(['gh.branch-protection'], {
      '/orgs/acme/repos': [repo('a')],
      '/repos/acme/a/rules/branches/main': rules,
      '/repos/acme/a/rulesets/7': { id: 7, enforcement: 'active', bypass_actors: [] },
      '/repos/acme/a/branches/main': { protected: true },
    });
    expect(noBypass['gh.branch-protection'].status).toBe('pass');
  });
});

describe('GitHub collaborators, actions and scanning', () => {
  it('fails outside collaborators with write or admin and warns on read only', async () => {
    const strong = await gh(['gh.outside-collaborators'], {
      '/orgs/acme/outside_collaborators': [{ id: 1, login: 'ext-admin' }, { id: 2, login: 'ext-reader' }],
      '/orgs/acme/repos': [repo('a')],
      '/repos/acme/a/collaborators': [
        { login: 'ext-admin', role_name: 'admin', permissions: { admin: true, push: true, pull: true } },
        { login: 'ext-reader', role_name: 'read', permissions: { pull: true } },
      ],
    });
    const o = strong['gh.outside-collaborators'];
    expect(o.status).toBe('fail');
    expect(o.resources?.[0]).toMatchObject({ id: 'ext-admin', type: 'Member', url: 'https://github.com/ext-admin' });
    expect(o.resources?.[0].detail).toContain('admin');
    const readOnly = await gh(['gh.outside-collaborators'], {
      '/orgs/acme/outside_collaborators': [{ id: 2, login: 'ext-reader' }],
      '/orgs/acme/repos': [repo('a')],
      '/repos/acme/a/collaborators': [{ login: 'ext-reader', permissions: { pull: true, triage: true } }],
    });
    expect(readOnly['gh.outside-collaborators'].status).toBe('warn');
    const none = await gh(['gh.outside-collaborators'], { '/orgs/acme/outside_collaborators': [] });
    expect(none['gh.outside-collaborators'].status).toBe('pass');
    expect(none.calls.some((u) => u.includes('/collaborators?'))).toBe(false);
  });

  it('treats a wildcard selected-actions pattern as all actions', async () => {
    const wildcard = await gh(['gh.actions-allowed'], {
      '/orgs/acme/actions/permissions/selected-actions': { github_owned_allowed: true, verified_allowed: true, patterns_allowed: ['*'] },
      '/orgs/acme/actions/permissions': { enabled_repositories: 'all', allowed_actions: 'selected' },
    });
    expect(wildcard['gh.actions-allowed'].status).toBe('warn');
    const restricted = await gh(['gh.actions-allowed'], {
      '/orgs/acme/actions/permissions/selected-actions': { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ['acme/*', 'docker/login-action@*'] },
      '/orgs/acme/actions/permissions': { enabled_repositories: 'all', allowed_actions: 'selected' },
    });
    expect(restricted['gh.actions-allowed'].status).toBe('pass');
    const hidden = await gh(['gh.actions-allowed'], { '/orgs/acme/actions/permissions': reply(403, { message: 'Must have admin rights' }) });
    expect(hidden['gh.actions-allowed'].status).toBe('error');
  });

  it('requires a code scanning analysis from the last 90 days', async () => {
    const old = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
    const r = await gh(['gh.code-scanning-alerts'], {
      '/orgs/acme/repos': [repo('a')],
      '/code-scanning/analyses': [{ id: 1, created_at: old }],
      '/orgs/acme/code-scanning/alerts': [],
    });
    expect(r['gh.code-scanning-alerts'].status).toBe('fail');
    expect(r['gh.code-scanning-alerts'].resources?.[0].detail).toContain('no analysis in the last 90 days');
    const recent = await gh(['gh.code-scanning-alerts'], {
      '/orgs/acme/repos': [repo('a')],
      '/code-scanning/analyses': [{ id: 1, created_at: new Date().toISOString() }],
      '/orgs/acme/code-scanning/alerts': [],
    });
    expect(recent['gh.code-scanning-alerts'].status).toBe('pass');
  });

  it('reports repositories without Dependabot security updates', async () => {
    const noUpdates = repo('b');
    (noUpdates.security_and_analysis as any).dependabot_security_updates = { status: 'disabled' };
    const r = await gh(['gh.dependabot-alerts'], {
      '/orgs/acme/repos': [repo('a'), noUpdates],
      '/vulnerability-alerts': reply(204),
      '/orgs/acme/dependabot/alerts': [],
    });
    expect(r['gh.dependabot-alerts'].status).toBe('warn');
    expect(r['gh.dependabot-alerts'].summary).toContain('security updates not enabled on 1 repository');
    expect(r['gh.dependabot-alerts'].resources?.map((x) => x.id)).toEqual(['acme/b']);
  });
});

describe('GitHub new checks', () => {
  it('fails on open secret scanning alerts without copying the secret, and errors when not visible', async () => {
    const r = await gh(['gh.secret-scanning-alerts'], {
      '/orgs/acme/secret-scanning/alerts': [
        { number: 1, secret_type: 'aws_access_key_id', secret_type_display_name: 'Amazon AWS Access Key ID', secret: 'AKIAEXAMPLESECRET123', repository: { full_name: 'acme/infra' } },
        { number: 2, secret_type: 'slack_webhook', secret: 'https://hooks.slack.example/T000/B000/XXX', repository: { full_name: 'acme/infra' } },
      ],
    });
    const o = r['gh.secret-scanning-alerts'];
    expect(o.status).toBe('fail');
    expect(o.resources?.[0]).toMatchObject({ id: 'acme/infra', url: 'https://github.com/acme/infra/security/secret-scanning' });
    expect(JSON.stringify(o)).not.toContain('AKIAEXAMPLESECRET123');
    expect(JSON.stringify(o)).not.toContain('hooks.slack.example');
    const hidden = await gh(['gh.secret-scanning-alerts'], { '/orgs/acme/secret-scanning/alerts': reply(403, { message: 'Resource not accessible' }) });
    expect(hidden['gh.secret-scanning-alerts'].status).toBe('error');
    const clean = await gh(['gh.secret-scanning-alerts'], { '/orgs/acme/secret-scanning/alerts': [], '/orgs/acme/repos': [repo('a')] });
    expect(clean['gh.secret-scanning-alerts'].status).toBe('pass');
  });

  it('lists members without 2FA only when 2FA is not enforced and the token is an owner', async () => {
    const enforced = await gh(['gh.members-without-2fa'], { '/orgs/acme': { login: 'acme', two_factor_requirement_enabled: true } });
    expect(enforced['gh.members-without-2fa'].status).toBe('pass');
    expect(enforced.calls.some((u) => u.includes('2fa_disabled'))).toBe(false);
    const missing = await gh(['gh.members-without-2fa'], {
      '/orgs/acme/members': [{ id: 1, login: 'lazy-dev' }],
      '/orgs/acme/outside_collaborators': [],
      '/orgs/acme': { login: 'acme', two_factor_requirement_enabled: false },
    });
    expect(missing['gh.members-without-2fa'].status).toBe('fail');
    expect(missing.calls.some((u) => u.includes('/orgs/acme/members?filter=2fa_disabled'))).toBe(true);
    expect(missing['gh.members-without-2fa'].resources?.[0]).toMatchObject({ id: 'lazy-dev', type: 'Member' });
    const notOwner = await gh(['gh.members-without-2fa'], { '/orgs/acme': { login: 'acme' } });
    expect(notOwner['gh.members-without-2fa'].status).toBe('error');
  });

  it('flags GitHub Apps with broad write permissions', async () => {
    const inst = (id: number, slug: string, permissions: Record<string, string>, repository_selection = 'selected') => ({ id, app_slug: slug, permissions, repository_selection });
    const critical = await gh(['gh.app-installations'], {
      '/orgs/acme/installations': { total_count: 2, installations: [inst(1, 'org-admin-bot', { members: 'write' }), inst(2, 'reader', { metadata: 'read', contents: 'read' })] },
    });
    expect(critical['gh.app-installations'].status).toBe('fail');
    expect(critical['gh.app-installations'].resources?.[0]).toMatchObject({ name: 'org-admin-bot', type: 'GitHub App', url: 'https://github.com/organizations/acme/settings/installations/1' });
    const broad = await gh(['gh.app-installations'], { '/orgs/acme/installations': { total_count: 1, installations: [inst(3, 'ci', { contents: 'write', workflows: 'write' }, 'all')] } });
    expect(broad['gh.app-installations'].status).toBe('warn');
    const ok = await gh(['gh.app-installations'], { '/orgs/acme/installations': { total_count: 1, installations: [inst(2, 'reader', { metadata: 'read' })] } });
    expect(ok['gh.app-installations'].status).toBe('pass');
    const hidden = await gh(['gh.app-installations'], { '/orgs/acme/installations': reply(403, { message: 'Resource not accessible' }) });
    expect(hidden['gh.app-installations'].status).toBe('error');
  });

  it('checks new-repository security defaults, including a default code security configuration', async () => {
    const all = {
      login: 'acme',
      dependency_graph_enabled_for_new_repositories: true,
      dependabot_alerts_enabled_for_new_repositories: true,
      dependabot_security_updates_enabled_for_new_repositories: true,
      secret_scanning_enabled_for_new_repositories: true,
      secret_scanning_push_protection_enabled_for_new_repositories: true,
    };
    expect((await gh(['gh.security-defaults'], { '/orgs/acme': all }))['gh.security-defaults'].status).toBe('pass');
    const off = { ...all, secret_scanning_enabled_for_new_repositories: false, secret_scanning_push_protection_enabled_for_new_repositories: false };
    const missing = await gh(['gh.security-defaults'], { '/orgs/acme': off });
    expect(missing['gh.security-defaults'].status).toBe('warn');
    expect(missing['gh.security-defaults'].summary).toContain('secret scanning');
    const viaConfig = await gh(['gh.security-defaults'], {
      '/orgs/acme/code-security/configurations/defaults': [
        { default_for_new_repos: 'all', configuration: { name: 'Acme baseline', secret_scanning: 'enabled', secret_scanning_push_protection: 'enabled' } },
      ],
      '/orgs/acme': off,
    });
    expect(viaConfig['gh.security-defaults'].status).toBe('pass');
    const hidden = await gh(['gh.security-defaults'], { '/orgs/acme': { login: 'acme' } });
    expect(hidden['gh.security-defaults'].status).toBe('warn');
    expect(hidden['gh.security-defaults'].summary).toContain('not visible');
  });

  it('reports hidden organisation settings consistently as warn', async () => {
    const r = await gh(['gh.org-2fa', 'gh.base-permissions', 'gh.public-repo-creation', 'gh.private-forking'], { '/orgs/acme': { login: 'acme' } });
    for (const id of ['gh.org-2fa', 'gh.base-permissions', 'gh.public-repo-creation', 'gh.private-forking']) {
      expect(r[id].status, id).toBe('warn');
      expect(r[id].summary, id).toContain('not visible to this token');
    }
  });
});
