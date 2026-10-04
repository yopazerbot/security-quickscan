import { CHECKS_BY_ID, EVIDENCE_LABELS, ISO_ASSESSABLE, ISO_BY_ID, ISO_CONTROLS, VERDICT_LABELS, type ControlVerdict, type EvidenceStrength, type Provider, type ResultStatus } from '@qs/shared';
import clsx from 'clsx';
import { ChevronDown, X } from 'lucide-react';
import { SystemBadge } from '../../components/SystemBadge';
import { Button, Card, StatusBadge } from '../../components/ui';
import { STATUS_STYLE, VERDICT_STYLE } from '../../lib/format';

export interface ControlCheck {
  checkId: string;
  systemId?: string;
  status: string;
  primary: boolean;
  triage: 'accepted' | 'false_positive' | null;
}

export interface Control {
  id: string;
  title: string;
  verdict: ControlVerdict;
  evidence?: EvidenceStrength;
  score: number | null;
  checks?: ControlCheck[];
}

export interface ReportSystem {
  id: string;
  provider: Provider;
  label: string;
  identity: string | null;
}

/** Short marker for evidence that is weaker than strong. */
const EVIDENCE_MARK: Partial<Record<EvidenceStrength, string>> = { limited: 'L', indirect: 'I' };

const THEMES = [
  { key: 'organizational', label: 'A.5 Organizational' },
  { key: 'people', label: 'A.6 People' },
  { key: 'technological', label: 'A.8 Technological' },
];


