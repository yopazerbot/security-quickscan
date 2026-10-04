import { PRODUCT_NAME } from '@qs/shared';
import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

/** Centered card with the product name, for pages shown outside the app layout (setup, password change). */
export function AuthShell({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-10 sm:py-12">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-brand-600">
            <ShieldCheck className="size-5 text-white" aria-hidden />
          </div>
          <span className="text-base font-semibold text-slate-900">{PRODUCT_NAME}</span>
        </div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {intro && <div className="mt-1.5 text-sm text-slate-600">{intro}</div>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

/** Live checklist under a new password field. Only checks the browser can do; the server has the final say. */
export function PasswordChecks({ checks }: { checks: { ok: boolean; label: string }[] }) {
  return (
    <ul className="space-y-1 text-xs" aria-label="Password requirements">
      {checks.map((c) => (
        <li key={c.label} className={c.ok ? 'text-emerald-700' : 'text-slate-500'}>
          <span aria-hidden>{c.ok ? '✓' : '•'}</span> {c.label}
          <span className="sr-only">{c.ok ? ' (met)' : ' (not met yet)'}</span>
        </li>
      ))}
    </ul>
  );
}
