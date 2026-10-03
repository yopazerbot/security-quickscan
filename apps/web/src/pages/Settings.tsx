import { brandingSchema, REPORT_TITLE_SHORT, type Branding } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, ImageUp, Link2, RotateCcw, Trash2 } from 'lucide-react';
import { useContext, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, UNSAFE_DataRouterContext, useBlocker, useNavigate } from 'react-router';
import { AsyncButton, useToast } from '../components/feedback';
import { Alert, Button, Card, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Spinner, Textarea, Toggle } from '../components/ui';
import { ApiError, del, fileToBase64, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/use-document-title';

type BrandingData = Branding & { hasLogo: boolean };
type BrandingErrors = Partial<Record<keyof Branding, string>>;

const LOGO_MAX_BYTES = 500_000;
const LOGO_TYPES = ['image/png', 'image/jpeg'];

/** Readable messages per field (the schema's own messages are technical). */
const FIELD_MESSAGES: Record<keyof Branding, string> = {
  companyName: 'Use at most 200 characters.',
  consultantName: 'Use at most 200 characters.',
  contactEmail: 'Enter a valid email address, or leave this empty.',
  website: 'Use at most 200 characters.',
  accentColor: 'Enter a colour as #rrggbb or #rgb, for example #4f46e5.',
  disclaimer: 'Use at most 4000 characters.',
};

/** "#abc" and "abc" become "#aabbcc"; returns null for anything that is not a hex colour. */
function expandHex(v: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}

const sameBranding = (a: Branding | null, b: Branding | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Warns before leaving with unsaved changes: the browser prompt on reload or close, and an in-app dialog for
 * navigation when the app runs on a data router (useBlocker needs one).
 */
function UnsavedChangesGuard({ when }: { when: boolean }) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [when]);
  return dataRouter ? <NavigationBlocker when={when} /> : <LinkClickBlocker when={when} />;
}

function DiscardDialog({ open, onStay, onLeave }: { open: boolean; onStay(): void; onLeave(): void }) {
  return (
    <Modal
      open={open}
      onClose={onStay}
      title="Discard unsaved changes?"
      footer={
        <>
          <Button variant="secondary" onClick={onStay}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={onLeave}>
            Discard changes
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">Your changes to the report branding have not been saved.</p>
    </Modal>
  );
}

function NavigationBlocker({ when }: { when: boolean }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname);
  return <DiscardDialog open={blocker.state === 'blocked'} onStay={() => blocker.reset?.()} onLeave={() => blocker.proceed?.()} />;
}

/** Without a data router: intercepts clicks on in-app links (navigation, breadcrumbs) while there are unsaved changes. */
function LinkClickBlocker({ when }: { when: boolean }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (!when) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement) || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith('/api/') || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [when]);
  return (
    <DiscardDialog
      open={pending !== null}
      onStay={() => setPending(null)}
      onLeave={() => {
        const to = pending;
        setPending(null);
        if (to) navigate(to);
      }}
    />
  );
}

