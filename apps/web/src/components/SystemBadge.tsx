import { PROVIDER_LABELS, type Provider } from '@qs/shared';
import clsx from 'clsx';
import { ProviderIcon } from './ProviderIcon';

/** Free-text environment of a system (production, acceptance...) as a small neutral chip. */
export function EnvironmentChip({ environment, className }: { environment?: string | null; className?: string }) {
  if (!environment) return null;
  return (
    <span
      data-testid="environment-chip"
      title={`Environment: ${environment}`}
      className={clsx('inline-block max-w-[9rem] shrink-0 truncate rounded bg-slate-100 px-1.5 py-px align-middle text-[10px] font-medium leading-4 text-slate-600 ring-1 ring-slate-200', className)}
    >
      <span className="sr-only">Environment: </span>
      {environment}
    </span>
  );
}

/**
 * A scanned system: provider icon, label, environment chip and (optionally) its identity (account, tenant or organisation) in smaller
 * text. With `onClick` it becomes a toggle button, for example to filter results to this system.
 */
export function SystemBadge({
  provider,
  label,
  identity,
  environment,
  size = 'sm',
  showIdentity = true,
  onClick,
  pressed,
  className,
  title,
}: {
  provider: Provider;
  label?: string | null;
  identity?: string | null;
  /** Free-text environment shown as a chip after the label. */
  environment?: string | null;
  size?: 'xs' | 'sm' | 'md';
  showIdentity?: boolean;
  onClick?: () => void;
  pressed?: boolean;
  className?: string;
  title?: string;
}) {
  const platform = PROVIDER_LABELS[provider] ?? provider;
  const name = label || platform;
  const icon = size === 'md' ? 'size-5' : size === 'sm' ? 'size-4' : 'size-3.5';
  const content = (
    <>
      <ProviderIcon provider={provider} className={icon} decorative />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={clsx('truncate', size === 'md' ? 'text-sm font-medium text-slate-800' : 'text-xs font-medium text-slate-700')}>{name}</span>
          <EnvironmentChip environment={environment} />
        </span>
        {showIdentity && identity && <span className="block truncate text-[11px] leading-tight text-slate-500">{identity}</span>}
      </span>
      {/* The icon is hidden from screen readers; the platform is named here unless the label already says it. */}
      {!name.toLowerCase().includes(platform.toLowerCase()) && <span className="sr-only"> ({platform})</span>}
    </>
  );
  const cls = clsx('inline-flex min-w-0 max-w-full items-center gap-1.5 text-left', className);
  const tip = title ?? [name, environment && `environment ${environment}`, identity].filter(Boolean).join(', ');
  if (onClick)
    return (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        title={tip}
        className={clsx(cls, 'rounded-md px-1 py-0.5 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500', pressed && 'bg-brand-50 ring-1 ring-brand-200')}
      >
        {content}
      </button>
    );
  return (
    <span className={cls} title={tip} data-testid="system-badge">
      {content}
    </span>
  );
}
