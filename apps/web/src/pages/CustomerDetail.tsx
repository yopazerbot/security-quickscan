import { CHECKS_BY_ID, INDUSTRIES, REGULATIONS, computeRiskProfile, type Provider, type Role } from '@qs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, ArrowRightLeft, Download, LogOut, Pencil, Play, Radar, Trash2, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CONTEXT_LABELS, RISK_STYLE } from '../components/ContextForm';
import { AsyncButton, useAction, useToast } from '../components/feedback';
import { ProviderIcon } from '../components/ProviderIcon';
import { AnchorButton, Badge, Button, Card, DemoBadge, EmptyState, ErrorState, Field, GradeBadge, Input, LinkButton, Modal, PageHeader, PageLoader, Select } from '../components/ui';
import { del, get, patch, post, put } from '../lib/api';
import { accessCan, useAuth, type CustomerAccess } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { ScanStatusBadge } from './Customers';

export function CustomerDetail() {
  const { customerId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['customer', customerId], queryFn: () => get<CustomerData>(`/api/customers/${customerId}`) });
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
  const can = accessCan(c.myAccess);
  // Sharing needs real accounts: hidden in local mode (one admin) and in demo sessions.
  const sharing = !me?.features.local && !me?.user.isDemo;
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
            {can.edit && (
              <LinkButton to={`/organisations/${c.id}/edit`} variant="secondary" icon={<Pencil className="size-4" aria-hidden />}>
                Edit
              </LinkButton>
            )}
            {can.edit && (
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
              <EmptyState icon={<Radar className="size-6" />} title="No scans yet" action={can.edit && <Button onClick={() => newScan.mutate()}>Start the first scan</Button>}>
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
          {sharing && <AccessCard c={c} />}
          {can.manage && (
            <Card title="Delete organisation">
              <p className="text-sm text-slate-500">Removes the organisation with all scans, results, stored credentials and triage notes.</p>
              <AsyncButton
                variant="ghost"
                size="sm"
                className="mt-3 text-red-700 hover:bg-red-50"
                icon={<Trash2 className="size-3.5" aria-hidden />}
                confirm={{
                  title: 'Delete organisation',
                  danger: true,
                  confirmLabel: 'Delete permanently',
                  body: (
                    <>
                      This permanently deletes <strong>{c.name}</strong> with all scans, results, stored credentials and triage notes. This cannot be undone. Consider exporting the data first.
                    </>
                  ),
                }}
                onClick={async () => {
                  await del(`/api/customers/${c.id}`);
                  nav('/organisations');
                  qc.removeQueries({ queryKey: ['customer', c.id] });
                  await qc.invalidateQueries({ queryKey: ['customers'] });
                  await qc.invalidateQueries({ queryKey: ['scans'] });
                  toast.success(`${c.name} was deleted`);
                }}
              >
                Delete organisation and all data
              </AsyncButton>
            </Card>
          )}
        </div>
      </div>
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

interface Share {
  userId: string;
  name: string;
  email: string;
  role: Role;
  permission: 'view' | 'edit';
  grantedAt: string;
}

interface CustomerData {
  id: string;
  name: string;
  country: string | null;
  isDemo: boolean;
  context: any;
  contactName: string | null;
  contactEmail: string | null;
  notes: string | null;
  scans: any[];
  triage: any[];
  myAccess: CustomerAccess;
  owner: { id: string; name: string; email: string } | null;
  shares: Share[];
}

/** Need-to-know access: owners and admins manage the share list, everyone else sees their own access and can leave. */
function AccessCard({ c }: { c: CustomerData }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { me } = useAuth();
  const toast = useToast();
  const run = useAction();
  const can = accessCan(c.myAccess);
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<'view' | 'edit'>('view');
  const [updating, setUpdating] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['customer', c.id] });

  if (!can.manage) {
    return (
      <Card title="Access">
        <p className="text-sm text-slate-600">
          {c.owner ? (
            <>
              Owned by <span className="font-medium text-slate-800">{c.owner.name}</span>.
            </>
          ) : (
            'This organisation has no owner.'
          )}{' '}
          You have {c.myAccess === 'view' ? 'view' : 'edit'} access.
        </p>
        <AsyncButton
          variant="ghost"
          size="sm"
          className="mt-3 text-red-700 hover:bg-red-50"
          icon={<LogOut className="size-3.5" aria-hidden />}
          confirm={{
            title: 'Leave organisation',
            danger: true,
            confirmLabel: 'Leave',
            body: (
              <>
                You lose access to <strong>{c.name}</strong> and its scans. The owner can share it with you again.
              </>
            ),
          }}
          onClick={async () => {
            await del(`/api/customers/${c.id}/shares/${me!.user.id}`);
            // Drop cached data first so the list never shows the organisation that was just left.
            qc.removeQueries({ queryKey: ['customer', c.id] });
            qc.removeQueries({ queryKey: ['customers'] });
            qc.removeQueries({ queryKey: ['scans'] });
            nav('/organisations');
            toast.success(`You left ${c.name}`);
          }}
        >
          Leave
        </AsyncButton>
      </Card>
    );
  }

  return (
    <Card
      title="Access"
      actions={
        <Button size="sm" variant="ghost" icon={<ArrowRightLeft className="size-3.5" aria-hidden />} onClick={() => setTransferOpen(true)}>
          Transfer ownership
        </Button>
      }
    >
      <p className="text-sm text-slate-600">
        Owner: <span className="font-medium text-slate-800">{c.owner ? c.owner.name : 'none'}</span>
        {c.owner?.email && <span className="ml-1 text-slate-400">{c.owner.email}</span>}
      </p>
      {c.shares.length > 0 ? (
        <ul className="mt-4 divide-y divide-slate-100 border-y border-slate-100">
          {c.shares.map((sh) => (
            <li key={sh.userId} className="flex items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-800">
                  {sh.name}
                  {sh.role === 'viewer' && <Badge className="bg-slate-100 text-slate-500">Read-only</Badge>}
                </div>
                <div className="truncate text-xs text-slate-500">{sh.email}</div>
              </div>
              <Select
                aria-label={`Permission for ${sh.name}`}
                className="w-24 py-1 text-xs"
                value={sh.role === 'viewer' ? 'view' : sh.permission}
                disabled={sh.role === 'viewer' || updating === sh.userId}
                title={sh.role === 'viewer' ? 'Read-only accounts always get view access' : undefined}
                onChange={async (e) => {
                  const next = e.target.value as Share['permission'];
                  setUpdating(sh.userId);
                  await run(async () => {
                    await patch(`/api/customers/${c.id}/shares/${sh.userId}`, { permission: next });
                    await refresh();
                  }, `${sh.name} now has ${next} access`);
                  setUpdating(null);
                }}
              >
                <option value="view">View</option>
                <option value="edit">Edit</option>
              </Select>
              <AsyncButton
                size="sm"
                variant="ghost"
                aria-label={`Remove access for ${sh.name}`}
                title="Remove access"
                icon={<X className="size-3.5" aria-hidden />}
                success={`${sh.name} no longer has access`}
                confirm={{
                  title: 'Remove access',
                  danger: true,
                  confirmLabel: 'Remove',
                  body: (
                    <>
                      <strong>{sh.name}</strong> can no longer see <strong>{c.name}</strong> or its scans.
                    </>
                  ),
                }}
                onClick={async () => {
                  await del(`/api/customers/${c.id}/shares/${sh.userId}`);
                  await refresh();
                }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500">Not shared with anyone yet.</p>
      )}
      <form className="mt-4 space-y-2" onSubmit={(e) => e.preventDefault()}>
        <Field label="Share by e-mail address">
          <Input type="email" placeholder="colleague@example.com" autoComplete="off" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Select aria-label="Permission" className="min-w-0 flex-1" value={permission} onChange={(e) => setPermission(e.target.value as Share['permission'])}>
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </Select>
          <AsyncButton
            type="submit"
            variant="secondary"
            className="shrink-0"
            icon={<UserPlus className="size-4" aria-hidden />}
            disabled={!email.trim()}
            onClick={async () => {
              const r = await post<{ ok: true; name: string }>(`/api/customers/${c.id}/shares`, { email: email.trim(), permission });
              setEmail('');
              await refresh();
              toast.success(`Shared with ${r.name}`);
            }}
          >
            Share
          </AsyncButton>
        </div>
      </form>
      <p className="mt-3 text-xs text-slate-500">Only people you add can see this organisation. Admins can see all organisations. Read-only accounts always get view access.</p>
      {transferOpen && <TransferModal c={c} onClose={() => setTransferOpen(false)} />}
    </Card>
  );
}

function TransferModal({ c, onClose }: { c: CustomerData; onClose(): void }) {
  const qc = useQueryClient();
  const candidates = c.shares.filter((sh) => sh.role !== 'viewer');
  const [sel, setSel] = useState<string | null>(null);
  const target = candidates.find((sh) => sh.userId === sel);
  return (
    <Modal
      open
      onClose={onClose}
      title="Transfer ownership"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <AsyncButton
            disabled={!target}
            success={target ? `${target.name} now owns ${c.name}` : undefined}
            onClick={async () => {
              await put(`/api/customers/${c.id}/owner`, { userId: sel });
              await qc.invalidateQueries({ queryKey: ['customer', c.id] });
              await qc.invalidateQueries({ queryKey: ['customers'] });
              onClose();
            }}
          >
            Transfer
          </AsyncButton>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-slate-500">Share the organisation with an analyst or admin first. Read-only accounts cannot own an organisation.</p>
      ) : (
        <>
          <p className="mb-4 text-sm text-slate-600">
            The new owner manages access and can delete the organisation. {c.owner ? <>The previous owner, {c.owner.name}, keeps edit access.</> : null}
          </p>
          <fieldset>
            <legend className="sr-only">New owner</legend>
            <ul className="space-y-2">
              {candidates.map((sh) => (
                <li key={sh.userId}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm ring-1 ring-slate-200 has-[:checked]:bg-brand-50 has-[:checked]:ring-brand-300">
                    <input type="radio" name={`owner-${c.id}`} className="size-4 text-brand-600" checked={sel === sh.userId} onChange={() => setSel(sh.userId)} />
                    <span className="font-medium text-slate-800">{sh.name}</span>
                    <span className="truncate text-slate-400">{sh.email}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </>
      )}
    </Modal>
  );
}
