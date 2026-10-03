import { CHECKS_BY_ID, ROLE_LABELS, type Role } from '@qs/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ScrollText, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, Input, PageHeader, PageLoader, Select, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/use-document-title';

interface AuditRow {
  id: number;
  at: string;
  action: string;
  userId: string | null;
  userEmail: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  targetEmail: string | null;
  ip: string | null;
  details: Record<string, any> | null;
}

const tone = (a: string) =>
  a.startsWith('auth.breakglass') || a.includes('denied') || a.includes('failed') || a.includes('delete') || a.includes('conflict')
    ? 'bg-red-50 text-red-700'
    : a.startsWith('credential')
      ? 'bg-amber-50 text-amber-700'
      : a.startsWith('auth')
        ? 'bg-brand-50 text-brand-700'
        : 'bg-slate-100 text-slate-600';

/** Stored action names use the old "customer" wording; the page says "organisation". */
const displayAction = (a: string) => a.replace(/^customer\./, 'organisation.');
/** And the reverse for the filter, so "organisation" finds the stored "customer.*" actions. */
const queryAction = (a: string) => a.replace(/^organisations?/i, 'customer');

const role = (r: unknown) => (typeof r === 'string' ? (ROLE_LABELS[r as Role] ?? r) : String(r));

const secrets = (n: unknown, kind = '') => (typeof n === 'number' ? `${n} ${kind}secret${n === 1 ? '' : 's'}` : `${kind}secrets`);

const QUICK_FILTERS: { label: string; prefix: string }[] = [
  { label: 'Sharing', prefix: 'customer.' },
  { label: 'Sign-ins', prefix: 'auth.' },
  { label: 'Users', prefix: 'user.' },
  { label: 'Scans', prefix: 'scan.' },
  { label: 'Credentials', prefix: 'credential.' },
  { label: 'Consent', prefix: 'consent.' },
];

const CONFLICT_STEP: Record<string, string> = {
  link: 'when a consent link was created',
  complete: 'when consent was completed',
  test: 'at the connection test',
  start: 'when a scan was started',
};

const OWNER_REASON: Record<string, string> = {
  'user.delete': ' because the previous owner was deleted',
  'user.deactivate': ' because the previous owner was deactivated',
  'user.demote': ' because the previous owner became a Viewer',
};

