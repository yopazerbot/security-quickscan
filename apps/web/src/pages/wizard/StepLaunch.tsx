import { PROVIDER_LABELS } from '@qs/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleDashed, FileCheck2, FlaskConical, Loader2, Rocket, ShieldCheck, Upload, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ProviderIcon } from '../../components/ProviderIcon';
import { useAction, useToast } from '../../components/feedback';
import { Alert, Card, Field, Input, buttonClass } from '../../components/ui';
import { fileToBase64, get, patch, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { WizardFooter, systemReady, useStepSave, type StepProps, type WizardSystem } from './ScanWizard';

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

const RETENTION_LABEL: Record<string, string> = {
  purge_on_completion: 'Deleted when the scan completes',
  days: 'Kept for a limited number of days',
  manual: 'Kept until manually deleted',
};

const MAX_DOC_BYTES = 5 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function SystemStatus({ s }: { s: WizardSystem }) {
  if (s.config.authMode === 'demo') return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700"><FlaskConical className="size-3.5" aria-hidden /> Simulated</span>;
  if (!s.connection) return <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500"><CircleDashed className="size-3.5" aria-hidden /> Not tested</span>;
  return s.connection.ok ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700" title={`Tested ${fmtDateTime(s.connection.checkedAt)}`}><ShieldCheck className="size-3.5" aria-hidden /> Connected</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700" title={s.connection.message}><XCircle className="size-3.5" aria-hidden /> Test failed</span>
  );
}

