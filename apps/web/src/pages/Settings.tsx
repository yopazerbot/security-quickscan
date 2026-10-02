import type { Branding } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, ImageUp, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, Modal, Toggle, PageHeader, PageLoader, Select, Textarea } from '../components/ui';
import { del, fileToBase64, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';

export function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['branding'], queryFn: () => get<Branding & { hasLogo: boolean }>('/api/settings/branding') });
  const [form, setForm] = useState<Branding | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [logoKey, setLogoKey] = useState(0);
  const { me } = useAuth();
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    if (q.data) {
      const { hasLogo: _h, ...b } = q.data;
      setForm(b);
    }
  }, [q.data]);
  if (!form) return <PageLoader />;
  const set = (k: keyof Branding, v: string) => setForm({ ...form, [k]: v });

  const save = async () => {
    setMsg(null);
    try {
      await put('/api/settings/branding', form);
      setMsg({ tone: 'success', text: 'Saved. New reports use these settings.' });
      await qc.invalidateQueries({ queryKey: ['branding'] });
    } catch (e: any) {
      setMsg({ tone: 'error', text: e.message });
    }
  };
  const uploadLogo = async (f?: File) => {
    if (!f) return;
    try {
      await put('/api/settings/logo', { contentBase64: await fileToBase64(f) });
      await qc.invalidateQueries({ queryKey: ['branding'] });
      setLogoKey((k) => k + 1);
    } catch (e: any) {
      setMsg({ tone: 'error', text: e.message });
    }
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Branding and defaults for client-facing reports." actions={<Button onClick={save}>Save settings</Button>} />
      {msg && <Alert tone={msg.tone} className="mb-6">{msg.text}</Alert>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Report branding">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name"><Input value={form.companyName} onChange={(e) => set('companyName', e.target.value)} /></Field>
            <Field label="Consultant name"><Input value={form.consultantName} onChange={(e) => set('consultantName', e.target.value)} /></Field>
            <Field label="Contact e-mail"><Input type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} /></Field>
            <Field label="Website"><Input value={form.website} onChange={(e) => set('website', e.target.value)} /></Field>
            <Field label="Accent colour">
              <div className="flex items-center gap-2">
                <input type="color" value={form.accentColor} onChange={(e) => set('accentColor', e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-slate-300" />
                <Input value={form.accentColor} onChange={(e) => set('accentColor', e.target.value)} className="font-mono" />
              </div>
            </Field>
            <Field label="Default classification" hint="Traffic Light Protocol marking on every page.">
              <Select value={form.classification} onChange={(e) => set('classification', e.target.value)}>
                {['TLP:CLEAR', 'TLP:GREEN', 'TLP:AMBER', 'TLP:AMBER+STRICT', 'TLP:RED'].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Disclaimer" className="sm:col-span-2" hint="Printed at the end of the PDF report.">
              <Textarea rows={5} value={form.disclaimer} onChange={(e) => set('disclaimer', e.target.value)} />
            </Field>
          </div>
        </Card>
        <Card title="Logo" subtitle="PNG or JPEG, max 500 KB. Shown on the report cover.">
          <div className="flex h-32 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200">
            {q.data?.hasLogo ? <img key={logoKey} src={`/api/settings/logo?v=${logoKey}`} alt="Logo" className="max-h-24 max-w-[80%] object-contain" /> : <span className="text-sm text-slate-400">No logo</span>}
          </div>
          <div className="mt-4 flex gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50">
              <ImageUp className="size-4" /> Upload
              <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => uploadLogo(e.target.files?.[0])} />
            </label>
            {q.data?.hasLogo && <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={async () => { await del('/api/settings/logo'); await qc.invalidateQueries({ queryKey: ['branding'] }); }}>Remove</Button>}
          </div>
          <div className="mt-6 rounded-xl p-4 text-white" style={{ backgroundColor: form.accentColor }}>
            <div className="text-xs opacity-80">{form.classification}</div>
            <div className="mt-6 text-lg font-semibold">Cloud Security Quick Scan</div>
            <div className="text-xs opacity-80">Preview of the cover colour</div>
          </div>
        </Card>
      </div>
      {me?.features.demo && (
        <Card
          className="mt-6"
          title={<span className="flex items-center gap-2"><FlaskConical className="size-4 text-amber-600" /> Demo data</span>}
          subtitle="Demo mode is on. The fictional customer Noordkust Logistics NV is seeded with two completed scans, triaged findings and a draft scan ready to run."
          actions={<Button variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => setConfirmReset(true)}>Reset demo data</Button>}
        >
          <p className="text-sm text-slate-600">
            Use it to try the full flow: open the customer, run the draft scan from the wizard, review the report and download the PDF and CSV exports. Demo systems never connect to real environments.
            Turn demo mode off in production by setting <code className="rounded bg-slate-100 px-1">DEMO_MODE=false</code>.
          </p>
          <DemoLoginSettings />
        </Card>
      )}
      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset demo data?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button
              loading={resetting}
              onClick={async () => {
                setResetting(true);
                try {
                  await post('/api/admin/demo/reset');
                  await qc.invalidateQueries();
                  setMsg({ tone: 'success', text: 'Demo data was reset.' });
                } catch (e: any) {
                  setMsg({ tone: 'error', text: e.message });
                } finally {
                  setResetting(false);
                  setConfirmReset(false);
                }
              }}
            >
              Reset
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">All demo customers, including scans you ran on them, are deleted and the original demo data is created again. Real customers are not affected.</p>
      </Modal>
    </>
  );
}

function DemoLoginSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['demo-login'], queryFn: () => get<{ enabled: boolean; pinSet: boolean; updatedAt: string | null; updatedBy: string | null }>('/api/admin/demo/login') });
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  if (!q.data) return null;

  const save = async (enabled: boolean, newPin?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await put('/api/admin/demo/login', { enabled, pin: newPin || undefined });
      setPin('');
      await qc.invalidateQueries({ queryKey: ['demo-login'] });
      setMsg({ tone: 'success', text: newPin ? 'PIN saved. Existing demo sessions were signed out.' : enabled ? 'Demo login enabled.' : 'Demo login disabled and all demo sessions signed out.' });
    } catch (e: any) {
      setMsg({ tone: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-slate-100 pt-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-sm font-semibold text-slate-900">Demo login with PIN</div>
          <p className="mt-0.5 max-w-xl text-sm text-slate-500">
            Lets prospects sign in with a PIN, without a Microsoft account. They only see demo customers, cannot enter real credentials and cannot open administration pages.
            Changing the PIN or turning this off signs out all demo sessions.
          </p>
        </div>
        <Toggle checked={q.data.enabled} disabled={busy || (!q.data.pinSet && !q.data.enabled)} onChange={(v) => save(v)} label="Demo login enabled" />
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label={q.data.pinSet ? 'New PIN' : 'PIN'} hint="6 to 12 digits. Stored as a one-way hash.">
          <Input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} className="w-48" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Button variant="secondary" loading={busy} disabled={pin.length < 6} onClick={() => save(q.data!.pinSet ? q.data!.enabled : true, pin)}>
          {q.data.pinSet ? 'Change PIN' : 'Set PIN and enable'}
        </Button>
      </div>
      {q.data.updatedAt && (
        <p className="mt-2 text-xs text-slate-400">
          Last changed {new Date(q.data.updatedAt).toLocaleString('en-GB')} by {q.data.updatedBy}
        </p>
      )}
      {msg && <Alert tone={msg.tone} className="mt-3">{msg.text}</Alert>}
    </div>
  );
}