/** A readable sentence for one audit entry. Unknown actions fall back to the action name. */
function describe(r: AuditRow): string {
  const d = r.details ?? {};
  const org = r.targetType === 'customer' ? (d.name ?? r.targetName ?? 'an organisation') : (r.targetName ?? 'an organisation');
  const who = d.targetEmail ?? r.targetEmail ?? 'a user';
  const userTarget = d.email ?? r.targetEmail ?? r.targetName ?? 'a user';
  switch (r.action) {
    // Organisations and sharing
    case 'customer.create':
      return `Created the organisation ${d.name ?? org}.`;
    case 'customer.update':
      return `Updated the details of ${org}.`;
    case 'customer.delete':
      return `Deleted the organisation ${d.name ?? org} with all its data.`;
    case 'customer.export':
      return `Exported the data of ${org}.`;
    case 'customer.share':
      return `Shared ${org} with ${who}${d.permission ? ` (${d.permission})` : ''}.`;
    case 'customer.share_update':
      return `Changed the access of ${who} to ${org}${d.permission ? ` to ${d.permission}` : ''}.`;
    case 'customer.unshare':
      return `Removed the access of ${who} to ${org}.`;
    case 'customer.leave':
      return `Left ${org}.`;
    case 'customer.owner_change':
      return `${d.fromEmail ? `Transferred ${org} from ${d.fromEmail}` : `Assigned ${org}`} to ${d.toEmail ?? r.targetEmail ?? 'a new owner'}${OWNER_REASON[d.reason] ?? ''}.`;
    case 'finding.triage': {
      const status = d.status === 'accepted' ? 'risk accepted' : d.status === 'false_positive' ? 'a false positive' : 'open again';
      return `Marked "${CHECKS_BY_ID[d.checkId]?.title ?? d.checkId ?? 'a finding'}" in ${org} as ${status}.`;
    }
    // Users
    case 'user.create':
      return `Invited ${userTarget}${d.role ? ` as ${role(d.role)}` : ''}.`;
    case 'user.update': {
      const changes = d.changes && typeof d.changes === 'object' ? (d.changes as Record<string, { from: unknown; to: unknown }>) : null;
      if (!changes) return `Updated the account of ${userTarget}.`;
      const parts = Object.entries(changes).map(([k, v]) =>
        k === 'role' ? `role ${role(v.from)} to ${role(v.to)}` : k === 'active' ? (v.to ? 'reactivated' : 'deactivated') : k === 'name' ? `name "${v.from ?? ''}" to "${v.to ?? ''}"` : k,
      );
      return `Updated ${userTarget}: ${parts.join(', ')}.`;
    }
    case 'user.delete':
      return `Deleted the user ${userTarget}${d.name ? ` (${d.name})` : ''}.`;
    case 'user.revoke_sessions':
      return `Signed out ${userTarget} everywhere${typeof d.count === 'number' ? ` (${d.count} session${d.count === 1 ? '' : 's'})` : ''}.`;
    case 'user.bootstrap_admin':
      return 'Created the first admin account.';
    // Sign-in
    case 'auth.login':
      return 'Signed in with Microsoft.';
    case 'auth.logout':
      return 'Signed out.';
    case 'auth.login_denied':
      return `Refused a sign-in${d.email ? ` for ${d.email}` : ''}: ${d.reason === 'guest' ? 'guest (B2B) accounts are not supported' : d.reason === 'inactive' ? 'the account is deactivated' : d.reason === 'not_invited' ? 'the account was not invited' : 'not allowed'}.`;
    case 'auth.breakglass_login':
      return 'Signed in with emergency access (break glass).';
    case 'auth.breakglass_failed':
      return d.usernameMatched === undefined ? 'Failed emergency sign-in.' : `Failed emergency sign-in (${d.usernameMatched ? 'right username, wrong password or code' : 'unknown username'}).`;
    case 'auth.breakglass_locked':
      return 'Emergency sign-in was blocked after too many attempts.';
    case 'auth.demo_login':
      return 'Signed in to the demo with the PIN.';
    case 'auth.demo_failed':
      return 'Failed demo sign-in (wrong PIN).';
    // Scans
    case 'scan.create':
      return 'Created a draft scan.';
    case 'scan.update':
      return d.contextChanged ? 'Updated the scan and the organisation context.' : 'Updated the scan.';
    case 'scan.retention':
      return `Set credential retention to ${d.mode === 'days' ? `${d.days ?? 30} days` : d.mode === 'purge_on_completion' ? 'delete when the scan ends' : d.mode === 'manual' ? 'keep until deleted' : (d.mode ?? 'a new value')}.`;
    case 'scan.criteria':
      return `Changed the evaluation criteria${Array.isArray(d.excluded) ? ` (${d.excluded.length} check${d.excluded.length === 1 ? '' : 's'} excluded)` : typeof d.excluded === 'number' ? ` (${d.excluded} excluded)` : ''}.`;
    case 'scan.start':
      return `Started a scan${typeof d.systems === 'number' ? ` of ${d.systems} system${d.systems === 1 ? '' : 's'}` : ''}${typeof d.checks === 'number' ? ` with ${d.checks} checks` : ''}.`;
    case 'scan.cancel':
      return 'Cancelled a scan.';
    case 'scan.delete':
      return 'Deleted a scan.';
    case 'scan.rescan':
      return 'Created a new scan from an earlier one.';
    case 'scan.failed':
      return d.reason === 'stale' ? 'A scan failed because the worker stopped responding.' : 'A scan failed.';
    case 'report.view':
      return 'Viewed a report.';
    case 'report.export':
      return `Downloaded a report${d.format ? ` (${String(d.format).toUpperCase()})` : ''}.`;
    // Systems, credentials and consent
    case 'system.create':
      return d.provider ? `Added a ${d.provider} system to a scan.` : 'Added a system to a scan.';
    case 'system.update':
      return 'Changed a system in a scan.';
    case 'system.delete':
      return 'Removed a system from a scan.';
    case 'system.test':
      return `Tested a connection: ${d.ok ? 'it worked' : 'it failed'}.`;
    case 'credential.store':
      return `Stored a secret${d.expiresAt ? `, deleted automatically on ${fmtDateTime(d.expiresAt)}` : ', kept until deleted'}.`;
    case 'credential.purge':
      return d.reason === 'manual'
        ? 'Deleted a stored secret.'
        : d.reason === 'expired'
          ? `Deleted ${secrets(d.count, 'expired ')}.`
          : d.reason === 'purge_on_completion'
            ? `Deleted ${secrets(d.count)} after the scan ended.`
            : 'Deleted stored secrets.';
    case 'consent.link_created':
      return `Created an admin consent link${d.tenant ? ` for tenant ${d.tenant}` : ''}.`;
    case 'consent.granted':
      return `Admin consent was confirmed${d.tenant ? ` for tenant ${d.tenant}` : ''}.`;
    case 'consent.denied':
      return `Admin consent was not granted${d.error ? ` (${d.error})` : ''}.`;
    case 'consent.tenant_mismatch':
      return 'Admin consent was given in a different tenant than the one configured.';
    case 'consent.tenant_conflict':
      return `${d.tenantId ? `Tenant ${d.tenantId}` : 'The tenant'} is already linked to another organisation. Blocked ${CONFLICT_STEP[d.step] ?? 'an attempt to use it'}.`;
    case 'consent.unverified':
      return `Microsoft did not confirm the admin consent${d.tenant ? ` for tenant ${d.tenant}` : ''}${d.reason === 'stale' ? ' (only an earlier consent exists)' : ' (not visible yet)'}.`;
    case 'tenant_binding.release':
      return `Released the link of tenant ${r.targetId ?? ''} so another organisation can use it.`;
    // Settings and demo
    case 'settings.branding':
      return 'Changed the report branding.';
    case 'settings.logo':
      return 'Uploaded a report logo.';
    case 'settings.logo_removed':
      return 'Removed the report logo.';
    case 'demo.reset':
      return 'Reset the demo data.';
    case 'demo.login_settings':
      return `${d.enabled ? 'Enabled' : 'Disabled'} demo login${d.pinChanged ? ' and changed the PIN' : ''}.`;
    default:
      return displayAction(r.action).replace(/[._]/g, ' ');
  }
}

