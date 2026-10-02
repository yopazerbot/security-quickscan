import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ScrollText, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, Input, PageHeader, PageLoader, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { fmtDateTime } from '../lib/format';

const tone = (a: string) =>
  a.startsWith('auth.breakglass') || a.includes('denied') || a.includes('failed') || a.includes('delete') ? 'bg-red-50 text-red-700' : a.startsWith('credential') ? 'bg-amber-50 text-amber-700' : a.startsWith('auth') ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600';

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
  const [input, setInput] = useState('');
  const filter = useDebounced(input.trim(), 300);
  const q = useInfiniteQuery({
    queryKey: ['audit', filter],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<any[]>(`/api/audit?${new URLSearchParams({ ...(pageParam ? { before: String(pageParam) } : {}), ...(filter ? { action: filter } : {}) })}`),
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].id : undefined),
    // Keep showing the current rows while the next filter loads instead of flashing a loader.
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.pages.flat() ?? [];
  const pending = input.trim() !== filter || (q.isFetching && !q.isFetchingNextPage && !q.isLoading);
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Append-only record of sign-ins, credential handling, scans, exports and administrative changes."
        actions={
          <div className="relative w-full sm:w-72">
            <Input
              type="search"
              aria-label="Filter by action prefix"
              placeholder="Filter by action prefix, e.g. credential"
              className="pr-9"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setInput('');
              }}
            />
            {pending && <Spinner className="absolute right-3 top-2.5 size-4" />}
          </div>
        }
      />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <PageLoader />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ScrollText className="size-6" />}
            title={filter ? 'No audit entries match' : 'No audit entries yet'}
            action={
              filter && (
                <Button variant="secondary" icon={<X className="size-4" aria-hidden />} onClick={() => setInput('')}>
                  Clear filter
                </Button>
              )
            }
          >
            {filter ? `No action starts with "${filter}". Try a shorter prefix such as auth, scan or credential.` : 'Sign-ins, scans and administrative changes appear here as they happen.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3 font-medium">Time</th>
                  <th className="px-3 py-3 font-medium">Action</th>
                  <th className="px-3 py-3 font-medium">User</th>
                  <th className="px-3 py-3 font-medium">Target</th>
                  <th className="px-3 py-3 font-medium">IP</th>
                  <th className="px-6 py-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap px-6 py-2.5 text-slate-500">{fmtDateTime(r.at)}</td>
                    <td className="px-3 py-2.5">
                      <span className={clsx('whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-xs', tone(r.action))}>{r.action}</span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">{r.userEmail ?? '-'}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{r.targetType ? `${r.targetType}:${String(r.targetId).slice(0, 8)}` : ''}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{r.ip}</td>
                    <td className="max-w-xs truncate px-6 py-2.5 font-mono text-xs text-slate-500" title={r.details ? JSON.stringify(r.details) : ''}>
                      {r.details ? JSON.stringify(r.details) : ''}
                    </td>
                  </tr>
                ))}
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