export function SettingsPage() {
  useDocumentTitle('Settings');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['branding'], queryFn: () => get<BrandingData>('/api/settings/branding') });
  // The form is initialised once; later refetches (logo upload or removal) never overwrite unsaved edits.
  const [form, setForm] = useState<Branding | null>(null);
  const [saved, setSaved] = useState<Branding | null>(null);
  const [preview, setPreview] = useState('#4f46e5');
  const [errors, setErrors] = useState<BrandingErrors>({});
  const [saving, setSaving] = useState(false);
  const [logoKey, setLogoKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { me } = useAuth();
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    if (q.data && !form) {
      const { hasLogo: _h, ...b } = q.data;
      setForm(b);
      setSaved(b);
      setPreview(expandHex(b.accentColor) ?? '#4f46e5');
    }
  }, [q.data, form]);
  const dirty = Boolean(form && saved && !sameBranding(form, saved));
  if (q.isError && !form) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!form) return <PageLoader />;
  const set = (k: keyof Branding, v: string) => {
    setForm({ ...form, [k]: v });
    if (errors[k]) setErrors({ ...errors, [k]: undefined });
  };
  const setHasLogo = (hasLogo: boolean) => qc.setQueryData<BrandingData>(['branding'], (old) => (old ? { ...old, hasLogo } : old));

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const candidate = { ...form, accentColor: expandHex(form.accentColor) ?? form.accentColor };
    const r = brandingSchema.safeParse(candidate);
    if (!r.success) {
      const next: BrandingErrors = {};
      for (const issue of r.error.issues) {
        const k = issue.path[0] as keyof Branding;
        if (k in FIELD_MESSAGES && !next[k]) next[k] = FIELD_MESSAGES[k];
      }
      setErrors(next);
      const first = Object.keys(next)[0];
      if (first) document.querySelector<HTMLElement>(`[name="branding-${first}"]`)?.focus();
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await put('/api/settings/branding', r.data);
      setForm(r.data);
      setSaved(r.data);
      qc.setQueryData<BrandingData>(['branding'], (old) => ({ ...r.data, hasLogo: old?.hasLogo ?? false }));
      toast.success('Saved. New reports use these settings.');
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        const next: BrandingErrors = {};
        for (const [k, msg] of Object.entries(err.fields)) if (k in FIELD_MESSAGES) next[k as keyof Branding] = msg;
        setErrors(next);
      }
      toast.error(err instanceof Error ? err.message : 'The settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (input: HTMLInputElement) => {
    const f = input.files?.[0];
    if (!f) return;
    if (!LOGO_TYPES.includes(f.type) || f.size > LOGO_MAX_BYTES) {
      toast.error('Choose a PNG or JPEG image of at most 500 KB.');
      input.value = '';
      return;
    }
    setUploading(true);
    try {
      await put('/api/settings/logo', { contentBase64: await fileToBase64(f) });
      setHasLogo(true);
      setLogoKey((k) => k + 1);
      toast.success('Logo uploaded.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The logo could not be uploaded.');
    } finally {
      // Allows selecting the same file again (e.g. after fixing it).
      input.value = '';
      setUploading(false);
    }
  };
  const hasLogo = q.data?.hasLogo;

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <PageHeader
        title="Settings"
        subtitle="Branding and defaults for reports."
        actions={
          <Button type="submit" form="branding-form" loading={saving}>
            Save settings
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Report branding" subtitle={dirty ? 'You have unsaved changes.' : undefined}>
          <form id="branding-form" noValidate onSubmit={(e) => void save(e)} className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name" error={errors.companyName}>
              <Input name="branding-companyName" maxLength={200} value={form.companyName} onChange={(e) => set('companyName', e.target.value)} />
            </Field>
            <Field label="Prepared by (name or team)" error={errors.consultantName}>
              <Input name="branding-consultantName" maxLength={200} value={form.consultantName} onChange={(e) => set('consultantName', e.target.value)} />
            </Field>
            <Field label="Contact email" error={errors.contactEmail}>
              <Input name="branding-contactEmail" type="email" maxLength={320} value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
            </Field>
            <Field label="Website" error={errors.website}>
              <Input name="branding-website" maxLength={200} value={form.website} onChange={(e) => set('website', e.target.value)} />
            </Field>
            <Field label="Accent colour" error={errors.accentColor} hint="A hex colour such as #4f46e5. Short forms like #45e also work.">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Accent colour picker"
                  value={preview}
                  onChange={(e) => {
                    setPreview(e.target.value);
                    set('accentColor', e.target.value);
                  }}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded border border-slate-300"
                />
                <Input
                  name="branding-accentColor"
                  aria-label="Accent colour hex value"
                  maxLength={7}
                  spellCheck={false}
                  value={form.accentColor}
                  onChange={(e) => {
                    const ok = expandHex(e.target.value);
                    if (ok) setPreview(ok);
                    set('accentColor', e.target.value);
                  }}
                  onBlur={(e) => {
                    const ok = expandHex(e.target.value);
                    if (ok && ok !== form.accentColor) set('accentColor', ok);
                  }}
                  className="font-mono"
                />
              </div>
            </Field>
            <Field label="Disclaimer" className="sm:col-span-2" error={errors.disclaimer} hint="Printed at the end of the PDF report.">
              <Textarea name="branding-disclaimer" rows={5} maxLength={4000} value={form.disclaimer} onChange={(e) => set('disclaimer', e.target.value)} />
            </Field>
          </form>
        </Card>
        <Card title="Logo" subtitle="PNG or JPEG, max 500 KB. Shown on the report cover.">
          <div className="flex h-32 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200">
            {uploading ? (
              <Spinner />
            ) : hasLogo ? (
              <img key={logoKey} src={`/api/settings/logo?v=${logoKey}`} alt="Current report logo" className="max-h-24 max-w-[80%] object-contain" />
            ) : (
              <span className="text-sm text-slate-500">No logo</span>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              ref={fileRef}
              id={fileId}
              type="file"
              accept="image/png,image/jpeg"
              className="peer sr-only"
              disabled={uploading}
              onChange={(e) => void uploadLogo(e.currentTarget)}
            />
            <label
              htmlFor={fileId}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
            >
              <ImageUp className="size-4" aria-hidden /> {hasLogo ? 'Replace logo' : 'Upload logo'}
            </label>
            {hasLogo && (
              <AsyncButton
                variant="ghost"
                icon={<Trash2 className="size-4" aria-hidden />}
                disabled={uploading}
                success="Logo removed."
                confirm={{ title: 'Remove logo?', body: 'New reports are generated without a logo on the cover. You can upload a logo again at any time.', confirmLabel: 'Remove logo', danger: true }}
                onClick={async () => {
                  await del('/api/settings/logo');
                  setHasLogo(false);
                  if (fileRef.current) fileRef.current.value = '';
                }}
              >
                Remove
              </AsyncButton>
            )}
          </div>
          <div className="mt-6 rounded-xl p-4 text-white" style={{ backgroundColor: preview }}>
            <div className="mt-8 text-lg font-semibold">{REPORT_TITLE_SHORT}</div>
            <div className="text-xs opacity-90">Preview of the cover colour</div>
          </div>
        </Card>
      </div>
      <TenantLinksCard />
      {me?.features.demo && (
        <Card
          className="mt-6"
          title={
            <span className="flex items-center gap-2">
              <FlaskConical className="size-4 text-amber-600" aria-hidden /> Demo data
            </span>
          }
          subtitle="Demo mode is on. The fictional organisation Noordkust Logistics NV is seeded with two completed scans, triaged findings and a draft scan ready to run."
          actions={
            <Button variant="secondary" icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => setConfirmReset(true)}>
              Reset demo data
            </Button>
          }
        >
          <p className="text-sm text-slate-600">
            Use it to try the full flow: open the organisation, run the draft scan from the wizard, review the report and download the PDF and CSV exports. Demo systems never connect to real environments.
            Turn demo mode off in production by setting <code className="rounded bg-slate-100 px-1">DEMO_MODE=false</code>.
          </p>
          <DemoLoginSettings />
        </Card>
      )}
      <Modal
        open={confirmReset}
        busy={resetting}
        onClose={() => setConfirmReset(false)}
        title="Reset demo data?"
        footer={
          <>
            <Button variant="secondary" disabled={resetting} onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={resetting}
              onClick={async () => {
                setResetting(true);
                try {
                  await post('/api/admin/demo/reset');
                  // Everything except the branding form, which may hold unsaved edits.
                  await qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'branding' });
                  toast.success('Demo data was reset.');
                } catch (e: any) {
                  toast.error(e?.message ?? 'The demo data could not be reset.');
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
        <p className="text-sm text-slate-600">All demo organisations, including scans you ran on them, are deleted and the original demo data is created again. Real organisations are not affected.</p>
      </Modal>
    </>
  );
}

interface TenantLink {
  tenantId: string;
  organisation: { id: string; name: string } | null;
  createdAt: string;
  createdBy: string | null;
}

/** Microsoft tenants linked to an organisation through admin consent; admins can release a link. */
function TenantLinksCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tenant-bindings'], queryFn: () => get<TenantLink[]>('/api/admin/tenant-bindings') });
  return (
    <Card
      className="mt-6"
      title={
        <span className="flex items-center gap-2">
          <Link2 className="size-4 text-slate-500" aria-hidden /> Microsoft tenant links
        </span>
      }
      subtitle="A Microsoft tenant that granted admin consent belongs to one organisation. Other organisations cannot use it until an admin releases the link."
    >
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-8" />
      ) : !q.data ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-slate-500">No tenant links yet. A link is created when admin consent is completed for an organisation.</p>
      ) : (
        <ul className="-my-2 divide-y divide-slate-100">
          {q.data.map((b) => (
            <li key={b.tenantId} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm text-slate-800">{b.tenantId}</div>
                <div className="text-xs text-slate-500">
                  {b.organisation ? (
                    <Link to={`/organisations/${b.organisation.id}`} className="font-medium text-brand-700 hover:underline">
                      {b.organisation.name}
                    </Link>
                  ) : (
                    <span className="font-medium text-slate-600">Organisation deleted</span>
                  )}
                  <span className="ml-1.5">
                    Linked {fmtDateTime(b.createdAt)}
                    {b.createdBy ? ` by ${b.createdBy}` : ''}
                  </span>
                </div>
              </div>
              <AsyncButton
                size="sm"
                variant="ghost"
                className="text-red-700 hover:bg-red-50"
                success="The tenant link was released."
                confirm={{
                  title: 'Release tenant link?',
                  danger: true,
                  confirmLabel: 'Release link',
                  body: (
                    <>
                      Tenant <span className="font-mono">{b.tenantId}</span> is no longer linked to {b.organisation ? <strong>{b.organisation.name}</strong> : 'the deleted organisation'}. It can then be
                      linked to another organisation when someone completes admin consent for it.
                      {b.organisation && ' Scans of this organisation need admin consent again before they can use the tenant.'}
                    </>
                  ),
                }}
                onClick={async () => {
                  await del(`/api/admin/tenant-bindings/${encodeURIComponent(b.tenantId)}`);
                  await qc.invalidateQueries({ queryKey: ['tenant-bindings'] });
                }}
              >
                Release
              </AsyncButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DemoLoginSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['demo-login'], queryFn: () => get<{ enabled: boolean; pinSet: boolean; updatedAt: string | null; updatedBy: string | null }>('/api/admin/demo/login') });
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const descId = useId();
  const needPinId = useId();
  if (q.isError)
    return (
      <div className="mt-6 border-t border-slate-100 pt-6">
        <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-8" />
      </div>
    );
  if (!q.data)
    return (
      <div className="mt-6 flex justify-center border-t border-slate-100 pt-6">
        <Spinner />
      </div>
    );

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
  const noPin = !q.data.pinSet && !q.data.enabled;

  return (
    <div className="mt-6 border-t border-slate-100 pt-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-sm font-semibold text-slate-900">Demo login with PIN</div>
          <p id={descId} className="mt-0.5 max-w-xl text-sm text-slate-500">
            Lets visitors sign in with a PIN, without a Microsoft account. They only see demo organisations, cannot enter real credentials and cannot open administration pages.
            Changing the PIN or turning this off signs out all demo sessions.
          </p>
          {noPin && (
            <p id={needPinId} className="mt-1 text-sm font-medium text-amber-800">
              Set a PIN below to enable demo login.
            </p>
          )}
        </div>
        <Toggle
          checked={q.data.enabled}
          disabled={busy || noPin}
          onChange={(v) => void save(v)}
          label="Demo login enabled"
          describedBy={noPin ? `${needPinId} ${descId}` : descId}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label={q.data.pinSet ? 'New PIN' : 'PIN'} hint="8 to 12 digits. Stored as a one-way hash.">
          <Input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} className="w-48" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Button variant="secondary" loading={busy} disabled={pin.length < 8} onClick={() => save(q.data!.pinSet ? q.data!.enabled : true, pin)}>
          {q.data.pinSet ? 'Change PIN' : 'Set PIN and enable'}
        </Button>
      </div>
      {q.data.updatedAt && (
        <p className="mt-2 text-xs text-slate-500">
          Last changed {fmtDateTime(q.data.updatedAt)} by {q.data.updatedBy}
        </p>
      )}
      {msg && (
        <Alert tone={msg.tone} className="mt-3" live>
          {msg.text}
        </Alert>
      )}
    </div>
  );
}
