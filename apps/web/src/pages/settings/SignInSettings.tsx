import { CONFIRM_REQUIRED, PASSWORD_MIN_LENGTH, type AuthSettingsView, type EntraSettingsInput, type PasswordSettingsInput, type TestResult } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldAlert, Users } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { isReauthCancelled, useReauth } from '../../components/reauth';
import { Alert, Badge, Button, Card, ErrorState, Field, Input, Modal, PageLoader, Toggle } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { AUTH_CONFIG_KEY, useAuth } from '../../lib/auth';
import { CopyField, orNull, SecretField, secretInput, SETTINGS_KEYS, SourceBadge, TestResultView, text, ToggleRow, useSaver } from './shared';

type OnDirty = (key: string, dirty: boolean) => void;

const admins = (n: number) => `${n} admin${n === 1 ? '' : 's'}`;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ALIASES = ['common', 'organizations', 'consumers'];

const fetchAuth = () => get<AuthSettingsView>('/api/admin/settings/auth');

export function SignInSettings({ onDirty }: { onDirty: OnDirty }) {
  const q = useQuery({ queryKey: SETTINGS_KEYS.auth, queryFn: fetchAuth });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoader />;
  const v = q.data;
  return (
    <div className="space-y-6">
      <LockoutInfo view={v} />
      <EntraCard view={v} onDirty={onDirty} />
      <PasswordCard view={v} onDirty={onDirty} />
      <BreakglassCard view={v} />
    </div>
  );
}

function LockoutInfo({ view }: { view: AuthSettingsView }) {
  const { entra, password } = view.adminsByMethod;
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-white p-4 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200/70 sm:p-5">
      <Users className="mt-0.5 size-5 shrink-0 text-slate-500" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium text-slate-900">
          Admins who can sign in: {admins(entra)} with Microsoft, {admins(password)} with email and password.
        </p>
        <p>
          To prevent a lockout, you cannot turn off a sign-in method or remove its configuration when no active admin could still sign in another way. The break-glass account
          does not count, because it is meant for emergencies only.
        </p>
      </div>
    </div>
  );
}

// ---------- Microsoft Entra ID ----------

interface EntraForm {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string | undefined;
  requireMfa: boolean;
}

const entraForm = (v: AuthSettingsView['entra']): EntraForm => ({ enabled: v.enabled, tenantId: text(v.tenantId), clientId: text(v.clientId), clientSecret: undefined, requireMfa: v.requireMfa });

const entraInput = (f: EntraForm): EntraSettingsInput => ({
  enabled: f.enabled,
  tenantId: orNull(f.tenantId),
  clientId: orNull(f.clientId),
  clientSecret: secretInput(f.clientSecret),
  requireMfa: f.requireMfa,
});

function entraErrors(f: EntraForm, secretSet: boolean) {
  const e: Partial<Record<'tenantId' | 'clientId' | 'clientSecret', string>> = {};
  const tenant = f.tenantId.trim();
  if (tenant && TENANT_ALIASES.includes(tenant.toLowerCase())) e.tenantId = 'Use your own tenant ID, not common, organizations or consumers.';
  else if (tenant && !GUID.test(tenant)) e.tenantId = 'Use the directory (tenant) ID, a GUID such as 11111111-2222-3333-4444-555555555555.';
  if (f.clientId.trim() && !GUID.test(f.clientId.trim())) e.clientId = 'The client ID is a GUID such as 11111111-2222-3333-4444-555555555555.';
  if (f.enabled) {
    if (!tenant) e.tenantId = 'Required while Microsoft sign-in is on.';
    if (!f.clientId.trim()) e.clientId = 'Required while Microsoft sign-in is on.';
    const secret = secretInput(f.clientSecret);
    if (secret === '' || (secret === undefined && !secretSet)) e.clientSecret = 'Required while Microsoft sign-in is on.';
  }
  return e;
}

