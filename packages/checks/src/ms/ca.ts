import type { CheckOutcome, ResourceRef } from '@qs/shared';
import { entraUrl } from '../links.js';
import { fail, pass, warn } from '../util.js';
import { graph, type MsCtx } from './client.js';
import { roleName } from './roles.js';

/**
 * Conditional Access evaluation shared by the Microsoft 365 checks.
 *
 * A policy counts as baseline enforcement only when it is enabled, its grant really enforces the requirement
 * (an OR with weaker alternatives does not), it applies to all users (or the required roles) and all cloud apps,
 * and no condition narrows it (locations, platforms, client apps, risk levels, authentication flows, device filters).
 * Exclusions limited to break-glass accounts (at most 2 users, no groups, roles, guests or apps) still pass;
 * broader exclusions downgrade to warn. Policies that almost qualify are reported as near misses with the reason.
 */

export interface CaPolicy {
  id: string;
  displayName: string;
  state: 'enabled' | 'disabled' | 'enabledForReportingButNotEnforced';
  conditions?: any;
  grantControls?: any;
  sessionControls?: any;
}

export type CaCondition = 'locations' | 'platforms' | 'clientAppTypes' | 'signInRisk' | 'userRisk' | 'authenticationFlows' | 'devices' | 'insiderRisk' | 'servicePrincipalRisk';

export interface CaRequirement {
  /** True when the policy is about this requirement at all (otherwise it is ignored, not a near miss). */
  purpose(p: CaPolicy): boolean;
  /** Reason the grant or session does not satisfy the requirement, or null. */
  control?(p: CaPolicy): string | null;
  /** Reason a required condition is missing (e.g. legacy client app types), or null. */
  required?(p: CaPolicy): string | null;
  /** Conditions that are part of the requirement itself and therefore do not narrow the policy. */
  allow?: CaCondition[];
  /** Required user scope: all users (default) or specific directory roles (all users also covers them). */
  roles?: string[];
}

export interface Exclusions {
  users: string[];
  groups: string[];
  roles: string[];
  guests: boolean;
  apps: string[];
}

export interface CaMatch {
  policy: CaPolicy;
  exclusions: Exclusions;
  /** Roles of the requirement that this policy covers (role requirements only). */
  roles: string[];
}

