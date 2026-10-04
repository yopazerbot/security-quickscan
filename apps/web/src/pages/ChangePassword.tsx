import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@qs/shared';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { AuthShell, PasswordChecks } from '../components/auth-shell';
import { useToast } from '../components/feedback';
import { PasswordInput } from '../components/password-input';
import { Alert, Button, Field, PageLoader } from '../components/ui';
import { post } from '../lib/api';
import { peekSignInPassword, rememberSignInPassword, useAuth } from '../lib/auth';
import { PASSWORD_POLICY_HINT } from '../lib/password';
import { useDocumentTitle } from '../lib/use-document-title';

/** Only same-app paths are accepted as a return target. */
function safeReturnPath(from: unknown): string | null {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\') || from.startsWith('/login') || from.startsWith('/change-password')) return null;
  return from;
}

/**
 * Forced after signing in with a temporary password (the route guard sends the user here), and available to anyone
 * signed in with a password who wants to change it.
 */
export function ChangePasswordPage() {
  const { me, loading, logout } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const from = safeReturnPath((location.state as { from?: unknown } | null)?.from);
  useDocumentTitle('Change password');
  // The temporary password typed on the login page, kept in memory only.
  const [prefilled] = useState(() => peekSignInPassword());
  const [form, setForm] = useState({ current: prefilled ?? '', next: '', confirm: '' });
  const [showCurrent, setShowCurrent] = useState(!prefilled);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace />;
  const forced = Boolean(me.mustChangePassword);
  if (!forced && me.authMethod !== 'password' && !me.user.hasPassword) return <Navigate to="/" replace />;

  const longEnough = form.next.length >= PASSWORD_MIN_LENGTH;
  const differs = form.next.length > 0 && form.next !== form.current;
  const matches = form.confirm.length > 0 && form.next === form.confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!longEnough || !differs || !matches) {
      setErr(!longEnough ? `Use at least ${PASSWORD_MIN_LENGTH} characters.` : !differs ? 'Choose a password that differs from the current one.' : 'The new passwords do not match.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await post('/api/auth/password/change', { currentPassword: form.current, newPassword: form.next });
      rememberSignInPassword(null);
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Your password was changed.');
      navigate(from ?? '/', { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Your password could not be changed.');
      // A wrong current password: let the user see and fix it.
      setShowCurrent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={forced ? 'Choose a new password' : 'Change password'}
      intro={forced ? 'You signed in with a temporary password. Choose your own password to continue.' : `Signed in as ${me.user.email}.`}
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <input type="text" name="username" autoComplete="username" value={me.user.email} readOnly hidden />
        {showCurrent ? (
          <Field label={forced ? 'Temporary password' : 'Current password'}>
            <PasswordInput autoComplete="current-password" maxLength={PASSWORD_MAX_LENGTH} value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required autoFocus={!prefilled} />
          </Field>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <KeyRound className="size-3.5" aria-hidden /> Using the temporary password you just signed in with.
            <button type="button" className="font-medium text-brand-700 underline underline-offset-2" onClick={() => setShowCurrent(true)}>
              Show
            </button>
          </p>
        )}
        <Field label="New password" hint={PASSWORD_POLICY_HINT}>
          <PasswordInput autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required autoFocus={Boolean(prefilled)} />
        </Field>
        <Field label="Confirm new password">
          <PasswordInput autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required />
        </Field>
        <PasswordChecks
          checks={[
            { ok: longEnough, label: `At least ${PASSWORD_MIN_LENGTH} characters` },
            { ok: differs, label: 'Different from the current password' },
            { ok: matches, label: 'Both new passwords match' },
          ]}
        />
        {err && (
          <Alert tone="error" live>
            {err}
          </Alert>
        )}
        <Button type="submit" className="w-full" loading={busy}>
          {forced ? 'Save and continue' : 'Change password'}
        </Button>
        {forced ? (
          <button type="button" className="mx-auto flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700" onClick={() => void logout()}>
            <LogOut className="size-3.5" aria-hidden /> Sign out
          </button>
        ) : (
          <Link to={from ?? '/'} className="block text-center text-xs font-medium text-slate-500 hover:text-slate-700">
            Cancel
          </Link>
        )}
        {!forced && <p className="text-xs text-slate-500">Your other sessions may be signed out after the change.</p>}
      </form>
    </AuthShell>
  );
}
