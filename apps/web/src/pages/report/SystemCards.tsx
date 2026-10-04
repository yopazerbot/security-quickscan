import { PROVIDER_LABELS, type Provider } from '@qs/shared';
import clsx from 'clsx';
import { ProviderIcon } from '../../components/ProviderIcon';
import { EnvironmentChip } from '../../components/SystemBadge';
import { GradeBadge } from '../../components/ui';
import { environmentGroups, type EnvironmentGroup } from '../../lib/systems';

/** Per-system summary as the report model provides it (newer reports); counts are computed when it is missing. */
export interface SystemSummary {
  score?: number | null;
  grade?: string | null;
  partial?: boolean;
  coverage?: { assessed: number; inScope: number };
  counts?: Partial<Record<string, number>>;
}

export interface SystemCardData {
  id: string;
  provider: Provider;
  label: string;
  identity: string | null;
  environment?: string | null;
  summary?: SystemSummary | null;
}

/** Grade badge, or "Not assessed" when too little was assessed; nothing for reports without summaries. */
function GradeOrNotAssessed({ s }: { s: SystemSummary | null | undefined }) {
  if (!s) return null;
  return s.grade ? (
    <span className="shrink-0" role="img" aria-label={`Grade ${s.grade}${typeof s.score === 'number' ? `, score ${s.score}` : ''}`}>
      <GradeBadge grade={s.grade} size="sm" />
    </span>
  ) : (
    <span className="shrink-0 rounded-md border border-dashed border-slate-400 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">Not assessed</span>
  );
}

function Counts({ fail, warn, partial }: { fail: number; warn: number; partial?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
      <span>
        <span className={clsx('font-semibold', fail ? 'text-red-700' : 'text-slate-600')}>{fail}</span> failed
      </span>
      <span>
        <span className={clsx('font-semibold', warn ? 'text-amber-700' : 'text-slate-600')}>{warn}</span> {warn === 1 ? 'warning' : 'warnings'}
      </span>
      {partial && <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900 ring-1 ring-amber-200">Partial</span>}
    </span>
  );
}

/**
 * One card per scanned system. Clicking a card filters the findings to that system; clicking it again clears the filter.
 * With two or more environments the cards are grouped under an environment heading with that environment's summary.
 */
export function SystemCards({
  systems,
  environments,
  fallbackCounts,
  selected,
  onSelect,
  selectedEnvironment,
  onSelectEnvironment,
}: {
  systems: SystemCardData[];
  /** Per-environment summaries from the report model (newer reports). */
  environments?: EnvironmentGroup[] | null;
  /** Failed and warning counts per system id from the findings, for reports without per-system summaries. */
  fallbackCounts: Map<string, { fail: number; warn: number }>;
  selected: string;
  onSelect(id: string): void;
  selectedEnvironment: string;
  onSelectEnvironment(key: string): void;
}) {
  const groups = environmentGroups(systems, environments);
  const grouped = groups.length > 1;
  const byId = new Map(systems.map((x) => [x.id, x]));

  const card = (x: SystemCardData) => {
    const s = x.summary ?? null;
    const fb = fallbackCounts.get(x.id) ?? { fail: 0, warn: 0 };
    const on = selected === x.id;
    return (
      <button
        key={x.id}
        type="button"
        data-testid="system-card"
        data-findings={fb.fail + fb.warn}
        aria-pressed={on}
        onClick={() => onSelect(on ? 'all' : x.id)}
        className={clsx(
          'flex items-start gap-3 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          on ? 'ring-2 ring-brand-600' : 'ring-slate-200/70',
        )}
      >
        <ProviderIcon provider={x.provider} className="mt-0.5 size-7" decorative />
        <span className="min-w-0 flex-1">
          {/* The label wraps (two lines at most) so the environment chip after it does not cut it short. */}
          <span className="line-clamp-2 break-words">
            <span className="text-sm font-semibold text-slate-900" data-testid="system-card-label">
              {x.label}
            </span>{' '}
            <EnvironmentChip environment={x.environment} className="-mt-0.5" />
          </span>
          <span className="block truncate text-xs text-slate-500">{x.identity ?? PROVIDER_LABELS[x.provider]}</span>
          <span className="sr-only"> ({PROVIDER_LABELS[x.provider]})</span>
          <span className="mt-2 block">
            <Counts fail={s?.counts?.fail ?? fb.fail} warn={s?.counts?.warn ?? fb.warn} partial={Boolean(s?.partial && s?.grade)} />
          </span>
        </span>
        <GradeOrNotAssessed s={s} />
      </button>
    );
  };

  return (
    <section aria-labelledby="systems-heading" className="mt-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="systems-heading" className="text-lg font-semibold text-slate-900">
          Systems
        </h2>
        <p className="no-print text-sm text-slate-500">
          {grouped ? 'Select an environment or a system to show only its findings.' : 'Select a system to show only its findings.'}
        </p>
      </div>
      {grouped ? (
        <div className="space-y-5">
          {groups.map((g) => {
            const s = g.summary ?? null;
            const fb = g.systemIds.reduce((a, id) => {
              const c = fallbackCounts.get(id);
              return { fail: a.fail + (c?.fail ?? 0), warn: a.warn + (c?.warn ?? 0) };
            }, { fail: 0, warn: 0 });
            const on = selectedEnvironment === g.key;
            const name = g.name ?? 'No environment';
            const headingId = `env-${g.key || 'none'}`.replace(/[^a-zA-Z0-9_-]/g, '-');
            return (
              <div key={g.key} role="group" aria-labelledby={headingId} data-testid="environment-group">
                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <h3 id={headingId} className={clsx('text-sm font-semibold', g.name ? 'text-slate-800' : 'text-slate-500')}>
                    {name}{' '}
                    <span className="font-normal text-slate-500">
                      ({g.systemIds.length} {g.systemIds.length === 1 ? 'system' : 'systems'})
                    </span>
                  </h3>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onSelectEnvironment(on ? 'all' : g.key)}
                    title={on ? 'Show the findings of every environment' : `Show only the findings in ${name}`}
                    data-testid="environment-summary"
                    className={clsx(
                      'flex items-center gap-3 rounded-xl bg-white px-3 py-1.5 text-left ring-1 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                      on ? 'ring-2 ring-brand-600' : 'ring-slate-200/70',
                    )}
                  >
                    <span className="sr-only">Summary for {name}: </span>
                    <Counts fail={s?.counts?.fail ?? fb.fail} warn={s?.counts?.warn ?? fb.warn} partial={Boolean(s?.partial && s?.grade)} />
                    <GradeOrNotAssessed s={s} />
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{g.systemIds.map((id) => byId.get(id)).filter((x): x is SystemCardData => Boolean(x)).map(card)}</div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{systems.map(card)}</div>
      )}
    </section>
  );
}
