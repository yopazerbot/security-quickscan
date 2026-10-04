import { REAUTH_REQUIRED, RECENT_AUTH_MINUTES } from '@qs/shared';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, ShieldCheck } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PasswordInput } from './password-input';
import { Alert, Button, Field, Modal } from './ui';

/** Thrown by withReauth when the user closes the dialog instead of confirming: callers skip their error toast. */
export class ReauthCancelledError extends Error {
  constructor() {
    super('The change was not saved because your identity was not confirmed.');
  }
}

export const isReauthCancelled = (e: unknown) => e instanceof ReauthCancelledError;

/** True after the user chose to sign in again with Microsoft: unsaved-changes prompts stay quiet for that navigation. */
let leavingForReauth = false;
export const isLeavingForReauth = () => leavingForReauth;

interface ReauthApi {
  /**
   * Runs `fn`. When the server answers that the change needs a recent sign-in, asks the user to confirm their identity
   * and runs `fn` once more. Rejects with ReauthCancelledError when the user cancels.
   */
  withReauth<T>(fn: () => Promise<T>): Promise<T>;
}

const ReauthCtx = createContext<ReauthApi>({ withReauth: (fn) => fn() });

export const useReauth = () => useContext(ReauthCtx);

export const needsReauth = (e: unknown) => e instanceof ApiError && e.code === REAUTH_REQUIRED;

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // One dialog for any number of requests that need it at the same time.
  const pending = useRef<{ promise: Promise<void>; resolve(): void; reject(e: unknown): void } | null>(null);

  const ask = useCallback(() => {
    if (!pending.current) {
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending.current = { promise, resolve, reject };
      setOpen(true);
    }
    return pending.current.promise;
  }, []);

  const finish = useCallback((ok: boolean) => {
    const p = pending.current;
    pending.current = null;
    setOpen(false);
    if (ok) p?.resolve();
    else p?.reject(new ReauthCancelledError());
  }, []);

  const api = useRef<ReauthApi>({
    async withReauth(fn) {
      try {
        return await fn();
      } catch (e) {
        if (!needsReauth(e)) throw e;
        await ask();
        return await fn();
      }
    },
  });

  return (
    <ReauthCtx.Provider value={api.current}>
      {children}
      <ReauthDialog open={open} onDone={() => finish(true)} onCancel={() => finish(false)} />
    </ReauthCtx.Provider>
  );
}

function ReauthDialog({ open, onDone, onCancel }: { open: boolean; onDone(): void; onCancel(): void }) {
  const { me, logout } = useAuth();
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const method = me?.authMethod;

  const close = () => {
    setPassword('');
    setErr(null);
    onCancel();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post('/api/auth/reauth', { password });
      setPassword('');
      await qc.invalidateQueries({ queryKey: ['me'] });
      onDone();
    } catch (e) {
      setPassword('');
      setErr(e instanceof ApiError && e.status === 429 ? e.message || 'Too many attempts. Wait a few minutes and try again.' : e instanceof Error ? e.message : 'Your password could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  const microsoft = () => {
    leavingForReauth = true;
    const here = window.location.pathname + window.location.search;
    window.location.assign(`/api/auth/login?reauth=1&returnTo=${encodeURIComponent(here)}`);
  };

  const intro = `For your security, changes to sign-in and security settings need a sign-in from the last ${RECENT_AUTH_MINUTES} minutes.`;

  return (
    <Modal
      open={open}
      busy={busy}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-brand-600" aria-hidden /> Confirm it is you
        </span>
      }
      footer={
        method === 'password' ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="reauth-form" loading={busy} disabled={!password}>
              Confirm and save
            </Button>
          </>
        ) : method === 'entra' ? (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={microsoft}>Sign in again with Microsoft</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button icon={<LogOut className="size-4" aria-hidden />} onClick={() => void logout()}>
              Sign out
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4 text-sm text-slate-600">
        <p>{intro}</p>
        {method === 'password' ? (
          <form id="reauth-form" onSubmit={(e) => void submit(e)} className="space-y-4">
            <input type="text" name="username" autoComplete="username" value={me?.user.email ?? ''} readOnly hidden />
            <Field label="Your password">
              <PasswordInput autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <p className="text-xs text-slate-500">Your change is saved right after you confirm.</p>
          </form>
        ) : method === 'entra' ? (
          <Alert tone="warn">You go to Microsoft and come back to this page. Changes you have not saved yet are lost: make them again after you return.</Alert>
        ) : (
          <p>Sign out and sign in again, then make the change again.</p>
        )}
        {err && (
          <Alert tone="error" live>
            {err}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
