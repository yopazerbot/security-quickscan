import type { AuthSettingsView, GeneralSettingsInput, GeneralSettingsView, ScannerSettingsView } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseZap } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useToast } from '../../components/feedback';
import { isReauthCancelled, useReauth } from '../../components/reauth';
import { Alert, Button, Card, ErrorState, Field, Input, Modal, PageLoader, Spinner, Toggle } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { AUTH_CONFIG_KEY } from '../../lib/auth';
import { SETTINGS_KEYS, SourceBadge, ToggleRow, useSaver } from './shared';

type OnDirty = (key: string, dirty: boolean) => void;

const fetchGeneral = () => get<GeneralSettingsView>('/api/admin/settings/general');

export function useGeneralSettings() {
  return useQuery({ queryKey: SETTINGS_KEYS.general, queryFn: fetchGeneral });
}

const toInput = (v: GeneralSettingsView): GeneralSettingsInput => ({
  sessionIdleMinutes: v.sessionIdleMinutes,
  sessionMaxHours: v.sessionMaxHours,
  auditRetentionMonths: v.auditRetentionMonths,
  demoMode: v.demoMode,
});

const NUMBERS = {
  sessionIdleMinutes: { label: 'Sign out after inactivity', unit: 'minutes', min: 5, max: 480, hint: 'Sessions end after this many minutes without activity. 5 to 480.' },
  sessionMaxHours: { label: 'Maximum session length', unit: 'hours', min: 1, max: 24, hint: 'Users sign in again after this many hours, even when active. 1 to 24.' },
  auditRetentionMonths: { label: 'Keep audit log for', unit: 'months', min: 1, max: 240, hint: 'Older audit entries are deleted automatically. 1 to 240.' },
} as const;
type NumberKey = keyof typeof NUMBERS;

const numberError = (k: NumberKey, raw: string) => {
  const n = Number(raw);
  const { min, max } = NUMBERS[k];
  return raw.trim() && Number.isInteger(n) && n >= min && n <= max ? undefined : `Enter a whole number from ${min} to ${max}.`;
};

export function SessionSettings({ onDirty }: { onDirty: OnDirty }) {
  const q = useGeneralSettings();
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoader />;
  return <SessionForm view={q.data} onDirty={onDirty} />;
}

function SessionForm({ view, onDirty }: { view: GeneralSettingsView; onDirty: OnDirty }) {
  const qc = useQueryClient();
  const [base, setBase] = useState(view);
  const toForm = (v: GeneralSettingsView) => ({ sessionIdleMinutes: String(v.sessionIdleMinutes), sessionMaxHours: String(v.sessionMaxHours), auditRetentionMonths: String(v.auditRetentionMonths) });
  const [form, setForm] = useState(() => toForm(view));
  const saver = useSaver();
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(base));
  useEffect(() => onDirty('sessions', dirty), [dirty, onDirty]);
  const errors = Object.fromEntries((Object.keys(NUMBERS) as NumberKey[]).map((k) => [k, numberError(k, form[k])])) as Record<NumberKey, string | undefined>;
  const invalid = Object.values(errors).some(Boolean);

  const save = async () => {
    if (invalid) return;
    // Demo mode is saved from its own switch: send the stored value, not a value from this form.
    const latest = qc.getQueryData<GeneralSettingsView>(SETTINGS_KEYS.general) ?? base;
    const body: GeneralSettingsInput = { ...toInput(latest), sessionIdleMinutes: Number(form.sessionIdleMinutes), sessionMaxHours: Number(form.sessionMaxHours), auditRetentionMonths: Number(form.auditRetentionMonths) };
    const { ok } = await saver.run(() => put('/api/admin/settings/general', body), 'Saved. New limits apply to sessions from their next request.');
    if (!ok) return;
    const fresh = await qc.fetchQuery({ queryKey: SETTINGS_KEYS.general, queryFn: fetchGeneral, staleTime: 0 });
    setBase(fresh);
    setForm(toForm(fresh));
    void qc.invalidateQueries({ queryKey: ['me'] });
  };

  return (
    <Card title="Sessions and retention" subtitle="Shorter sessions limit the damage of an unattended or stolen session.">
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {(Object.keys(NUMBERS) as NumberKey[]).map((k) => (
            <Field
              key={k}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {NUMBERS[k].label} <SourceBadge source={base.sources[k]} />
                </span>
              }
              error={errors[k] || saver.fields[k]}
              hint={NUMBERS[k].hint}
            >
              <div className="flex items-center gap-2">
                <Input type="number" inputMode="numeric" min={NUMBERS[k].min} max={NUMBERS[k].max} className="w-28" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                <span className="text-sm text-slate-500">{NUMBERS[k].unit}</span>
              </div>
            </Field>
          ))}
        </div>
        {saver.error && (
          <Alert tone="error" live>
            {saver.error}
          </Alert>
        )}
        <div className="flex justify-end border-t border-slate-100 pt-4">
          <Button type="submit" loading={saver.busy} disabled={!dirty || invalid}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The demo mode switch (stored with the general settings). */
