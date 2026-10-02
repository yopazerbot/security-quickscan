import { DOMAIN_LABELS, DOMAIN_SHORT, ISO_BY_ID, ISO_CONTROLS, PROVIDER_LABELS, VERDICT_LABELS, type ControlVerdict, type Severity } from '@qs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, ChevronDown, Download, ExternalLink, FileSpreadsheet, FileText, ListChecks, Printer, RefreshCw, SearchX, ShieldCheck, Sparkles, Target } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Bar, BarChart, Cell, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { RISK_STYLE } from '../components/ContextForm';
import { AsyncButton, useToast } from '../components/feedback';
import { ProviderIcon } from '../components/ProviderIcon';
import { Alert, AnchorButton, Button, Card, EmptyState, ErrorState, Input, PageHeader, PageLoader, Select, SeverityBadge, StatusBadge, Textarea } from '../components/ui';
import { get, post, put } from '../lib/api';
import { accessCan } from '../lib/auth';
import { fmtDate, fmtDateTime, GRADE_HEX, SEVERITY_HEX, VERDICT_STYLE } from '../lib/format';

type Item = any;

const TRIAGE_LABEL: Record<string, string> = { open: 'Open', accepted: 'Risk accepted', false_positive: 'False positive' };

/** DOM id of a finding card, so other parts of the report can link to it. */
const findingId = (key: string) => `finding-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/** Counts of zero are neutral: "0 new" is neither good nor bad news. */
const countCls = (n: number, tone: string) => (n === 0 ? 'text-slate-600' : tone);

/** One or two plain-language sentences for the top of the report, built from the summary data. */
function executiveSummary(m: any): string {
  const s = m.summary;
  const parts = [`Overall grade ${s.grade} (${s.score}/100).`];
  const fail = s.counts.fail ?? 0;
  const warn = s.counts.warn ?? 0;
  const crit = s.severityCounts.critical ?? 0;
  const high = s.severityCounts.high ?? 0;
  const checks = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (fail + warn === 0) parts.push('No failed checks or warnings.');
  else {
    const sev = [crit && `${crit} critical`, high && `${high} high`].filter(Boolean).join(' and ');
    parts.push(`${checks(fail, 'failed check', 'failed checks')} and ${checks(warn, 'warning', 'warnings')}${sev ? `, of which ${sev} severity` : ''}.`);
  }
  const gaps = s.domainScores
    .filter((d: any) => d.score !== null && d.score < 75)
    .sort((a: any, b: any) => a.score - b.score)
    .slice(0, 2)
    .map((d: any) => DOMAIN_LABELS[d.domain as keyof typeof DOMAIN_LABELS] ?? d.domain);
  if (gaps.length) parts.push(`Biggest gaps: ${gaps.join(', ')}.`);
  const accepted = s.counts.accepted ?? 0;
  if (accepted) parts.push(`${checks(accepted, 'finding is', 'findings are')} risk accepted.`);
  return parts.join(' ');
}

function ControlHeatmap({ controls, selected, onSelect }: { controls: any[]; selected: string | null; onSelect(id: string | null): void }) {
  const byId = new Map(controls.map((c) => [c.id, c]));
  const themes = [
    { key: 'organizational', label: 'A.5 Organizational' },
    { key: 'people', label: 'A.6 People' },
    { key: 'technological', label: 'A.8 Technological' },
  ];
  return (
    <div className="space-y-4">
      {themes.map((t) => {
        const list = ISO_CONTROLS.filter((c) => c.theme === t.key && byId.has(c.id));
        if (!list.length) return null;
        return (
          <div key={t.key}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
              {list.map((c) => {
                const a = byId.get(c.id);
                const v = a.verdict as ControlVerdict;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={selected === c.id}
                    onClick={() => onSelect(selected === c.id ? null : c.id)}
                    title={`A.${c.id} ${c.title}\n${VERDICT_LABELS[v]}${a.score !== null ? ` (${a.score}%)` : ''}`}
                    className={clsx(
                      'rounded-lg px-2 py-2 text-left transition hover:scale-[1.03]',
                      VERDICT_STYLE[v].cls,
                      selected === c.id && 'ring-2 ring-slate-900 ring-offset-2',
                      selected && selected !== c.id && 'opacity-40',
                    )}
                  >
                    <div className="font-mono text-sm font-semibold">A.{c.id}</div>
                    <div className="truncate text-[10px] opacity-90">{c.title}</div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-3 pt-1 text-xs text-slate-500">
        {(Object.keys(VERDICT_LABELS) as ControlVerdict[]).map((v) => (
          <span key={v} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: VERDICT_STYLE[v].hex }} />
            {VERDICT_LABELS[v]}
          </span>
        ))}
      </div>
    </div>
  );
}

function Triage({ customerId, item, onSaved }: { customerId: string; item: Item; onSaved(): void }) {
  const [status, setStatus] = useState(item.triage?.status ?? 'open');
  const [note, setNote] = useState(item.triage?.note ?? '');
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => put(`/api/customers/${customerId}/triage/${item.checkId}`, { status, note }),
    onSuccess: () => {
      toast.success('Saved');
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save the triage.'),
  });
  return (
    <div className="rounded-xl bg-slate-50 p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Triage (applies to future scans of this organisation)</div>
      <div className="flex flex-wrap items-start gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Triage status">
          <option value="open">Open</option>
          <option value="accepted">Risk accepted</option>
          <option value="false_positive">False positive</option>
        </Select>
        <Textarea className="min-h-9 min-w-48 flex-1 py-1.5" rows={1} placeholder="Note (shown in the report)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} />
        <Button variant="secondary" onClick={() => m.mutate()} loading={m.isPending}>
          Save
        </Button>
      </div>
    </div>
  );
}

function FindingDetail({ f, customerId, canWrite, interactive, onTriaged }: { f: Item; customerId: string; canWrite: boolean; interactive: boolean; onTriaged(): void }) {
  return (
    <>
      <p className="text-sm text-slate-600">{f.description}</p>
      <div className="grid gap-5 lg:grid-cols-2 print:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Affected resources ({f.resources.length})</h4>
          {f.resources.length === 0 ? (
            <p className="text-sm text-slate-400">Tenant or account level setting.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-lg ring-1 ring-slate-200 print:max-h-none print:overflow-visible">
              <table className="w-full text-left text-xs">
                <tbody className="divide-y divide-slate-100">
                  {f.resources.map((r: any) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 font-medium text-slate-800">{r.name ?? r.id}</td>
                      <td className="px-3 py-2 text-slate-500">{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
                  Reference <ExternalLink className="size-3" />
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

function FindingCard({ f, customerId, canWrite, onTriaged, focused }: { f: Item; customerId: string; canWrite: boolean; onTriaged(): void; focused: boolean }) {
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
      <button type="button" aria-expanded={open} aria-controls={bodyId} className="flex w-full items-start gap-4 px-5 py-4 text-left md:items-center" onClick={() => setOpen(!open)}>
        <span className="h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: SEVERITY_HEX[f.severity as Severity] }} />
        <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">{f.title}</span>
              {f.isNew && <span className="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">New</span>}
              {f.triage && f.triage.status !== 'open' && (
                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">{TRIAGE_LABEL[f.triage.status]}</span>
              )}
            </div>
            <div className="mt-0.5 line-clamp-2 text-sm text-slate-500 md:truncate">{f.summary}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:justify-end">
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <ProviderIcon provider={f.provider} className="size-4" />
              {f.systemLabel}
            </span>
            <span className="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-[11px] text-brand-700">A.{f.iso[0]}</span>
            <SeverityBadge severity={f.severity} />
            <StatusBadge status={f.status} />
          </div>
        </div>
        <ChevronDown className={clsx('no-print mt-1 size-4 shrink-0 text-slate-400 transition md:mt-0', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <div id={bodyId} className="animate-fade-in space-y-5 border-t border-slate-100 px-5 py-5">
          <FindingDetail f={f} customerId={customerId} canWrite={canWrite} interactive onTriaged={onTriaged} />
        </div>
      ) : (
        // Collapsed on screen, but always fully expanded on paper.
        <div className="print-only space-y-5 border-t border-slate-100 px-5 py-5">
          <FindingDetail f={f} customerId={customerId} canWrite={canWrite} interactive={false} onTriaged={onTriaged} />
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
  const [platform, setPlatform] = useState<string>('all');
  const [control, setControl] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [triage, setTriage] = useState<string>('all');
  const [showPassed, setShowPassed] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const rescan = async () => {
    const r = await post<{ id: string }>(`/api/scans/${scanId}/rescan`);
    nav(`/scans/${r.id}/wizard`);
  };

  const m = q.data;
  const findings = useMemo(() => {
    if (!m) return [];
    return m.findings.filter(
      (f: Item) =>
        (sev === 'all' || f.severity === sev) &&
        (platform === 'all' || f.provider === platform) &&
        (!control || f.iso.includes(control)) &&
        (status === 'all' || f.status === status) &&
        (triage === 'all' || (f.triage?.status ?? 'open') === triage) &&
        (!search || `${f.title} ${f.summary}`.toLowerCase().includes(search.toLowerCase())),
    );
  }, [m, sev, platform, control, status, triage, search]);
  const filtered = sev !== 'all' || platform !== 'all' || control !== null || status !== 'all' || triage !== 'all' || search !== '';
  const clearFilters = () => {
    setSev('all');
    setPlatform('all');
    setControl(null);
    setStatus('all');
    setTriage('all');
    setSearch('');
  };

  // Jump to a finding from the top risks list: filters are cleared first so the target is rendered.
  useEffect(() => {
    if (!focusKey) return;
    document.getElementById(findingId(focusKey))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const t = setTimeout(() => setFocusKey(null), 2500);
    return () => clearTimeout(t);
  }, [focusKey]);
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
  const verdicts = s.controls.reduce((a: Record<string, number>, c: any) => ({ ...a, [c.verdict]: (a[c.verdict] ?? 0) + 1 }), {});
  const delta = m.comparison && m.comparison.previousScore !== null ? s.score - m.comparison.previousScore : null;
  const risk = RISK_STYLE[m.riskProfile.level as keyof typeof RISK_STYLE];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['report', scanId] });
    void qc.invalidateQueries({ queryKey: ['customer', m.customer.id] });
  };

  return (
    <>
      <PageHeader
        crumbs={<Link to={`/organisations/${m.customer.id}`} className="hover:text-slate-700">{m.customer.name}</Link>}
        title="Security quick scan report"
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
        </Alert>
      )}
      {m.scan.status === 'cancelled' && <Alert tone="warn" className="mb-6">This scan was cancelled; results are partial.</Alert>}
      {m.systems.some((x: any) => x.credentialsStored) && (
        <Alert tone="info" className="no-print mb-6">
          Credentials for this scan are still stored (encrypted) per the retention you chose. Remember to remove scanner access when it is no longer needed.
        </Alert>
      )}

      <section aria-labelledby="exec-summary" className="mb-6 rounded-2xl bg-white px-6 py-5 shadow-sm ring-1 ring-slate-200/70">
        <h2 id="exec-summary" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <ListChecks className="size-4" aria-hidden /> Executive summary
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-slate-800">{executiveSummary(m)}</p>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-col gap-8 p-8 sm:flex-row sm:items-center">
            <div className="flex flex-col items-center">
              <div className="flex size-32 items-center justify-center rounded-3xl text-7xl font-bold text-white shadow-lg" style={{ backgroundColor: GRADE_HEX[s.grade] }}>
                {s.grade}
              </div>
              <div className="mt-3 text-sm font-medium text-slate-600">Score {s.score}/100</div>
              {delta !== null && (
                <div className={clsx('mt-1 inline-flex items-center gap-1 text-xs font-semibold', delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-600' : 'text-slate-500')}>
                  {delta > 0 ? <ArrowUpRight className="size-3.5" /> : delta < 0 ? <ArrowDownRight className="size-3.5" /> : null}
                  {delta > 0 ? '+' : ''}
                  {delta} vs {fmtDate(m.comparison.previousDate)}
                </div>
              )}
            </div>
            <div className="flex-1">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Failed', s.counts.fail, '#dc2626'],
                  ['Warnings', s.counts.warn, '#d97706'],
                  ['Passed', s.counts.pass, '#059669'],
                  ['Not assessed', s.counts.na + s.counts.error, '#94a3b8'],
                ].map(([l, v, c]) => (
                  <div key={l as string} className="rounded-xl bg-slate-50 p-3">
                    <div className="text-2xl font-semibold" style={{ color: (v as number) === 0 ? '#475569' : (c as string) }}>{v as number}</div>
                    <div className="text-xs text-slate-500">{l}</div>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span className={clsx('rounded-md px-2 py-0.5 text-xs font-semibold ring-1', risk.cls)}>{risk.label} risk profile</span>
                <span className="text-slate-300">|</span>
                {m.systems.map((x: any) => (
                  <span key={x.id} className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-0.5 text-xs">
                    <ProviderIcon provider={x.provider} className="size-3.5" />
                    {x.label}
                  </span>
                ))}
              </div>
              {m.comparison && (
                <p className="mt-3 text-sm text-slate-500">
                  Since the previous scan: <strong className={countCls(m.comparison.resolved.length, 'text-emerald-700')}>{m.comparison.resolved.length} resolved</strong>,{' '}
                  <strong className={countCls(m.comparison.newFindings.length, 'text-red-700')}>{m.comparison.newFindings.length} new</strong>,{' '}
                  {m.comparison.persisting.length} persisting.
                </p>
              )}
            </div>
          </div>
        </Card>
        <Card title="Findings by severity">
          <div className="h-44">
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

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="ISO/IEC 27001:2022 Annex A"
          subtitle={
            <>
              {s.controls.length} controls evidenced: {verdicts.effective ?? 0} effective, {verdicts.partial ?? 0} partial, {verdicts.not_effective ?? 0} not effective.{' '}
              <span className="no-print">Click a control to filter findings.</span>
            </>
          }
        >
          <ControlHeatmap controls={s.controls} selected={control} onSelect={setControl} />
        </Card>
        <Card title="Score by domain">
          <div className="h-72">
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
                  <span className="hidden text-xs text-slate-400 sm:inline">{f.systemLabel}</span>
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
            <p className="text-sm text-slate-500">
              {findings.length} of {m.findings.length} shown{control && <> for A.{control} {ISO_BY_ID[control]?.title}</>}
            </p>
          </div>
          <div className="no-print flex flex-wrap gap-2">
            <Input type="search" placeholder="Search" aria-label="Search findings" className="w-48" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={sev} onChange={(e) => setSev(e.target.value)} className="w-36" aria-label="Filter by severity">
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
            <Select value={triage} onChange={(e) => setTriage(e.target.value)} className="w-44" aria-label="Filter by triage">
              <option value="all">All triage states</option>
              {Object.entries(TRIAGE_LABEL).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </Select>
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-44" aria-label="Filter by platform">
              <option value="all">All platforms</option>
              {[...new Set(m.systems.map((x: any) => x.provider))].map((p: any) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p as keyof typeof PROVIDER_LABELS]}</option>
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
          {findings.map((f: Item) => (
            <FindingCard key={f.key} f={f} customerId={m.customer.id} canWrite={can.edit} onTriaged={refresh} focused={focusKey === f.key} />
          ))}
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
                  Try another severity, result or triage state, or clear the filters to see all {m.findings.length} findings.
                </EmptyState>
              )}
            </div>
          )}
        </div>
      </section>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <Card title={`Passed checks (${m.passed.length})`} actions={<Button variant="ghost" size="sm" onClick={() => setShowPassed(!showPassed)}>{showPassed ? 'Hide' : 'Show'}</Button>}>
          {showPassed ? (
            <ul className="space-y-1.5 text-sm">
              {m.passed.map((p: Item) => (
                <li key={p.key} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  <span className="flex-1 text-slate-700">{p.title}</span>
                  <span className="font-mono text-[11px] text-slate-400">A.{p.iso[0]}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">{m.passed.length} checks met the baseline.</p>
          )}
        </Card>
        <Card title={`Not assessed (${m.notAssessed.length}) and excluded (${m.excluded.length})`}>
          <ul className="space-y-2 text-sm">
            {m.notAssessed.map((p: Item) => (
              <li key={p.key}>
                <div className="flex items-center gap-2">
                  <StatusBadge status={p.status} />
                  <span className="text-slate-700">{p.title}</span>
                </div>
                <p className="ml-1 mt-0.5 text-xs text-slate-500">{p.summary}</p>
              </li>
            ))}
            {m.excluded.map((e: any) => (
              <li key={e.checkId} className="text-slate-500">
                <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase">Excluded</span>
                {e.title}
                {e.reason && <span className="text-xs">: {e.reason}</span>}
              </li>
            ))}
            {m.notAssessed.length + m.excluded.length === 0 && <li className="text-slate-500">Everything in scope was assessed.</li>}
          </ul>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Scope">
          <dl className="space-y-2 text-sm">
            {m.systems.map((x: any) => (
              <div key={x.id} className="flex justify-between gap-4">
                <dt className="text-slate-500">{x.label}</dt>
                <dd className="text-right font-medium text-slate-800">{x.identity ?? PROVIDER_LABELS[x.provider as keyof typeof PROVIDER_LABELS]}</dd>
              </div>
            ))}
          </dl>
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
