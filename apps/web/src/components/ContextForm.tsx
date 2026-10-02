import { computeRiskProfile, DOMAIN_LABELS, INDUSTRIES, REGULATIONS, type CustomerContext, type RiskLevel } from '@qs/shared';
import clsx from 'clsx';
import { Gauge } from 'lucide-react';
import type { ReactNode } from 'react';
import { Field, Select, Textarea } from './ui';

function Choice<T extends string>({ value, onChange, options, disabled }: { value: T; onChange(v: T): void; options: [T, string][]; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          className={clsx(
            'rounded-lg px-3 py-1.5 text-sm font-medium ring-1 transition',
            value === v ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:ring-slate-300',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function YesNo({ value, onChange, disabled }: { value: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  return <Choice value={value ? 'y' : 'n'} onChange={(v) => onChange(v === 'y')} options={[['n', 'No'], ['y', 'Yes']]} disabled={disabled} />;
}

function Q({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="py-4">
      <div className="mb-2">
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {hint && <div className="text-xs text-slate-500">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function ContextForm({ value, onChange, disabled }: { value: CustomerContext; onChange(v: CustomerContext): void; disabled?: boolean }) {
  const set = <K extends keyof CustomerContext>(k: K, v: CustomerContext[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="divide-y divide-slate-100">
      <div className="grid gap-4 pb-4 sm:grid-cols-2">
        <Field label="Sector">
          <Select value={value.industry} onChange={(e) => set('industry', e.target.value)} disabled={disabled}>
            {INDUSTRIES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Number of employees">
          <Select value={value.employees} onChange={(e) => set('employees', e.target.value as CustomerContext['employees'])} disabled={disabled}>
            {['1-10', '11-50', '51-250', '251-1000', '1000+'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Q label="Regulatory and certification context" hint="Select all that apply.">
        <div className="flex flex-wrap gap-2">
          {REGULATIONS.map(([id, label]) => {
            const on = value.regulations.includes(id);
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                onClick={() => set('regulations', on ? value.regulations.filter((r) => r !== id) : [...value.regulations, id])}
                className={clsx(
                  'rounded-full px-3 py-1 text-xs font-medium ring-1 transition',
                  on ? 'bg-brand-50 text-brand-700 ring-brand-300' : 'bg-white text-slate-600 ring-slate-200 hover:ring-slate-300',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </Q>
      <Q label="Sensitivity of data processed" hint="Personal data, health or financial data, trade secrets, ...">
        <Choice value={value.dataSensitivity} onChange={(v) => set('dataSensitivity', v)} disabled={disabled} options={[['low', 'Low'], ['moderate', 'Moderate'], ['high', 'High'], ['very_high', 'Very high']]} />
      </Q>
      <Q label="Internet-facing services" hint="Customer portals, APIs, public web applications hosted in the cloud.">
        <Choice value={value.internetExposure} onChange={(v) => set('internetExposure', v)} disabled={disabled} options={[['none', 'None'], ['limited', 'Limited'], ['significant', 'Significant']]} />
      </Q>
      <Q label="Remote work">
        <Choice value={value.remoteWork} onChange={(v) => set('remoteWork', v)} disabled={disabled} options={[['none', 'Office based'], ['hybrid', 'Hybrid'], ['full', 'Fully remote']]} />
      </Q>
      <Q label="IT management">
        <Choice value={value.itManagement} onChange={(v) => set('itManagement', v)} disabled={disabled} options={[['internal', 'Internal team'], ['msp', 'Managed service provider'], ['mixed', 'Mixed']]} />
      </Q>
      <div className="grid gap-x-8 sm:grid-cols-2">
        <Q label="Develops software in-house?">
          <YesNo value={value.developsSoftware} onChange={(v) => set('developsSoftware', v)} disabled={disabled} />
        </Q>
        <Q label="Security incidents in the past 2 years?">
          <YesNo value={value.previousIncidents} onChange={(v) => set('previousIncidents', v)} disabled={disabled} />
        </Q>
      </div>
      <Q label="Security maturity (your assessment)">
        <Choice
          value={value.securityMaturity}
          onChange={(v) => set('securityMaturity', v)}
          disabled={disabled}
          options={[['initial', 'Initial / ad hoc'], ['developing', 'Developing'], ['defined', 'Defined'], ['managed', 'Managed']]}
        />
      </Q>
      <div className="pt-4">
        <Field label="Crown jewels and key concerns" hint="Optional. Critical systems, data or business processes to keep in mind when interpreting results.">
          <Textarea value={value.crownJewels} onChange={(e) => set('crownJewels', e.target.value)} disabled={disabled} maxLength={2000} />
        </Field>
      </div>
    </div>
  );
}

export const RISK_STYLE: Record<RiskLevel, { label: string; cls: string; bar: string }> = {
  low: { label: 'Low', cls: 'text-emerald-700 bg-emerald-50 ring-emerald-200', bar: 'bg-emerald-500' },
  medium: { label: 'Medium', cls: 'text-amber-700 bg-amber-50 ring-amber-200', bar: 'bg-amber-500' },
  high: { label: 'High', cls: 'text-orange-700 bg-orange-50 ring-orange-200', bar: 'bg-orange-500' },
  critical: { label: 'Critical', cls: 'text-red-700 bg-red-50 ring-red-200', bar: 'bg-red-600' },
};

export function RiskProfilePanel({ context }: { context: CustomerContext }) {
  const p = computeRiskProfile(context);
  const s = RISK_STYLE[p.level];
  const pct = Math.min(100, Math.round((p.points / 24) * 100));
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className={clsx('flex size-11 items-center justify-center rounded-xl ring-1', s.cls)}>
          <Gauge className="size-5" />
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Risk profile</div>
          <div className="text-xl font-semibold text-slate-900">{s.label}</div>
        </div>
      </div>
      <div>
        <div className="h-2 rounded-full bg-slate-100">
          <div className={clsx('h-2 rounded-full transition-all', s.bar)} style={{ width: `${Math.max(pct, 4)}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-medium uppercase text-slate-400">
          <span>Low</span>
          <span>Medium</span>
          <span>High</span>
          <span>Critical</span>
        </div>
      </div>
      {p.drivers.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Drivers</div>
          <ul className="space-y-1 text-sm text-slate-600">
            {p.drivers.map((d) => (
              <li key={d} className="flex gap-2">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-slate-400" />
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Weighted domains</div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(p.domainWeights)
            .filter(([, w]) => w > 1)
            .map(([d, w]) => (
              <span key={d} className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                {DOMAIN_LABELS[d as keyof typeof DOMAIN_LABELS]} x{w}
              </span>
            ))}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">
        The profile selects which criteria are included by default (higher risk adds more checks) and weights the score. You can still adjust the criteria per scan.
      </p>
    </div>
  );
}
