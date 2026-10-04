import { ALL_SYSTEMS_KEY, CHECKS_BY_ID, PROVIDER_LABELS, PROVIDER_SHORT, type Provider, type Role } from '@qs/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, ArrowRightLeft, ChevronDown, Download, KeyRound, LogOut, Pencil, Play, Radar, Trash2, UserPlus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AsyncButton, useAction, useToast } from '../components/feedback';
import { DataTable } from '../components/data-table';
import { ProviderIcon } from '../components/ProviderIcon';
import { EnvironmentChip, SystemBadge } from '../components/SystemBadge';
import { AnchorButton, Badge, Button, Card, DemoBadge, EmptyState, ErrorState, Field, GradeBadge, Input, LinkButton, Modal, PageHeader, PageLoader, Select, Spinner } from '../components/ui';
import { del, get, patch, post, put } from '../lib/api';
import { accessCan, useAuth, type CustomerAccess } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { scanLink } from '../lib/scan-link';
import { keyOfScanSystem, parseSystemKey, systemIdentity } from '../lib/systems';
import { useDocumentTitle } from '../lib/use-document-title';
import { ScanStatusBadge } from './Customers';

/** Environment names without case-only duplicates, sorted. */
const uniqueEnvironments = (xs: string[] | undefined) => [...new Map((xs ?? []).map((e) => [e.toLowerCase(), e])).values()].sort((a, b) => a.localeCompare(b));

/** What view and edit access allow; shown to the person who shares and to the person who receives access. */
const PERMISSION_HINT = 'View: see scans and reports. Edit: also add systems and credentials, run scans and triage findings.';

/** Scan states after which stored secrets can still exist and no scan is using them. */
const FINISHED = new Set(['completed', 'failed', 'cancelled']);

export function CustomerDetail() {
  const { customerId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['customer', customerId], queryFn: () => get<CustomerData>(`/api/customers/${customerId}`) });
  useDocumentTitle(q.data?.name ?? 'Organisation');
  const newScan = useMutation({
    mutationFn: async (): Promise<{ id: string; resumed?: boolean }> => {
      // Resume an empty draft this user started earlier instead of piling up empty drafts.
      const emptyDrafts = (q.data?.scans ?? []).filter((s) => s.status === 'draft' && s.providers.length === 0).slice(0, 3);
      for (const d of emptyDrafts) {
        try {
          const full = await get<{ createdBy: string | null; status: string; systems: unknown[] }>(`/api/scans/${d.id}`);
          if (full.status === 'draft' && full.createdBy === me?.user.id && full.systems.length === 0) return { id: d.id, resumed: true };
        } catch {
          /* not resumable: create a new draft below */
        }
      }
      return post<{ id: string }>(`/api/customers/${customerId}/scans`, {});
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['scans'] });
      void qc.invalidateQueries({ queryKey: ['customer', customerId] });
      if (r.resumed) toast.success('You already had an empty draft for this organisation, so it was opened again.');
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
  const trend = [...c.scans]
    .filter((s) => s.status === 'completed' && s.score !== null && s.score !== undefined)
    .reverse()
    .map((s) => ({ date: fmtDate(s.finishedAt), score: s.score }));
  const triaged = c.triage.filter((t: any) => t.status !== 'open');
  const finished = c.scans.filter((s) => FINISHED.has(s.status));

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
              <EmptyState
                icon={<Radar className="size-6" />}
                title="No scans yet"
                action={can.edit && <Button onClick={() => newScan.mutate()}>Start the first scan</Button>}
              >
                {can.edit
                  ? 'A scan walks you through scope, access and a final review. Every best-practice check for the systems in scope runs.'
                  : 'Scans and reports appear here once someone with edit access runs a scan for this organisation.'}
              </EmptyState>
            ) : (
              <div className="-m-6">
                <ScanTable scans={c.scans} customerId={c.id} canEdit={can.edit} />
              </div>
            )}
          </Card>
          {finished.length > 0 && <StoredSecretsCard scans={finished} canEdit={can.edit} />}
          {triaged.length > 0 && <TriagedCard triaged={triaged} scans={finished} />}
        </div>
        <div className="space-y-6">
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
                  title: 'Delete organisation?',
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
                  toast.success(`${c.name} was deleted.`);
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

