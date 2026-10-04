import type { CheckOutcome, ResourceRef } from '@qs/shared';
import { githubOrgSettingsUrl, githubRepoUrl, githubUrl } from '../links.js';
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
const DAY_MS = 24 * 3600 * 1000;
/** Code scanning only counts as set up when an analysis ran in this window. */
const CODE_SCANNING_MAX_AGE_DAYS = 90;

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
async function ghAll<T = any>(ctx: GhCtx, path: string, max = 5000, itemsOf: (data: any) => unknown = (d) => d): Promise<Listed<T>> {
  const out: T[] = [];
  let next: string | undefined = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  const seen = new Set<string>();
  for (let pages = 0; next; pages++) {
    if (out.length >= max || pages >= MAX_PAGES || seen.has(next)) return listed(out, true);
    seen.add(next);
    const r: { status: number; data: any; headers: Headers } = await gh(ctx, next);
    if (r.status >= 400) throw new GhError(`GitHub ${r.status} on ${path.split('?')[0]}: ${r.data?.message ?? ''}`, r.status);
    const raw = itemsOf(r.data);
    const items = Array.isArray(raw) ? raw : [];
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

/** Returns null when the endpoint is not visible (404/403: feature off, no licence or missing permission). */
async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GhError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

/**
 * Consistent handling of what the token cannot see:
 * - an organisation setting that is absent from the API response (token without owner visibility) gives warn
 *   "could not determine", so a weaker token never scores better than a clean result;
 * - an endpoint that answers 403/404 because a permission is missing gives error (could not be evaluated) with
 *   the permission to add.
 */
const hiddenSetting = (what: string): CheckOutcome =>
  warn(`Could not determine ${what}: the setting is not visible to this token (it needs organisation owner visibility).`, [], { hidden: true });
const notVisible = (what: string, permission: string): CheckOutcome => ({
  status: 'error',
  summary: `${what} could not be evaluated: not visible to this token. Grant ${permission} (read-only) and rescan.`,
});

const safeOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '(invalid URL)';
  }
};

const ownerOf = (fullName: string) => fullName.split('/')[0];
const repoRef = (r: any, detail?: string, sub?: string): ResourceRef => repoNameRef(r.full_name, detail, sub);
const repoNameRef = (fullName: string, detail?: string, sub?: string): ResourceRef => ({
  id: fullName,
  name: fullName,
  detail,
  type: 'Repository',
  url: githubRepoUrl(fullName, sub),
  account: ownerOf(fullName),
});
const memberRef = (ctx: GhCtx, u: any, detail?: string): ResourceRef => ({
  id: String(u.login ?? u.id),
  name: u.login,
  detail,
  type: 'Member',
  url: u.login ? githubUrl(u.login) : undefined,
  account: ctx.org,
});
const orgSettingRef = (ctx: GhCtx, name: string, sub: string, detail?: string): ResourceRef => ({
  id: `${ctx.org}/settings/${sub}`,
  name,
  detail,
  type: 'Organisation setting',
  url: githubOrgSettingsUrl(ctx.org, sub),
  account: ctx.org,
});

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
  /** Optional reason per disabled repository (e.g. last analysis too old). */
  reasons?: Record<string, string>;
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

/**
 * Code scanning per repository: set up when the most recent analysis is at most 90 days old.
 * An older analysis means scanning stopped (workflow removed or failing) and counts as not enabled.
 */
