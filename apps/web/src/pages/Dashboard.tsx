import { INDUSTRIES } from '@qs/shared';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Building2, Plus, Radar } from 'lucide-react';
import { Link } from 'react-router';
import { Card, DemoBadge, EmptyState, ErrorState, GradeBadge, LinkButton, PageHeader, PageLoader, Stat } from '../components/ui';
import { get } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { fmtDate, scoreHex } from '../lib/format';
import { scanLink } from '../lib/scan-link';
import { useDocumentTitle } from '../lib/use-document-title';
import { ScanStatusBadge } from './Customers';

export function Dashboard() {
  const { me } = useAuth();
  const can = useCan();
  useDocumentTitle('Dashboard');
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
  // Scans with too little coverage have no score; they are left out of the average and the ranking.
  const scored = cs.filter((c) => typeof c.latestScan?.score === 'number');
  const avg = scored.length ? Math.round(scored.reduce((a, c) => a + c.latestScan.score, 0) / scored.length) : null;
  const running = ss.filter((s) => s.status === 'running' || s.status === 'queued');
  const attention = [...scored].sort((a, b) => a.latestScan.score - b.latestScan.score).slice(0, 5);

  return (
    <>
      <PageHeader
        title={`Welcome back, ${me?.user.name.split(' ')[0]}`}
        subtitle={can.admin ? 'All organisations and recent quick scans.' : 'Your organisations and those shared with you.'}
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
              {can.write
                ? 'Create an organisation and start your first quick scan.'
                : cs.length === 0
                  ? 'Organisations appear here once someone shares them with you.'
                  : 'Scans appear here once the owner of an organisation runs one.'}
            </EmptyState>
          ) : (
            <div className="-mx-6 -my-6 divide-y divide-slate-100">
              {ss.slice(0, 10).map((s) => {
                const row = (
                  <>
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
                  </>
                );
                // View-only users cannot open the wizard, so drafts are shown without a link.
                if (s.status === 'draft' && !can.write)
                  return (
                    <div key={s.id} className="flex items-center gap-4 px-6 py-3.5">
                      {row}
                      <span className="size-4" aria-hidden />
                    </div>
                  );
                return (
                  <Link key={s.id} to={scanLink(s)} className="flex items-center gap-4 px-6 py-3.5 transition hover:bg-slate-50">
                    {row}
                    <ArrowRight className="size-4 text-slate-500" aria-hidden />
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Needs attention" subtitle="Lowest scoring organisations">
          {attention.length === 0 ? (
            <p className="text-sm text-slate-500">{cs.length === 0 && !can.write ? 'Organisations appear here once someone shares them with you.' : 'No graded scans yet.'}</p>
          ) : (
            <ul className="space-y-3">
              {attention.map((c) => (
                <li key={c.id}>
                  <Link to={`/organisations/${c.id}`} className="group flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <Building2 className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 group-hover:text-brand-700" title={c.name}>
                          {c.name}
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-slate-700">
                          {c.latestScan.score}
                          <span className="sr-only"> out of 100</span>
                        </span>
                      </div>
                      <div className="truncate text-xs text-slate-500">{INDUSTRIES.find(([id]) => id === c.industry)?.[1] ?? ''}</div>
                      <div className="mt-1.5 h-1.5 rounded-full bg-slate-100" aria-hidden>
                        <div className="h-1.5 rounded-full" style={{ width: `${c.latestScan.score}%`, backgroundColor: scoreHex(c.latestScan.score) }} />
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {running.length > 0 && (
            <div className="mt-6 border-t border-slate-100 pt-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Activity className="size-3.5 text-brand-600" aria-hidden /> In progress
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
