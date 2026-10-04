import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { AuthShell, PasswordChecks } from '../components/auth-shell';
import { PasswordInput } from '../components/password-input';
import { Alert, Button, ErrorState, Field, Input, PageLoader } from '../components/ui';
import { get, post } from '../lib/api';
import { AUTH_CONFIG_KEY, useAuth } from '../lib/auth';
import { PASSWORD_POLICY_HINT } from '../lib/password';
import { useDocumentTitle } from '../lib/use-document-title';

/** The setup token from the link in the server log, read once and removed from the address bar (and history). */
const linkToken: string = (() => {
  try {
    const url = new URL(window.location.href);
    if (url.pathname !== '/setup') return '';
    const token = url.searchParams.get('token') ?? '';
    if (token) {
      url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    return token;
  } catch {
    return '';
  }
})();

/** First run: creates the first administrator with an email address and password. */
export function SetupPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  useDocumentTitle('Setup');
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => get<{ required: boolean }>('/api/setup/status'), retry: false });
  const [form, setForm] = useState({ token: linkToken, email: '', name: '', password: '', confirm: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status.isLoading) return <PageLoader />;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => status.refetch()} className="m-4" />;
  if (!status.data?.required) {
    if (me) return <Navigate to="/" replace />;
    return (
      <AuthShell title="Setup is complete" intro="An administrator already exists for this installation.">
        <Link to="/login" className="font-medium text-brand-700 hover:underline">
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  const longEnough = form.password.length >= PASSWORD_MIN_LENGTH;
  const matches = form.confirm.length > 0 && form.password === form.confirm;
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!longEnough || !matches) {
      setErr(!longEnough ? `Use at least ${PASSWORD_MIN_LENGTH} characters.` : 'The passwords do not match.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await post('/api/setup', { token: form.token.trim(), email: form.email.trim(), name: form.name.trim(), password: form.password });
      await Promise.all([qc.invalidateQueries({ queryKey: ['me'] }), qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY }), qc.invalidateQueries({ queryKey: ['setup-status'] })]);
      navigate('/', { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create the first administrator" intro="The setup link with its one-time token is printed in the server log when the server starts.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        {!linkToken && (
          <Field label="Setup token" hint="Copy it from the setup link in the server log.">
            <Input autoComplete="off" spellCheck={false} className="font-mono" value={form.token} onChange={(e) => set('token', e.target.value)} required autoFocus />
          </Field>
        )}
        <Field label="Your name">
          <Input autoComplete="name" maxLength={200} value={form.name} onChange={(e) => set('name', e.target.value)} required autoFocus={Boolean(linkToken)} />
        </Field>
        <Field label="Email">
          <Input type="email" autoComplete="username" inputMode="email" maxLength={320} value={form.email} onChange={(e) => set('email', e.target.value)} required />
        </Field>
        <Field label="Password" hint={PASSWORD_POLICY_HINT}>
          <PasswordInput autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} value={form.password} onChange={(e) => set('password', e.target.value)} required />
        </Field>
        <Field label="Confirm password">
          <PasswordInput autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} value={form.confirm} onChange={(e) => set('confirm', e.target.value)} required />
        </Field>
        <PasswordChecks
          checks={[
            { ok: longEnough, label: `At least ${PASSWORD_MIN_LENGTH} characters` },
            { ok: matches, label: 'Both passwords match' },
          ]}
        />
        {err && (
          <Alert tone="error" live>
            {err}
          </Alert>
        )}
        <Button type="submit" className="w-full" loading={busy} disabled={!form.token.trim() || !form.email.trim() || !form.name.trim()}>
          Create administrator and sign in
        </Button>
        <p className="text-xs text-slate-500">You can set up Microsoft sign-in and other options in Settings afterwards.</p>
      </form>
    </AuthShell>
  );
}
