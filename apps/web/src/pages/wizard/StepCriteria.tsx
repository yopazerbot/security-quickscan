import { CHECKS_BY_ID, DOMAIN_LABELS, ISO_BY_ID, PROVIDER_LABELS, PROVIDER_SHORT, isoSort, type Provider } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { RotateCcw, Search, SearchX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { RISK_STYLE } from '../../components/ContextForm';
import { ProviderIcon } from '../../components/ProviderIcon';
import { AsyncButton, useAction } from '../../components/feedback';
import { Alert, Button, Card, EmptyState, ErrorState, Input, PageLoader, SeverityBadge, Toggle } from '../../components/ui';
import { get, put } from '../../lib/api';
import { WizardFooter, useStepSave, type StepProps } from './ScanWizard';

interface Crit {
  checkId: string;
  included: boolean;
  reason: string;
  defaultIncluded: boolean;
}

/** A row the scan has to store: it differs from the risk-profile default (or carries an exclusion reason). */
const isOverride = (i: Crit) => i.included !== i.defaultIncluded || (!i.included && i.reason.trim() !== '');

/**
 * The default-included checks seen the last time this browser loaded or saved the criteria of a scan. Lets the
 * step notice that the organisation's risk profile (and so the defaults) changed in the meantime.
 */
const defaultsKey = (scanId: string) => `qs_criteria_defaults:${scanId}`;
function readDefaults(scanId: string): string[] | null {
  try {
    const raw = localStorage.getItem(defaultsKey(scanId));
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}
function writeDefaults(scanId: string, rows: Crit[]) {
  try {
    localStorage.setItem(defaultsKey(scanId), JSON.stringify(rows.filter((r) => r.defaultIncluded).map((r) => r.checkId)));
  } catch {
    /* storage unavailable */
  }
}

export function StepCriteria({ scan, next, back, saveRef, navigating }: StepProps) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const run = useAction();
  /** Rows still set to the previous profile's default after the risk profile changed. */
  const [stale, setStale] = useState<string[]>([]);
  const q = useQuery({ queryKey: ['criteria', scan.id], queryFn: () => get<Crit[]>(`/api/scans/${scan.id}/criteria`) });
  const [items, setItems] = useState<Crit[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Provider | 'all'>('all');
  const [view, setView] = useState<'provider' | 'iso'>('provider');

  useEffect(() => {
    if (!q.data) return;
    setItems(q.data);
    const before = readDefaults(scan.id);
    if (!before) {
      writeDefaults(scan.id, q.data);
      return;
    }
    const was = new Set(before);
    // A check whose default flipped, and which is still stored at the old default, was pinned by an earlier save.
    setStale(q.data.filter((r) => was.has(r.checkId) !== r.defaultIncluded && r.included === was.has(r.checkId)).map((r) => r.checkId));
  }, [q.data, scan.id]);

  const applyNewDefaults = () => {
    const ids = new Set(stale);
    setItems((xs) => xs.map((x) => (ids.has(x.checkId) ? { ...x, included: x.defaultIncluded, reason: '' } : x)));
    setStale([]);
  };
  const keepSettings = () => {
    if (q.data) writeDefaults(scan.id, q.data);
    setStale([]);
  };

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
  // Only overrides are sent (plus rows changed back to their default, so an earlier override is replaced):
  // checks left at their default keep following the organisation's risk profile.
  const save = async () => {
    if (!q.data) return;
    const loaded = new Map(q.data.map((r) => [r.checkId, r]));
    const changed = items.filter((i) => {
      const o = loaded.get(i.checkId);
      return !o || o.included !== i.included || o.reason !== i.reason;
    });
    if (changed.length) {
      const changedIds = new Set(changed.map((i) => i.checkId));
      const send = items.filter((i) => changedIds.has(i.checkId) || isOverride(i));
      await put(`/api/scans/${scan.id}/criteria`, { items: send.map(({ checkId, included, reason }) => ({ checkId, included, reason: included ? '' : reason })) });
      qc.setQueryData(['criteria', scan.id], items);
    }
    writeDefaults(scan.id, items);
  };
  useStepSave(saveRef, save);

  /** Saves the toggles first, then opens the organisation form, which returns to this step after saving. */
  const editOrganisation = async () => {
    const ok = await run(save);
    if (ok) nav(`/organisations/${scan.customer.id}/edit?returnTo=${encodeURIComponent(`/scans/${scan.id}/wizard?step=criteria`)}`);
  };

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
            <span className="text-lg font-normal text-slate-500"> / {items.length}</span>
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
          <p className="mt-3 text-xs text-slate-500">
            From the organisation context.{' '}
            <Link
              to={`/organisations/${scan.customer.id}/edit?returnTo=${encodeURIComponent(`/scans/${scan.id}/wizard?step=criteria`)}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                void editOrganisation();
              }}
              className="font-medium text-brand-700 hover:underline"
            >
              Edit organisation
            </Link>
          </p>
        </div>
      </div>

      {stale.length > 0 && (
        <Alert tone="info" live className="mb-6" title="The risk profile changed">
          <p>
            {stale.length === 1 ? 'One check is' : `${stale.length} checks are`} still set to the default of the previous risk profile. Apply the new defaults to
            follow the current profile; checks you changed yourself stay as they are.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={applyNewDefaults}>
              Apply new defaults
            </Button>
            <Button size="sm" variant="secondary" onClick={keepSettings}>
              Keep current settings
            </Button>
          </div>
        </Alert>
      )}

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
              title: 'Reset to defaults?',
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
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-500" aria-hidden />
            <Input type="search" aria-label="Search criteria" placeholder="Search title or control (e.g. 8.5)" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div role="group" aria-label="Filter by platform" className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
            {(['all', ...providers] as const).map((p) => (
              <button key={p} type="button" aria-pressed={tab === p} onClick={() => setTab(p)} className={clsx('flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium', tab === p ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600')}>
                {p !== 'all' && <ProviderIcon provider={p} className="size-3.5" />}
                {p === 'all' ? 'All' : PROVIDER_SHORT[p]}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Group by" className="ml-auto flex rounded-lg bg-slate-100 p-0.5 text-sm">
            {(['provider', 'iso'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={clsx('rounded-md px-3 py-1.5 font-medium', view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600')}>
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
              <div className="flex items-center gap-2 border-y border-slate-100 bg-slate-50 px-6 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
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
                          <span className="text-[11px] text-slate-500">{DOMAIN_LABELS[m.domain]}</span>
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
