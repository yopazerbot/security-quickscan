import { gradeFor, type ControlVerdict, type ResultStatus, type Severity } from '@qs/shared';

export const fmtDate = (d?: string | Date | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';

export const fmtDateTime = (d?: string | Date | null) =>
  d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export const SEVERITY_STYLE: Record<Severity, string> = {
  critical: 'bg-red-900 text-white',
  high: 'bg-red-100 text-red-700 ring-1 ring-red-200',
  medium: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  info: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
};

export const SEVERITY_HEX: Record<Severity, string> = { critical: '#7f1d1d', high: '#dc2626', medium: '#d97706', low: '#0284c7', info: '#64748b' };

export const STATUS_STYLE: Record<ResultStatus | 'pending' | 'running', { label: string; cls: string; dot: string }> = {
  pass: { label: 'Pass', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500' },
  fail: { label: 'Fail', cls: 'bg-red-50 text-red-700 ring-red-200', dot: 'bg-red-500' },
  warn: { label: 'Warning', cls: 'bg-amber-50 text-amber-700 ring-amber-200', dot: 'bg-amber-500' },
  na: { label: 'N/A', cls: 'bg-slate-50 text-slate-500 ring-slate-200', dot: 'bg-slate-300' },
  error: { label: 'Error', cls: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200', dot: 'bg-fuchsia-500' },
  pending: { label: 'Queued', cls: 'bg-slate-50 text-slate-400 ring-slate-200', dot: 'bg-slate-200' },
  running: { label: 'Running', cls: 'bg-brand-50 text-brand-700 ring-brand-200', dot: 'bg-brand-500' },
};

export const VERDICT_STYLE: Record<ControlVerdict, { cls: string; hex: string }> = {
  // Same colours as the PDF report; white text on these shades meets WCAG AA.
  effective: { cls: 'bg-emerald-700 text-white', hex: '#047857' },
  partial: { cls: 'bg-amber-700 text-white', hex: '#b45309' },
  not_effective: { cls: 'bg-red-700 text-white', hex: '#b91c1c' },
  not_assessed: { cls: 'bg-slate-200 text-slate-700', hex: '#cbd5e1' },
};

export const GRADE_HEX: Record<string, string> = { A: '#059669', B: '#65a30d', C: '#ca8a04', D: '#ea580c', E: '#dc2626', F: '#991b1b' };

/** Score colours follow the grade bands, so a score and its grade always have the same colour. */
export const scoreHex = (s: number | null | undefined) => (s === null || s === undefined ? '#cbd5e1' : GRADE_HEX[gradeFor(s)]);
