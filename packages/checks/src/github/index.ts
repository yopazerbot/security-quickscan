import type { CheckOutcome, ResourceRef } from '@qs/shared';
import type { ProviderModule } from '../types.js';
import { applyCoverage, applyTruncation, CheckError, fail, failIfAny, fetchJson, listed, type Listed, mapLimit, MAX_PAGES, Memo, na, pass, warn } from '../util.js';

export interface GhCtx {
  org: string;
  token: string;
  memo: Memo;
  signal?: AbortSignal;
}

const HOSTS = ['api.github.com'];
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'security-quickscan' };
const MAX_REPOS = 200;

class GhError extends CheckError {}

async function gh<T = any>(ctx: GhCtx, path: string): Promise<{ status: number; data: T; headers: Headers }> {
  const url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  return fetchJson<T>({ url, token: ctx.token, allowedHosts: HOSTS, headers: HEADERS, signal: ctx.signal });
}

async function ghOk<T = any>(ctx: GhCtx, path: string): Promise<T> {
  const r = await gh<T>(ctx, path);
  if (r.status >= 400) throw new GhError(`GitHub ${r.status} on ${path.split('?')[0]}: ${(r.data as any)?.message ?? ''}`, r.status);
  return r.data;
}

/** Follow Link rel="next" pages; the result is flagged `truncated` when a cap or a looping link stopped it early. */
async function ghAll<T = any>(ctx: GhCtx, path: string, max = 5000): Promise<Listed<T>> {
  const out: T[] = [];
  let next: string | undefined = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  const seen = new Set<string>();
  for (let pages = 0; next; pages++) {
    if (out.length >= max || pages >= MAX_PAGES || seen.has(next)) return listed(out, true);
    seen.add(next);
    const r: { status: number; data: any; headers: Headers } = await gh(ctx, next);
    if (r.status >= 400) throw new GhError(`GitHub ${r.status} on ${path.split('?')[0]}: ${r.data?.message ?? ''}`, r.status);
    const items = Array.isArray(r.data) ? r.data : [];
    out.push(...items);
    next = items.length ? /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1] : undefined;
  }
  return listed(out, false);
}

const org = (ctx: GhCtx) => ctx.memo.get('org', () => ghOk<any>(ctx, `/orgs/${ctx.org}`));
const repos = (ctx: GhCtx) =>
  ctx.memo.get('repos', async () => {
    const all = await ghAll<any>(ctx, `/orgs/${ctx.org}/repos?type=all&sort=pushed`);
    return listed(
      all.filter((r) => !r.archived && !r.disabled),
      all.truncated,
    );
  });

/**
 * Repositories evaluated by per-repository checks (most recently pushed first, capped at MAX_REPOS),
 * plus how many active repositories were listed and whether that list itself was cut off.
 */
async function repoScope(ctx: GhCtx) {
  const all = await repos(ctx);
  return { list: all.slice(0, MAX_REPOS), total: all.length, truncated: all.truncated || all.length > MAX_REPOS };
}

/** Pass becomes warn "first X of Y" when not every repository was evaluated. */
const repoCap = (o: CheckOutcome, scope: { list: unknown[]; total: number; truncated: boolean }) =>
  applyTruncation(o, scope.truncated, scope.list.length, 'repositories', scope.total > scope.list.length ? scope.total : undefined);

/** Returns null when the feature is unavailable (404/403 for not enabled or no licence). */
async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GhError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

const safeOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '(invalid URL)';
  }
};

const repoRef = (r: any, detail?: string): ResourceRef => ({ id: r.full_name, name: r.full_name, detail });

/** security_and_analysis is only returned for repositories where the token has admin read. */
const settingsCoverage = (list: any[], known: any[]) => ({
  evaluated: known.length,
  total: list.length,
  skipped: list.filter((r) => !r.security_and_analysis).map((r) => r.full_name),
  unit: 'repositories',
  hint: 'Security settings need repository admin read (Administration: read).',
});

interface Enablement {
  enabled: string[];
  disabled: string[];
  unknown: string[];
}

