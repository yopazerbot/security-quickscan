import { INDUSTRIES } from '@qs/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, Plus, Search, SearchX, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { DataTable } from '../components/data-table';
import { Badge, Button, Card, DemoBadge, EmptyState, ErrorState, GradeBadge, Input, LinkButton, PageHeader, PageLoader } from '../components/ui';
import { get } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { useDocumentTitle } from '../lib/use-document-title';

const SCAN_STATUS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  queued: 'bg-brand-50 text-brand-700',
  running: 'bg-brand-100 text-brand-700',
  completed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-amber-50 text-amber-700',
};

export function ScanStatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium capitalize', SCAN_STATUS[status])}>
      {status === 'running' && <span className="size-1.5 animate-pulse rounded-full bg-brand-600" />}
      {status}
    </span>
  );
}

/** "Shared with you", with the access level when the list provides it. */
function sharedLabel(access: unknown) {
  return access === 'view' ? 'Shared with you, can view' : access === 'edit' ? 'Shared with you, can edit' : 'Shared with you';
}

/** Sort text of the access column. */
function accessText(c: any, admin: boolean, demo: boolean) {
  if (c.owned) return 'Owned by you';
  if (admin) return c.ownerName ? `Owner: ${c.ownerName}` : c.isDemo ? '' : 'No owner';
  return demo && c.isDemo ? '' : sharedLabel(c.myAccess ?? c.permission);
}

function AccessCell({ c, admin, demo }: { c: any; admin: boolean; demo: boolean }) {
  if (c.owned) return <span className="text-xs text-slate-500">Owned by you</span>;
  if (admin)
    return c.ownerName ? (
      <span className="text-xs text-slate-500">Owner: {c.ownerName}</span>
    ) : c.isDemo ? (
      <span className="text-xs text-slate-500">-</span>
    ) : (
      <Badge className="bg-amber-100 text-amber-800 ring-1 ring-amber-200">No owner</Badge>
    );
  // The demo visitor reaches demo organisations through a shared account: not "shared with you".
  if (demo && c.isDemo) return <span className="text-xs text-slate-500">-</span>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-slate-500">
      <Badge className="bg-brand-50 text-brand-700 ring-1 ring-brand-100">{sharedLabel(c.myAccess ?? c.permission)}</Badge>
      {c.ownerName && <span className="truncate">Owner: {c.ownerName}</span>}
    </div>
  );
}

export function Customers() {
  const nav = useNavigate();
  const can = useCan();
  const { me } = useAuth();
  useDocumentTitle('Organisations');
  const [q, setQ] = useState('');
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['customers'], queryFn: () => get<any[]>('/api/customers') });
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) return <PageLoader />;
  const term = q.trim().toLowerCase();
  const rows = (data ?? []).filter((c) => c.name.toLowerCase().includes(term));

  return (
    <>
      <PageHeader
        title="Organisations"
        subtitle="Each organisation has its own context, risk profile and scan history."
        actions={
          can.write && (
            <LinkButton to="/organisations/new" icon={<Plus className="size-4" aria-hidden />}>
              New organisation
            </LinkButton>
          )
        }
      />
      {data && data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 className="size-6" />}
            title="No organisations yet"
            action={
              can.write && (
                <LinkButton to="/organisations/new" icon={<Plus className="size-4" aria-hidden />}>
                  Add your first organisation
                </LinkButton>
              )
            }
          >
            {can.write
              ? 'Capture the organisation context once; it drives the risk profile and evaluation criteria of every scan. Only you and admins can see it until you share it.'
              : 'Organisations appear here once someone shares them with you.'}
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="relative mb-4 max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-400" aria-hidden />
            <Input
              type="search"
              aria-label="Search organisations"
              placeholder="Search organisations"
              className={q ? 'px-9' : 'pl-9'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQ('');
              }}
            />
            {q && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQ('')}
                className="absolute right-2 top-1.5 rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <Card className="overflow-hidden">
            <DataTable
              storageKey="organisations"
              label="organisations"
              caption="Organisations"
              minWidth="48rem"
              rows={rows}
              rowKey={(c) => c.id}
              filterKey={term}
              onRowClick={(c) => nav(`/organisations/${c.id}`)}
              empty={
                <EmptyState
                  icon={<SearchX className="size-6" />}
                  title="No organisations match"
                  action={
                    <Button variant="secondary" icon={<X className="size-4" aria-hidden />} onClick={() => setQ('')}>
                      Clear search
                    </Button>
                  }
                >
                  No organisation name contains "{q.trim()}". Check the spelling or clear the search to see all organisations.
                </EmptyState>
              }
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  sort: (c) => c.name.toLowerCase(),
                  render: (c) => (
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link to={`/organisations/${c.id}`} className="font-semibold text-slate-900 hover:text-brand-700 hover:underline">
                          {c.name}
                        </Link>
                        {c.isDemo && <DemoBadge />}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">{INDUSTRIES.find(([id]) => id === c.industry)?.[1] ?? 'Unknown sector'}</div>
                    </div>
                  ),
                },
                {
                  key: 'grade',
                  header: 'Latest grade',
                  sort: (c) => (typeof c.latestScan?.score === 'number' ? c.latestScan.score : null),
                  render: (c) => <GradeBadge grade={c.latestScan?.grade} score={c.latestScan?.score} size="sm" />,
                },
                { key: 'scans', header: 'Scans', align: 'right', sort: (c) => c.scanCount ?? 0, render: (c) => <span className="text-slate-600">{c.scanCount}</span> },
                {
                  key: 'updated',
                  header: 'Last scan',
                  sort: (c) => (c.latestScan?.finishedAt ? new Date(c.latestScan.finishedAt) : null),
                  render: (c) => <span className="whitespace-nowrap text-slate-600">{c.latestScan ? fmtDate(c.latestScan.finishedAt) : 'Not scanned yet'}</span>,
                },
                {
                  key: 'access',
                  header: 'Access',
                  sort: (c) => accessText(c, can.admin, Boolean(me?.user.isDemo)),
                  render: (c) => <AccessCell c={c} admin={can.admin} demo={Boolean(me?.user.isDemo)} />,
                },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}
