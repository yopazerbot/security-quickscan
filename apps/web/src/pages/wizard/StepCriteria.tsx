import { CHECKS_BY_ID, DOMAIN_LABELS, ISO_BY_ID, PROVIDER_LABELS, PROVIDER_SHORT, isoSort, type Provider } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { RotateCcw, Search, SearchX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { RISK_STYLE } from '../../components/ContextForm';
import { ProviderIcon } from '../../components/ProviderIcon';
import { AsyncButton } from '../../components/feedback';
import { Button, Card, EmptyState, ErrorState, Input, PageLoader, SeverityBadge, Toggle } from '../../components/ui';
import { get, put } from '../../lib/api';
import { WizardFooter, useStepSave, type StepProps } from './ScanWizard';

interface Crit {
  checkId: string;
  included: boolean;
  reason: string;
  defaultIncluded: boolean;
}

export function StepCriteria({ scan, next, back, saveRef, navigating }: StepProps) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['criteria', scan.id], queryFn: () => get<Crit[]>(`/api/scans/${scan.id}/criteria`) });
  const [items, setItems] = useState<Crit[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Provider | 'all'>('all');
  const [view, setView] = useState<'provider' | 'iso'>('provider');

  useEffect(() => {
    if (q.data) setItems(q.data);
  }, [q.data]);

  const providers = useMemo(() => [...new Set(items.map((i) => CHECKS_BY_ID[i.checkId].provider))], [items]);
  const filtered = items.filter((i) => {
    const m = CHECKS_BY_ID[i.checkId];
    if (tab !== 'all' && m.provider !== tab) return false;
    const s = search.toLowerCase();
    return !s || m.title.toLowerCase().includes(s) || m.frameworks.iso27001.some((c) => `a.${c}`.includes(s.replace(/^a\./, 'a.')) || c.includes(s));
  });
  const included = items.filter((i) => i.included);
  const controls = new Set(included.flatMap((i) => CHECKS_BY_ID[i.checkId].frameworks.iso27001));
  const update = (id: string, patch: Partial<Crit>) => setItems((xs) => xs.map((x) => (x.checkId === id ? { ...x, ...patch } : x)));

  const groups = useMemo(() => {
    const map = new Map<string, Crit[]>();
    for (const i of filtered) {
      const m = CHECKS_BY_ID[i.checkId];
      const key = view === 'provider' ? m.provider : m.frameworks.iso27001[0];
      map.set(key, [...(map.get(key) ?? []), i]);
    }
    const keys = [...map.keys()].sort(view === 'iso' ? isoSort : undefined);
    return keys.map((k) => ({ key: k, rows: map.get(k)! }));
  }, [filtered, view]);

  // Saved by the wizard before it leaves this step; errors become a toast and keep the user here.
  useStepSave(saveRef, async () => {
    if (!q.data || JSON.stringify(items) === JSON.stringify(q.data)) return;
    await put(`/api/scans/${scan.id}/criteria`, { items: items.map(({ checkId, included, reason }) => ({ checkId, included, reason })) });
    qc.setQueryData(['criteria', scan.id], items);
  });

  if (q.isError && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PageLoader />;
  const risk = RISK_STYLE[scan.riskProfile.level as keyof typeof RISK_STYLE];

  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Criteria in scope</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">
            {included.length}
            <span className="text-lg font-normal text-slate-400"> / {items.length}</span>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">ISO 27001 Annex A controls covered</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{controls.size}</div>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Defaults based on risk profile</div>
          <div className="mt-2">
            <span className={clsx('rounded-lg px-2.5 py-1 text-sm font-semibold ring-1', risk.cls)}>{risk.label}</span>
          </div>
          <Link to={`/customers/${scan.customer.id}/edit`} className="mt-3 inline-block text-xs font-medium text-brand-700 hover:underline">
            From the customer context. Edit customer
          </Link>
        </div>
      </div>

      <Card
        title="Evaluation criteria"
        subtitle="Every check maps to an ISO/IEC 27001:2022 Annex A control. Exclude checks that are out of scope and record why; exclusions are listed in the report."
        actions={
          <AsyncButton
            variant="ghost"
            size="sm"
            icon={<RotateCcw className="size-3.5" />}
            onClick={() => setItems((xs) => xs.map((x) => ({ ...x, included: x.defaultIncluded, reason: '' })))}
            confirm={{
              title: 'Reset to defaults',
              body: 'Every check goes back to the default for this risk profile and all exclusion reasons are cleared. The change is saved when you continue.',
              confirmLabel: 'Reset',
            }}
          >
            Reset to defaults
          </AsyncButton>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-400" aria-hidden />
            <Input type="search" aria-label="Search criteria" placeholder="Search title or control (e.g. 8.5)" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div role="group" aria-label="Filter by platform" className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
            {(['all', ...providers] as const).map((p) => (
              <button key={p} type="button" aria-pressed={tab === p} onClick={() => setTab(p)} className={clsx('flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium', tab === p ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>
                {p !== 'all' && <ProviderIcon provider={p} className="size-3.5" />}
                {p === 'all' ? 'All' : PROVIDER_SHORT[p]}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Group by" className="ml-auto flex rounded-lg bg-slate-100 p-0.5 text-sm">
            {(['provider', 'iso'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={clsx('rounded-md px-3 py-1.5 font-medium', view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>
                {v === 'provider' ? 'By platform' : 'By ISO control'}
              </button>
            ))}
          </div>
        </div>

        <div className="-mx-6 -mb-6">
          {!filtered.length && (
            <EmptyState
              icon={<SearchX className="size-6" />}
              title="No criteria match"
              action={
                <Button variant="secondary" size="sm" onClick={() => { setSearch(''); setTab('all'); }}>
                  Clear filters
                </Button>
              }
            >
              Nothing matches {search ? <>&ldquo;{search}&rdquo;</> : 'this filter'}. Try another title or control number.
            </EmptyState>
          )}
          {groups.map((g) => (
            <div key={g.key}>
              <div className="flex items-center gap-2 border-y border-slate-100 bg-slate-50 px-6 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {view === 'provider' ? (
                  <>
                    <ProviderIcon provider={g.key as Provider} className="size-4" />
                    {PROVIDER_LABELS[g.key as Provider]}
                  </>
                ) : (
                  <>A.{g.key} {ISO_BY_ID[g.key]?.title}</>
                )}
                <span className="ml-auto font-medium normal-case tracking-normal">
                  {g.rows.filter((r) => r.included).length}/{g.rows.length} included
                </span>
              </div>
              <ul className="divide-y divide-slate-100">
                {g.rows.map((i) => {
                  const m = CHECKS_BY_ID[i.checkId];
                  return (
                    <li key={i.checkId} className={clsx('px-6 py-3 transition', !i.included && 'bg-slate-50/60')}>
                      <div className="flex items-start gap-4">
                        <div className="pt-0.5">
                          <Toggle checked={i.included} onChange={(v) => update(i.checkId, { included: v })} label={m.title} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={clsx('text-sm font-medium', i.included ? 'text-slate-900' : 'text-slate-500')}>{m.title}</span>
                            <SeverityBadge severity={m.severity} />
                            {!i.defaultIncluded && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-600">optional for this profile</span>}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500">{m.description}</p>
                          {!i.included && (
                            <Input className="mt-2 max-w-lg py-1.5 text-xs" aria-label={`Reason for excluding ${m.title}`} placeholder="Reason for exclusion (shown in the report)" value={i.reason} maxLength={1000} onChange={(e) => update(i.checkId, { reason: e.target.value })} />
                          )}
                        </div>
                        <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
                          <div className="flex flex-wrap justify-end gap-1">
                            {m.frameworks.iso27001.map((c, idx) => (
                              <span key={c} title={ISO_BY_ID[c]?.title} className={clsx('rounded px-1.5 py-0.5 font-mono text-[11px]', idx === 0 ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700')}>
                                A.{c}
                              </span>
                            ))}
                          </div>
                          <span className="text-[11px] text-slate-400">{DOMAIN_LABELS[m.domain]}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </Card>
      <WizardFooter
        onBack={back}
        onNext={next}
        loading={navigating}
        disabled={!included.length}
        nextLabel="Save and continue"
        extra={!included.length && <span className="text-xs text-slate-500">Include at least one check.</span>}
      />
    </>
  );
}
