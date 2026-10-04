import {
  DOMAIN_LABELS,
  DOMAIN_SHORT,
  executiveSummarySentences,
  ISO_BY_ID,
  partialLabel,
  PROVIDER_LABELS,
  REPORT_TITLE,
  type Severity,
} from '@qs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, ChevronDown, Download, ExternalLink, FileSpreadsheet, FileText, KeyRound, ListChecks, Printer, RefreshCw, SearchX, ShieldCheck, Sparkles, Target, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Bar, BarChart, Cell, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AsyncButton, useToast } from '../components/feedback';
import { DataTable, Pager, usePaged } from '../components/data-table';
import { ProviderIcon } from '../components/ProviderIcon';
import { ResourceList } from '../components/ResourceList';
import { SystemBadge } from '../components/SystemBadge';
import { Alert, AnchorButton, Button, Card, EmptyState, ErrorState, Input, PageHeader, PageLoader, Select, SeverityBadge, StatusBadge, Textarea } from '../components/ui';
import { del, get, post, put } from '../lib/api';
import { accessCan } from '../lib/auth';
import { fmtDate, fmtDateTime, GRADE_HEX, SEVERITY_HEX } from '../lib/format';
import { useDocumentTitle } from '../lib/use-document-title';
import { IsoSection } from './report/IsoSection';
import { SystemCards } from './report/SystemCards';

type Item = any;

const TRIAGE_LABEL: Record<string, string> = { open: 'Open', accepted: 'Risk accepted', false_positive: 'Not applicable / false positive' };
/** Short labels for the small badges on finding cards. */
const TRIAGE_BADGE: Record<string, string> = { accepted: 'Risk accepted', false_positive: 'Not applicable' };