function ControlHeatmap({ controls, selected, onSelect }: { controls: Control[]; selected: string | null; onSelect(id: string | null): void }) {
  const byId = new Map(controls.map((c) => [c.id, c]));
  return (
    <div className="space-y-4">
      {THEMES.map((t) => {
        const list = ISO_CONTROLS.filter((c) => c.theme === t.key && byId.has(c.id));
        if (!list.length) return null;
        return (
          <div key={t.key}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
              {list.map((c) => {
                const a = byId.get(c.id)!;
                const v = a.verdict;
                const pct = a.score !== null && a.score !== undefined ? `${a.score}%` : null;
                const ev = a.evidence && a.evidence !== 'none' ? EVIDENCE_LABELS[a.evidence] : null;
                const mark = a.evidence ? EVIDENCE_MARK[a.evidence] : undefined;
                const text = `A.${c.id} ${c.title}: ${VERDICT_LABELS[v]}${pct ? `, ${pct}` : ''}${ev ? `, ${ev.toLowerCase()}` : ''}`;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={selected === c.id}
                    aria-label={text}
                    onClick={() => onSelect(selected === c.id ? null : c.id)}
                    title={`A.${c.id} ${c.title}\n${VERDICT_LABELS[v]}${pct ? ` (${pct})` : ''}${ev ? `\n${ev}` : ''}`}
                    className={clsx(
                      'relative rounded-lg px-2 py-2 text-left transition motion-safe:hover:scale-[1.03]',
                      VERDICT_STYLE[v].cls,
                      // The selected control gets a strong ring; the others keep their colour so verdicts stay readable.
                      selected === c.id && 'ring-[3px] ring-slate-900 ring-offset-2',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono text-sm font-semibold">A.{c.id}</span>
                      <span className="text-[10px] font-semibold" aria-hidden>
                        {pct ?? 'n/a'}
                      </span>
                    </div>
                    <div className="line-clamp-2 text-[10px] leading-tight">{c.title}</div>
                    {mark && (
                      <span
                        aria-hidden
                        className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-white text-[9px] font-bold text-slate-800 shadow ring-1 ring-slate-400"
                      >
                        {mark}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="space-y-2 pt-1 text-xs text-slate-600">
        <ul aria-label="Verdicts" className="flex flex-wrap gap-x-3 gap-y-1.5">
          {(Object.keys(VERDICT_LABELS) as ControlVerdict[]).map((v) => (
            <li key={v} className="flex items-center gap-1.5">
              <span className={clsx('size-2.5 rounded-sm', VERDICT_STYLE[v].swatch)} style={{ backgroundColor: VERDICT_STYLE[v].hex }} aria-hidden />
              {VERDICT_LABELS[v]}
            </li>
          ))}
        </ul>
        <ul aria-label="Evidence markers" className="flex flex-wrap gap-x-3 gap-y-1.5">
          {(['limited', 'indirect'] as const).map((e) => (
            <li key={e} className="flex items-center gap-1.5">
              <span aria-hidden className="flex size-4 items-center justify-center rounded-full bg-white text-[9px] font-bold text-slate-800 ring-1 ring-slate-400">
                {EVIDENCE_MARK[e]}
              </span>
              {EVIDENCE_LABELS[e]}
            </li>
          ))}
          <li className="text-slate-500">No marker: strong evidence.</li>
        </ul>
      </div>
    </div>
  );
}

const TRIAGE_TEXT = { accepted: 'Risk accepted', false_positive: 'False positive' } as const;

/** The results behind one control, grouped by system. */
function ControlDrillDown({ control, systems, onClose, onSystem }: { control: Control; systems: Map<string, ReportSystem>; onClose(): void; onSystem(id: string): void }) {
  const checks = control.checks ?? [];
  const groups = new Map<string, ControlCheck[]>();
  for (const c of checks) groups.set(c.systemId ?? '', [...(groups.get(c.systemId ?? '') ?? []), c]);
  const meta = ISO_BY_ID[control.id];
  return (
    <section aria-labelledby="control-drilldown" className="mt-5 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="control-drilldown" className="text-sm font-semibold text-slate-900">
            A.{control.id} {meta?.title ?? control.title}
          </h3>
          <p className="mt-0.5 text-xs text-slate-600">
            {VERDICT_LABELS[control.verdict]}
            {control.score !== null && control.score !== undefined && ` (${control.score}%)`}
            {control.evidence && control.evidence !== 'none' && `. ${EVIDENCE_LABELS[control.evidence]}.`}
          </p>
        </div>
        <Button variant="ghost" size="sm" icon={<X className="size-3.5" aria-hidden />} onClick={onClose}>
          Close
        </Button>
      </div>
      {checks.length === 0 ? (
        <p className="text-xs text-slate-600">The findings list below is filtered to this control.</p>
      ) : (
        <div className="space-y-3">
          {[...groups.entries()].map(([sid, rows]) => {
            const sys = systems.get(sid);
            return (
              <div key={sid || 'unknown'}>
                {sys ? (
                  <SystemBadge provider={sys.provider} label={sys.label} identity={sys.identity} onClick={() => onSystem(sys.id)} title={`Show the findings of ${sys.label}`} />
                ) : (
                  <span className="text-xs font-medium text-slate-600">Unknown system</span>
                )}
                <ul className="mt-1.5 divide-y divide-slate-200 rounded-lg bg-white ring-1 ring-slate-200">
                  {rows.map((r, i) => (
                    <li key={`${i}-${r.checkId}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                      <span className="min-w-0 flex-1 font-medium text-slate-800">{CHECKS_BY_ID[r.checkId]?.title ?? r.checkId}</span>
                      <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', r.primary ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700')}>
                        {r.primary ? 'Primary' : 'Secondary'}
                      </span>
                      {r.triage && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700">{TRIAGE_TEXT[r.triage]}</span>}
                      <StatusBadge status={(r.status in STATUS_STYLE ? r.status : 'na') as ResultStatus} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** ISO/IEC 27001:2022 Annex A heatmap, evidence legend, control drill-down and the controls without coverage. */
export function IsoSection({
  controls,
  notCovered,
  systems,
  selected,
  onSelect,
  onSystem,
  className,
}: {
  controls: Control[];
  notCovered?: string[];
  systems: ReportSystem[];
  selected: string | null;
  onSelect(id: string | null): void;
  onSystem(id: string): void;
  className?: string;
}) {
  const verdicts = controls.reduce<Record<string, number>>((a, c) => ({ ...a, [c.verdict]: (a[c.verdict] ?? 0) + 1 }), {});
  const assessable = new Set(ISO_ASSESSABLE);
  const evidenced = controls.filter((c) => c.verdict !== 'not_assessed' && assessable.has(c.id)).length;
  const uncovered = notCovered ?? ISO_ASSESSABLE.filter((id) => !controls.some((c) => c.id === id && c.verdict !== 'not_assessed'));
  const sysMap = new Map(systems.map((s) => [s.id, s]));
  const current = selected ? controls.find((c) => c.id === selected) : undefined;
  return (
    <Card
      className={className}
      title="ISO/IEC 27001:2022 Annex A"
      subtitle={
        <>
          {evidenced} of {ISO_ASSESSABLE.length} assessable controls evidenced: {verdicts.effective ?? 0} effective, {verdicts.no_issues_limited ?? 0} without issues on limited evidence,{' '}
          {verdicts.partial ?? 0} partial, {verdicts.not_effective ?? 0} not effective. <span className="no-print">Click a control to see its results and filter the findings.</span>
        </>
      }
    >
      <p className="mb-4 text-xs leading-relaxed text-slate-600">
        Verdicts cover only the aspects of a control that automated configuration checks can see; policies, procedures and people are not assessed. Evidence strength says how much the
        checks tell about a control: strong means at least one high or critical primary check, or two or more primary checks; limited means only minor primary checks; indirect means only
        checks that map to the control as a secondary control. Clean results on limited or indirect evidence show as "No issues found (limited evidence)", not as effective.
      </p>
      <ControlHeatmap controls={controls} selected={selected} onSelect={onSelect} />
      {current && <ControlDrillDown control={current} systems={sysMap} onClose={() => onSelect(null)} onSystem={onSystem} />}
      {uncovered.length > 0 && (
        <details className="group mt-5 rounded-xl ring-1 ring-slate-200">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            Not covered by automated checks ({uncovered.length})
            <ChevronDown className="size-4 text-slate-500 transition group-open:rotate-180" aria-hidden />
          </summary>
          <div className="border-t border-slate-100 px-4 py-3">
            <p className="mb-2 text-xs text-slate-600">Technologically assessable controls that no result in this scan evidences. Assess them in the audit by other means.</p>
            <ul className="grid gap-x-6 gap-y-1 text-xs text-slate-700 sm:grid-cols-2">
              {uncovered.map((id) => (
                <li key={id}>
                  <span className="font-mono font-semibold">A.{id}</span> {ISO_BY_ID[id]?.title ?? ''}
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </Card>
  );
}
