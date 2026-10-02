import { useInfiniteQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Button, Card, Input, PageHeader, PageLoader } from '../components/ui';
import { get } from '../lib/api';
import { fmtDateTime } from '../lib/format';

const tone = (a: string) =>
  a.startsWith('auth.breakglass') || a.includes('denied') || a.includes('failed') || a.includes('delete') ? 'bg-red-50 text-red-700' : a.startsWith('credential') ? 'bg-amber-50 text-amber-700' : a.startsWith('auth') ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600';

export function AuditPage() {
  const [filter, setFilter] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', filter],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<any[]>(`/api/audit?${new URLSearchParams({ ...(pageParam ? { before: String(pageParam) } : {}), ...(filter ? { action: filter } : {}) })}`),
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].id : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of sign-ins, credential handling, scans, exports and administrative changes." actions={<Input placeholder="Filter by action prefix, e.g. credential" className="w-72" value={filter} onChange={(e) => setFilter(e.target.value)} />} />
      {q.isLoading ? <PageLoader /> : (
        <Card>
          <table className="w-full text-left text-sm">
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
                  <td className="px-3 py-2.5"><span className={clsx('rounded-md px-2 py-0.5 font-mono text-xs', tone(r.action))}>{r.action}</span></td>
                  <td className="px-3 py-2.5 text-slate-700">{r.userEmail ?? '-'}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{r.targetType ? `${r.targetType}:${String(r.targetId).slice(0, 8)}` : ''}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{r.ip}</td>
                  <td className="max-w-xs truncate px-6 py-2.5 font-mono text-xs text-slate-500" title={r.details ? JSON.stringify(r.details) : ''}>{r.details ? JSON.stringify(r.details) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.hasNextPage && <div className="border-t border-slate-100 p-4 text-center"><Button variant="secondary" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>Load more</Button></div>}
        </Card>
      )}
    </>
  );
}