/** The target in words: a name or email when known, otherwise the type and a short id. */
function target(r: AuditRow) {
  const type = r.targetType === 'customer' ? 'Organisation' : r.targetType ? r.targetType.charAt(0).toUpperCase() + r.targetType.slice(1) : '';
  const name = r.targetName && r.targetEmail && r.targetName !== r.targetEmail ? `${r.targetName}` : (r.targetName ?? r.targetEmail);
  if (name) return { main: name, sub: r.targetEmail && r.targetEmail !== name ? r.targetEmail : type };
  if (r.targetType) return { main: `${type} ${String(r.targetId ?? '').slice(0, 8)}`, sub: '' };
  return null;
}

/** Returns `value` once it has stopped changing for `ms` milliseconds. */
function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function AuditPage() {
  useDocumentTitle('Audit log');
  const [input, setInput] = useState('');
  const [organisationId, setOrganisationId] = useState('');
  const [userId, setUserId] = useState('');
  const filter = useDebounced(input.trim(), 300);
  const action = queryAction(filter);
  const orgs = useQuery({ queryKey: ['customers'], queryFn: () => get<{ id: string; name: string }[]>('/api/customers') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<{ id: string; name: string; email: string }[]>('/api/users') });
  const q = useInfiniteQuery({
    queryKey: ['audit', action, organisationId, userId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      get<AuditRow[]>(
        `/api/audit?${new URLSearchParams({
          ...(pageParam ? { before: String(pageParam) } : {}),
          ...(action ? { action } : {}),
          ...(organisationId ? { organisationId } : {}),
          ...(userId ? { userId } : {}),
        })}`,
      ),
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].id : undefined),
    // Keep showing the current rows while the next filter loads instead of flashing a loader.
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.pages.flat() ?? [];
  const pending = input.trim() !== filter || (q.isFetching && !q.isFetchingNextPage && !q.isLoading);
  const filtered = Boolean(filter || organisationId || userId);
  const clear = () => {
    setInput('');
    setOrganisationId('');
    setUserId('');
  };
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of sign-ins, sharing, credential handling, scans, exports and administrative changes." />
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick filters">
          {QUICK_FILTERS.map((f) => {
            const on = action === f.prefix;
            return (
              <button
                key={f.prefix}
                type="button"
                aria-pressed={on}
                onClick={() => setInput(on ? '' : displayAction(f.prefix))}
                className={clsx(
                  'rounded-full px-3 py-1 text-xs font-medium ring-1 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50',
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="relative">
            <Input
              type="search"
              aria-label="Filter by action prefix"
              placeholder="Action, e.g. organisation, auth or scan"
              className="pr-9"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setInput('');
              }}
            />
            {pending && <Spinner className="absolute right-3 top-2.5 size-4" />}
          </div>
          <Select aria-label="Filter by organisation" value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
            <option value="">All organisations</option>
            {(orgs.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All users</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <PageLoader />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ScrollText className="size-6" />}
            title={filtered ? 'No audit entries match' : 'No audit entries yet'}
            action={
              filtered && (
                <Button variant="secondary" icon={<X className="size-4" aria-hidden />} onClick={clear}>
                  Clear filters
                </Button>
              )
            }
          >
            {filtered
              ? 'Nothing matches these filters. Try a shorter action prefix such as auth, scan, credential or organisation (organisations and sharing), or another organisation or user.'
              : 'Sign-ins, scans and administrative changes appear here as they happen.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <p className="sr-only" role="status">
            {rows.length} audit entries shown.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-left text-sm">
              <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3 font-medium">Time</th>
                  <th className="px-3 py-3 font-medium">Event</th>
                  <th className="px-3 py-3 font-medium">By</th>
                  <th className="px-3 py-3 font-medium">Target</th>
                  <th className="px-3 py-3 font-medium">IP</th>
                  <th className="px-6 py-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const t = target(r);
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="whitespace-nowrap px-6 py-2.5 text-slate-500">{fmtDateTime(r.at)}</td>
                      <td className="max-w-md px-3 py-2.5">
                        <div className="text-slate-800">{describe(r)}</div>
                        <span className={clsx('mt-1 inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono text-[11px]', tone(r.action))}>{displayAction(r.action)}</span>
                      </td>
                      <td className="px-3 py-2.5 text-slate-700">{r.actorEmail ?? r.userEmail ?? '-'}</td>
                      <td className="px-3 py-2.5">
                        {t ? (
                          <>
                            <div className="text-slate-700">{t.main}</div>
                            {t.sub && <div className="text-xs text-slate-500">{t.sub}</div>}
                          </>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{r.ip}</td>
                      <td className="px-6 py-2.5 text-xs text-slate-500">
                        {r.details ? (
                          <details>
                            <summary className="cursor-pointer rounded text-slate-600 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Raw data</summary>
                            <pre className="mt-1 max-w-xs overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-600">{JSON.stringify(r.details, null, 2)}</pre>
                          </details>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {q.hasNextPage && (
            <div className="border-t border-slate-100 p-4 text-center">
              <Button variant="secondary" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