/** Dependabot alerts per repository: GET /repos/{o}/{r}/vulnerability-alerts is 204 when enabled and 404 when not. */
const dependabotEnablement = (ctx: GhCtx, list: any[]) =>
  ctx.memo.get('dependabot-enablement', async () => {
    const en: Enablement = { enabled: [], disabled: [], unknown: [] };
    await mapLimit(
      list,
      6,
      async (r) => {
        const res = await gh(ctx, `/repos/${r.full_name}/vulnerability-alerts`);
        // A 404 is only conclusive when the token can read the repository settings; otherwise it may hide a permission problem.
        if (res.status === 204) en.enabled.push(r.full_name);
        else if (res.status === 404 && (r.security_and_analysis || r.permissions?.admin)) en.disabled.push(r.full_name);
        else if (res.status === 404 || res.status === 403) en.unknown.push(r.full_name);
        else throw new GhError(`GitHub ${res.status} on /repos/${r.full_name}/vulnerability-alerts: ${(res.data as any)?.message ?? ''}`, res.status);
      },
      ctx.signal,
    );
    return en;
  });

/** Code scanning per repository: a repository with at least one analysis has code scanning set up. */
const codeScanningEnablement = (ctx: GhCtx, list: any[]) =>
  ctx.memo.get('code-scanning-enablement', async () => {
    const en: Enablement = { enabled: [], disabled: [], unknown: [] };
    await mapLimit(
      list,
      6,
      async (r) => {
        const res = await gh<any>(ctx, `/repos/${r.full_name}/code-scanning/analyses?per_page=1`);
        const msg = String(res.data?.message ?? '');
        if (res.status === 200 && Array.isArray(res.data) && res.data.length) en.enabled.push(r.full_name);
        else if (res.status === 200 || res.status === 404 || (res.status === 403 && /advanced security|not enabled/i.test(msg))) en.disabled.push(r.full_name);
        else if (res.status === 403) en.unknown.push(r.full_name);
        else throw new GhError(`GitHub ${res.status} on /repos/${r.full_name}/code-scanning/analyses: ${msg}`, res.status);
      },
      ctx.signal,
    );
    return en;
  });

const enablementCoverage = (en: Enablement) => ({
  evaluated: en.enabled.length + en.disabled.length,
  total: en.enabled.length + en.disabled.length + en.unknown.length,
  skipped: [...en.unknown].sort(),
  unit: 'repositories',
  hint: 'The token cannot read the feature status of these repositories (needs repository admin read or security events read).',
});

const notEnabledRefs = (en: Enablement, feature: string) => [...en.disabled].sort().map((n): ResourceRef => ({ id: n, name: n, detail: `${feature} not enabled` }));

/** Nothing to alert on because the feature is off everywhere: a control that is not monitored at all fails. */
function notEnabledAnywhere(feature: string, en: Enablement, scope: { list: unknown[]; total: number; truncated: boolean }): CheckOutcome {
  const outcome = fail(`${feature} not enabled on any of the ${en.disabled.length} evaluated repositories.`, notEnabledRefs(en, feature), { enabled: 0, notEnabled: en.disabled.length });
  return repoCap(applyCoverage(outcome, enablementCoverage(en)), scope);
}

/** Partial enablement turns a clean result into warn "not enabled on N of M repositories". */
function withEnablement(o: CheckOutcome, feature: string, en: Enablement): CheckOutcome {
  let out = o;
  if (en.disabled.length) {
    const note = `${feature} not enabled on ${en.disabled.length} of ${en.enabled.length + en.disabled.length} repositories.`;
    const resources = [...(o.resources ?? []), ...notEnabledRefs(en, feature)].slice(0, 500);
    const evidence = { ...o.evidence, enabled: en.enabled.length, notEnabled: en.disabled.length };
    out = { ...o, status: o.status === 'pass' ? 'warn' : o.status, summary: `${o.summary} ${note}`, resources, evidence };
  }
  return applyCoverage(out, enablementCoverage(en));
}

