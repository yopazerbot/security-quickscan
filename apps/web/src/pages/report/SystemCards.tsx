import { PROVIDER_LABELS, type Provider } from '@qs/shared';
import clsx from 'clsx';
import { ProviderIcon } from '../../components/ProviderIcon';
import { GradeBadge } from '../../components/ui';

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
  summary?: SystemSummary | null;
}

/** One card per scanned system. Clicking a card filters the findings to that system; clicking it again clears the filter. */
export function SystemCards({
  systems,
  fallbackCounts,
  selected,
  onSelect,
}: {
  systems: SystemCardData[];
  /** Failed and warning counts per system id from the findings, for reports without per-system summaries. */
  fallbackCounts: Map<string, { fail: number; warn: number }>;
  selected: string;
  onSelect(id: string): void;
}) {
  return (
    <section aria-labelledby="systems-heading" className="mt-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="systems-heading" className="text-lg font-semibold text-slate-900">
          Systems
        </h2>
        <p className="no-print text-sm text-slate-500">Select a system to show only its findings.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {systems.map((x) => {
          const s = x.summary ?? null;
          const fb = fallbackCounts.get(x.id) ?? { fail: 0, warn: 0 };
          const fail = s?.counts?.fail ?? fb.fail;
          const warn = s?.counts?.warn ?? fb.warn;
          const on = selected === x.id;
          const graded = Boolean(s?.grade);
          return (
            <button
              key={x.id}
              type="button"
              data-testid="system-card"
              aria-pressed={on}
              onClick={() => onSelect(on ? 'all' : x.id)}
              className={clsx(
                'flex items-start gap-3 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                on ? 'ring-2 ring-brand-600' : 'ring-slate-200/70',
              )}
            >
              <ProviderIcon provider={x.provider} className="mt-0.5 size-7" decorative />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-900">{x.label}</span>
                <span className="block truncate text-xs text-slate-500">{x.identity ?? PROVIDER_LABELS[x.provider]}</span>
                <span className="sr-only"> ({PROVIDER_LABELS[x.provider]})</span>
                <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  <span>
                    <span className={clsx('font-semibold', fail ? 'text-red-700' : 'text-slate-600')}>{fail}</span> failed
                  </span>
                  <span>
                    <span className={clsx('font-semibold', warn ? 'text-amber-700' : 'text-slate-600')}>{warn}</span> {warn === 1 ? 'warning' : 'warnings'}
                  </span>
                  {s?.partial && graded && <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900 ring-1 ring-amber-200">Partial</span>}
                </span>
              </span>
              {s ? (
                graded ? (
                  <span className="shrink-0" role="img" aria-label={`Grade ${s.grade}${typeof s.score === 'number' ? `, score ${s.score}` : ''}`}>
                    <GradeBadge grade={s.grade} size="sm" />
                  </span>
                ) : (
                  <span className="shrink-0 rounded-md border border-dashed border-slate-400 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">Not assessed</span>
                )
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