/** The organisation's scans. Drafts open the wizard for editors only; view-only users see them as plain rows. */
function ScanTable({ scans, customerId, canEdit }: { scans: ScanSummary[]; customerId: string; canEdit: boolean }) {
  const nav = useNavigate();
  const linked = (s: ScanSummary) => s.status !== 'draft' || canEdit;
  return (
    <DataTable
      storageKey="organisation-scans"
      label="scans"
      caption="Scans"
      minWidth="44rem"
      rows={scans}
      rowKey={(s) => s.id}
      onRowClick={(s) => linked(s) && nav(scanLink(s))}
      hidePagerWhenSmall
      columns={[
        {
          key: 'name',
          header: 'Name',
          sort: (s) => s.name.toLowerCase(),
          render: (s) =>
            linked(s) ? (
              <Link to={scanLink(s)} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                {s.name}
              </Link>
            ) : (
              <span className="font-medium text-slate-900" title="Only people with edit access can open a draft.">
                {s.name}
              </span>
            ),
        },
        { key: 'status', header: 'Status', sort: (s) => s.status, render: (s) => <ScanStatusBadge status={s.status} /> },
        {
          key: 'grade',
          header: 'Grade',
          sort: (s) => s.score ?? null,
          render: (s) => (s.status === 'draft' ? <span className="text-slate-500">-</span> : <GradeBadge grade={s.grade} score={s.score} size="sm" />),
        },
        {
          key: 'systems',
          header: 'Systems',
          sort: (s) => s.providers.length,
          render: (s) =>
            s.providers.length ? (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {(s.providers as Provider[]).map((p) => (
                  <span key={p} className="inline-flex items-center gap-1 text-xs text-slate-600">
                    <ProviderIcon provider={p} className="size-3.5" decorative />
                    {PROVIDER_SHORT[p]}
                    <span className="sr-only"> ({PROVIDER_LABELS[p]})</span>
                  </span>
                ))}
                {uniqueEnvironments(s.environments).map((e) => (
                  <EnvironmentChip key={e} environment={e} />
                ))}
              </span>
            ) : (
              <span className="text-xs text-slate-500">None yet</span>
            ),
        },
        {
          key: 'date',
          header: 'Date',
          sort: (s) => new Date(s.finishedAt ?? s.createdAt),
          render: (s) => (
            <span className="whitespace-nowrap text-xs text-slate-600">{s.status === 'draft' ? `Draft started ${fmtDate(s.createdAt)}` : fmtDate(s.finishedAt ?? s.createdAt)}</span>
          ),
        },
        {
          key: 'actions',
          header: <span className="sr-only">Actions</span>,
          align: 'right',
          render: (s) =>
            s.status === 'draft' && canEdit ? <DiscardDraft s={s} customerId={customerId} /> : linked(s) ? <ArrowRight className="ml-auto size-4 text-slate-500" aria-hidden /> : null,
        },
      ]}
    />
  );
}

function DiscardDraft({ s, customerId }: { s: ScanSummary; customerId: string }) {
  const qc = useQueryClient();
  return (
    <AsyncButton
      size="sm"
      variant="ghost"
      className="text-red-700 hover:bg-red-50"
      aria-label={`Discard draft ${s.name}`}
      title="Discard draft"
      icon={<Trash2 className="size-3.5" aria-hidden />}
      success="The draft was discarded."
      confirm={{
        title: 'Discard draft?',
        danger: true,
        confirmLabel: 'Discard draft',
        body: (
          <>
            <strong>{s.name}</strong> is deleted with its systems and any stored credentials. Finished scans are not affected.
          </>
        ),
      }}
      onClick={async () => {
        await del(`/api/scans/${s.id}`);
        await qc.invalidateQueries({ queryKey: ['customer', customerId] });
        await qc.invalidateQueries({ queryKey: ['scans'] });
      }}
    />
  );
}

