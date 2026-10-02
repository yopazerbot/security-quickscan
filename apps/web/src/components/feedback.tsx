import clsx from 'clsx';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Button, Modal } from './ui';

// ---------- Toasts ----------

interface Toast {
  id: number;
  tone: 'success' | 'error';
  text: string;
}

const ToastCtx = createContext<{ success(text: string): void; error(text: string): void }>({ success: () => {}, error: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  const api = useRef({ success: (t: string) => push('success', t), error: (t: string) => push('error', t) });
  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      <div aria-live="polite" className="no-print pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={clsx(
              'pointer-events-auto flex items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-lg ring-1 motion-safe:animate-fade-in',
              t.tone === 'success' ? 'bg-white text-slate-800 ring-emerald-200' : 'bg-white text-slate-800 ring-red-200',
            )}
          >
            {t.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />}
            <span className="flex-1">{t.text}</span>
            <button type="button" aria-label="Dismiss" className="text-slate-400 hover:text-slate-700" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              <X className="size-4" />
            </button>
          </div>
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
