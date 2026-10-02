import { INDUSTRIES } from '@qs/shared';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Building2, Plus, Radar } from 'lucide-react';
import { Link } from 'react-router';
import { Card, DemoBadge, EmptyState, ErrorState, GradeBadge, LinkButton, PageHeader, PageLoader, Stat } from '../components/ui';
import { get } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { fmtDate, scoreHex } from '../lib/format';
import { ScanStatusBadge } from './Customers';

export function Dashboard() {
  const { me } = useAuth();
  const can = useCan();
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => get<any[]>('/api/customers') });
  const scans = useQuery({ queryKey: ['scans'], queryFn: () => get<any[]>('/api/scans'), refetchInterval: 10_000 });
  if (customers.isError || scans.isError)
    return (
      <ErrorState
        error={customers.error ?? scans.error}
        onRetry={() => {
          void customers.refetch();
          void scans.refetch();
        }}
      />
    );
  if (customers.isLoading || scans.isLoading) return <PageLoader />;
  const cs = customers.data ?? [];
  const ss = scans.data ?? [];
  const scored = cs.filter((c) => c.latestScan?.score !== null && c.latestScan?.score !== undefined);
  const avg = scored.length ? Math.round(scored.reduce((a, c) => a + c.latestScan.score, 0) / scored.length) : null;
  const running = ss.filter((s) => s.status === 'running' || s.status === 'queued');
  const attention = [...scored].sort((a, b) => a.latestScan.score - b.latestScan.score).slice(0, 5);

  return (
    <>
      <PageHeader
        title={`Welcome back, ${me?.user.name.split(' ')[0]}`}
        subtitle="Overview of your organisations and recent quick scans."
        actions={
          can.write && (
            <LinkButton to="/organisations/new" icon={<Plus className="size-4" aria-hidden />}>
              New organisation
            </LinkButton>
          )
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Organisations" value={cs.length} />
        <Stat label="Completed scans" value={ss.filter((s) => s.status === 'completed').length} sub="among the 25 most recent scans" />
        <Stat label="Running now" value={running.length} tone={running.length ? '#4f46e5' : undefined} />
        <Stat label="Average score" value={avg ?? '-'} tone={avg !== null ? scoreHex(avg) : undefined} sub="latest scan per organisation" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Recent scans" actions={<Link to="/organisations" className="text-sm font-medium text-brand-600 hover:text-brand-700">All organisations</Link>}>
          {ss.length === 0 ? (
            <EmptyState icon={<Radar className="size-6" />} title="No scans yet">
              Create an organisation and start your first quick scan.
            </EmptyState>
          ) : (
            <div className="-mx-6 -my-6 divide-y divide-slate-100">
              {ss.slice(0, 10).map((s) => (
                <Link
                  key={s.id}
                  to={s.status === 'completed' || s.status === 'cancelled' ? `/scans/${s.id}/report` : s.status === 'draft' ? `/scans/${s.id}/wizard` : `/scans/${s.id}/progress`}
                  className="flex items-center gap-4 px-6 py-3.5 transition hover:bg-slate-50"
                >
                  <GradeBadge grade={s.grade} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 truncate text-sm font-medium text-slate-900">
                      {s.customerName}
                      {s.isDemo && <DemoBadge />}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {s.name} · {fmtDate(s.finishedAt ?? s.createdAt)}
                    </div>
                  </div>
                  <ScanStatusBadge status={s.status} />
                  <ArrowRight className="size-4 text-slate-300" />
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card title="Needs attention" subtitle="Lowest scoring organisations">
          {attention.length === 0 ? (
            <p className="text-sm text-slate-500">No completed scans yet.</p>
          ) : (
            <ul className="space-y-3">
              {attention.map((c) => (
                <li key={c.id}>
                  <Link to={`/organisations/${c.id}`} className="group flex items-center gap-3">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <Building2 className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-900 group-hover:text-brand-700">{c.name}</div>
                      <div className="text-xs text-slate-500">{INDUSTRIES.find(([id]) => id === c.industry)?.[1] ?? ''}</div>
                    </div>
                    <div className="w-24">
                      <div className="h-1.5 rounded-full bg-slate-100">
                        <div className="h-1.5 rounded-full" style={{ width: `${c.latestScan.score}%`, backgroundColor: scoreHex(c.latestScan.score) }} />
                      </div>
                    </div>
                    <span className="w-8 text-right text-sm font-semibold text-slate-700">{c.latestScan.score}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {running.length > 0 && (
            <div className="mt-6 border-t border-slate-100 pt-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Activity className="size-3.5 text-brand-600" /> In progress
              </div>
              {running.map((s) => (
                <Link key={s.id} to={`/scans/${s.id}/progress`} className="block text-sm font-medium text-brand-700 hover:underline">
                  {s.customerName}
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
