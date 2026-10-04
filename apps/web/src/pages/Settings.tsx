import { brandingSchema, REPORT_TITLE_SHORT, type Branding } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { FlaskConical, ImageUp, Link2, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, UNSAFE_DataRouterContext, useBlocker, useNavigate, useSearchParams } from 'react-router';
import { DataTable } from '../components/data-table';
import { AsyncButton, useToast } from '../components/feedback';
import { isLeavingForReauth } from '../components/reauth';
import { Alert, Button, Card, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Spinner, Textarea, Toggle } from '../components/ui';
import { ApiError, del, fileToBase64, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/use-document-title';
import { DemoModeToggle, ImportEnvBanner, SessionSettings } from './settings/GeneralSettings';
import { ScannerSettings } from './settings/ScannerSettings';
import { SignInSettings } from './settings/SignInSettings';

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
      // Signing in again with Microsoft: the user was already told that unsaved changes are lost.
      if (isLeavingForReauth()) return;
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
      <p className="text-sm text-slate-600">Some changes on this page have not been saved.</p>
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

type OnDirty = (key: string, dirty: boolean) => void;

const TABS = [
  { id: 'sign-in', label: 'Sign-in methods', keys: ['entra', 'password'] },
  { id: 'scanner', label: 'Scanner identities', keys: ['scanner-ms', 'scanner-aws'] },
  { id: 'sessions', label: 'Sessions and retention', keys: ['sessions'] },
  { id: 'branding', label: 'Report branding', keys: ['branding'] },
  { id: 'tenants', label: 'Tenant links', keys: [] },
  { id: 'demo', label: 'Demo', keys: [] },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function SettingsPage() {
  useDocumentTitle('Settings');
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : 'sign-in';
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const onDirty = useCallback<OnDirty>((key, value) => setDirty((d) => (Boolean(d[key]) === value ? d : { ...d, [key]: value })), []);
  const anyDirty = Object.values(dirty).some(Boolean);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const baseId = useId();
  const select = (id: TabId, focus = false) => {
    // Replace: switching tabs is not a navigation worth a history entry. The tab survives a reload and a sign-in redirect.
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('tab', id);
      return next;
    }, { replace: true });
    if (focus) tabRefs.current[id]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const to = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    select(TABS[to].id, true);
  };

  return (
    <>
      <UnsavedChangesGuard when={anyDirty} />
      <PageHeader title="Settings" subtitle="Sign-in, scanner identities, sessions and report branding. Changes take effect right away, without a restart." />
      <ImportEnvBanner />
      <div role="tablist" aria-label="Settings sections" onKeyDown={onKeyDown} className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => {
          const selected = t.id === tab;
          const unsaved = t.keys.some((k) => dirty[k]);
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.id)}
              className={clsx(
                '-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                selected ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900',
              )}
            >
              {t.label}
              {unsaved && (
                <>
                  <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
                  <span className="sr-only">(unsaved changes)</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {/* Panels stay mounted while hidden, so unsaved input survives switching tabs. */}
      {TABS.map((t) => (
        <div key={t.id} role="tabpanel" id={`${baseId}-panel-${t.id}`} aria-labelledby={`${baseId}-tab-${t.id}`} hidden={t.id !== tab}>
          {t.id === 'sign-in' && <SignInSettings onDirty={onDirty} />}
          {t.id === 'scanner' && <ScannerSettings onDirty={onDirty} />}
          {t.id === 'sessions' && <SessionSettings onDirty={onDirty} />}
          {t.id === 'branding' && <BrandingSection onDirty={onDirty} />}
          {t.id === 'tenants' && <TenantLinksCard />}
          {t.id === 'demo' && <DemoSection />}
        </div>
      ))}
    </>
  );
}

function BrandingSection({ onDirty }: { onDirty: OnDirty }) {
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
  useEffect(() => {
    if (q.data && !form) {
      const { hasLogo: _h, ...b } = q.data;
      setForm(b);
      setSaved(b);
      setPreview(expandHex(b.accentColor) ?? '#4f46e5');
    }
  }, [q.data, form]);
  const dirty = Boolean(form && saved && !sameBranding(form, saved));
  useEffect(() => onDirty('branding', dirty), [dirty, onDirty]);
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
      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Report branding"
          subtitle={dirty ? 'You have unsaved changes.' : 'Shown on the PDF report.'}
          actions={
            <Button type="submit" form="branding-form" loading={saving} disabled={!dirty}>
              Save
            </Button>
          }
        >
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
    </>
  );
}

function DemoSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  return (
    <>
      <DemoModeToggle />
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
            Turn demo mode off above on installations that scan real customers.
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
                  // Everything except the settings forms, which may hold unsaved edits.
                  await qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'branding' && query.queryKey[0] !== 'admin-settings' });
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
        <div className="-mx-6 -mb-6">
          <DataTable
            storageKey="tenant-links"
            label="tenant links"
            caption="Microsoft tenant links"
            minWidth="44rem"
            rows={q.data}
            rowKey={(b) => b.tenantId}
            hidePagerWhenSmall
            columns={[
              { key: 'tenant', header: 'Tenant', sort: (b) => b.tenantId, render: (b) => <span className="font-mono text-xs text-slate-800">{b.tenantId}</span> },
              {
                key: 'organisation',
                header: 'Organisation',
                sort: (b) => b.organisation?.name.toLowerCase() ?? null,
                render: (b) =>
                  b.organisation ? (
                    <Link to={`/organisations/${b.organisation.id}`} className="font-medium text-brand-700 hover:underline">
                      {b.organisation.name}
                    </Link>
                  ) : (
                    <span className="font-medium text-slate-600">Organisation deleted</span>
                  ),
              },
              {
                key: 'linked',
                header: 'Linked',
                sort: (b) => new Date(b.createdAt),
                render: (b) => (
                  <span className="text-xs text-slate-600">
                    {fmtDateTime(b.createdAt)}
                    {b.createdBy && <span className="block text-slate-500">by {b.createdBy}</span>}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                align: 'right',
                render: (b) => (
                  <AsyncButton
                    size="sm"
                    variant="ghost"
                    className="text-red-700 hover:bg-red-50"
                    aria-label={`Release the link of tenant ${b.tenantId}`}
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
                ),
              },
            ]}
          />
        </div>
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
