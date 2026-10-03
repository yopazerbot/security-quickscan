import { PRODUCT_NAME } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { Alert, Button, Field, Input } from '../components/ui';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SOURCE_URL } from '../lib/constants';
import { useDocumentTitle } from '../lib/use-document-title';

/** Set by the API client when a signed-in session ends; read (and cleared) once by this page. */
const EXPIRED_FLAG = 'qs_expired';
const RETURN_TO = 'qs_return_to';

function readExpiredFlag() {
  try {
    return sessionStorage.getItem(EXPIRED_FLAG) === '1';
  } catch {
    return false;
  }
}

const ERRORS: Record<string, string> = {
  not_invited: `Your account has not been invited to ${PRODUCT_NAME}. Ask an administrator to add you.`,
  account_disabled: 'Your account is deactivated. Ask an administrator.',
  guest_not_supported: 'Guest (B2B) accounts cannot sign in. Use an account from this tenant.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  wrong_tenant: 'You signed in with an account from a different Microsoft tenant.',
  mfa_required: 'Multi-factor authentication is required. Sign in again using MFA.',
  state_mismatch: 'The sign-in session expired or was started in another tab. Please try again.',
  state_expired: 'The sign-in session expired. Please try again.',
  token_error: 'Microsoft sign-in could not be completed. Please try again.',
  idp_error: 'Microsoft returned an error during sign-in.',
};

const CODE_HINTS: Record<string, string> = {
  AADSTS7000215: 'invalid client secret. Use the secret Value (not the Secret ID) in ENTRA_CLIENT_SECRET.',
  AADSTS7000222: 'the client secret has expired. Create a new one.',
  AADSTS700016: 'application not found. Check ENTRA_CLIENT_ID and ENTRA_TENANT_ID.',
  AADSTS700025: 'the app is configured as a public client. In Entra > Authentication, register the redirect URI under the Web platform (not SPA or Mobile/desktop) and set "Allow public client flows" to No.',
  AADSTS50011: 'redirect URI mismatch. Add APP_URL/api/auth/callback as a Web redirect URI.',
  AADSTS54005: 'the sign-in code was already used. Start again in a new tab.',
  AADSTS70008: 'the sign-in code expired. Please try again.',
  invalid_client: 'check ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET.',
};

