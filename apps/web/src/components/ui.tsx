import type { ResultStatus, Severity } from '@qs/shared';
import clsx from 'clsx';
import { AlertTriangle, Check, Copy, Loader2, RotateCw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api';
import { GRADE_HEX, SEVERITY_STYLE, STATUS_STYLE } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

type Size = 'sm' | 'md' | 'lg';

/** Button styling, shared by <Button> and link-styled buttons (<LinkButton>, <a className={buttonClass()}>). */
export function buttonClass(variant: Variant = 'primary', size: Size = 'md', className?: string) {
  return clsx(
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    size === 'sm' && 'px-2.5 py-1.5 text-xs',
    size === 'md' && 'px-3.5 py-2 text-sm',
    size === 'lg' && 'px-5 py-2.5 text-sm',
    variant === 'primary' && 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
    variant === 'secondary' && 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50',
    variant === 'ghost' && 'text-slate-600 hover:bg-slate-100',
    variant === 'danger' && 'bg-red-600 text-white shadow-sm hover:bg-red-700',
    variant === 'success' && 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700',
    className,
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }) {
  return (
    <button {...rest} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/** A router link that looks like a button (no <button> nested in <a>). */
export function LinkButton({ to, variant, size, icon, className, children }: { to: string; variant?: Variant; size?: Size; icon?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <Link to={to} className={buttonClass(variant, size, className)}>
      {icon}
      {children}
    </Link>
  );
}

/** A plain download/external link that looks like a button. */
export function AnchorButton({ href, variant, size, icon, className, children, label }: { href: string; variant?: Variant; size?: Size; icon?: ReactNode; className?: string; children?: ReactNode; label?: string }) {
  return (
    <a href={href} aria-label={label} className={buttonClass(variant, size, className)}>
      {icon}
      {children}
    </a>
  );
}

export function Card({ className, children, title, actions, subtitle }: { className?: string; children: ReactNode; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx('rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(title || actions ? 'p-6' : '')}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

const inputCls =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';

/** Lets a caller's width class (w-48, max-w-*) replace the default full width. */
const withWidth = (cls?: string) => clsx(/(^|\s)w-/.test(cls ?? '') ? inputCls.replace('w-full ', '') : inputCls, cls);

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={withWidth(className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={clsx(withWidth(className), 'min-h-20')} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={clsx(withWidth(className), 'pr-8')}>
    {children}
  </select>
);

/**
 * Accessible on/off switch. Named by the visible text referenced by `labelledBy` when given,
 * otherwise by `label` (as aria-label).
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-600' : 'bg-slate-300',
      )}
    >
      <span aria-hidden className={clsx('pointer-events-none mt-0.5 inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide', className)}>{children}</span>;
}

export const SeverityBadge = ({ severity }: { severity: Severity }) => <Badge className={SEVERITY_STYLE[severity]}>{severity}</Badge>;

export function StatusBadge({ status }: { status: ResultStatus | 'pending' | 'running' }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1', s.cls)}>
      <span className={clsx('size-1.5 rounded-full', s.dot, status === 'running' && 'animate-pulse')} />
      {s.label}
    </span>
  );
}

export function GradeBadge({ grade, score, size = 'md' }: { grade?: string | null; score?: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'size-24 text-5xl' : size === 'md' ? 'size-10 text-lg' : 'size-7 text-sm';
  // No grade: the scan is not finished, or too few checks could be assessed to grade it. Same footprint as a grade.
  if (!grade)
    return (
      <span
        role="img"
        aria-label="Not assessed"
        title="Not assessed"
        className={clsx('inline-flex shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-slate-400 font-bold text-slate-600', dim)}
      >
        <span aria-hidden>-</span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2">
      <span className={clsx('inline-flex items-center justify-center rounded-xl font-bold text-white shadow-sm', dim)} style={{ backgroundColor: GRADE_HEX[grade] ?? '#334155' }}>
        {grade}
      </span>
      {score !== undefined && score !== null && size !== 'lg' && <span className="text-sm font-medium text-slate-600">{score}</span>}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-brand-600', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner className="size-7" />
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">{icon}</div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {children && <p className="mt-1 max-w-md text-sm text-slate-500">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn' | 'error' | 'success'; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'rounded-xl px-4 py-3 text-sm ring-1',
        tone === 'info' && 'bg-brand-50 text-brand-900 ring-brand-100',
        tone === 'warn' && 'bg-amber-50 text-amber-900 ring-amber-200',
        tone === 'error' && 'bg-red-50 text-red-800 ring-red-200',
        tone === 'success' && 'bg-emerald-50 text-emerald-800 ring-emerald-200',
        className,
      )}
    >
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={clsx(title && 'mt-0.5')}>{children}</div>}
    </div>
  );
}

/**
 * Accessible modal built on the native <dialog>: focus is trapped and restored by the browser,
 * Escape closes it, and it cannot be dismissed while `busy` (e.g. during a save).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  busy,
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself, outside the panel).
        if (e.target === ref.current && !busy) onClose();
      }}
      className={clsx(
        'm-auto w-[calc(100%-2rem)] rounded-2xl bg-white p-0 shadow-2xl backdrop:bg-slate-900/40 backdrop:backdrop-blur-sm motion-safe:animate-fade-in',
        wide ? 'max-w-3xl' : 'max-w-lg',
      )}
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        <button type="button" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40" onClick={onClose} disabled={busy} aria-label="Close">
          <X className="size-5" />
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
      {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-6 py-4">{footer}</div>}
    </dialog>
  );
}

/** Shown when a query fails: the message plus a retry button (instead of an endless spinner). */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const status = error instanceof ApiError ? error.status : 0;
  const message =
    status === 404 ? 'This item does not exist or you do not have access to it.' : status === 403 ? 'You do not have permission to view this.' : error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div role="alert" className={clsx('flex flex-col items-center justify-center rounded-2xl bg-white px-6 py-14 text-center ring-1 ring-slate-200', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-red-50 text-red-600">
        <AlertTriangle className="size-5" aria-hidden />
      </div>
      <p className="font-semibold text-slate-900">Could not load this page</p>
      <p className="mt-1 max-w-md text-sm text-slate-600">{message}</p>
      {onRetry && status !== 404 && status !== 403 && (
        <Button variant="secondary" className="mt-5" icon={<RotateCw className="size-4" />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
    >
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {label ?? (done ? 'Copied' : 'Copy')}
    </button>
  );
}

export function CodeBlock({ children, copy = true }: { children: string; copy?: boolean }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-xs leading-relaxed text-slate-100">{children}</pre>
      {copy && (
        <div className="absolute right-2 top-2 rounded-md bg-white/90 opacity-0 transition group-hover:opacity-100">
          <CopyButton value={children} />
        </div>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {crumbs && <div className="mb-1 text-sm text-slate-500">{crumbs}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: string; sub?: ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function DemoBadge() {
  return <Badge className="bg-amber-100 text-amber-800 ring-1 ring-amber-200">Demo</Badge>;
}