const checks: Record<string, (ctx: GhCtx) => Promise<CheckOutcome>> = {
  async 'gh.org-2fa'(ctx) {
    const o = await org(ctx);
    if (o.two_factor_requirement_enabled === true) return pass('Two-factor authentication is required for all members.');
    if (o.two_factor_requirement_enabled === false) return fail('The organisation does not require two-factor authentication.');
    return warn('Could not determine the 2FA requirement (token needs organisation owner visibility).');
  },

  async 'gh.base-permissions'(ctx) {
    const p = (await org(ctx)).default_repository_permission;
    if (!p) return warn('Base permission not visible to this token.');
    if (p === 'admin' || p === 'write') return fail(`Base permission is "${p}" for all members.`, [], { default_repository_permission: p });
    return pass(`Base permission is "${p}".`);
  },

  async 'gh.owner-count'(ctx) {
    const owners = await ghAll<any>(ctx, `/orgs/${ctx.org}/members?role=admin`);
    const res = owners.map((o) => ({ id: String(o.id), name: o.login }));
    if (!owners.length) return { status: 'error', summary: 'No organisation owners are visible to this token, so the owner count could not be evaluated.' };
    if (owners.length > 5) return fail(`${owners.length} organisation owners.`, res);
    if (owners.length > 4) return warn(`${owners.length} organisation owners (recommended 2-4).`, res);
    if (owners.length < 2) return warn('Only 1 organisation owner: risk of lock-out if that account is lost. Add a second owner (2-4 recommended).', res);
    return applyTruncation(pass(`${owners.length} organisation owners.`, { resources: res }), owners.truncated, owners.length, 'owners');
  },

  async 'gh.outside-collaborators'(ctx) {
    const oc = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/outside_collaborators`));
    if (oc === null) return na('Outside collaborators not visible to this token.');
    return failIfAny(oc.map((u) => ({ id: String(u.id), name: u.login })), (n) => `${n} outside collaborator(s) to review.`, 'No outside collaborators.', 'warn');
  },

  async 'gh.public-repo-creation'(ctx) {
    const o = await org(ctx);
    if (o.members_can_create_public_repositories === undefined) return warn('Setting not visible to this token.');
    return o.members_can_create_public_repositories ? warn('Members can create public repositories.') : pass('Members cannot create public repositories.');
  },

  async 'gh.private-forking'(ctx) {
    const o = await org(ctx);
    if (o.members_can_fork_private_repositories === undefined) return na('Setting not visible to this token.');
    return o.members_can_fork_private_repositories ? warn('Members can fork private repositories.') : pass('Forking of private repositories is disabled.');
  },

  async 'gh.public-repos'(ctx) {
    const pub = (await repos(ctx)).filter((r) => r.visibility === 'public' || r.private === false);
    if (!pub.length) return pass('No public repositories.');
    return { status: 'warn', summary: `${pub.length} public repositor${pub.length === 1 ? 'y' : 'ies'}: confirm they are intended to be public.`, resources: pub.map((r) => repoRef(r)) };
  },

  async 'gh.branch-protection'(ctx) {
    const scope = await repoScope(ctx);
    const rs = scope.list.filter((r) => r.default_branch && r.size > 0);
    if (!rs.length) return repoCap(na('No non-empty repositories.'), scope);
    const bad: ResourceRef[] = [];
    await mapLimit(rs, 6, async (r) => {
      const br = await optional(() => ghOk<any>(ctx, `/repos/${r.full_name}/branches/${encodeURIComponent(r.default_branch)}`));
      if (br?.protected) return;
      const rules = await optional(() => ghOk<any[]>(ctx, `/repos/${r.full_name}/rules/branches/${encodeURIComponent(r.default_branch)}`));
      if (rules?.some((x) => x.type === 'pull_request')) return;
      bad.push(repoRef(r, `${r.default_branch} not protected`));
    });
    return repoCap(failIfAny(bad, (n) => `${n} of ${rs.length} repositories have an unprotected default branch.`, `All ${rs.length} repositories protect their default branch.`), scope);
  },

  async 'gh.secret-scanning'(ctx) {
    const scope = await repoScope(ctx);
    if (!scope.list.length) return repoCap(na('No repositories.'), scope);
    const known = scope.list.filter((r) => r.security_and_analysis);
    const bad = known.filter((r) => r.security_and_analysis?.secret_scanning?.status !== 'enabled').map((r) => repoRef(r, r.visibility));
    const outcome = failIfAny(bad, (n) => `Secret scanning disabled on ${n} of ${known.length} repositories.`, `Secret scanning enabled on all ${known.length} evaluated repositories.`);
    return repoCap(applyCoverage(outcome, settingsCoverage(scope.list, known)), scope);
  },

  async 'gh.push-protection'(ctx) {
    const scope = await repoScope(ctx);
    if (!scope.list.length) return repoCap(na('No repositories.'), scope);
    const known = scope.list.filter((r) => r.security_and_analysis);
    const bad = known.filter((r) => r.security_and_analysis?.secret_scanning_push_protection?.status !== 'enabled').map((r) => repoRef(r));
    const outcome = failIfAny(bad, (n) => `Push protection disabled on ${n} of ${known.length} repositories.`, `Push protection enabled on all ${known.length} evaluated repositories.`, 'warn');
    return repoCap(applyCoverage(outcome, settingsCoverage(scope.list, known)), scope);
  },

  async 'gh.dependabot-alerts'(ctx) {
    const scope = await repoScope(ctx);
    if (!scope.list.length) return repoCap(na('No repositories.'), scope);
    const en = await dependabotEnablement(ctx, scope.list);
    if (!en.enabled.length) return notEnabledAnywhere('Dependabot alerts', en, scope);
    const alerts = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/dependabot/alerts?state=open&severity=critical,high`, 2000));
    if (alerts === null) return { status: 'error', summary: 'Dependabot alerts are enabled, but the organisation alert list is not visible to this token (needs Dependabot alerts read).' };
    const byRepo = new Map<string, { c: number; h: number }>();
    for (const a of alerts) {
      const k = a.repository?.full_name ?? '?';
      const e = byRepo.get(k) ?? { c: 0, h: 0 };
      if (a.security_advisory?.severity === 'critical') e.c++;
      else e.h++;
      byRepo.set(k, e);
    }
    const res = [...byRepo.entries()].map(([k, v]) => ({ id: k, name: k, detail: `${v.c} critical, ${v.h} high` }));
    const count = `${alerts.length}${alerts.truncated ? '+' : ''}`;
    const outcome = failIfAny(res, () => `${count} open critical/high Dependabot alerts across ${res.length} repositories.`, 'No open critical or high Dependabot alerts.', 'fail');
    return repoCap(withEnablement(outcome, 'Dependabot alerts', en), scope);
  },

  async 'gh.code-scanning-alerts'(ctx) {
    const scope = await repoScope(ctx);
    if (!scope.list.length) return repoCap(na('No repositories.'), scope);
    const en = await codeScanningEnablement(ctx, scope.list);
    if (!en.enabled.length) return notEnabledAnywhere('Code scanning', en, scope);
    const alerts = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/code-scanning/alerts?state=open&severity=critical,high`, 2000));
    if (alerts === null) return { status: 'error', summary: 'Code scanning is enabled, but the organisation alert list is not visible to this token (needs code scanning alerts read).' };
    const byRepo = new Map<string, number>();
    for (const a of alerts) byRepo.set(a.repository?.full_name ?? '?', (byRepo.get(a.repository?.full_name ?? '?') ?? 0) + 1);
    const count = `${alerts.length}${alerts.truncated ? '+' : ''}`;
    const outcome = failIfAny([...byRepo.entries()].map(([k, n]) => ({ id: k, name: k, detail: `${n} alerts` })), () => `${count} open critical/high code scanning alerts.`, 'No open critical or high code scanning alerts.', 'warn');
    return repoCap(withEnablement(outcome, 'Code scanning', en), scope);
  },

  async 'gh.actions-allowed'(ctx) {
    const p = await optional(() => ghOk<any>(ctx, `/orgs/${ctx.org}/actions/permissions`));
    if (!p) return na('Actions settings not visible to this token.');
    if (p.enabled_repositories === 'none') return na('GitHub Actions is disabled.');
    return p.allowed_actions === 'all' ? warn('All actions and reusable workflows are allowed.', [], p) : pass(`Allowed actions restricted (${p.allowed_actions}).`, { evidence: p });
  },

  async 'gh.workflow-permissions'(ctx) {
    const p = await optional(() => ghOk<any>(ctx, `/orgs/${ctx.org}/actions/permissions/workflow`));
    if (!p) return na('Workflow settings not visible to this token.');
    if (p.default_workflow_permissions === 'write') return fail('Default GITHUB_TOKEN has read/write permissions.', [], p);
    if (p.can_approve_pull_request_reviews) return warn('Workflows may approve pull requests.', [], p);
    return pass('Default workflow token is read-only and cannot approve PRs.', { evidence: p });
  },

  async 'gh.deploy-keys'(ctx) {
    const scope = await repoScope(ctx);
    if (!scope.list.length) return repoCap(na('No repositories.'), scope);
    const bad: ResourceRef[] = [];
    const hidden: string[] = [];
    await mapLimit(scope.list, 6, async (r) => {
      const keys = await optional(() => ghOk<any[]>(ctx, `/repos/${r.full_name}/keys`));
      if (!keys) return void hidden.push(r.full_name);
      for (const k of keys) if (!k.read_only) bad.push({ id: `${r.full_name}#${k.id}`, name: r.full_name, detail: `write key "${k.title}"` });
    });
    const evaluated = scope.list.length - hidden.length;
    const outcome = failIfAny(bad, (n) => `${n} write-enabled deploy key(s).`, `All deploy keys in ${evaluated} evaluated repositories are read-only.`, 'warn');
    return repoCap(
      applyCoverage(outcome, { evaluated, total: scope.list.length, skipped: hidden.sort(), unit: 'repositories', hint: 'Deploy keys need repository admin read (Administration: read).' }),
      scope,
    );
  },

  async 'gh.webhooks'(ctx) {
    const hooks = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/hooks`));
    if (hooks === null) return na('Organisation webhooks not visible to this token.');
    if (!hooks.length) return na('No organisation webhooks.');
    const bad = hooks
      .filter((h) => h.config?.insecure_ssl === '1' || String(h.config?.url ?? '').startsWith('http://'))
      // Only the origin: webhook paths and credentials often contain tokens.
      .map((h) => ({ id: String(h.id), name: safeOrigin(String(h.config?.url ?? '')), detail: h.config?.insecure_ssl === '1' ? 'SSL verification off' : 'plain HTTP' }));
    return failIfAny(bad, (n) => `${n} webhook(s) without verified HTTPS.`, `All ${hooks.length} webhooks use verified HTTPS.`, 'warn');
  },
};

export const githubModule: ProviderModule<GhCtx> = {
  async connect(config, secret, _env, memo) {
    if (!secret?.token) throw new CheckError('GitHub token is missing.');
    return { org: config.org, token: secret.token, memo };
  },
  async identity(ctx) {
    const me = await gh<any>(ctx, '/user');
    const o = await gh<any>(ctx, `/orgs/${ctx.org}`);
    if (o.status === 404) return { ok: false, message: `Organisation "${ctx.org}" not found or not accessible with this token.` };
    if (o.status >= 400) return { ok: false, message: `GitHub returned ${o.status}: ${o.data?.message}` };
    const ownerView = o.data.two_factor_requirement_enabled !== undefined && o.data.two_factor_requirement_enabled !== null;
    return {
      ok: true,
      message: `Connected to ${o.data.login}${me.status === 200 ? ` as ${me.data.login}` : ''}.${ownerView ? '' : ' Token lacks owner-level visibility: some organisation settings will be reported as unknown.'}`,
      details: { org: o.data.login, user: me.data?.login, scopes: me.headers.get('x-oauth-scopes'), ownerView },
    };
  },
  checks,
};