/** Only same-app paths are accepted as a return target (no protocol-relative or absolute URLs). */
function safeReturnPath(from: unknown): string | null {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\') || from.startsWith('/login')) return null;
  return from;
}

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="size-4" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export function Login() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const location = useLocation();
  const from = safeReturnPath((location.state as { from?: unknown } | null)?.from);
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => get<{ entra: boolean; breakglass: boolean; demoLogin: boolean; local: boolean }>('/api/auth/config') });
  const [showBg, setShowBg] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', totp: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  // Read once per visit: the flag says a session really ended (not a fresh visit or a shared deep link).
  const [sessionExpired] = useState(readExpiredFlag);
  useDocumentTitle('Sign in');
  const error = params.get('error');

  useEffect(() => {
    try {
      sessionStorage.removeItem(EXPIRED_FLAG);
      // A failed attempt or a visit without a return target must not send the next sign-in somewhere stale.
      if (error || !from) sessionStorage.removeItem(RETURN_TO);
    } catch {
      /* storage unavailable */
    }
  }, [error, from]);

  // Local installation: there is no login, fetching the session signs in automatically.
  useEffect(() => {
    if (cfg.data?.local) void qc.invalidateQueries({ queryKey: ['me'] });
  }, [cfg.data?.local, qc]);

  // After any successful sign-in (break glass, demo PIN) `me` is set and we return to the page that sent us here.
  if (me) return <Navigate to={from ?? '/'} replace />;
  const detail = params.get('code')?.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);
  const hint = detail ? CODE_HINTS[detail] : undefined;
  const signedOut = Boolean(params.get('signedOut'));
  // Sent here by a protected page (not on a fresh visit to the start page, not after signing out).
  const redirected = Boolean(from) && from !== '/' && !signedOut && !error;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post('/api/auth/breakglass', form);
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e: any) {
      setErr(e.message);
      setForm((f) => ({ ...f, totp: '' }));
    } finally {
      setBusy(false);
    }
  };

  const submitPin = async (e: FormEvent) => {
    e.preventDefault();
    setPinBusy(true);
    setPinErr(null);
    try {
      await post('/api/auth/demo', { pin });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e: any) {
      setPinErr(e.message);
      setPin('');
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-ink lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(99,102,241,0.45),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(16,185,129,0.25),transparent_50%)]" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-brand-600 shadow-lg shadow-brand-600/40">
              <ShieldCheck className="size-6 text-white" aria-hidden />
            </div>
            <span className="text-lg font-semibold text-white">{PRODUCT_NAME}</span>
          </div>
          <div className="max-w-md">
            <p className="text-4xl font-semibold leading-tight tracking-tight text-white">Cloud security posture, mapped to ISO 27001.</p>
            <p className="mt-4 text-base leading-relaxed text-slate-300">
              Read-only quick scans of Microsoft 365, Entra ID, Azure, AWS and GitHub. Risk-based criteria, live progress and shareable reports.
            </p>
          </div>
          <p className="text-xs text-slate-500">Authorised use only. All activity is logged.</p>
        </div>
      </div>

      <div className="flex items-center justify-center px-4 py-10 sm:p-8">
        <div className="w-full max-w-sm">
          {/* Compact branding for small screens, where the left panel is hidden. */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex size-9 items-center justify-center rounded-xl bg-brand-600 shadow-md shadow-brand-600/30">
              <ShieldCheck className="size-5 text-white" aria-hidden />
            </div>
            <span className="text-base font-semibold text-slate-900">{PRODUCT_NAME}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
          {cfg.data?.entra && <p className="mt-1 text-sm text-slate-500">Use your organisation Microsoft account.</p>}

          {sessionExpired && !signedOut && !error ? (
            <Alert tone="info" className="mt-6">
              Your session has expired. Sign in again.
            </Alert>
          ) : (
            redirected && (
              <Alert tone="info" className="mt-6">
                Sign in to continue.
              </Alert>
            )
          )}

          {signedOut && !error && (
            <Alert tone="success" className="mt-6">
              You have been signed out.
            </Alert>
          )}

          {error && (
            <Alert tone="error" className="mt-6" live>
              {ERRORS[error] ?? 'Sign-in failed.'}
              {detail && (
                <span className="mt-1 block text-xs opacity-80">
                  Microsoft error {detail}
                  {hint ? `: ${hint}` : ''}
                </span>
              )}
            </Alert>
          )}

          {cfg.data?.entra !== false && (
            <a
              href="/api/auth/login"
              onClick={() => {
                // The SSO callback always lands on "/"; the layout picks this up and continues to the original page.
                try {
                  if (from && from !== '/') sessionStorage.setItem(RETURN_TO, from);
                } catch {
                  /* storage unavailable */
                }
              }}
              className="mt-6 flex w-full items-center justify-center gap-3 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm ring-1 ring-slate-300 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              <MicrosoftLogo />
              Sign in with Microsoft
            </a>
          )}

          {cfg.data?.demoLogin && (
            <form onSubmit={submitPin} className="mt-6 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
              <div className="mb-1 text-sm font-semibold text-amber-900">Demo access</div>
              <p className="mb-3 text-xs text-amber-800">Explore the tool with a fictional organisation. Enter the PIN you received.</p>
              <div className="flex gap-2">
                <Input
                  aria-label="Demo PIN"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={12}
                  placeholder="PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  required
                />
                <Button type="submit" loading={pinBusy} disabled={pin.length < 8}>
                  Enter demo
                </Button>
              </div>
              {pinErr && (
                <p role="alert" className="mt-2 text-xs text-red-700">
                  {pinErr}
                </p>
              )}
            </form>
          )}

          {cfg.data?.breakglass && (
            <div className="mt-8 border-t border-slate-200 pt-6">
              {!showBg ? (
                <button type="button" className="flex items-center gap-2 rounded text-xs font-medium text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => setShowBg(true)}>
                  <KeyRound className="size-3.5" aria-hidden /> Emergency access (break glass)
                </button>
              ) : (
                <form onSubmit={submit} className="space-y-4">
                  <Alert tone="warn">Emergency access is for when Microsoft sign-in is unavailable. Every use is audited.</Alert>
                  <Field label="Username">
                    <Input autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
                  </Field>
                  <Field label="Password">
                    <Input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
                  </Field>
                  <Field label="Authenticator code">
                    <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={form.totp} onChange={(e) => setForm({ ...form, totp: e.target.value.replace(/\D/g, '') })} required />
                  </Field>
                  {err && (
                    <div role="alert">
                      <Alert tone="error">{err}</Alert>
                    </div>
                  )}
                  <Button type="submit" className="w-full" loading={busy} icon={<Lock className="size-4" />}>
                    Sign in
                  </Button>
                </form>
              )}
            </div>
          )}
          <p className="mt-12 text-xs text-slate-500">
            Developed by <span className="font-medium text-slate-600">Yoshi Parlevliet</span>
            <span className="mx-1.5">·</span>
            <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener" className="hover:text-slate-700 hover:underline">
              Open source (MIT)
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
