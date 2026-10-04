import { PROVIDER_ICON_VIEWBOX, PROVIDER_ICONS, PROVIDER_LABELS, type IconShape, type Provider } from '@qs/shared';
import clsx from 'clsx';

function Shape({ s }: { s: IconShape }) {
  const paint = {
    fill: s.fill ?? (s.stroke ? 'none' : undefined),
    stroke: s.stroke,
    strokeWidth: s.strokeWidth,
    strokeLinecap: s.strokeLinecap,
  };
  switch (s.kind) {
    case 'rect':
      return <rect x={s.x} y={s.y} width={s.width} height={s.height} rx={s.rx} {...paint} />;
    case 'circle':
      return <circle cx={s.cx} cy={s.cy} r={s.r} {...paint} />;
    case 'path':
      return <path d={s.d} {...paint} />;
    case 'text':
      return (
        <text x={s.x} y={s.y} fontSize={s.fontSize} fontWeight={s.fontWeight} textAnchor={s.textAnchor} fontFamily={s.fontFamily} {...paint}>
          {s.text}
        </text>
      );
  }
}

/**
 * Neutral, simple platform glyphs (not official logos), drawn from the shared icon data so the web app and the PDF
 * report show the same icons. Named for screen readers by default; pass `decorative` when a text label sits next to it.
 */
export function ProviderIcon({ provider, className, decorative }: { provider: Provider; className?: string; decorative?: boolean }) {
  const def = PROVIDER_ICONS[provider];
  const label = PROVIDER_LABELS[provider] ?? def?.label ?? provider;
  const cls = clsx('shrink-0', className ?? 'size-5');
  if (!def) return null;
  return (
    <svg
      viewBox={`0 0 ${PROVIDER_ICON_VIEWBOX} ${PROVIDER_ICON_VIEWBOX}`}
      className={cls}
      {...(decorative ? { 'aria-hidden': true, focusable: false } : { role: 'img', 'aria-label': label })}
    >
      {def.shapes.map((s, i) => (
        <Shape key={i} s={s} />
      ))}
    </svg>
  );
}
