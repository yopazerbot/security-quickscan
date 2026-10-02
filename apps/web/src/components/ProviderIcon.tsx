import type { Provider } from '@qs/shared';
import clsx from 'clsx';

/** Neutral, simple platform glyphs (not official logos). */
export function ProviderIcon({ provider, className }: { provider: Provider; className?: string }) {
  const cls = clsx('shrink-0', className ?? 'size-5');
  switch (provider) {
    case 'm365':
      return (
        <svg viewBox="0 0 20 20" className={cls} aria-label="Microsoft 365">
          <rect x="1" y="1" width="8.5" height="8.5" rx="1" fill="#f25022" />
          <rect x="10.5" y="1" width="8.5" height="8.5" rx="1" fill="#7fba00" />
          <rect x="1" y="10.5" width="8.5" height="8.5" rx="1" fill="#00a4ef" />
          <rect x="10.5" y="10.5" width="8.5" height="8.5" rx="1" fill="#ffb900" />
        </svg>
      );
    case 'azure':
      return (
        <svg viewBox="0 0 20 20" className={cls} aria-label="Azure">
          <path d="M8 2h4.5L6.8 18H1.5z" fill="#0078d4" />
          <path d="M11.2 6.5L18.5 18H8.6l6-2.2z" fill="#50a0e8" />
        </svg>
      );
    case 'aws':
      return (
        <svg viewBox="0 0 20 20" className={cls} aria-label="AWS">
          <rect width="20" height="20" rx="4" fill="#232f3e" />
          <path d="M4.5 12.8c3.2 2 7.8 2 11 0" stroke="#ff9900" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M13.8 11.8l2 .9-.6 2" stroke="#ff9900" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <text x="10" y="10" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="#fff" fontFamily="Arial">aws</text>
        </svg>
      );
    case 'github':
      return (
        <svg viewBox="0 0 20 20" className={cls} aria-label="GitHub">
          <circle cx="10" cy="10" r="10" fill="#1f2328" />
          <path
            d="M10 4.2a5.8 5.8 0 0 0-1.83 11.3c.29.05.4-.13.4-.28v-1c-1.6.35-1.95-.77-1.95-.77-.27-.67-.65-.85-.65-.85-.53-.36.04-.35.04-.35.58.04.89.6.89.6.52.89 1.37.63 1.7.48.05-.38.2-.63.37-.78-1.28-.15-2.63-.64-2.63-2.85 0-.63.22-1.14.6-1.55-.06-.14-.26-.73.06-1.53 0 0 .48-.15 1.58.6a5.5 5.5 0 0 1 2.88 0c1.1-.75 1.58-.6 1.58-.6.32.8.12 1.39.06 1.53.37.4.6.92.6 1.55 0 2.22-1.36 2.7-2.64 2.85.2.18.39.53.39 1.07v1.59c0 .15.1.33.4.28A5.8 5.8 0 0 0 10 4.2z"
            fill="#fff"
          />
        </svg>
      );
  }
}
