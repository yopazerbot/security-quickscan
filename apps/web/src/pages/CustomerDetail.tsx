import { CHECKS_BY_ID, INDUSTRIES, REGULATIONS, ROLE_LABELS, computeRiskProfile, type Provider, type Role } from '@qs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Download, Pencil, Play, Radar, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CONTEXT_LABELS, RISK_STYLE } from '../components/ContextForm';
import { AsyncButton, useToast } from '../components/feedback';
import { ProviderIcon } from '../components/ProviderIcon';
import { AnchorButton, Button, Card, DemoBadge, EmptyState, ErrorState, GradeBadge, LinkButton, Modal, PageHeader, PageLoader } from '../components/ui';
import { del, get, post, put } from '../lib/api';
import { useCan } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { ScanStatusBadge } from './Customers';

export function CustomerDetail() {
  const { customerId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const toast = useToast();
  const [assignOpen, setAssignOpen] = useState(false);
  const q = useQuery({ queryKey: ['customer', customerId], queryFn: () => get(`/api/customers/${customerId}`) });
  const newScan = useMutation({
    mutationFn: () => post<{ id: string }>(`/api/customers/${customerId}/scans`, {}),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['scans'] });
      nav(`/scans/${r.id}/wizard`);
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading || !q.data) return <PageLoader />;
  const c = q.data;
  const profile = computeRiskProfile(c.context);
  const trend = [...c.scans]
    .filter((s: any) => s.status === 'completed')
    .reverse()
    .map((s: any) => ({ date: fmtDate(s.finishedAt), score: s.score }));
  const triaged = c.triage.filter((t: any) => t.status !== 'open');

  const scanLink = (s: any) =>
    s.status === 'draft' ? `/scans/${s.id}/wizard` : s.status === 'queued' || s.status === 'running' ? `/scans/${s.id}/progress` : `/scans/${s.id}/report`;

  return (
    <>
      <PageHeader
        crumbs={<Link to="/organisations" className="hover:text-slate-700">Organisations</Link>}
        title={
          <span className="flex items-center gap-3">
            {c.name}
            {c.isDemo && <DemoBadge />}
          </span>
        }
        subtitle={[INDUSTRIES.find(([id]) => id === c.context.industry)?.[1], c.country].filter(Boolean).join(' · ')}
        actions={
          <>
            <AnchorButton href={`/api/customers/${c.id}/export`} variant="ghost" icon={<Download className="size-4" aria-hidden />}>
              Export data
            </AnchorButton>
            {can.write && (
              <LinkButton to={`/organisations/${c.id}/edit`} variant="secondary" icon={<Pencil className="size-4" aria-hidden />}>
                Edit
              </LinkButton>
            )}
            {can.write && (
              <Button icon={<Play className="size-4" />} loading={newScan.isPending} onClick={() => newScan.mutate()}>
                New scan
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {trend.length > 0 && (
            <Card title="Score trend">
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ left: -20, right: 10, top: 5 }}>
                    <CartesianGrid stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                    <Line type="monotone" dataKey="score" stroke="#4f46e5" strokeWidth={2.5} dot={{ r: 4, fill: '#4f46e5' }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}
          <Card title="Scans">
            {c.scans.length === 0 ? (
              <EmptyState icon={<Radar className="size-6" />} title="No scans yet" action={can.write && <Button onClick={() => newScan.mutate()}>Start the first scan</Button>}>
                A scan walks you through scope, credentials and criteria, then runs automatically.
              </EmptyState>
            ) : (
              <div className="-m-6 divide-y divide-slate-100">
                {c.scans.map((s: any) => (
                  <Link key={s.id} to={scanLink(s)} className="flex items-center gap-4 px-6 py-4 transition hover:bg-slate-50">
                    <GradeBadge grade={s.grade} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900">{s.name}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                        {fmtDate(s.finishedAt ?? s.createdAt)}
                        <span className="flex gap-1">
                          {(s.providers as Provider[]).map((p) => (
                            <ProviderIcon key={p} provider={p} className="size-3.5" />
                          ))}
                        </span>
                      </div>
                    </div>
                    {s.score !== null && <span className="text-sm font-semibold text-slate-700">{s.score}</span>}
                    <ScanStatusBadge status={s.status} />
                    <ArrowRight className="size-4 text-slate-300" />
                  </Link>
                ))}
              </div>
            )}
          </Card>
          {triaged.length > 0 && (
            <Card title="Triaged findings" subtitle="Risk acceptances and false positives carry over to future scans.">
              <ul className="-my-2 divide-y divide-slate-100">
                {triaged.map((t: any) => (
                  <li key={t.checkId} className="py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-800">{CHECKS_BY_ID[t.checkId]?.title ?? t.checkId}</span>
                      <span className={clsx('rounded-md px-2 py-0.5 text-xs font-medium', t.status === 'accepted' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600')}>
                        {t.status === 'accepted' ? 'Risk accepted' : 'False positive'}
                      </span>
                    </div>
                    {t.note && <p className="mt-1 text-xs text-slate-500">{t.note}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Risk profile">
            <div className="flex items-center gap-3">
              <span className={clsx('rounded-lg px-2.5 py-1 text-sm font-semibold ring-1', RISK_STYLE[profile.level].cls)}>{RISK_STYLE[profile.level].label}</span>
              <span className="text-xs text-slate-500">{profile.points} risk points</span>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <Row k="Employees" v={c.context.employees} />
              <Row k="Data sensitivity" v={CONTEXT_LABELS.dataSensitivity[c.context.dataSensitivity as keyof typeof CONTEXT_LABELS.dataSensitivity]} />
              <Row k="Internet exposure" v={CONTEXT_LABELS.internetExposure[c.context.internetExposure as keyof typeof CONTEXT_LABELS.internetExposure]} />
              <Row k="Remote work" v={CONTEXT_LABELS.remoteWork[c.context.remoteWork as keyof typeof CONTEXT_LABELS.remoteWork]} />
            </dl>
            {c.context.regulations.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {c.context.regulations.map((r: string) => (
                  <span key={r} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                    {REGULATIONS.find(([id]) => id === r)?.[1] ?? r}
                  </span>
                ))}
              </div>
            )}
          </Card>
          <Card title="Contact">
            <dl className="space-y-2 text-sm">
              <Row k="Name" v={c.contactName || '-'} />
              <Row k="Email" v={c.contactEmail || '-'} />
            </dl>
            {c.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-slate-600">{c.notes}</p>}
          </Card>
          {can.admin && (
            <Card
              title="Access"
              actions={
                <Button size="sm" variant="ghost" icon={<Users className="size-3.5" />} onClick={() => setAssignOpen(true)}>
                  Manage
                </Button>
              }
            >
              {c.assigned.length === 0 ? (
                <p className="text-sm text-slate-500">Only admins and users with access to all organisations.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {c.assigned.map((u: any) => (
                    <li key={u.id}>
                      {u.name} <span className="text-slate-400">{u.email}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-6 border-t border-slate-100 pt-4">
                <AsyncButton
                  variant="ghost"
                  size="sm"
                  className="text-red-700 hover:bg-red-50"
                  icon={<Trash2 className="size-3.5" aria-hidden />}
                  confirm={{
                    title: 'Delete organisation',
                    danger: true,
                    confirmLabel: 'Delete permanently',
                    body: (
                      <>
                        This permanently deletes <strong>{c.name}</strong> with all scans, results, stored credentials and triage notes. This cannot be undone. Consider exporting the data
                        first.
                      </>
                    ),
                  }}
                  onClick={async () => {
                    await del(`/api/customers/${c.id}`);
                    await qc.invalidateQueries({ queryKey: ['customers'] });
                    await qc.invalidateQueries({ queryKey: ['scans'] });
                    toast.success(`${c.name} was deleted`);
                    nav('/organisations');
                  }}
                >
                  Delete organisation and all data
                </AsyncButton>
              </div>
            </Card>
          )}
        </div>
      </div>

      {assignOpen && <AssignModal customerId={c.id} assigned={c.assigned.map((u: any) => u.id)} onClose={() => setAssignOpen(false)} />}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{k}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-slate-800">{v}</dd>
    </div>
  );
}

function AssignModal({ customerId, assigned, onClose }: { customerId: string; assigned: string[]; onClose(): void }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<any[]>('/api/users') });
  const [sel, setSel] = useState<string[]>(assigned);
  const candidates = (users.data ?? []).filter((u) => u.role !== 'admin' && !u.allCustomers && !u.isBreakglass);
  return (
    <Modal
      open
      onClose={onClose}
      title="Who can access this organisation?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <AsyncButton
            success="Access updated"
            onClick={async () => {
              await put(`/api/customers/${customerId}/assignments`, { userIds: sel });
              await qc.invalidateQueries({ queryKey: ['customer', customerId] });
              onClose();
            }}
          >
            Save
          </AsyncButton>
        </>
      }
    >
      {users.isError ? (
        <ErrorState error={users.error} onRetry={() => users.refetch()} />
      ) : users.isLoading ? (
        <PageLoader />
      ) : candidates.length === 0 ? (
        <p className="text-sm text-slate-500">There are no analysts or viewers that need explicit assignment. Admins and users with access to all organisations always have access.</p>
      ) : (
        <ul className="space-y-2">
          {candidates.map((u) => (
            <li key={u.id}>
              <label className="flex items-center gap-3 text-sm">
                <input type="checkbox" className="size-4 rounded border-slate-300 text-brand-600" checked={sel.includes(u.id)} onChange={(e) => setSel(e.target.checked ? [...sel, u.id] : sel.filter((x) => x !== u.id))} />
                <span className="font-medium">{u.name}</span>
                <span className="text-slate-400">{u.email}</span>
                <span className="ml-auto text-xs text-slate-500">{ROLE_LABELS[u.role as Role]}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