function EntraCard({ view, onDirty }: { view: AuthSettingsView; onDirty: OnDirty }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const { withReauth } = useReauth();
  const [base, setBase] = useState(view.entra);
  const [form, setForm] = useState(() => entraForm(view.entra));
  const [showErrors, setShowErrors] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const saver = useSaver();
  const enabledId = useId();
  const mfaId = useId();
  // Compared as API input: clicking Replace without typing a new secret is not a change.
  const dirty = JSON.stringify(entraInput(form)) !== JSON.stringify(entraInput(entraForm(base)));
  useEffect(() => onDirty('entra', dirty), [dirty, onDirty]);
  const errors = showErrors ? entraErrors(form, base.clientSecret.set) : {};
  const set = (patch: Partial<EntraForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setTest(null);
    saver.clearError();
  };
  const disablingOwn = me?.authMethod === 'entra' && base.enabled && !form.enabled;
  const nobodyElse = base.enabled && !form.enabled && view.adminsByMethod.password === 0;

  const save = async (confirm = false) => {
    setShowErrors(true);
    if (Object.keys(entraErrors(form, base.clientSecret.set)).length) return;
    if (disablingOwn && !confirm) return setConfirming(true);
    setConfirming(false);
    const r = await saver.run(() => put('/api/admin/settings/auth/entra', { ...entraInput(form), ...(confirm ? { confirm: true } : {}) }), form.enabled ? 'Microsoft sign-in settings saved.' : 'Microsoft sign-in turned off.', {
      quietCodes: [CONFIRM_REQUIRED],
    });
    // The server knows best which change switches off the current session's method.
    if (r.code === CONFIRM_REQUIRED) return setConfirming(true);
    if (!r.ok) return;
    const fresh = await qc.fetchQuery({ queryKey: SETTINGS_KEYS.auth, queryFn: fetchAuth, staleTime: 0 });
    setBase(fresh.entra);
    setForm(entraForm(fresh.entra));
    setShowErrors(false);
    void qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY });
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await withReauth(() => post<TestResult>('/api/admin/settings/auth/entra/test', entraInput({ ...form, enabled: true }))));
    } catch (e) {
      if (!isReauthCancelled(e)) setTest({ ok: false, message: e instanceof Error ? e.message : 'The test could not be run.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <MicrosoftLogo /> Microsoft Entra ID
          <SourceBadge source={base.source} />
        </span>
      }
      subtitle="Single sign-on with accounts from your Microsoft tenant. Users must be added on the Users page first."
      actions={
        <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} labelledBy={enabledId} />
      }
    >
      <span id={enabledId} className="sr-only">
        Microsoft sign-in enabled
      </span>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        {base.source === 'env' && (
          <Alert tone="info">These values come from environment variables on the server. When you save here, the app settings take over and the environment variables are no longer used.</Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tenant ID" error={errors.tenantId} hint="Directory (tenant) ID from the app registration overview.">
            <Input spellCheck={false} autoComplete="off" maxLength={100} className="font-mono" value={form.tenantId} onChange={(e) => set({ tenantId: e.target.value })} />
          </Field>
          <Field label="Client ID" error={errors.clientId} hint="Application (client) ID.">
            <Input spellCheck={false} autoComplete="off" maxLength={100} className="font-mono" value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} />
          </Field>
        </div>
        <SecretField
          label="Client secret"
          state={base.clientSecret}
          value={form.clientSecret}
          onChange={(v) => set({ clientSecret: v })}
          error={errors.clientSecret}
          hint="Use the secret Value, not the Secret ID. Stored encrypted and never shown again."
        />
        <CopyField label="Redirect URI" value={view.entra.redirectUri} hint="Register this as a Web redirect URI in the app registration (Authentication)." />
        <ToggleRow
          title={<span id={mfaId}>Require multi-factor authentication</span>}
          description="Sign-in is refused unless Microsoft reports that MFA was used. Enforce MFA with Conditional Access as well."
        >
          <Toggle checked={form.requireMfa} onChange={(v) => set({ requireMfa: v })} labelledBy={mfaId} />
        </ToggleRow>
        {nobodyElse && (
          <Alert tone="warn">No admin can sign in with email and password. Turning Microsoft sign-in off would lock every admin out, so the server will refuse it.</Alert>
        )}
        {test && <TestResultView result={test} />}
        {saver.error && (
          <Alert tone="error" live>
            {saver.error}
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="secondary" loading={testing} disabled={!form.tenantId.trim() || !form.clientId.trim()} onClick={() => void runTest()}>
            Test configuration
          </Button>
          <Button type="submit" loading={saver.busy} disabled={!dirty}>
            Save
          </Button>
        </div>
      </form>
      <ConfirmDisableOwn open={confirming} method="Microsoft" busy={saver.busy} onCancel={() => setConfirming(false)} onConfirm={() => void save(true)} />
    </Card>
  );
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

function ConfirmDisableOwn({ open, method, busy, onCancel, onConfirm }: { open: boolean; method: string; busy: boolean; onCancel(): void; onConfirm(): void }) {
  return (
    <Modal
      open={open}
      busy={busy}
      onClose={onCancel}
      title={`Turn off ${method} sign-in?`}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            Turn off
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        You are signed in with {method}. After this change you, and everyone else using this method, can no longer sign in with it. Make sure you can sign in another way first.
      </p>
    </Modal>
  );
}

// ---------- Email and password ----------

function PasswordCard({ view, onDirty }: { view: AuthSettingsView; onDirty: OnDirty }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const [base, setBase] = useState(view.password);
  const [form, setForm] = useState({ enabled: view.password.enabled, minLength: String(view.password.minLength) });
  const [confirming, setConfirming] = useState(false);
  const saver = useSaver();
  const enabledId = useId();
  const dirty = form.enabled !== base.enabled || Number(form.minLength) !== base.minLength;
  useEffect(() => onDirty('password', dirty), [dirty, onDirty]);
  const min = Number(form.minLength);
  const minError = Number.isInteger(min) && min >= PASSWORD_MIN_LENGTH && min <= 64 ? undefined : `Enter a whole number from ${PASSWORD_MIN_LENGTH} to 64.`;
  const disablingOwn = me?.authMethod === 'password' && base.enabled && !form.enabled;
  const nobodyElse = base.enabled && !form.enabled && view.adminsByMethod.entra === 0;

  const save = async (confirm = false) => {
    if (minError) return;
    if (disablingOwn && !confirm) return setConfirming(true);
    setConfirming(false);
    const body: PasswordSettingsInput = { enabled: form.enabled, minLength: min, ...(confirm ? { confirm: true } : {}) };
    const r = await saver.run(() => put('/api/admin/settings/auth/password', body), form.enabled ? 'Password sign-in settings saved.' : 'Password sign-in turned off.', {
      quietCodes: [CONFIRM_REQUIRED],
    });
    if (r.code === CONFIRM_REQUIRED) return setConfirming(true);
    if (!r.ok) return;
    const fresh = await qc.fetchQuery({ queryKey: SETTINGS_KEYS.auth, queryFn: fetchAuth, staleTime: 0 });
    setBase(fresh.password);
    setForm({ enabled: fresh.password.enabled, minLength: String(fresh.password.minLength) });
    void qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY });
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="size-4 text-slate-500" aria-hidden /> Email and password
        </span>
      }
      subtitle="Accounts sign in with their email address and a password. Passwords are stored as a slow one-way hash; repeated failures lock the account for a while."
      actions={
        <Toggle
          checked={form.enabled}
          onChange={(v) => {
            setForm({ ...form, enabled: v });
            saver.clearError();
          }}
          labelledBy={enabledId}
        />
      }
    >
      <span id={enabledId} className="sr-only">
        Password sign-in enabled
      </span>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        <Field label="Minimum password length" error={minError} hint={`At least ${PASSWORD_MIN_LENGTH}. Common passwords are always refused.`}>
          <Input type="number" inputMode="numeric" min={PASSWORD_MIN_LENGTH} max={64} className="w-32" value={form.minLength} onChange={(e) => setForm({ ...form, minLength: e.target.value })} />
        </Field>
        <p className="text-sm text-slate-500">
          Give someone a password on the{' '}
          <Link to="/admin/users" className="font-medium text-brand-700 hover:underline">
            Users
          </Link>{' '}
          page: you set a temporary password that they must change when they first sign in.
        </p>
        {form.enabled && view.adminsByMethod.password === 0 && <Alert tone="info">No admin has a password yet. Give at least one admin a password so admins can use this method.</Alert>}
        {nobodyElse && <Alert tone="warn">No admin can sign in with Microsoft. Turning password sign-in off would lock every admin out, so the server will refuse it.</Alert>}
        {saver.error && (
          <Alert tone="error" live>
            {saver.error}
          </Alert>
        )}
        <div className="flex justify-end border-t border-slate-100 pt-4">
          <Button type="submit" loading={saver.busy} disabled={!dirty || Boolean(minError)}>
            Save
          </Button>
        </div>
      </form>
      <ConfirmDisableOwn open={confirming} method="password" busy={saver.busy} onCancel={() => setConfirming(false)} onConfirm={() => void save(true)} />
    </Card>
  );
}

// ---------- Break glass ----------

function BreakglassCard({ view }: { view: AuthSettingsView }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-red-600" aria-hidden /> Break-glass account
        </span>
      }
      actions={
        view.breakglass.enabled ? (
          <Badge className="bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Configured</Badge>
        ) : (
          <Badge className="bg-slate-100 text-slate-700">Not configured</Badge>
        )
      }
    >
      <p className="text-sm text-slate-600">
        Emergency sign-in with a username, password and authenticator code for when the normal sign-in is unavailable. It is configured with environment variables on the server
        (<code className="rounded bg-slate-100 px-1 text-xs">BREAKGLASS_*</code>) so it keeps working even when the settings in the database are wrong, and cannot be changed here.
      </p>
    </Card>
  );
}
