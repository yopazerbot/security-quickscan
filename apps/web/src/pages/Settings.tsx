import type { Branding } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageHeader, PageLoader, Select, Textarea } from '../components/ui';
import { del, fileToBase64, get, put } from '../lib/api';

export function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['branding'], queryFn: () => get<Branding & { hasLogo: boolean }>('/api/settings/branding') });
  const [form, setForm] = useState<Branding | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [logoKey, setLogoKey] = useState(0);
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
    </>
  );
}