/**
 * Risk acceptances and findings marked not applicable, each with the system it applies to. Systems are resolved from the most
 * recent finished scans; a key that no loaded scan knows still shows its platform and id.
 */
function TriagedCard({ triaged, scans }: { triaged: any[]; scans: ScanSummary[] }) {
  const recent = scans.slice(0, 5);
  const results = useQueries({ queries: recent.map((s) => ({ queryKey: ['scan', s.id], queryFn: () => get<ScanDetail>(`/api/scans/${s.id}`) })) });
  const known = new Map<string, { provider: Provider; label: string; identity: string | null; environment: string | null }>();
  for (const r of results)
    for (const sys of r.data?.systems ?? []) {
      const key = keyOfScanSystem(sys);
      if (!known.has(key))
        known.set(key, { provider: sys.provider, label: sys.label, identity: systemIdentity(sys.provider, sys.connection?.details, sys.config), environment: sys.environment ?? null });
    }
  return (
    <Card title="Triaged findings" subtitle="Risk acceptances and not applicable findings apply to scans that finish from now on.">
      <ul className="-my-2 divide-y divide-slate-100">
        {triaged.map((t: any) => {
          const key: string = t.systemKey ?? ALL_SYSTEMS_KEY;
          const sys = known.get(key);
          const parsed = parseSystemKey(key);
          return (
            <li key={`${t.checkId}|${key}`} className="py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-slate-800">{CHECKS_BY_ID[t.checkId]?.title ?? t.checkId}</span>
                <span className={clsx('shrink-0 rounded-md px-2 py-0.5 text-xs font-medium', t.status === 'accepted' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600')}>
                  {t.status === 'accepted' ? 'Risk accepted' : 'Not applicable / false positive'}
                </span>
              </div>
              <div className="mt-1">
                {key === ALL_SYSTEMS_KEY ? (
                  <span className="text-xs text-slate-600">All systems</span>
                ) : sys ? (
                  <SystemBadge provider={sys.provider} label={sys.label} identity={sys.identity} environment={sys.environment} size="xs" />
                ) : parsed.provider ? (
                  <SystemBadge provider={parsed.provider} label={PROVIDER_LABELS[parsed.provider]} identity={parsed.id} size="xs" />
                ) : (
                  <span className="text-xs text-slate-600">{key}</span>
                )}
              </div>
              {t.note && <p className="mt-1 text-xs text-slate-500">{t.note}</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

interface ScanDetail {
  id: string;
  name: string;
  status: string;
  systems: {
    id: string;
    provider: Provider;
    label: string;
    environment?: string | null;
    config?: Record<string, any> | null;
    connection?: { details?: Record<string, any> | null } | null;
    credential: { hint: string; expiresAt: string | null; createdAt: string } | null;
  }[];
}

/**
 * Secrets that are still stored for finished scans (for example "keep until I delete them"), with a delete action
 * for people with edit access. Loads the scans only when the section is opened.
 */
function StoredSecretsCard({ scans, canEdit }: { scans: ScanSummary[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const results = useQueries({
    queries: scans.map((s) => ({ queryKey: ['scan', s.id], queryFn: () => get<ScanDetail>(`/api/scans/${s.id}`), enabled: open })),
  });
  const loading = open && results.some((r) => r.isLoading);
  const failed = results.filter((r) => r.isError).length;
  const rows = results.flatMap((r) => (r.data ? r.data.systems.filter((sys) => sys.credential).map((sys) => ({ scan: r.data!, sys })) : []));
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="size-4 text-slate-500" aria-hidden /> Stored secrets
        </span>
      }
      subtitle="Secrets kept after a scan, for example when retention is set to keep them until you delete them."
      actions={
        <Button size="sm" variant="ghost" aria-expanded={open} icon={<ChevronDown className={clsx('size-3.5 transition', open && 'rotate-180')} aria-hidden />} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {!open ? (
        <p className="text-sm text-slate-500">Show the list to check which finished scans still hold a secret{canEdit ? ' and delete them' : ''}.</p>
      ) : loading ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">No finished scan of this organisation holds a stored secret.</p>
          ) : (
            <ul className="-my-2 divide-y divide-slate-100">
              {rows.map(({ scan, sys }) => (
                <li key={sys.id} className="flex flex-wrap items-center gap-3 py-3">
                  <ProviderIcon provider={sys.provider} className="size-4" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-800">{sys.label}</div>
                    <div className="truncate text-xs text-slate-500">
                      {scan.name}
                      {sys.credential!.hint && <span className="ml-1.5 font-mono">{sys.credential!.hint}</span>}
                      <span className="ml-1.5">{sys.credential!.expiresAt ? `Deleted automatically on ${fmtDate(sys.credential!.expiresAt)}` : 'Kept until someone deletes it'}</span>
                    </div>
                  </div>
                  {canEdit && (
                    <AsyncButton
                      size="sm"
                      variant="ghost"
                      className="text-red-700 hover:bg-red-50"
                      icon={<Trash2 className="size-3.5" aria-hidden />}
                      success={`The stored secret for ${sys.label} was deleted.`}
                      confirm={{
                        title: 'Delete stored secret?',
                        danger: true,
                        confirmLabel: 'Delete secret',
                        body: (
                          <>
                            The secret for <strong>{sys.label}</strong> in <strong>{scan.name}</strong> is deleted. The report stays available. A new scan of this system needs the secret again.
                          </>
                        ),
                      }}
                      onClick={async () => {
                        await del(`/api/scans/${scan.id}/systems/${sys.id}/credentials`);
                        await qc.invalidateQueries({ queryKey: ['scan', scan.id] });
                      }}
                    >
                      Delete stored secret
                    </AsyncButton>
                  )}
                </li>
              ))}
            </ul>
          )}
          {failed > 0 && <p className="mt-3 text-xs text-red-700">{failed === 1 ? 'One scan could not be loaded.' : `${failed} scans could not be loaded.`} Reload the page to try again.</p>}
        </>
      )}
    </Card>
  );
}

interface Share {
  userId: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  permission: 'view' | 'edit';
  grantedAt: string;
}

interface ScanSummary {
  id: string;
  name: string;
  status: string;
  score: number | null;
  grade: string | null;
  createdAt: string;
  finishedAt: string | null;
  providers: string[];
  /** Environments of the scan's systems (distinct, may differ only in case). */
  environments?: string[];
}

interface CustomerData {
  id: string;
  name: string;
  isDemo: boolean;
  scans: ScanSummary[];
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
  const [shareErr, setShareErr] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['customer', c.id] });

  if (!can.manage) {
    const isOwner = Boolean(me && c.owner?.id === me.user.id);
    return (
      <Card title="Access">
        <p className="text-sm text-slate-600">
          {c.owner ? (
            <>
              Owned by <span className="font-medium text-slate-800">{c.owner.name}</span>.
            </>
          ) : (
            'This organisation has no owner. Ask an administrator to assign one.'
          )}{' '}
          You have {c.myAccess === 'view' ? 'view' : 'edit'} access.
        </p>
        <p className="mt-2 text-xs text-slate-500">{PERMISSION_HINT}</p>
        {!isOwner && (
          <AsyncButton
            variant="ghost"
            size="sm"
            className="mt-3 text-red-700 hover:bg-red-50"
            icon={<LogOut className="size-3.5" aria-hidden />}
            confirm={{
              title: 'Leave organisation?',
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
              toast.success(`You left ${c.name}.`);
            }}
          >
            Leave
          </AsyncButton>
        )}
      </Card>
    );
  }

  const share = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || sharing) return;
    setSharing(true);
    setShareErr(null);
    try {
      const r = await post<{ ok: true; name: string; permission: 'view' | 'edit' }>(`/api/customers/${c.id}/shares`, { email: email.trim(), permission });
      setEmail('');
      await refresh();
      toast.success(`${r.name} can now ${r.permission === 'edit' ? 'edit' : 'view'} ${c.name}.`);
    } catch (err) {
      setShareErr(err instanceof Error ? err.message : 'The organisation could not be shared.');
    } finally {
      setSharing(false);
    }
  };

  return (
    <Card
      title="Access"
      actions={
        <Button size="sm" variant="ghost" icon={<ArrowRightLeft className="size-3.5" aria-hidden />} onClick={() => setTransferOpen(true)}>
          {c.owner ? 'Transfer ownership' : 'Assign owner'}
        </Button>
      }
    >
      <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-slate-600">
        Owner:
        {c.owner ? (
          <>
            <span className="font-medium text-slate-800">{c.owner.name}</span>
            {c.owner.email && <span className="text-slate-500">{c.owner.email}</span>}
          </>
        ) : (
          <Badge className="bg-amber-100 text-amber-800 ring-1 ring-amber-200">No owner</Badge>
        )}
      </p>
      {c.shares.length > 0 ? (
        <ul className="mt-4 divide-y divide-slate-100 border-y border-slate-100">
          {c.shares.map((sh) => {
            const fixed = sh.role === 'viewer' || sh.role === 'admin';
            return (
              <li key={sh.userId} className="flex items-center gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-800">
                    <span className="truncate">{sh.name}</span>
                    {!sh.active && <Badge className="bg-slate-100 text-slate-600">Inactive</Badge>}
                    {sh.role === 'admin' && <Badge className="bg-brand-50 text-brand-700">Admin, full access</Badge>}
                    {sh.role === 'viewer' && <Badge className="bg-slate-100 text-slate-600">Viewer, can only view</Badge>}
                  </div>
                  <div className="truncate text-xs text-slate-500">{sh.email}</div>
                </div>
                <Select
                  aria-label={`Permission for ${sh.name}`}
                  className="w-24 py-1 text-xs"
                  value={sh.role === 'viewer' ? 'view' : sh.role === 'admin' ? 'edit' : sh.permission}
                  disabled={fixed || updating === sh.userId}
                  title={sh.role === 'viewer' ? 'Viewer accounts always get view access' : sh.role === 'admin' ? 'Admins have full access to every organisation' : undefined}
                  onChange={async (e) => {
                    const next = e.target.value as Share['permission'];
                    setUpdating(sh.userId);
                    await run(async () => {
                      await patch(`/api/customers/${c.id}/shares/${sh.userId}`, { permission: next });
                      await refresh();
                    }, `${sh.name} now has ${next} access.`);
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
                  success={`${sh.name} no longer has access.`}
                  confirm={{
                    title: 'Remove access?',
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
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500">Not shared with anyone yet.</p>
      )}
      <form className="mt-4 space-y-2" onSubmit={(e) => void share(e)} noValidate>
        <Field label="Share by email address" error={shareErr}>
          <Input
            type="email"
            placeholder="colleague@example.com"
            autoComplete="off"
            maxLength={320}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setShareErr(null);
            }}
          />
        </Field>
        <div className="flex gap-2">
          <Select aria-label="Permission" aria-describedby={`perm-hint-${c.id}`} className="min-w-0 flex-1" value={permission} onChange={(e) => setPermission(e.target.value as Share['permission'])}>
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </Select>
          <Button type="submit" variant="secondary" className="shrink-0" loading={sharing} icon={<UserPlus className="size-4" aria-hidden />} disabled={!email.trim()}>
            Share
          </Button>
        </div>
        <p id={`perm-hint-${c.id}`} className="text-xs text-slate-500">
          {PERMISSION_HINT}
        </p>
      </form>
      <p className="mt-3 text-xs text-slate-500">Only people you add can see this organisation. Admins can see all organisations. Viewer accounts always get view access.</p>
      {transferOpen && <TransferModal c={c} onClose={() => setTransferOpen(false)} />}
    </Card>
  );
}

interface Candidate {
  userId: string;
  name: string;
  email: string;
}

/**
 * Owners hand the organisation to someone it is shared with; admins can pick any active analyst or admin
 * (also to give an ownerless organisation an owner).
 */
function TransferModal({ c, onClose }: { c: CustomerData; onClose(): void }) {
  const qc = useQueryClient();
  const asAdmin = c.myAccess === 'admin';
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => get<{ id: string; name: string; email: string; role: Role; active: boolean; isDemo: boolean; isBreakglass: boolean }[]>('/api/users'),
    enabled: asAdmin,
  });
  const candidates: Candidate[] = asAdmin
    ? (users.data ?? [])
        .filter((u) => u.active && u.role !== 'viewer' && !u.isDemo && !u.isBreakglass && u.id !== c.owner?.id)
        .map((u) => ({ userId: u.id, name: u.name || u.email, email: u.email }))
    : c.shares.filter((sh) => sh.role !== 'viewer' && sh.active).map((sh) => ({ userId: sh.userId, name: sh.name, email: sh.email }));
  const [sel, setSel] = useState<string | null>(null);
  const target = candidates.find((x) => x.userId === sel);
  const assign = !c.owner;
  return (
    <Modal
      open
      onClose={onClose}
      title={assign ? 'Assign an owner' : 'Transfer ownership?'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <AsyncButton
            variant={assign ? 'primary' : 'danger'}
            disabled={!target}
            success={target ? `${target.name} now owns ${c.name}.` : undefined}
            onClick={async () => {
              await put(`/api/customers/${c.id}/owner`, { userId: sel });
              await qc.invalidateQueries({ queryKey: ['customer', c.id] });
              await qc.invalidateQueries({ queryKey: ['customers'] });
              onClose();
            }}
          >
            {target ? (assign ? `Make ${target.name} the owner` : `Transfer to ${target.name}`) : assign ? 'Assign owner' : 'Transfer'}
          </AsyncButton>
        </>
      }
    >
      {asAdmin && users.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : asAdmin && users.isError ? (
        <ErrorState error={users.error} onRetry={() => users.refetch()} className="py-8" />
      ) : candidates.length === 0 ? (
        <p className="text-sm text-slate-600">
          {asAdmin
            ? 'There is no active analyst or admin account to make the owner. Invite one under Users first.'
            : 'Share the organisation with an active analyst or admin first. Viewer accounts cannot own an organisation.'}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-slate-600">
            {c.myAccess === 'owner' ? (
              <>
                You will keep edit access but can no longer manage access or delete this organisation. Only {target ? target.name : 'the new owner'} or an admin can transfer it back.
              </>
            ) : (
              <>
                The new owner manages access and can delete the organisation. {c.owner ? <>The previous owner, {c.owner.name}, keeps edit access.</> : null}
              </>
            )}
          </p>
          <fieldset>
            <legend className="sr-only">New owner</legend>
            <ul className="space-y-2">
              {candidates.map((x) => (
                <li key={x.userId}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm ring-1 ring-slate-200 has-[:checked]:bg-brand-50 has-[:checked]:ring-brand-300">
                    <input type="radio" name={`owner-${c.id}`} className="size-4 text-brand-600" checked={sel === x.userId} onChange={() => setSel(x.userId)} />
                    <span className="font-medium text-slate-800">{x.name}</span>
                    <span className="truncate text-slate-500">{x.email}</span>
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