export interface CaEvaluation {
  enforced: CaMatch[];
  reportOnly: CaMatch[];
  nearMiss: { policy: CaPolicy; reason: string }[];
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const lower = (v: unknown) => arr(v).map((s) => s.toLowerCase());

export const builtIn = (p: CaPolicy): string[] => arr(p.grantControls?.builtInControls);
export const blocks = (p: CaPolicy) => builtIn(p).includes('block');
export const hasMfaGrant = (p: CaPolicy) => builtIn(p).includes('mfa') || Boolean(p.grantControls?.authenticationStrength);

/** With operator OR, the user may satisfy any one control: other controls than the wanted ones make it optional. */
export function orBypass(p: CaPolicy, wanted: string[]): string | null {
  const op = String(p.grantControls?.operator ?? 'OR').toUpperCase();
  if (op !== 'OR') return null;
  const others = builtIn(p).filter((g) => !wanted.includes(g));
  const wantedPresent = builtIn(p).some((g) => wanted.includes(g)) || (wanted.includes('mfa') && p.grantControls?.authenticationStrength);
  if (!wantedPresent || !others.length) return null;
  return `grant uses OR: ${others.join(', ')} satisfies the policy without ${wanted.join('/')}`;
}

function exclusionsOf(p: CaPolicy): Exclusions {
  const u = p.conditions?.users ?? {};
  const excludeUsers = arr(u.excludeUsers);
  return {
    users: excludeUsers.filter((x) => x !== 'GuestsOrExternalUsers'),
    groups: arr(u.excludeGroups),
    roles: arr(u.excludeRoles),
    guests: excludeUsers.includes('GuestsOrExternalUsers') || Boolean(u.excludeGuestsOrExternalUsers),
    apps: arr(p.conditions?.applications?.excludeApplications),
  };
}

export const isBreakGlassOnly = (e: Exclusions) => e.users.length <= 2 && !e.groups.length && !e.roles.length && !e.guests && !e.apps.length;
const noExclusions = (e: Exclusions) => !e.users.length && !e.groups.length && !e.roles.length && !e.guests && !e.apps.length;

/** Conditions that narrow a policy, minus the allowed ones. */
function narrowing(p: CaPolicy, allow: CaCondition[]): string[] {
  const c = p.conditions ?? {};
  const out: string[] = [];
  const add = (k: CaCondition, text: string) => {
    if (!allow.includes(k)) out.push(text);
  };
  const incLoc = arr(c.locations?.includeLocations);
  if ((incLoc.length && !incLoc.includes('All')) || arr(c.locations?.excludeLocations).length) add('locations', 'limited by location');
  const incPl = lower(c.platforms?.includePlatforms);
  if ((incPl.length && !incPl.includes('all')) || arr(c.platforms?.excludePlatforms).length) add('platforms', 'limited to some device platforms');
  const apps = lower(c.clientAppTypes);
  if (apps.length && !apps.includes('all') && !(apps.includes('browser') && apps.includes('mobileappsanddesktopclients'))) add('clientAppTypes', `limited to client apps ${arr(c.clientAppTypes).join(', ')}`);
  if (arr(c.signInRiskLevels).length) add('signInRisk', `only for sign-in risk ${arr(c.signInRiskLevels).join('/')}`);
  if (arr(c.userRiskLevels).length) add('userRisk', `only for user risk ${arr(c.userRiskLevels).join('/')}`);
  if (arr(c.servicePrincipalRiskLevels).length) add('servicePrincipalRisk', 'only for service principal risk');
  if (arr(c.insiderRiskLevels).length || (typeof c.insiderRiskLevels === 'string' && c.insiderRiskLevels)) add('insiderRisk', 'only for insider risk');
  const flows = String(c.authenticationFlows?.transferMethods ?? '').trim();
  if (flows && flows !== 'none') add('authenticationFlows', `only for authentication flows ${flows}`);
  if (c.devices?.deviceFilter?.rule) add('devices', 'limited by a device filter');
  return out;
}

/** Roles of `wanted` the policy targets (all users covers every role), minus excluded roles. */
function coveredRoles(p: CaPolicy, wanted: string[]): string[] {
  const u = p.conditions?.users ?? {};
  const all = arr(u.includeUsers).includes('All');
  const inc = new Set(arr(u.includeRoles));
  const exc = new Set(arr(u.excludeRoles));
  return wanted.filter((r) => (all || inc.has(r)) && !exc.has(r));
}

export function evaluateCa(policies: CaPolicy[], req: CaRequirement): CaEvaluation {
  const out: CaEvaluation = { enforced: [], reportOnly: [], nearMiss: [] };
  for (const p of policies) {
    if (!req.purpose(p)) continue;
    const reasons: string[] = [];
    if (p.state === 'disabled') reasons.push('policy is disabled');
    const ctl = req.control?.(p);
    if (ctl) reasons.push(ctl);
    const rq = req.required?.(p);
    if (rq) reasons.push(rq);
    const users = p.conditions?.users ?? {};
    let roles: string[] = [];
    if (req.roles) {
      roles = coveredRoles(p, req.roles);
      if (!roles.length) reasons.push('does not target the administrator roles');
    } else if (!arr(users.includeUsers).includes('All')) {
      reasons.push('does not apply to all users');
    }
    const apps = p.conditions?.applications ?? {};
    if (!arr(apps.includeApplications).includes('All')) reasons.push('does not apply to all cloud apps');
    reasons.push(...narrowing(p, req.allow ?? []));
    const match: CaMatch = { policy: p, exclusions: exclusionsOf(p), roles };
    if (reasons.length) out.nearMiss.push({ policy: p, reason: reasons.join('; ') });
    else if (p.state === 'enabled') out.enforced.push(match);
    else out.reportOnly.push(match);
  }
  return out;
}

export const policyRef = (p: CaPolicy, detail?: string): ResourceRef => ({
  id: p.id,
  name: p.displayName,
  detail: detail ?? p.state,
  type: 'Conditional Access policy',
  url: entraUrl('caPolicy', p.id),
});

/** Display names for excluded users and groups (best effort, ids when the lookup fails). */
async function nameOf(ctx: MsCtx, kind: 'user' | 'group', id: string): Promise<string> {
  return ctx.memo.get(`name:${kind}:${id}`, async () => {
    try {
      if (kind === 'user') {
        const u: any = await graph(ctx, `/users/${encodeURIComponent(id)}?$select=id,displayName,userPrincipalName`);
        return String(u?.userPrincipalName ?? u?.displayName ?? id);
      }
      const g: any = await graph(ctx, `/groups/${encodeURIComponent(id)}?$select=id,displayName`);
      return String(g?.displayName ?? id);
    } catch {
      return id;
    }
  });
}

const MAX_NAME_LOOKUPS = 25;

export async function exclusionRefs(ctx: MsCtx, e: Exclusions, label: string): Promise<ResourceRef[]> {
  const refs: ResourceRef[] = [];
  let lookups = 0;
  const name = async (kind: 'user' | 'group', id: string) => (lookups++ < MAX_NAME_LOOKUPS ? nameOf(ctx, kind, id) : id);
  for (const id of e.users) refs.push({ id, name: await name('user', id), detail: label, type: 'User', url: entraUrl('user', id) });
  for (const id of e.groups) refs.push({ id, name: await name('group', id), detail: `${label} (group)`, type: 'Group', url: entraUrl('group', id) });
  for (const id of e.roles) refs.push({ id, name: roleName(id), detail: `${label} (role)`, type: 'Directory role', url: entraUrl('role', id) });
  if (e.guests) refs.push({ id: 'GuestsOrExternalUsers', name: 'Guests and external users', detail: label, type: 'User group' });
  for (const id of e.apps) refs.push({ id, name: id, detail: `${label} (application)`, type: 'Application' });
  return refs;
}

export const describeExclusions = (e: Exclusions) =>
  [
    e.users.length && `${e.users.length} user(s)`,
    e.groups.length && `${e.groups.length} group(s)`,
    e.roles.length && `${e.roles.length} role(s)`,
    e.guests && 'guests and external users',
    e.apps.length && `${e.apps.length} application(s)`,
  ]
    .filter(Boolean)
    .join(', ');

const nearMissRefs = (ev: CaEvaluation) => ev.nearMiss.map((n) => policyRef(n.policy, `does not count: ${n.reason}`));
const nearMissEvidence = (ev: CaEvaluation) => ev.nearMiss.map((n) => ({ policy: n.policy.displayName, id: n.policy.id, state: n.policy.state, reason: n.reason }));

export interface CaTexts {
  /** e.g. 'MFA is enforced for all users' */
  enforced: string;
  /** e.g. 'an all-users MFA policy' */
  subject: string;
  /** Summary when nothing qualifies. */
  missing: string;
}

/** Outcome for an all-users requirement: pass (clean or break-glass only), warn (broad exclusions or report-only), fail. */
export async function caOutcome(ctx: MsCtx, ev: CaEvaluation, t: CaTexts): Promise<CheckOutcome> {
  const names = (ms: CaMatch[]) => ms.map((m) => `'${m.policy.displayName}'`).join(', ');
  const clean = ev.enforced.filter((m) => noExclusions(m.exclusions));
  const breakGlass = ev.enforced.filter((m) => isBreakGlassOnly(m.exclusions));
  const evidence: Record<string, unknown> = { nearMisses: nearMissEvidence(ev) };
  if (clean.length) return pass(`${t.enforced} by ${names(clean)}.`, { resources: clean.map((m) => policyRef(m.policy)), evidence });
  if (breakGlass.length) {
    const m = breakGlass[0];
    const excluded = await exclusionRefs(ctx, m.exclusions, 'break-glass exclusion');
    return pass(`${t.enforced} by ${names(breakGlass)}, with break-glass exclusions: ${excluded.map((r) => r.name).join(', ')}.`, {
      resources: [...breakGlass.map((x) => policyRef(x.policy)), ...excluded],
      evidence: { ...evidence, breakGlassExclusions: excluded.map((r) => r.name) },
    });
  }
  if (ev.enforced.length) {
    const m = ev.enforced[0];
    const excluded = await exclusionRefs(ctx, m.exclusions, 'excluded');
    return warn(
      `${t.enforced} by '${m.policy.displayName}', but it excludes ${describeExclusions(m.exclusions)}: more than break-glass accounts. Review the exclusions.`,
      [...ev.enforced.map((x) => policyRef(x.policy)), ...excluded],
      { ...evidence, exclusions: excluded.map((r) => `${r.name} (${r.type})`) },
    );
  }
  if (ev.reportOnly.length) {
    return warn(`${t.subject} exists but is in report-only mode: ${names(ev.reportOnly)}.`, [...ev.reportOnly.map((m) => policyRef(m.policy)), ...nearMissRefs(ev)], evidence);
  }
  const near = ev.nearMiss.length ? ` ${ev.nearMiss.length} related policy(ies) do not count: ${ev.nearMiss.slice(0, 3).map((n) => `'${n.policy.displayName}' (${n.reason})`).join(', ')}.` : '';
  return fail(`${t.missing}${near}`, nearMissRefs(ev), evidence);
}

export const nearMisses = { refs: nearMissRefs, evidence: nearMissEvidence };