export function DemoModeToggle() {
  const q = useGeneralSettings();
  const qc = useQueryClient();
  const saver = useSaver();
  const [confirmOff, setConfirmOff] = useState(false);
  const labelId = useId();
  const descId = useId();
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-8" />;
  if (!q.data)
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  const view = q.data;
  const save = async (demoMode: boolean) => {
    setConfirmOff(false);
    const { ok } = await saver.run(() => put('/api/admin/settings/general', { ...toInput(view), demoMode }), demoMode ? 'Demo mode turned on.' : 'Demo mode turned off.');
    if (!ok) return;
    await qc.fetchQuery({ queryKey: SETTINGS_KEYS.general, queryFn: fetchGeneral, staleTime: 0 });
    await Promise.all([qc.invalidateQueries({ queryKey: ['me'] }), qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY })]);
  };
  return (
    <Card title="Demo mode">
      <ToggleRow
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span id={labelId}>Demo mode</span> <SourceBadge source={view.sources.demoMode} />
          </span>
        }
        description={
          <span id={descId}>
            Adds simulated systems and a fictional demo organisation, and allows the demo login with a PIN. Turn it off on installations that scan real customers.
          </span>
        }
      >
        <Toggle checked={view.demoMode} disabled={saver.busy} onChange={(v) => (v ? void save(true) : setConfirmOff(true))} labelledBy={labelId} describedBy={descId} />
      </ToggleRow>
      {saver.error && (
        <Alert tone="error" className="mt-4" live>
          {saver.error}
        </Alert>
      )}
      <Modal
        open={confirmOff}
        busy={saver.busy}
        onClose={() => setConfirmOff(false)}
        title="Turn off demo mode?"
        footer={
          <>
            <Button variant="secondary" disabled={saver.busy} onClick={() => setConfirmOff(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={saver.busy} onClick={() => void save(false)}>
              Turn off
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">Simulated systems and the demo login are no longer available, and demo visitors are signed out.</p>
      </Modal>
    </Card>
  );
}

/**
 * Shown when any setting still comes from an environment variable: imports them into the app settings (encrypted),
 * after which they can be managed here and removed from the server environment.
 */
export function ImportEnvBanner() {
  const qc = useQueryClient();
  const toast = useToast();
  const { withReauth } = useReauth();
  const scanner = useQuery({ queryKey: SETTINGS_KEYS.scanner, queryFn: () => get<ScannerSettingsView>('/api/admin/settings/scanner') });
  const authQ = useQuery({ queryKey: SETTINGS_KEYS.auth, queryFn: () => get<AuthSettingsView>('/api/admin/settings/auth') });
  const general = useGeneralSettings();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const a = authQ.data;
  const names: string[] = [];
  if (a && (a.entra.source === 'env' || a.entra.clientSecret.source === 'env')) names.push('Microsoft sign-in');
  if (scanner.data && (scanner.data.ms.source === 'env' || scanner.data.ms.clientSecret.source === 'env')) names.push('Microsoft scanner app');
  if (scanner.data && (scanner.data.aws.source === 'env' || scanner.data.aws.secretAccessKey.source === 'env')) names.push('AWS scanner identity');
  if (general.data && Object.values(general.data.sources).includes('env')) names.push('sessions, retention or demo mode');
  if (!names.length) return null;

  const run = async () => {
    setBusy(true);
    try {
      const r = await withReauth(() => post<{ imported: string[] }>('/api/admin/settings/import-env'));
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY });
      const list = r?.imported ?? [];
      toast.success(
        list.length
          ? `Imported ${list.join(', ')}. You can now remove these environment variables from the server.`
          : 'Nothing new to import: the app settings already have these values. You can remove the environment variables from the server.',
      );
      setOpen(false);
    } catch (e) {
      if (!isReauthCancelled(e)) toast.error(e instanceof Error ? e.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Alert tone="info" className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <DatabaseZap className="size-5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            Some settings come from environment variables: {names.join(', ')}. Import them to manage everything here; secrets are stored encrypted.
          </p>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Import from environment
          </Button>
        </div>
      </Alert>
      <Modal
        open={open}
        busy={busy}
        onClose={() => setOpen(false)}
        title="Import settings from the environment?"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void run()}>
              Import
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-600">
          <p>The current values of these environment variables are copied into the app settings: {names.join(', ')}.</p>
          <p>From then on the app settings are used and changes are made on this page. Afterwards, remove the variables from the server environment so secrets are not kept in two places.</p>
          <p>The break-glass account always stays in the environment.</p>
        </div>
      </Modal>
    </>
  );
}
