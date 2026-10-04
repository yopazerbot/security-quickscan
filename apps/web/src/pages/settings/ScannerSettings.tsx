import type { ScannerSettingsInput, ScannerSettingsView, TestResult } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ProviderIcon } from '../../components/ProviderIcon';
import { isReauthCancelled, useReauth } from '../../components/reauth';
import { Alert, Button, Card, ErrorState, Field, Input, PageLoader } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { CopyField, orNull, SecretField, secretInput, SETTINGS_KEYS, SourceBadge, TestResultView, text, useSaver } from './shared';

type OnDirty = (key: string, dirty: boolean) => void;
type Provider = 'ms' | 'aws';

const fetchScanner = () => get<ScannerSettingsView>('/api/admin/settings/scanner');

export function ScannerSettings({ onDirty }: { onDirty: OnDirty }) {
  const q = useQuery({ queryKey: SETTINGS_KEYS.scanner, queryFn: fetchScanner });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoader />;
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-600">
        The identities the scanner uses to read customer environments. Customers grant these identities read-only access; their credentials are never stored for scans that use
        them.
      </p>
      <MsCard view={q.data} onDirty={onDirty} />
      <AwsCard view={q.data} onDirty={onDirty} />
    </div>
  );
}

/** Tests the saved configuration of one scanner identity. */
function useScannerTest(provider: Provider) {
  const { withReauth } = useReauth();
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await withReauth(() => post<TestResult>('/api/admin/settings/scanner/test', { provider })));
    } catch (e) {
      if (!isReauthCancelled(e)) setResult({ ok: false, message: e instanceof Error ? e.message : 'The test could not be run.' });
    } finally {
      setBusy(false);
    }
  };
  return { result, busy, run, reset: () => setResult(null) };
}

/** Saves one provider's part of the scanner settings, then reloads them and the session features (scanner on/off). */
function useScannerSave() {
  const qc = useQueryClient();
  const saver = useSaver();
  const save = async (body: ScannerSettingsInput, success: string) => {
    const { ok } = await saver.run(() => put('/api/admin/settings/scanner', body), success);
    if (!ok) return null;
    void qc.invalidateQueries({ queryKey: ['me'] });
    return qc.fetchQuery({ queryKey: SETTINGS_KEYS.scanner, queryFn: fetchScanner, staleTime: 0 });
  };
  return { ...saver, save };
}

function MsCard({ view, onDirty }: { view: ScannerSettingsView; onDirty: OnDirty }) {
  const [base, setBase] = useState(view.ms);
  const [form, setForm] = useState<{ clientId: string; clientSecret: string | undefined }>({ clientId: text(view.ms.clientId), clientSecret: undefined });
  const saver = useScannerSave();
  const test = useScannerTest('ms');
  const dirty = form.clientId !== text(base.clientId) || secretInput(form.clientSecret) !== undefined;
  useEffect(() => onDirty('scanner-ms', dirty), [dirty, onDirty]);
  const save = async () => {
    const fresh = await saver.save({ ms: { clientId: orNull(form.clientId), clientSecret: secretInput(form.clientSecret) } }, 'Microsoft scanner app saved.');
    if (!fresh) return;
    setBase(fresh.ms);
    setForm({ clientId: text(fresh.ms.clientId), clientSecret: undefined });
    test.reset();
  };
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <ProviderIcon provider="m365" decorative className="size-4" /> Microsoft scanner app
          <SourceBadge source={base.source} />
        </span>
      }
      subtitle="A multi-tenant app registration. Customers grant it read-only access to Microsoft 365, Entra ID and Azure through admin consent."
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Client ID" hint="Application (client) ID of the multi-tenant app.">
          <Input spellCheck={false} autoComplete="off" maxLength={100} className="font-mono" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
        </Field>
        <SecretField label="Client secret" state={base.clientSecret} value={form.clientSecret} onChange={(v) => setForm({ ...form, clientSecret: v })} hint="Stored encrypted and never shown again." />
        <CopyField label="Consent redirect URI" value={view.ms.consentRedirectUri} hint="Register this as a Web redirect URI in the scanner app registration." />
        <Actions saver={saver} test={test} dirty={dirty} canTest={Boolean(base.clientId && base.clientSecret.set)} />
      </form>
    </Card>
  );
}

function AwsCard({ view, onDirty }: { view: ScannerSettingsView; onDirty: OnDirty }) {
  const [base, setBase] = useState(view.aws);
  const [form, setForm] = useState<{ accessKeyId: string; secretAccessKey: string | undefined }>({ accessKeyId: text(view.aws.accessKeyId), secretAccessKey: undefined });
  const saver = useScannerSave();
  const test = useScannerTest('aws');
  const dirty = form.accessKeyId !== text(base.accessKeyId) || secretInput(form.secretAccessKey) !== undefined;
  useEffect(() => onDirty('scanner-aws', dirty), [dirty, onDirty]);
  const save = async () => {
    const fresh = await saver.save({ aws: { accessKeyId: orNull(form.accessKeyId), secretAccessKey: secretInput(form.secretAccessKey) } }, 'AWS scanner identity saved.');
    if (!fresh) return;
    setBase(fresh.aws);
    setForm({ accessKeyId: text(fresh.aws.accessKeyId), secretAccessKey: undefined });
    test.reset();
  };
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <ProviderIcon provider="aws" decorative className="size-4" /> AWS scanner identity
          <SourceBadge source={base.source} />
        </span>
      }
      subtitle="An IAM user whose only permission is to assume the read-only role customers create in their accounts."
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Access key ID">
          <Input spellCheck={false} autoComplete="off" maxLength={128} className="font-mono" value={form.accessKeyId} onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })} />
        </Field>
        <SecretField label="Secret access key" state={base.secretAccessKey} value={form.secretAccessKey} onChange={(v) => setForm({ ...form, secretAccessKey: v })} hint="Stored encrypted and never shown again." />
        <CopyField label="Principal ARN" value={view.aws.principalArn} hint="Customers trust this principal in their read-only role. Known after the credentials are saved and tested." />
        <Actions saver={saver} test={test} dirty={dirty} canTest={Boolean(base.accessKeyId && base.secretAccessKey.set)} />
      </form>
    </Card>
  );
}

function Actions({ saver, test, dirty, canTest }: { saver: ReturnType<typeof useScannerSave>; test: ReturnType<typeof useScannerTest>; dirty: boolean; canTest: boolean }) {
  return (
    <>
      {test.result && <TestResultView result={test.result} />}
      {saver.error && (
        <Alert tone="error" live>
          {saver.error}
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
        {dirty && canTest && <span className="mr-auto text-xs text-slate-500">The test uses the saved values. Save first to test your changes.</span>}
        <Button variant="secondary" loading={test.busy} disabled={!canTest || dirty} onClick={() => void test.run()}>
          Test
        </Button>
        <Button type="submit" loading={saver.busy} disabled={!dirty}>
          Save
        </Button>
      </div>
    </>
  );
}
