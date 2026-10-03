import clsx from 'clsx';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Button, Modal } from './ui';

// ---------- Toasts ----------

export interface ToastAction {
  label: string;
  onClick(): void;
}

interface Toast {
  id: number;
  tone: 'success' | 'error';
  text: string;
  action?: ToastAction;
}

interface ToastApi {
  success(text: string, opts?: { action?: ToastAction }): void;
  /** Error toasts stay until the user dismisses them (or uses their action). */
  error(text: string, opts?: { action?: ToastAction }): void;
}

const ToastCtx = createContext<ToastApi>({ success: () => {}, error: () => {} });

const SUCCESS_MS = 5000;

/** One toast. Success toasts dismiss themselves, but not while the pointer or keyboard focus is on them. */
function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss(): void }) {
  const [paused, setPaused] = useState(false);
  const left = useRef(SUCCESS_MS);
  useEffect(() => {
    if (t.tone !== 'success' || paused) return;
    const started = Date.now();
    const timer = setTimeout(onDismiss, left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(1500, left.current - (Date.now() - started));
    };
  }, [t.tone, paused, onDismiss]);
  return (
    <div
      role={t.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
      className={clsx(
        'pointer-events-auto flex items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-lg ring-1 motion-safe:animate-fade-in',
        t.tone === 'success' ? 'bg-white text-slate-800 ring-emerald-200' : 'bg-white text-slate-800 ring-red-200',
      )}
    >
      {t.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />}
      <div className="flex-1">
        <span>{t.text}</span>
        {t.action && (
          <button
            type="button"
            className="mt-1 block font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-900"
            onClick={() => {
              onDismiss();
              t.action!.onClick();
            }}
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button type="button" aria-label="Dismiss" className="rounded text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" onClick={onDismiss}>
        <X className="size-4" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((tone: Toast['tone'], raw: string, action?: ToastAction) => {
    // Toasts are full sentences; server messages sometimes come without the final full stop.
    const text = /[.!?]$/.test(raw.trim()) ? raw.trim() : `${raw.trim()}.`;
    setToasts((all) => {
      // The same message twice (e.g. a global handler and the caller both report it): keep the first.
      if (all.some((x) => x.tone === tone && x.text === text)) return all;
      return [...all.slice(-3), { id: next.current++, tone, text, action }];
    });
  }, []);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  const api = useRef<ToastApi>({ success: (t, o) => push('success', t, o?.action), error: (t, o) => push('error', t, o?.action) });
  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      <div aria-live="polite" className="no-print pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------- Confirm dialog ----------

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

/** A button that runs an async action: shows a spinner, reports errors, optionally confirms first and toasts success. */
export function AsyncButton({
  onClick,
  success,
  confirm,
  children,
  ...rest
}: Omit<ComponentProps<typeof Button>, 'onClick'> & { onClick: () => unknown; success?: string; confirm?: ConfirmOptions }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onClick();
      if (success) toast.success(success);
      setAsking(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button {...rest} loading={busy && !asking} onClick={() => (confirm ? setAsking(true) : void run())}>
        {children}
      </Button>
      {confirm && (
        <Modal
          open={asking}
          busy={busy}
          onClose={() => setAsking(false)}
          title={confirm.title}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button variant={confirm.danger ? 'danger' : 'primary'} loading={busy} onClick={() => void run()}>
                {confirm.confirmLabel ?? 'Confirm'}
              </Button>
            </>
          }
        >
          <div className="text-sm text-slate-600">{confirm.body}</div>
        </Modal>
      )}
    </>
  );
}

/** Wraps an async handler with error toasts, for places that cannot use AsyncButton. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async (fn: () => unknown, success?: string) => {
      try {
        await fn();
        if (success) toast.success(success);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'The action failed.');
        return false;
      }
    },
    [toast],
  );
}
