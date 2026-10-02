import { PROVIDER_LABELS } from '@qs/shared';
import { useQuery } from '@tanstack/react-query';
import { FileCheck2, Rocket, ShieldCheck, Upload } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ProviderIcon } from '../../components/ProviderIcon';
import { Alert, Button, Card, Field, Input } from '../../components/ui';
import { fileToBase64, get, patch, post, put } from '../../lib/api';
import { WizardFooter, type StepProps } from './ScanWizard';

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

const RETENTION_LABEL: Record<string, string> = {
  purge_on_completion: 'Deleted when the scan completes',
  days: 'Kept for a limited number of days',
  manual: 'Kept until manually deleted',
};

export function StepLaunch({ scan, refresh, back }: StepProps) {
  const nav = useNavigate();
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
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: any) => setForm({ ...form, [k]: v });
  const included = (crit.data ?? []).filter((c) => c.included).length;

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/api/scans/${scan.id}`, { authorization: form });
      await post(`/api/scans/${scan.id}/start`);
      nav(`/scans/${scan.id}/progress`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const upload = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      await put(`/api/scans/${scan.id}/authorization-doc`, { filename: file.name, contentBase64: await fileToBase64(file) });
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Customer authorisation" subtitle="Record who authorised this assessment. Scans can only run inside the authorised window.">
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
            <Field label="Valid until">
              <Input type="date" value={form.validUntil} onChange={(e) => set('validUntil', e.target.value)} />
            </Field>
          </div>
          <div className="mt-5 rounded-xl border border-dashed border-slate-300 p-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                {scan.hasAuthorizationDoc ? <FileCheck2 className="size-5 text-emerald-600" /> : <Upload className="size-5" />}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-800">{scan.hasAuthorizationDoc ? scan.authorizationDocName : 'Signed authorisation letter (optional)'}</div>
                <div className="text-xs text-slate-500">PDF, max 5 MB. Stored encrypted.</div>
              </div>
              <label className="cursor-pointer rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50">
                {uploading ? 'Uploading...' : scan.hasAuthorizationDoc ? 'Replace' : 'Upload PDF'}
                <input type="file" accept="application/pdf" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
              </label>
            </div>
          </div>
          <label className="mt-5 flex items-start gap-3 rounded-xl bg-brand-50 p-4 text-sm text-brand-950 ring-1 ring-brand-100">
            <input type="checkbox" className="mt-0.5 size-4 rounded border-slate-300 text-brand-600" checked={form.confirmed} onChange={(e) => set('confirmed', e.target.checked)} />
            <span>I confirm that the customer has authorised this read-only security assessment of the systems listed, and that the access granted is limited to what is needed.</span>
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
                  <ShieldCheck className="size-4 text-emerald-500" />
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
          <Alert tone="info" title="What happens next">
            The scanner connects with read-only access, runs each check and streams results live. Nothing is changed in the customer environments.
          </Alert>
        </div>
      </div>
      {err && <Alert tone="error" className="mt-4">{err}</Alert>}
      <WizardFooter
        onBack={back}
        onNext={start}
        loading={busy}
        disabled={!form.confirmed || !form.authorizerName || !form.authorizerEmail || !form.authorizerRole}
        nextLabel="Start scan"
        extra={<Rocket className="size-5 text-brand-500" />}
      />
    </>
  );
}