export function StepLaunch({ scan, refresh, back, saveRef, navigating }: StepProps) {
  const nav = useNavigate();
  const run = useAction();
  const toast = useToast();
  const { me } = useAuth();
  const crit = useQuery({ queryKey: ['criteria', scan.id], queryFn: () => get<any[]>(`/api/scans/${scan.id}/criteria`) });
  const a = scan.authorization ?? {};
  const [form, setForm] = useState({
    authorizerName: a.authorizerName ?? '',
    authorizerRole: a.authorizerRole ?? '',
    authorizerEmail: a.authorizerEmail ?? '',
    authorizedOn: a.authorizedOn ?? today(),
    validUntil: a.validUntil ?? plusDays(30),
    confirmed: Boolean(a.confirmed),
  });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const set = (k: keyof typeof form, v: any) => setForm({ ...form, [k]: v });
  const included = (crit.data ?? []).filter((c) => c.included).length;

  const dateError = form.authorizedOn && form.validUntil && form.validUntil < form.authorizedOn ? '"Valid until" must be on or after the authorisation date.' : undefined;
  const missing = [
    !form.authorizerName.trim() && 'name',
    !form.authorizerRole.trim() && 'role',
    !EMAIL_RE.test(form.authorizerEmail.trim()) && (form.authorizerEmail.trim() ? 'a valid e-mail' : 'e-mail'),
    !form.authorizedOn && 'authorisation date',
    !form.validUntil && 'end date',
    !form.confirmed && 'confirmation',
  ].filter(Boolean) as string[];
  const complete = !missing.length && !dateError;
  const unreadySystems = scan.systems.filter((s) => !systemReady(s));

  // The server only accepts a complete authorisation, so an unfinished form is kept local when leaving the step.
  useStepSave(saveRef, async () => {
    if (!complete || (Object.keys(form) as (keyof typeof form)[]).every((k) => form[k] === a[k])) return;
    await patch(`/api/scans/${scan.id}`, { authorization: form });
    await refresh();
  });

  const start = async () => {
    setBusy(true);
    const ok = await run(async () => {
      await patch(`/api/scans/${scan.id}`, { authorization: form });
      await post(`/api/scans/${scan.id}/start`);
    });
    if (ok) nav(`/scans/${scan.id}/progress`);
    else setBusy(false);
  };

  const upload = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_DOC_BYTES) {
      toast.error(`${file.name} is too large. The maximum is 5 MB.`);
      return;
    }
    setUploading(true);
    await run(async () => {
      await put(`/api/scans/${scan.id}/authorization-doc`, { filename: file.name, contentBase64: await fileToBase64(file) });
      await refresh();
    }, 'Authorisation letter uploaded.');
    setUploading(false);
  };

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Assessment authorisation" subtitle="Record who authorised this assessment. Scans can only run inside the authorised window.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Authorised by (name)">
              <Input value={form.authorizerName} onChange={(e) => set('authorizerName', e.target.value)} maxLength={200} />
            </Field>
            <Field label="Role / title">
              <Input value={form.authorizerRole} onChange={(e) => set('authorizerRole', e.target.value)} placeholder="e.g. CEO, IT manager" maxLength={200} />
            </Field>
            <Field label="E-mail" className="sm:col-span-2">
              <Input type="email" value={form.authorizerEmail} onChange={(e) => set('authorizerEmail', e.target.value)} maxLength={320} />
            </Field>
            <Field label="Authorised on">
              <Input type="date" value={form.authorizedOn} onChange={(e) => set('authorizedOn', e.target.value)} />
            </Field>
            <Field label="Valid until" error={dateError}>
              <Input type="date" value={form.validUntil} min={form.authorizedOn || undefined} aria-invalid={Boolean(dateError)} onChange={(e) => set('validUntil', e.target.value)} />
            </Field>
          </div>
          {!me?.user.isDemo && (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 p-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                  {scan.hasAuthorizationDoc ? <FileCheck2 className="size-5 text-emerald-600" aria-hidden /> : <Upload className="size-5" aria-hidden />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">{scan.hasAuthorizationDoc ? scan.authorizationDocName : 'Signed authorisation letter (optional)'}</div>
                  <div className="text-xs text-slate-500">PDF, max 5 MB. Stored encrypted.</div>
                </div>
                <label
                  className={clsx(
                    buttonClass('secondary', 'sm'),
                    'focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2',
                    uploading ? 'pointer-events-none opacity-50' : 'cursor-pointer',
                  )}
                >
                  {uploading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />}
                  {uploading ? 'Uploading...' : scan.hasAuthorizationDoc ? 'Replace PDF' : 'Upload PDF'}
                  <input type="file" accept="application/pdf,.pdf" className="sr-only" disabled={uploading} onChange={(e) => void upload(e.currentTarget)} />
                </label>
              </div>
            </div>
          )}
          <label className="mt-5 flex items-start gap-3 rounded-xl bg-brand-50 p-4 text-sm text-brand-950 ring-1 ring-brand-100">
            <input type="checkbox" className="mt-0.5 size-4 rounded border-slate-300 text-brand-600" checked={form.confirmed} onChange={(e) => set('confirmed', e.target.checked)} />
            <span>I confirm that this read-only security assessment of the systems listed is authorised by the organisation (for example the system owner or management), and that the access granted is limited to what is needed.</span>
          </label>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          <Card title="Summary">
            <ul className="space-y-3">
              {scan.systems.map((s) => (
                <li key={s.id} className="flex items-center gap-3">
                  <ProviderIcon provider={s.provider} className="size-6" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-800">{s.label}</div>
                    <div className="text-xs text-slate-500">{PROVIDER_LABELS[s.provider]}</div>
                  </div>
                  <SystemStatus s={s} />
                </li>
              ))}
            </ul>
            <dl className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Criteria</dt>
                <dd className="font-medium">{included} checks</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Risk profile</dt>
                <dd className="font-medium capitalize">{scan.riskProfile.level}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Secrets</dt>
                <dd className="text-right font-medium">{RETENTION_LABEL[scan.retentionMode]}</dd>
              </div>
            </dl>
          </Card>
          {unreadySystems.length > 0 && (
            <Alert tone="warn" title="Connection not verified">
              Test the connection for {unreadySystems.map((s) => s.label).join(', ')} in the Access step before starting.
            </Alert>
          )}
          <Alert tone="info" title="What happens next">
            The scanner connects with read-only access, runs each check and streams results live. Nothing is changed in the scanned environments.
          </Alert>
        </div>
      </div>
      <WizardFooter
        onBack={navigating || busy ? undefined : back}
        onNext={start}
        loading={busy}
        disabled={!complete || unreadySystems.length > 0 || navigating}
        nextLabel="Start scan"
        extra={
          complete ? (
            <Rocket className="size-5 text-brand-500" aria-hidden />
          ) : (
            <span className="text-xs text-slate-600">{missing.length ? <>Missing: <span className="font-medium text-slate-800">{missing.join(', ')}</span></> : 'Fix the authorisation dates.'}</span>
          )
        }
      />
    </>
  );
}
