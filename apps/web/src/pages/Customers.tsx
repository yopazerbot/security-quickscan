import { INDUSTRIES } from '@qs/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, Plus, Search, SearchX, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Card, DemoBadge, EmptyState, ErrorState, GradeBadge, Input, LinkButton, PageHeader, PageLoader } from '../components/ui';
import { get } from '../lib/api';
import { useCan } from '../lib/auth';
import { fmtDate } from '../lib/format';

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

export function Customers() {
  const can = useCan();
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
            Capture the organisation context once; it drives the risk profile and evaluation criteria of every scan.
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
                className="absolute right-2 top-1.5 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {rows.length === 0 ? (
            <Card>
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
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((c) => (
                <Link key={c.id} to={`/organisations/${c.id}`} className="group rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-base font-semibold text-slate-900 group-hover:text-brand-700">{c.name}</span>
                        {c.isDemo && <DemoBadge />}
                      </div>
                      <div className="mt-0.5 truncate text-sm text-slate-500">{INDUSTRIES.find(([id]) => id === c.industry)?.[1] ?? 'Unknown sector'}</div>
                    </div>
                    <GradeBadge grade={c.latestScan?.grade} />
                  </div>
                  <div className="mt-5 flex items-center justify-between text-xs text-slate-500">
                    <span>{c.scanCount} scan{c.scanCount === 1 ? '' : 's'}</span>
                    <span>{c.latestScan ? `Last scan ${fmtDate(c.latestScan.finishedAt)}` : 'Not scanned yet'}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