const codeScanningEnablement = (ctx: GhCtx, list: any[]) =>
  ctx.memo.get('code-scanning-enablement', async () => {
    const en: Enablement = { enabled: [], disabled: [], unknown: [], reasons: {} };
    const cutoff = Date.now() - CODE_SCANNING_MAX_AGE_DAYS * DAY_MS;
    await mapLimit(
      list,
      6,
      async (r) => {
        const res = await gh<any>(ctx, `/repos/${r.full_name}/code-scanning/analyses?per_page=1`);
        const msg = String(res.data?.message ?? '');
        if (res.status === 200 && Array.isArray(res.data) && res.data.length) {
          const last = Date.parse(res.data[0]?.created_at ?? '');
          if (Number.isFinite(last) && last < cutoff) {
            en.disabled.push(r.full_name);
            en.reasons![r.full_name] = `no analysis in the last ${CODE_SCANNING_MAX_AGE_DAYS} days (last ${new Date(last).toISOString().slice(0, 10)})`;
          } else en.enabled.push(r.full_name);
        } else if (res.status === 200 || res.status === 404 || (res.status === 403 && /advanced security|not enabled/i.test(msg))) en.disabled.push(r.full_name);
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

const notEnabledRefs = (en: Enablement, feature: string) =>
  [...en.disabled].sort().map((n): ResourceRef => repoNameRef(n, en.reasons?.[n] ? `${feature}: ${en.reasons[n]}` : `${feature} not enabled`, 'settings/security_analysis'));

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

/** Add a "pass becomes warn" note with extra resources. */
function addIssues(o: CheckOutcome, note: string, extra: ResourceRef[], evidence: Record<string, unknown>): CheckOutcome {
  if (!extra.length) return o;
  return {
    ...o,
    status: o.status === 'pass' || o.status === 'na' ? 'warn' : o.status,
    summary: `${o.summary} ${note}`,
    resources: [...(o.resources ?? []), ...extra].slice(0, 500),
    evidence: { ...o.evidence, ...evidence },
  };
}

// ----- Branch protection content -----------------------------------------------------------------------------------

export type ProtectionLevel = 'protected' | 'partial' | 'unprotected' | 'hidden';
export interface ProtectionResult {
  level: ProtectionLevel;
  missing: string[];
  notes: string[];
}

const REQUIREMENTS = {
  reviews: 'at least 1 required approving review',
  stale: 'stale approvals dismissed on new commits',
  admins: 'rules also apply to administrators (enforce admins or no ruleset bypass actors)',
  forcePush: 'force pushes blocked',
  deletion: 'branch deletion blocked',
} as const;

/** Ruleset details (bypass actors) are shared by every repository an organisation ruleset applies to. */
const rulesetDetail = (ctx: GhCtx, repo: string, id: number) => ctx.memo.get(`ruleset:${id}`, () => optional(() => ghOk<any>(ctx, `/repos/${repo}/rulesets/${id}`)));

/**
 * Evaluate classic branch protection plus active rulesets for the default branch.
 * A 403/404 on the branch itself, or a protected branch whose settings cannot be read, is "hidden" (never unprotected).
 */
export async function evaluateBranchProtection(ctx: GhCtx, r: any): Promise<ProtectionResult> {
  const branch = encodeURIComponent(r.default_branch);
  const br = await optional(() => ghOk<any>(ctx, `/repos/${r.full_name}/branches/${branch}`));
  if (!br) return { level: 'hidden', missing: [], notes: ['default branch not visible'] };

  let classic: any = null;
  let classicHidden = false;
  if (br.protected) {
    const res = await gh<any>(ctx, `/repos/${r.full_name}/branches/${branch}/protection`);
    if (res.status === 200 && res.data && typeof res.data === 'object') classic = res.data;
    else if (res.status === 403 || (res.status === 404 && !/not protected/i.test(String(res.data?.message ?? '')))) classicHidden = true;
    else if (res.status >= 500) throw new GhError(`GitHub ${res.status} on /repos/${r.full_name}/branches/${branch}/protection`, res.status);
  }

  const rulesRaw = await optional(() => ghOk<any>(ctx, `/repos/${r.full_name}/rules/branches/${branch}`));
  const rules: any[] = Array.isArray(rulesRaw) ? rulesRaw : [];

  if (!classic && !rules.length) {
    if (classicHidden) return { level: 'hidden', missing: [], notes: ['protection settings not visible (needs Administration: read)'] };
    // Explain a ruleset that exists but is not enforced.
    const sets = await optional(() => ghOk<any>(ctx, `/repos/${r.full_name}/rulesets?includes_parents=true&per_page=100`));
    const inactive = (Array.isArray(sets) ? sets : []).filter((s) => s?.target !== 'tag' && s?.enforcement && s.enforcement !== 'active');
    const notes = inactive.map((s) => `ruleset "${s.name}" is ${s.enforcement === 'evaluate' ? 'in evaluate mode (not enforced)' : s.enforcement}`);
    return { level: 'unprotected', missing: Object.values(REQUIREMENTS), notes };
  }

  const pr = rules.filter((x) => x.type === 'pull_request');
  const reviews =
    (classic?.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1 ||
    pr.some((x) => (x.parameters?.required_approving_review_count ?? 0) >= 1);
  const stale = classic?.required_pull_request_reviews?.dismiss_stale_reviews === true || pr.some((x) => x.parameters?.dismiss_stale_reviews_on_push === true);
  const forcePush = classic?.allow_force_pushes?.enabled === false || rules.some((x) => x.type === 'non_fast_forward');
  const deletion = classic?.allow_deletions?.enabled === false || rules.some((x) => x.type === 'deletion');

  const notes: string[] = [];
  let admins = classic?.enforce_admins?.enabled === true;
  if (!admins && pr.length) {
    // Rulesets: the pull request rule counts for admins only when its ruleset has no bypass actors.
    const ids = [...new Set(pr.map((x) => x.ruleset_id).filter((x) => typeof x === 'number'))] as number[];
    const details = await Promise.all(ids.map((id) => rulesetDetail(ctx, r.full_name, id)));
    const visible = details.filter((d) => d && Array.isArray(d.bypass_actors));
    if (visible.some((d) => d.bypass_actors.length === 0)) admins = true;
    else if (!visible.length && ids.length) {
      // Bypass list not visible to this token: do not penalise, but say so.
      admins = true;
      notes.push('ruleset bypass actors not visible');
    } else {
      const actors = visible.flatMap((d) => d.bypass_actors.map((a: any) => a.actor_type)).filter(Boolean);
      if (actors.length) notes.push(`bypass allowed for ${[...new Set(actors)].join(', ')}`);
    }
  }

  const missing = [
    !reviews && REQUIREMENTS.reviews,
    !stale && REQUIREMENTS.stale,
    !admins && REQUIREMENTS.admins,
    !forcePush && REQUIREMENTS.forcePush,
    !deletion && REQUIREMENTS.deletion,
  ].filter(Boolean) as string[];
  return { level: missing.length ? 'partial' : 'protected', missing, notes };
}

// ----- Outside collaborators ----------------------------------------------------------------------------------------

const PERM_RANK: Record<string, number> = { read: 1, pull: 1, triage: 2, write: 3, push: 3, maintain: 4, admin: 5 };
const permOf = (c: any): string => {
  const role = String(c.role_name ?? '').toLowerCase();
  if (PERM_RANK[role]) return role === 'pull' ? 'read' : role === 'push' ? 'write' : role;
  const p = c.permissions ?? {};
  if (p.admin) return 'admin';
  if (p.maintain) return 'maintain';
  if (p.push) return 'write';
  if (p.triage) return 'triage';
  return 'read';
};

// ----- GitHub Apps --------------------------------------------------------------------------------------------------

/** Permissions that let an app change code, CI, secrets or the organisation itself when granted with write. */
const BROAD_APP_PERMS = ['administration', 'organization_administration', 'members', 'contents', 'workflows', 'secrets', 'organization_secrets', 'actions', 'environments'];
/** Write on these is an organisation takeover path. */
const CRITICAL_APP_PERMS = ['organization_administration', 'members'];

// ----- New-repository security defaults ----------------------------------------------------------------------------

const SECURITY_DEFAULTS: { field: string; label: string; config: string }[] = [
  { field: 'dependency_graph_enabled_for_new_repositories', label: 'dependency graph', config: 'dependency_graph' },
  { field: 'dependabot_alerts_enabled_for_new_repositories', label: 'Dependabot alerts', config: 'dependabot_alerts' },
  { field: 'dependabot_security_updates_enabled_for_new_repositories', label: 'Dependabot security updates', config: 'dependabot_security_updates' },
  { field: 'secret_scanning_enabled_for_new_repositories', label: 'secret scanning', config: 'secret_scanning' },
  { field: 'secret_scanning_push_protection_enabled_for_new_repositories', label: 'secret scanning push protection', config: 'secret_scanning_push_protection' },
];

const checks: Record<string, (ctx: GhCtx) => Promise<CheckOutcome>> = {
  async 'gh.org-2fa'(ctx) {
    const o = await org(ctx);
    if (o.two_factor_requirement_enabled === true) return pass('Two-factor authentication is required for all members.');
    if (o.two_factor_requirement_enabled === false)
      return fail('The organisation does not require two-factor authentication.', [orgSettingRef(ctx, 'Authentication security', 'security', 'Require two-factor authentication is off')]);
    return hiddenSetting('the 2FA requirement');
  },

  async 'gh.base-permissions'(ctx) {
    const p = (await org(ctx)).default_repository_permission;
    if (!p) return hiddenSetting('the base repository permission');
    if (p === 'admin' || p === 'write')
      return fail(`Base permission is "${p}" for all members.`, [orgSettingRef(ctx, 'Member privileges', 'member_privileges', `base permission ${p}`)], { default_repository_permission: p });
    return pass(`Base permission is "${p}".`, { evidence: { default_repository_permission: p } });
  },

  async 'gh.owner-count'(ctx) {
    const owners = await ghAll<any>(ctx, `/orgs/${ctx.org}/members?role=admin`);
    const res = owners.map((o) => memberRef(ctx, o, 'organisation owner'));
    if (!owners.length) return { status: 'error', summary: 'No organisation owners are visible to this token, so the owner count could not be evaluated.' };
    if (owners.length > 5) return fail(`${owners.length} organisation owners.`, res);
    if (owners.length > 4) return warn(`${owners.length} organisation owners (recommended 2-4).`, res);
    if (owners.length < 2) return warn('Only 1 organisation owner: risk of lock-out if that account is lost. Add a second owner (2-4 recommended).', res);
    return applyTruncation(pass(`${owners.length} organisation owners.`, { resources: res }), owners.truncated, owners.length, 'owners');
  },

  /**
   * Outside collaborators with their highest repository permission: admin/maintain/write fails, read/triage warns.
   * Org list (Members: read) plus per-repository collaborators with affiliation=outside for repositories in scope.
   */
  async 'gh.outside-collaborators'(ctx) {
    const orgList = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/outside_collaborators`));
    if (orgList && !orgList.length && !orgList.truncated) return pass('No outside collaborators.');
    const scope = await repoScope(ctx);
    const access = new Map<string, { user: any; perm: string; repos: string[] }>();
    const hidden: string[] = [];
    await mapLimit(
      scope.list,
      6,
      async (r) => {
        const cs = await optional(() => ghAll<any>(ctx, `/repos/${r.full_name}/collaborators?affiliation=outside`, 1000));
        if (cs === null) return void hidden.push(r.full_name);
        for (const c of cs) {
          const perm = permOf(c);
          const e = access.get(c.login) ?? { user: c, perm, repos: [] };
          if (PERM_RANK[perm] > PERM_RANK[e.perm]) e.perm = perm;
          e.repos.push(`${r.full_name.split('/')[1]} (${perm})`);
          access.set(c.login, e);
        }
      },
      ctx.signal,
    );
    if (orgList === null && hidden.length === scope.list.length) return notVisible('Outside collaborators', 'organisation Members: read');
    for (const u of orgList ?? []) if (!access.has(u.login)) access.set(u.login, { user: u, perm: '', repos: [] });

    const entries = [...access.values()].sort((a, b) => (PERM_RANK[b.perm] ?? 0) - (PERM_RANK[a.perm] ?? 0) || a.user.login.localeCompare(b.user.login));
    const strong = entries.filter((e) => (PERM_RANK[e.perm] ?? 0) >= PERM_RANK.write);
    const resources = entries.map((e) => {
      const list = e.repos.slice(0, 5).join(', ') + (e.repos.length > 5 ? ` and ${e.repos.length - 5} more` : '');
      return memberRef(ctx, e.user, e.perm ? `outside collaborator, highest permission ${e.perm}: ${list}` : 'outside collaborator, no access found in the evaluated repositories');
    });
    const evidence = { outsideCollaborators: entries.length, withWriteOrAdmin: strong.length };
    let outcome: CheckOutcome;
    if (!entries.length) outcome = pass('No outside collaborators.');
    else if (strong.length) outcome = fail(`${strong.length} of ${entries.length} outside collaborator(s) have write or admin access.`, resources, evidence);
    else outcome = warn(`${entries.length} outside collaborator(s) with read or triage access to review.`, resources, evidence);
    outcome = applyCoverage(outcome, {
      evaluated: scope.list.length - hidden.length,
      total: scope.list.length,
      skipped: hidden.sort(),
      unit: 'repositories',
      hint: 'Repository collaborators need repository Metadata: read.',
    });
    return repoCap(outcome, scope);
  },

  async 'gh.public-repo-creation'(ctx) {
    const o = await org(ctx);
    if (o.members_can_create_public_repositories === undefined || o.members_can_create_public_repositories === null) return hiddenSetting('whether members can create public repositories');
    return o.members_can_create_public_repositories
      ? warn('Members can create public repositories.', [orgSettingRef(ctx, 'Repository creation', 'member_privileges', 'public repositories allowed')])
      : pass('Members cannot create public repositories.');
  },

  async 'gh.private-forking'(ctx) {
    const o = await org(ctx);
    if (o.members_can_fork_private_repositories === undefined || o.members_can_fork_private_repositories === null) return hiddenSetting('the private repository forking policy');
    return o.members_can_fork_private_repositories
      ? warn('Members can fork private repositories.', [orgSettingRef(ctx, 'Repository forking', 'member_privileges', 'forking of private repositories allowed')])
      : pass('Forking of private repositories is disabled.');
  },

  async 'gh.public-repos'(ctx) {
    const pub = (await repos(ctx)).filter((r) => r.visibility === 'public' || r.private === false);
    if (!pub.length) return pass('No public repositories.');
    return warn(
      `${pub.length} public repositor${pub.length === 1 ? 'y' : 'ies'}: confirm they are intended to be public.`,
      pub.map((r) => repoRef(r, 'public')),
    );
  },

  async 'gh.branch-protection'(ctx) {
    const scope = await repoScope(ctx);
    const rs = scope.list.filter((r) => r.default_branch && r.size > 0);
    if (!rs.length) return repoCap(na('No non-empty repositories.'), scope);
    const unprotected: ResourceRef[] = [];
    const partial: ResourceRef[] = [];
    const hidden: string[] = [];
    await mapLimit(
      rs,
      6,
      async (r) => {
        const p = await evaluateBranchProtection(ctx, r);
        const notes = p.notes.length ? ` (${p.notes.join('; ')})` : '';
        if (p.level === 'hidden') hidden.push(r.full_name);
        else if (p.level === 'unprotected') unprotected.push(repoRef(r, `${r.default_branch} not protected${notes}`, 'settings/rules'));
        else if (p.level === 'partial') partial.push(repoRef(r, `${r.default_branch} missing: ${p.missing.join(', ')}${notes}`, 'settings/rules'));
      },
      ctx.signal,
    );
    const evaluated = rs.length - hidden.length;
    const byName = (a: ResourceRef, b: ResourceRef) => a.id.localeCompare(b.id);
    const resources = [...unprotected.sort(byName), ...partial.sort(byName)];
    const evidence = { evaluated, unprotected: unprotected.length, partial: partial.length };
    let outcome: CheckOutcome;
    if (unprotected.length)
      outcome = fail(
        `${unprotected.length} of ${evaluated} repositories have an unprotected default branch${partial.length ? `, ${partial.length} more are only partially protected` : ''}.`,
        resources,
        evidence,
      );
    else if (partial.length) outcome = warn(`${partial.length} of ${evaluated} repositories only partially protect their default branch.`, resources, evidence);
    else outcome = pass(`All ${evaluated} evaluated repositories fully protect their default branch.`, { evidence });
    outcome = applyCoverage(outcome, {
      evaluated,
      total: rs.length,
      skipped: hidden.sort(),
      unit: 'repositories',
      hint: 'Branch protection settings need repository Administration: read.',
    });
    return repoCap(outcome, scope);
  },

  async 'gh.secret-scanning'(ctx) {
    const scope = await repoScope(ctx);
    if (!scope.list.length) return repoCap(na('No repositories.'), scope);
    const known = scope.list.filter((r) => r.security_and_analysis);
    const bad = known.filter((r) => r.security_and_analysis?.secret_scanning?.status !== 'enabled').map((r) => repoRef(r, `${r.visibility}, secret scanning off`, 'settings/security_analysis'));
    const outcome = failIfAny(bad, (n) => `Secret scanning disabled on ${n} of ${known.length} repositories.`, `Secret scanning enabled on all ${known.length} evaluated repositories.`);
    return repoCap(applyCoverage(outcome, settingsCoverage(scope.list, known)), scope);
  },

  async 'gh.push-protection'(ctx) {
    const scope = await repoScope(ctx);
    if (!scope.list.length) return repoCap(na('No repositories.'), scope);
    const known = scope.list.filter((r) => r.security_and_analysis);
    const bad = known
      .filter((r) => r.security_and_analysis?.secret_scanning_push_protection?.status !== 'enabled')
      .map((r) => repoRef(r, 'push protection off', 'settings/security_analysis'));
    const outcome = failIfAny(bad, (n) => `Push protection disabled on ${n} of ${known.length} repositories.`, `Push protection enabled on all ${known.length} evaluated repositories.`, 'warn');
    return repoCap(applyCoverage(outcome, settingsCoverage(scope.list, known)), scope);
  },

  async 'gh.secret-scanning-alerts'(ctx) {
    const alerts = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/secret-scanning/alerts?state=open`, 2000));
    if (alerts === null) return notVisible('Secret scanning alerts', 'repository Secret scanning alerts: read');
    if (!alerts.length) {
      const known = (await repos(ctx)).filter((r) => r.security_and_analysis);
      if (known.length && !known.some((r) => r.security_and_analysis?.secret_scanning?.status === 'enabled'))
        return na('Secret scanning is not enabled on any evaluated repository, so there are no alerts to review (see "Secret scanning enabled").');
      return pass('No open secret scanning alerts.');
    }
    const byRepo = new Map<string, { n: number; types: Set<string> }>();
    for (const a of alerts) {
      // Never copy the secret value itself (a.secret) into results.
      const k = a.repository?.full_name ?? '?';
      const e = byRepo.get(k) ?? { n: 0, types: new Set<string>() };
      e.n++;
      e.types.add(String(a.secret_type_display_name ?? a.secret_type ?? 'secret'));
      byRepo.set(k, e);
    }
    const res = [...byRepo.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .map(([k, v]) => {
        const types = [...v.types];
        return repoNameRef(k, `${v.n} open alert${v.n === 1 ? '' : 's'}: ${types.slice(0, 4).join(', ')}${types.length > 4 ? ` and ${types.length - 4} more` : ''}`, 'security/secret-scanning');
      });
    const count = `${alerts.length}${alerts.truncated ? '+' : ''}`;
    return fail(`${count} open secret scanning alert(s) across ${res.length} repositor${res.length === 1 ? 'y' : 'ies'}: rotate the exposed credentials.`, res, {
      openAlerts: alerts.length,
      truncated: alerts.truncated,
    });
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
    const res = [...byRepo.entries()].map(([k, v]) => repoNameRef(k, `${v.c} critical, ${v.h} high`, 'security/dependabot'));
    const count = `${alerts.length}${alerts.truncated ? '+' : ''}`;
    let outcome = failIfAny(res, () => `${count} open critical/high Dependabot alerts across ${res.length} repositories.`, 'No open critical or high Dependabot alerts.', 'fail');
    outcome = withEnablement(outcome, 'Dependabot alerts', en);
    // Dependabot security updates (automatic fix pull requests), read from the repository security settings.
    const enabledSet = new Set(en.enabled);
    const noUpdates = scope.list.filter((r) => enabledSet.has(r.full_name) && r.security_and_analysis && r.security_and_analysis.dependabot_security_updates?.status !== 'enabled');
    outcome = addIssues(
      outcome,
      `Dependabot security updates not enabled on ${noUpdates.length} repositor${noUpdates.length === 1 ? 'y' : 'ies'} with alerts on.`,
      noUpdates.map((r) => repoRef(r, 'Dependabot security updates not enabled', 'settings/security_analysis')),
      { noSecurityUpdates: noUpdates.length },
    );
    return repoCap(outcome, scope);
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
    const outcome = failIfAny(
      [...byRepo.entries()].map(([k, n]) => repoNameRef(k, `${n} alerts`, 'security/code-scanning')),
      () => `${count} open critical/high code scanning alerts.`,
      'No open critical or high code scanning alerts.',
      'warn',
    );
    return repoCap(withEnablement(outcome, 'Code scanning', en), scope);
  },

  async 'gh.actions-allowed'(ctx) {
    const p = await optional(() => ghOk<any>(ctx, `/orgs/${ctx.org}/actions/permissions`));
    if (!p) return notVisible('GitHub Actions settings', 'organisation Administration: read');
    if (p.enabled_repositories === 'none') return na('GitHub Actions is disabled.');
    const ref = orgSettingRef(ctx, 'Actions policy', 'actions');
    if (p.allowed_actions === 'all') return warn('All actions and reusable workflows are allowed.', [{ ...ref, detail: 'allowed_actions: all' }], p);
    if (p.allowed_actions === 'local_only') return pass('Only actions and reusable workflows from this organisation are allowed.', { evidence: p });
    if (p.allowed_actions === 'selected') {
      const s = await optional(() => ghOk<any>(ctx, `/orgs/${ctx.org}/actions/permissions/selected-actions`));
      if (!s) return notVisible('The selected actions list', 'organisation Administration: read');
      const patterns: string[] = Array.isArray(s.patterns_allowed) ? s.patterns_allowed : [];
      // A pattern that starts with a wildcard (e.g. "*", "*/*", "*@*") matches every action, so the restriction is void.
      const wildcard = patterns.filter((x) => /^\s*\*/.test(x));
      const evidence = { ...p, selected: s };
      if (wildcard.length) return warn(`Allowed actions are "selected", but the pattern ${wildcard.map((x) => `"${x}"`).join(', ')} allows every action.`, [{ ...ref, detail: `patterns: ${patterns.join(', ')}` }], evidence);
      const parts = [s.github_owned_allowed ? 'GitHub-owned' : '', s.verified_allowed ? 'verified creators' : '', patterns.length ? `${patterns.length} listed pattern(s)` : ''].filter(Boolean);
      return pass(`Allowed actions restricted to ${parts.length ? parts.join(', ') : 'organisation actions only'}.`, { evidence });
    }
    return pass(`Allowed actions restricted (${p.allowed_actions}).`, { evidence: p });
  },

  async 'gh.workflow-permissions'(ctx) {
    const p = await optional(() => ghOk<any>(ctx, `/orgs/${ctx.org}/actions/permissions/workflow`));
    if (!p) return notVisible('Workflow token settings', 'organisation Administration: read');
    const ref = orgSettingRef(ctx, 'Workflow permissions', 'actions');
    if (p.default_workflow_permissions === 'write') return fail('Default GITHUB_TOKEN has read/write permissions.', [{ ...ref, detail: 'default_workflow_permissions: write' }], p);
    if (p.can_approve_pull_request_reviews) return warn('Workflows may approve pull requests.', [{ ...ref, detail: 'can_approve_pull_request_reviews: true' }], p);
    return pass('Default workflow token is read-only and cannot approve PRs.', { evidence: p });
  },

  async 'gh.deploy-keys'(ctx) {
    const scope = await repoScope(ctx);
    if (!scope.list.length) return repoCap(na('No repositories.'), scope);
    const bad: ResourceRef[] = [];
    const hidden: string[] = [];
    await mapLimit(
      scope.list,
      6,
      async (r) => {
        const keys = await optional(() => ghOk<any[]>(ctx, `/repos/${r.full_name}/keys`));
        if (!keys) return void hidden.push(r.full_name);
        for (const k of keys)
          if (!k.read_only)
            bad.push({ id: `${r.full_name}#${k.id}`, name: r.full_name, detail: `write key "${k.title}"`, type: 'Deploy key', url: githubRepoUrl(r.full_name, 'settings/keys'), account: ownerOf(r.full_name) });
      },
      ctx.signal,
    );
    const evaluated = scope.list.length - hidden.length;
    const outcome = failIfAny(bad, (n) => `${n} write-enabled deploy key(s).`, `All deploy keys in ${evaluated} evaluated repositories are read-only.`, 'warn');
    return repoCap(
      applyCoverage(outcome, { evaluated, total: scope.list.length, skipped: hidden.sort(), unit: 'repositories', hint: 'Deploy keys need repository admin read (Administration: read).' }),
      scope,
    );
  },

  async 'gh.webhooks'(ctx) {
    const hooks = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/hooks`));
    if (hooks === null) return notVisible('Organisation webhooks', 'organisation Webhooks: read');
    if (!hooks.length) return na('No organisation webhooks.');
    const bad = hooks
      .filter((h) => h.config?.insecure_ssl === '1' || String(h.config?.url ?? '').startsWith('http://'))
      // Only the origin: webhook paths and credentials often contain tokens.
      .map(
        (h): ResourceRef => ({
          id: String(h.id),
          name: safeOrigin(String(h.config?.url ?? '')),
          detail: h.config?.insecure_ssl === '1' ? 'SSL verification off' : 'plain HTTP',
          type: 'Webhook',
          url: githubOrgSettingsUrl(ctx.org, `hooks/${h.id}`),
          account: ctx.org,
        }),
      );
    return failIfAny(bad, (n) => `${n} webhook(s) without verified HTTPS.`, `All ${hooks.length} webhooks use verified HTTPS.`, 'warn');
  },

  /** Members (and outside collaborators) without 2FA. Only meaningful when 2FA is not enforced; the filter needs an owner token. */
  async 'gh.members-without-2fa'(ctx) {
    const o = await org(ctx);
    if (o.two_factor_requirement_enabled === true) return pass('Two-factor authentication is enforced, so every member and collaborator has 2FA.');
    if (o.two_factor_requirement_enabled !== false) return notVisible('Members without 2FA', 'an organisation owner token (the 2FA filter is only shown to owners)');
    const members = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/members?filter=2fa_disabled`));
    if (members === null) return notVisible('Members without 2FA', 'an organisation owner token with Members: read');
    const outside = (await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/outside_collaborators?filter=2fa_disabled`))) ?? [];
    const res = [...members.map((u) => memberRef(ctx, u, 'member without 2FA')), ...outside.map((u) => memberRef(ctx, u, 'outside collaborator without 2FA'))];
    const outcome = failIfAny(
      res,
      (n) => `${n} account(s) without two-factor authentication (2FA is not enforced).`,
      'All members have two-factor authentication enabled, although it is not enforced.',
    );
    return applyTruncation(outcome, members.truncated, members.length, 'members');
  },

  async 'gh.app-installations'(ctx) {
    const inst = await optional(() => ghAll<any>(ctx, `/orgs/${ctx.org}/installations`, 1000, (d) => d?.installations));
    if (inst === null) return notVisible('GitHub App installations', 'organisation Administration: read');
    if (!inst.length) return pass('No GitHub Apps are installed on the organisation.');
    const critical: ResourceRef[] = [];
    const broad: ResourceRef[] = [];
    for (const i of inst) {
      if (i.suspended_at) continue;
      const perms: Record<string, string> = i.permissions ?? {};
      const writes = BROAD_APP_PERMS.filter((p) => perms[p] === 'write' || perms[p] === 'admin');
      if (!writes.length) continue;
      const all = i.repository_selection === 'all';
      const isCritical = writes.some((p) => CRITICAL_APP_PERMS.includes(p)) || (all && writes.includes('administration'));
      const slug = String(i.app_slug ?? i.app_id ?? i.id);
      const ref: ResourceRef = {
        id: String(i.id),
        name: slug,
        detail: `write: ${writes.join(', ')}; ${all ? 'all repositories' : 'selected repositories'}`,
        type: 'GitHub App',
        url: typeof i.html_url === 'string' && i.html_url.startsWith('https://github.com/') ? i.html_url : githubOrgSettingsUrl(ctx.org, `installations/${i.id}`),
        account: ctx.org,
      };
      (isCritical ? critical : broad).push(ref);
    }
    const resources = [...critical, ...broad];
    const evidence = { installations: inst.length, broad: resources.length, critical: critical.length };
    let outcome: CheckOutcome;
    if (critical.length) outcome = fail(`${critical.length} GitHub App(s) can administer the organisation or its members; ${resources.length} of ${inst.length} have broad write permissions.`, resources, evidence);
    else if (broad.length) outcome = warn(`${broad.length} of ${inst.length} GitHub App(s) have broad write permissions (code, workflows, secrets or administration).`, resources, evidence);
    else outcome = pass(`None of the ${inst.length} installed GitHub Apps hold broad write permissions.`, { evidence });
    return applyTruncation(outcome, inst.truncated, inst.length, 'installations');
  },

  /** Security features enabled automatically for new repositories (legacy org fields or a default code security configuration). */
  async 'gh.security-defaults'(ctx) {
    const o = await org(ctx);
    const visible = SECURITY_DEFAULTS.filter((d) => typeof o[d.field] === 'boolean');
    if (!visible.length) return hiddenSetting('the security defaults for new repositories');
    let off = visible.filter((d) => o[d.field] === false);
    let viaConfig: string | undefined;
    if (off.length) {
      // Newer organisations use code security configurations; a default configuration for all new repositories also counts.
      const defaults = await optional(() => ghOk<any[]>(ctx, `/orgs/${ctx.org}/code-security/configurations/defaults`));
      const cfg = (Array.isArray(defaults) ? defaults : []).find((d) => d?.default_for_new_repos === 'all')?.configuration;
      if (cfg) {
        viaConfig = cfg.name;
        off = off.filter((d) => cfg[d.config] !== 'enabled');
      }
    }
    const unknown = SECURITY_DEFAULTS.filter((d) => !visible.includes(d)).map((d) => d.label);
    const evidence = { ...Object.fromEntries(SECURITY_DEFAULTS.map((d) => [d.field, o[d.field] ?? null])), defaultConfiguration: viaConfig ?? null };
    const unknownNote = unknown.length ? ` Not visible: ${unknown.join(', ')}.` : '';
    if (off.length)
      return warn(
        `New repositories do not get ${off.map((d) => d.label).join(', ')} by default.${unknownNote}`,
        [orgSettingRef(ctx, 'Code security defaults', 'security_analysis', `off for new repositories: ${off.map((d) => d.label).join(', ')}`)],
        evidence,
      );
    const out = pass(`New repositories get ${visible.map((d) => d.label).join(', ')} by default${viaConfig ? ` (configuration "${viaConfig}")` : ''}.${unknownNote}`, { evidence });
    return unknown.length ? { ...out, status: 'warn' } : out;
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