/** DOM id of a finding card, so other parts of the report can link to it. */
const findingId = (key: string) => `finding-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/** Counts of zero are neutral: "0 new" is neither good nor bad news. */
const countCls = (n: number, tone: string) => (n === 0 ? 'text-slate-600' : tone);

/** Smooth scrolling unless the user asked the system for reduced motion. */
const scrollBehavior = (): ScrollBehavior => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/** The system of a report item: identity from the item (newer reports) or from the report's system list. */
const identityOf = (f: Item, systems: Map<string, any>): string | null => f.systemIdentity ?? systems.get(f.systemId)?.identity ?? null;

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const STATUS_ORDER: Record<string, number> = { fail: 0, warn: 1, error: 2, na: 3, pass: 4 };

type FindingSort = 'severity' | 'system' | 'status' | 'title';
const FINDING_SORTS: [FindingSort, string][] = [
  ['severity', 'Severity'],
  ['system', 'System'],
  ['status', 'Status'],
  ['title', 'Title'],
];

function sortFindings(list: Item[], by: FindingSort): Item[] {
  // The server sends findings by severity; the other orders keep severity as the tie-breaker.
  if (by === 'severity') return list;
  const sev = (f: Item) => SEV_ORDER[f.severity] ?? 9;
  const key: Record<Exclude<FindingSort, 'severity'>, (a: Item, b: Item) => number> = {
    system: (a, b) => String(a.systemLabel).localeCompare(String(b.systemLabel)),
    status: (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
    title: (a, b) => String(a.title).localeCompare(String(b.title)),
  };
  return [...list].sort((a, b) => key[by](a, b) || sev(a) - sev(b) || String(a.title).localeCompare(String(b.title)));
}

const SORT_KEY = 'qs_report_findings_sort';
function readSort(): FindingSort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return FINDING_SORTS.some(([k]) => k === v) ? (v as FindingSort) : 'severity';
  } catch {
    return 'severity';
  }
}

function Triage({ customerId, item, onSaved }: { customerId: string; item: Item; onSaved(): void }) {
  // The form edits the current decision for this check on this system; the report itself may be frozen with an older one.
  const [status, setStatus] = useState(item.currentTriage?.status ?? 'open');
  const [note, setNote] = useState(item.currentTriage?.note ?? '');
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => put(`/api/customers/${customerId}/triage/${item.checkId}`, { systemKey: item.systemKey, status, note }),
    onSuccess: () => {
      toast.success(`Triage saved for ${item.systemLabel}.`);
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save the triage.'),
  });
  const inReport = item.triage?.status ?? 'open';
  const current = item.currentTriage?.status ?? 'open';
  const labelId = `${findingId(item.key)}-triage`;
  return (
    <div className="rounded-xl bg-slate-50 p-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-600">Triage</div>
      <p id={labelId} className="mb-3 text-xs text-slate-600">
        Applies to this check on {item.systemLabel} for scans that finish from now on. Finished reports do not change.
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-64" aria-label={`Triage status for ${item.systemLabel}`} aria-describedby={`${labelId} ${labelId}-help`}>
          <option value="open">Open</option>
          <option value="accepted">Risk accepted</option>
          <option value="false_positive">Not applicable / false positive</option>
        </Select>
        <Textarea
          className="min-h-9 min-w-48 flex-1 py-1.5"
          rows={1}
          placeholder="Note (shown in the report)"
          aria-label="Triage note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={5000}
        />
        <Button variant="secondary" onClick={() => m.mutate()} loading={m.isPending}>
          Save
        </Button>
      </div>
      <p id={`${labelId}-help`} className="mt-2 text-xs text-slate-600">
        {status === 'false_positive'
          ? 'Not applicable / false positive removes the finding from the score. Use it when the check does not apply to this organisation or the result is wrong.'
          : status === 'accepted'
            ? 'Risk accepted keeps the finding in the report but leaves it out of the score; the related ISO control still shows it as a gap.'
            : 'Choose Not applicable / false positive to remove the finding from the score, or Risk accepted to record a deliberate decision.'}
      </p>
      {inReport !== current && (
        <p className="mt-3 text-xs text-slate-600">
          In this report: <strong className="font-semibold text-slate-800">{TRIAGE_LABEL[inReport]}</strong>. Current decision:{' '}
          <strong className="font-semibold text-slate-800">{TRIAGE_LABEL[current]}</strong>.
        </p>
      )}
    </div>
  );
}

function FindingDetail({ f, identity, customerId, canWrite, interactive, onTriaged }: { f: Item; identity: string | null; customerId: string; canWrite: boolean; interactive: boolean; onTriaged(): void }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span className="font-semibold uppercase tracking-wide text-slate-500">System</span>
        <SystemBadge provider={f.provider} label={f.systemLabel} identity={identity} size="sm" />
      </div>
      <p className="text-sm text-slate-600">{f.description}</p>
      <div className="grid gap-5 lg:grid-cols-2 print:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Affected resources ({f.resources.length})</h4>
          {f.resources.length === 0 ? <p className="text-sm text-slate-500">Tenant or account level setting.</p> : <ResourceList resources={f.resources} />}
        </div>
        <div className="space-y-4">
          <div className="rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-100">
            <h4 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-800">
              Recommendation <span className="font-normal normal-case">(effort: {f.effort})</span>
            </h4>
            <p className="text-sm text-emerald-950">{f.remediation}</p>
          </div>
          <div className="text-xs text-slate-500">
            <div className="mb-1">
              <span className="font-semibold text-slate-700">ISO 27001:2022</span>{' '}
              {f.iso.map((c: string, i: number) => (
                <span key={c}>
                  {i > 0 && ', '}A.{c} {ISO_BY_ID[c]?.title}
                  {i === 0 && ' (primary)'}
                </span>
              ))}
            </div>
            {f.cis && <div><span className="font-semibold text-slate-700">CIS</span> {f.cis}</div>}
            {f.nis2 && <div><span className="font-semibold text-slate-700">NIS2</span> {f.nis2}</div>}
            <div className="mt-2 flex flex-wrap gap-3">
              {f.references.map((r: string) => (
                <a key={r} href={r} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                  Reference <ExternalLink className="size-3" aria-hidden />
                  <span className="sr-only"> (opens in a new tab)</span>
                  <span className="print-only">{r}</span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
      {interactive && f.evidence && (
        <details className="no-print text-xs">
          <summary className="cursor-pointer font-medium text-slate-500">Raw evidence</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-slate-100">{JSON.stringify(f.evidence, null, 2)}</pre>
        </details>
      )}
      {interactive && canWrite && (
        <div className="no-print">
          <Triage customerId={customerId} item={f} onSaved={onTriaged} />
        </div>
      )}
      {f.triage?.note && <p className={clsx('text-sm italic text-slate-500', interactive && canWrite && 'print-only')}>Note: {f.triage.note}</p>}
    </>
  );
}

function FindingCard({
  f,
  identity,
  customerId,
  canWrite,
  onTriaged,
  focused,
  showNew,
}: {
  f: Item;
  identity: string | null;
  customerId: string;
  canWrite: boolean;
  onTriaged(): void;
  focused: boolean;
  showNew: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  const bodyId = `${findingId(f.key)}-body`;
  return (
    <div
      id={findingId(f.key)}
      data-testid="finding"
      className={clsx('print-avoid-break scroll-mt-20 rounded-xl bg-white ring-1 transition', open ? 'shadow-md ring-slate-300' : 'ring-slate-200 hover:ring-slate-300', focused && 'ring-2 ring-brand-500')}
    >
      <button type="button" data-finding-toggle aria-expanded={open} aria-controls={bodyId} className="flex w-full items-start gap-4 px-5 py-4 text-left md:items-center" onClick={() => setOpen(!open)}>
        <span className="h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: SEVERITY_HEX[f.severity as Severity] }} />
        <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">{f.title}</span>
              {showNew && f.isNew && <span className="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">New</span>}
              {f.triage && f.triage.status !== 'open' && (
                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">{TRIAGE_BADGE[f.triage.status] ?? TRIAGE_LABEL[f.triage.status]}</span>
              )}
            </div>
            <div className="mt-0.5 line-clamp-2 text-sm text-slate-500 md:truncate">{f.summary}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:justify-end">
            <SystemBadge provider={f.provider} label={f.systemLabel} identity={identity} showIdentity={false} size="xs" className="max-w-[14rem]" />
            <span className="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-[11px] text-brand-700">A.{f.iso[0]}</span>
            <SeverityBadge severity={f.severity} />
            <StatusBadge status={f.status} />
          </div>
        </div>
        <ChevronDown className={clsx('no-print mt-1 size-4 shrink-0 text-slate-500 transition md:mt-0', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <div id={bodyId} className="animate-fade-in space-y-5 border-t border-slate-100 px-5 py-5">
          <FindingDetail f={f} identity={identity} customerId={customerId} canWrite={canWrite} interactive onTriaged={onTriaged} />
        </div>
      ) : (
        // Collapsed on screen, but always fully expanded on paper.
        <div className="print-only space-y-5 border-t border-slate-100 px-5 py-5">
          <FindingDetail f={f} identity={identity} customerId={customerId} canWrite={canWrite} interactive={false} onTriaged={onTriaged} />
        </div>
      )}
    </div>
  );
}

export function Report() {
  const { scanId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['report', scanId], queryFn: () => get(`/api/scans/${scanId}/report`) });
  const [sev, setSev] = useState<string>('all');
  const [system, setSystem] = useState<string>('all');
  const [sortBy, setSortByState] = useState<FindingSort>(readSort);
  const setSortBy = (v: FindingSort) => {
    setSortByState(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };
  const [control, setControl] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [triage, setTriage] = useState<string>('all');
  const [showPassed, setShowPassed] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useDocumentTitle(q.data ? `${q.data.customer.name} report` : 'Report');
  const rescan = async () => {
    const r = await post<{ id: string }>(`/api/scans/${scanId}/rescan`);
    nav(`/scans/${r.id}/wizard`);
  };

  const m = q.data;
  const systems = useMemo(() => new Map<string, any>((m?.systems ?? []).map((x: any) => [x.id, x])), [m]);
  const findings = useMemo(() => {
    if (!m) return [];
    const term = search.trim().toLowerCase();
    const list = m.findings.filter(
      (f: Item) =>
        (sev === 'all' || f.severity === sev) &&
        (system === 'all' || f.systemId === system) &&
        (!control || f.iso.includes(control)) &&
        (status === 'all' || f.status === status) &&
        (triage === 'all' || (f.triage?.status ?? 'open') === triage) &&
        (!term || `${f.title} ${f.summary} ${f.systemLabel} ${identityOf(f, systems) ?? ''}`.toLowerCase().includes(term)),
    );
    return sortFindings(list, sortBy);
  }, [m, systems, sev, system, control, status, triage, search, sortBy]);
  const filtered = sev !== 'all' || system !== 'all' || control !== null || status !== 'all' || triage !== 'all' || search !== '';
  const paged = usePaged(findings, 'report-findings', `${sev}|${system}|${control}|${status}|${triage}|${search}|${sortBy}`);
  const clearFilters = () => {
    setSev('all');
    setSystem('all');
    setControl(null);
    setStatus('all');
    setTriage('all');
    setSearch('');
  };

  // Jump to a finding from the top risks list: filters are cleared first so the target is rendered.
  const focusVisible = Boolean(focusKey && paged.visible.some((f: Item) => f.key === focusKey));
  useEffect(() => {
    if (!focusKey) return;
    // The finding may be on another page of the list: go there first, then scroll once it is rendered.
    if (!focusVisible) {
      const idx = findings.findIndex((f: Item) => f.key === focusKey);
      if (idx >= 0) paged.pagerProps.onPage(Math.floor(idx / paged.pagerProps.pageSize));
      return;
    }
    const el = document.getElementById(findingId(focusKey));
    el?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    // Move keyboard focus to the finding so the next Tab continues from there.
    el?.querySelector<HTMLButtonElement>('[data-finding-toggle]')?.focus({ preventScroll: true });
    const t = setTimeout(() => setFocusKey(null), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, focusVisible]);
  const jumpTo = (key: string) => {
    clearFilters();
    setFocusKey(key);
  };

  if (q.isLoading) return <PageLoader />;
  if (q.error || !m) return <ErrorState error={q.error ?? new Error('Report not available')} onRetry={() => void q.refetch()} />;

  const can = accessCan(m.myAccess);
  const s = m.summary;
  const radar = s.domainScores.filter((d: any) => d.score !== null).map((d: any) => ({ domain: DOMAIN_SHORT[d.domain as keyof typeof DOMAIN_SHORT], score: d.score }));
  const sevData = (['critical', 'high', 'medium', 'low'] as Severity[]).map((k) => ({ name: k[0].toUpperCase() + k.slice(1), value: s.severityCounts[k], fill: SEVERITY_HEX[k] }));
  const failCounts = new Map<string, { fail: number; warn: number }>();
  for (const f of m.findings as Item[]) {
    const c = failCounts.get(f.systemId) ?? { fail: 0, warn: 0 };
    if (f.status === 'fail') c.fail++;
    else if (f.status === 'warn') c.warn++;
    failCounts.set(f.systemId, c);
  }
  const cmp = m.comparison;
  // Score changes only mean something when both scans were graded on the same systems.
  const comparable = Boolean(cmp && !cmp.differentScope && cmp.previousScore !== null && s.score !== null);
  const delta = comparable ? s.score - cmp.previousScore : null;
  const partial = partialLabel(s);
  const storedSecrets = m.systems.filter((x: any) => x.credentialsStored);
  const tiles: [string, number, string][] = [
    ['Failed', s.counts.fail ?? 0, '#dc2626'],
    ['Warnings', s.counts.warn ?? 0, '#b45309'],
    ['Passed', s.counts.pass ?? 0, '#047857'],
    ['Accepted / not applicable', (s.counts.accepted ?? 0) + (s.counts.false_positive ?? 0), '#4338ca'],
    ['Not assessed', (s.counts.na ?? 0) + (s.counts.error ?? 0), '#475569'],
  ];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['report', scanId] });
    void qc.invalidateQueries({ queryKey: ['customer', m.customer.id] });
  };

  return (
    <>
      <PageHeader
        crumbs={<Link to={`/organisations/${m.customer.id}`} className="hover:text-slate-700">{m.customer.name}</Link>}
        title={REPORT_TITLE}
        subtitle={`${m.scan.name} · ${m.scan.status === 'failed' ? 'failed' : m.scan.status === 'cancelled' ? 'cancelled' : 'completed'} ${fmtDateTime(m.scan.finishedAt)}`}
        actions={
          <div className="no-print flex flex-wrap gap-2">
            {/* The server answers with Content-Disposition: attachment, so these links download instead of navigating. */}
            <AnchorButton href={`/api/scans/${scanId}/report.pdf`} icon={<FileText className="size-4" />}>
              PDF report
            </AnchorButton>
            <AnchorButton href={`/api/scans/${scanId}/report.csv`} variant="secondary" icon={<FileSpreadsheet className="size-4" />}>
              Findings CSV
            </AnchorButton>
            <AnchorButton href={`/api/scans/${scanId}/report.csv?type=controls`} variant="secondary" icon={<Download className="size-4" />}>
              ISO controls CSV
            </AnchorButton>
            <Button variant="ghost" icon={<Printer className="size-4" />} onClick={() => window.print()}>
              Print
            </Button>
            {can.edit && (
              <AsyncButton variant="ghost" icon={<RefreshCw className="size-4" />} onClick={rescan}>
                Rescan
              </AsyncButton>
            )}
          </div>
        }
      />
      {m.scan.status === 'failed' && (
        <Alert tone="error" className="mb-6" title="This scan failed before all checks could run">
          Results are partial: only checks that completed before the failure are included, so the grade and score may not reflect the full scope.
          {!can.edit && ' Ask the owner to rescan.'}
        </Alert>
      )}
      {m.scan.status === 'cancelled' && (
        <Alert tone="warn" className="mb-6">
          This scan was cancelled; results are partial.{!can.edit && ' Ask the owner to rescan.'}
        </Alert>
      )}
      {storedSecrets.length > 0 && (
        <Alert tone="info" className="no-print mb-6" title={<span className="flex items-center gap-2"><KeyRound className="size-4" aria-hidden /> Stored secrets</span>}>
          <p>
            Credentials for this scan are still stored (encrypted) per the retention you chose
            {m.scan.retentionDays ? ` (kept for ${m.scan.retentionDays} ${m.scan.retentionDays === 1 ? 'day' : 'days'})` : ''}. Remember to remove scanner access when it is no longer needed.
          </p>
          <ul className="mt-3 space-y-2">
            {storedSecrets.map((x: any) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <SystemBadge provider={x.provider} label={x.label} identity={x.identity} showIdentity={false} />
                <span className="text-xs">{x.credentialsExpireAt ? `Deleted automatically on ${fmtDateTime(x.credentialsExpireAt)}` : 'Kept until someone deletes it'}</span>
                {can.edit && (
                  <AsyncButton
                    size="sm"
                    variant="secondary"
                    icon={<Trash2 className="size-3.5" />}
                    onClick={async () => {
                      await del(`/api/scans/${scanId}/systems/${x.id}/credentials`);
                      refresh();
                    }}
                    success={`The stored secret for ${x.label} was deleted.`}
                    confirm={{
                      title: 'Delete stored secret?',
                      body: `The encrypted secret for ${x.label} is deleted now. This report stays as it is; a rescan asks for the secret again.`,
                      confirmLabel: 'Delete secret',
                      danger: true,
                    }}
                  >
                    Delete stored secret
                  </AsyncButton>
                )}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <section aria-labelledby="exec-summary" className="mb-6 rounded-2xl bg-white px-6 py-5 shadow-sm ring-1 ring-slate-200/70">
        <h2 id="exec-summary" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <ListChecks className="size-4" aria-hidden /> Executive summary
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-slate-800">{executiveSummarySentences(s).join(' ')}</p>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-col gap-8 p-8 sm:flex-row sm:items-center">
            <div className="flex flex-col items-center">
              {s.grade ? (
                <div
                  role="img"
                  aria-label={`Grade ${s.grade}`}
                  className="flex size-32 items-center justify-center rounded-3xl text-7xl font-bold text-white shadow-lg"
                  style={{ backgroundColor: GRADE_HEX[s.grade] }}
                >
                  <span aria-hidden>{s.grade}</span>
                </div>
              ) : (
                <div className="flex size-32 items-center justify-center rounded-3xl border-2 border-dashed border-slate-400 px-3 text-center text-base font-semibold text-slate-600">
                  Not assessed
                </div>
              )}
              <div className="mt-3 text-center text-sm font-medium text-slate-600">{s.score !== null ? `Score ${s.score}/100` : 'No score: too few checks assessed'}</div>
              {partial && <div className="mt-2 rounded-md bg-amber-50 px-2 py-0.5 text-center text-xs font-medium text-amber-900 ring-1 ring-amber-200">{partial}</div>}
              {delta !== null && (
                <div className={clsx('mt-1 inline-flex items-center gap-1 text-xs font-semibold', delta > 0 ? 'text-emerald-700' : delta < 0 ? 'text-red-700' : 'text-slate-600')}>
                  {delta > 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : delta < 0 ? <ArrowDownRight className="size-3.5" aria-hidden /> : null}
                  {delta > 0 ? '+' : ''}
                  {delta} vs {fmtDate(cmp.previousDate)}
                </div>
              )}
            </div>
            <div className="flex-1">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                {tiles.map(([l, v, c]) => (
                  <div key={l} className="rounded-xl bg-slate-50 p-3">
                    <div className="text-2xl font-semibold" style={{ color: v === 0 ? '#475569' : c }}>{v}</div>
                    <div className="text-xs text-slate-600">{l}</div>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                {m.systems.map((x: any) => (
                  <span key={x.id} className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5">
                    <SystemBadge provider={x.provider} label={x.label} showIdentity={false} size="xs" />
                  </span>
                ))}
              </div>
              {cmp && (
                <p className="mt-3 text-sm text-slate-500">
                  Since the previous scan: <strong className={countCls(cmp.resolved.length, 'text-emerald-700')}>{cmp.resolved.length} resolved</strong>,{' '}
                  <strong className={countCls(cmp.newFindings.length, 'text-red-700')}>{cmp.newFindings.length} new</strong>, {cmp.persisting.length} persisting.{' '}
                  <span className="text-xs">
                    {cmp.differentScope
                      ? `Compared with ${fmtDate(cmp.previousDate)}, shared systems only (different scope).`
                      : `Compared with ${fmtDate(cmp.previousDate)}.`}
                  </span>
                </p>
              )}
            </div>
          </div>
        </Card>
        <Card title="Findings by severity">
          <div
            className="h-44"
            role="img"
            aria-label={`Findings by severity: ${sevData.map((d) => `${d.value} ${d.name.toLowerCase()}`).join(', ')}.`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sevData} layout="vertical" margin={{ left: 0, right: 24 }}>
                <XAxis type="number" hide allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: '#475569' }} axisLine={false} tickLine={false} width={64} />
                <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={18} label={{ position: 'right', fontSize: 12, fill: '#0f172a' }}>
                  {sevData.map((d) => (
                    <Cell key={d.name} fill={d.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {m.systems.length > 0 && <SystemCards systems={m.systems} fallbackCounts={failCounts} selected={system} onSelect={setSystem} />}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <IsoSection
          className="lg:col-span-2"
          controls={s.controls}
          notCovered={s.notCovered}
          systems={m.systems}
          selected={control}
          onSelect={setControl}
          onSystem={(id) => setSystem(id)}
        />
        <Card title="Score by domain">
          <div className="h-72" role="img" aria-label="Radar chart of the score per domain. The list that follows gives each score.">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radar} outerRadius="66%" margin={{ left: 44, right: 44 }}>
                <PolarGrid stroke="#e2e8f0" />
                <PolarAngleAxis dataKey="domain" tick={{ fontSize: 11, fill: '#475569' }} />
                <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                <Radar dataKey="score" stroke="#4f46e5" fill="#6366f1" fillOpacity={0.25} strokeWidth={2} />
                <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          {/* Text alternative for the radar: read by screen readers and printed under the chart. */}
          <ul className="sr-only print:not-sr-only print:mt-3 print:space-y-0.5 print:text-xs print:text-slate-700">
            {s.domainScores.map((d: any) => (
              <li key={d.domain}>
                {DOMAIN_LABELS[d.domain as keyof typeof DOMAIN_LABELS] ?? d.domain}: {d.score !== null ? `${d.score}/100` : 'not assessed'}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><Target className="size-4 text-red-600" /> Top risks</span>}>
          {m.topRisks.length === 0 ? (
            <p className="text-sm text-slate-500">No open findings.</p>
          ) : (
            <ol className="space-y-2.5">
              {m.topRisks.map((f: Item, i: number) => (
                <li key={f.key} className="flex items-center gap-3 text-sm">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{i + 1}</span>
                  <a
                    href={`#${findingId(f.key)}`}
                    onClick={(e) => {
                      e.preventDefault();
                      jumpTo(f.key);
                    }}
                    className="min-w-0 flex-1 truncate text-slate-800 hover:text-brand-700 hover:underline"
                  >
                    {f.title}
                  </a>
                  <span className="hidden sm:inline-flex">
                    <SystemBadge provider={f.provider} label={f.systemLabel} showIdentity={false} size="xs" className="max-w-[10rem]" />
                  </span>
                  <span className="sm:hidden">
                    <ProviderIcon provider={f.provider} className="size-4" />
                    <span className="sr-only">{f.systemLabel}</span>
                  </span>
                  <span className="shrink-0">
                    <SeverityBadge severity={f.severity} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-amber-500" /> Quick wins</span>} subtitle="Low effort, meaningful risk reduction.">
          {m.quickWins.length === 0 ? (
            <p className="text-sm text-slate-500">No low-effort items open.</p>
          ) : (
            <ul className="space-y-3">
              {m.quickWins.map((f: Item) => (
                <li key={f.key} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">{f.title}</span>
                    <SeverityBadge severity={f.severity} />
                    <SystemBadge provider={f.provider} label={f.systemLabel} showIdentity={false} size="xs" />
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{f.remediation}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section className="mt-10">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Findings</h2>
            <p className="text-sm text-slate-500" role="status" aria-live="polite">
              {findings.length} of {m.findings.length} shown{control && <> for A.{control} {ISO_BY_ID[control]?.title}</>}
              {system !== 'all' && systems.get(system) && <> on {systems.get(system).label}</>}
            </p>
          </div>
          <div className="no-print flex flex-wrap gap-2">
            <Input type="search" placeholder="Search" aria-label="Search findings" className="w-48" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={sev} onChange={(e) => setSev(e.target.value)} className="w-40" aria-label="Filter by severity">
              <option value="all">All severities</option>
              {['critical', 'high', 'medium', 'low', 'info'].map((x) => (
                <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)}</option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36" aria-label="Filter by result">
              <option value="all">All results</option>
              <option value="fail">Fail</option>
              <option value="warn">Warning</option>
            </Select>
            <Select value={triage} onChange={(e) => setTriage(e.target.value)} className="w-60" aria-label="Filter by triage">
              <option value="all">All triage states</option>
              {Object.entries(TRIAGE_LABEL).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </Select>
            <Select value={system} onChange={(e) => setSystem(e.target.value)} className="w-56" aria-label="Filter by system">
              <option value="all">All systems</option>
              {m.systems.map((x: any) => (
                <option key={x.id} value={x.id}>
                  {x.identity ? `${x.label} (${x.identity})` : x.label}
                </option>
              ))}
            </Select>
            <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as FindingSort)} className="w-44" aria-label="Sort findings">
              {FINDING_SORTS.map(([k, l]) => (
                <option key={k} value={k}>
                  Sort by {l.toLowerCase()}
                </option>
              ))}
            </Select>
            {control && <Button variant="ghost" onClick={() => setControl(null)}>Clear A.{control}</Button>}
            {filtered && (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-2">
          {paged.visible.map((f: Item) => (
            <FindingCard
              key={f.key}
              f={f}
              identity={identityOf(f, systems)}
              customerId={m.customer.id}
              canWrite={can.edit}
              onTriaged={refresh}
              focused={focusKey === f.key}
              showNew={comparable}
            />
          ))}
          {paged.showPager && <Pager {...paged.pagerProps} label="findings" className="pt-2" />}
          {findings.length === 0 && (
            <div className="rounded-xl bg-white ring-1 ring-slate-200">
              {m.findings.length === 0 ? (
                <EmptyState icon={<ShieldCheck className="size-6" />} title="No findings">
                  Every assessed check met the baseline.
                </EmptyState>
              ) : (
                <EmptyState
                  icon={<SearchX className="size-6" />}
                  title="No findings match these filters"
                  action={
                    <Button variant="secondary" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                >
                  Try another severity, result, triage state or system, or clear the filters to see all {m.findings.length} findings.
                </EmptyState>
              )}
            </div>
          )}
        </div>
      </section>

      <div className="mt-10 space-y-6">
        <Card
          title={`Passed checks (${m.passed.length})`}
          actions={
            <Button variant="ghost" size="sm" aria-expanded={showPassed} onClick={() => setShowPassed(!showPassed)}>
              {showPassed ? 'Hide' : 'Show'}
            </Button>
          }
        >
          {showPassed ? (
            <div className="-m-6">
              <DataTable
                storageKey="report-passed"
                label="passed checks"
                caption="Passed checks"
                minWidth="40rem"
                rows={m.passed as Item[]}
                rowKey={(p) => p.key}
                hidePagerWhenSmall
                columns={[
                  {
                    key: 'title',
                    header: 'Check',
                    sort: (p) => p.title,
                    render: (p) => (
                      <span className="flex items-center gap-2 text-slate-700">
                        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                        {p.title}
                      </span>
                    ),
                  },
                  {
                    key: 'system',
                    header: 'System',
                    sort: (p) => p.systemLabel,
                    render: (p) => <SystemBadge provider={p.provider} label={p.systemLabel} identity={identityOf(p, systems)} size="xs" />,
                  },
                  { key: 'severity', header: 'Severity', sort: (p) => SEV_ORDER[p.severity] ?? 9, render: (p) => <SeverityBadge severity={p.severity} /> },
                  { key: 'control', header: 'Control', sort: (p) => p.iso[0], render: (p) => <span className="font-mono text-[11px] text-slate-500">A.{p.iso[0]}</span> },
                ]}
              />
            </div>
          ) : (
            <p className="text-sm text-slate-500">{m.passed.length} checks met the baseline.</p>
          )}
        </Card>
        <Card title={m.excluded.length ? `Not assessed (${m.notAssessed.length}) and excluded (${m.excluded.length})` : `Not assessed (${m.notAssessed.length})`}>
          {m.notAssessed.length > 0 && (
            <div className="-mx-6 -mt-6 mb-4">
              <DataTable
                storageKey="report-not-assessed"
                label="checks not assessed"
                caption="Checks not assessed"
                minWidth="40rem"
                rows={m.notAssessed as Item[]}
                rowKey={(p) => p.key}
                hidePagerWhenSmall
                columns={[
                  { key: 'status', header: 'Result', sort: (p) => p.status, render: (p) => <StatusBadge status={p.status} /> },
                  {
                    key: 'title',
                    header: 'Check',
                    sort: (p) => p.title,
                    render: (p) => (
                      <>
                        <div className="text-slate-700">{p.title}</div>
                        <p className="mt-0.5 text-xs text-slate-500">{p.summary}</p>
                      </>
                    ),
                  },
                  {
                    key: 'system',
                    header: 'System',
                    sort: (p) => p.systemLabel,
                    render: (p) => <SystemBadge provider={p.provider} label={p.systemLabel} identity={identityOf(p, systems)} size="xs" />,
                  },
                ]}
              />
            </div>
          )}
          <ul className="space-y-2 text-sm">
            {m.excluded.map((e: any) => (
              <li key={e.checkId} className="flex flex-wrap items-center gap-2 text-slate-600">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase">Excluded</span>
                <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                  <ProviderIcon provider={e.provider} className="size-3.5" decorative />
                  {e.providerLabel ?? PROVIDER_LABELS[e.provider as keyof typeof PROVIDER_LABELS]}
                </span>
                <span className="text-slate-700">{e.title}</span>
                {e.reason && <span className="text-xs">: {e.reason}</span>}
              </li>
            ))}
            {m.notAssessed.length + m.excluded.length === 0 && <li className="text-slate-500">Everything in scope was assessed.</li>}
          </ul>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Scope">
          <ul className="space-y-3 text-sm">
            {m.systems.map((x: any) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <SystemBadge provider={x.provider} label={x.label} identity={x.identity} size="md" />
                <span className="text-xs text-slate-500">{x.providerLabel ?? PROVIDER_LABELS[x.provider as keyof typeof PROVIDER_LABELS]}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Method and limitations">
          <p className="text-sm leading-relaxed text-slate-600">
            Automated, read-only configuration review via official cloud APIs between {fmtDateTime(m.scan.startedAt)} and {fmtDateTime(m.scan.finishedAt)}. Results map to ISO/IEC 27001:2022 Annex A
            controls as technical evidence only; organisational aspects (policies, procedures, awareness) are not covered. No penetration testing was performed.
          </p>
        </Card>
      </div>
    </>
  );
}
