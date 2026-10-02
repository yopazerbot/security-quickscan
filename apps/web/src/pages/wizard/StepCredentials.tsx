import { PROVIDER_LABELS } from '@qs/shared';
import clsx from 'clsx';
import { BookOpen, CheckCircle2, ChevronDown, ExternalLink, KeyRound, Link2, Lock, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ProviderIcon } from '../../components/ProviderIcon';
import { AsyncButton, useAction, useToast } from '../../components/feedback';
import { Alert, Button, Card, CopyButton, Field, Input } from '../../components/ui';
import { del, patch, post, put } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { AwsKeysGuide, AwsRoleGuide, GithubGuide, MsAppGuide, MsConsentGuide } from './guidance';
import { WizardFooter, systemReady, type StepProps, type WizardScan, type WizardSystem } from './ScanWizard';
import { authModes, usePlatform } from './StepScope';

const RETENTION = [
  { id: 'purge_on_completion', title: 'Delete after the scan', desc: 'Most secure. Secrets are wiped as soon as the scan ends (or after 7 days if never run).', badge: 'Recommended' },
  { id: 'days', title: 'Keep for a number of days', desc: 'Allows a re-scan without entering credentials again. Deleted automatically afterwards.' },
  { id: 'manual', title: 'Keep until I delete them', desc: 'Encrypted at rest. Use only when agreed with the system owner.' },
] as const;

function Retention({ scan, refresh }: { scan: WizardScan; refresh(): Promise<unknown> }) {
  const run = useAction();
  const [mode, setMode] = useState(scan.retentionMode);
  const [days, setDays] = useState(String(scan.retentionDays ?? 30));
  const save = async (m: WizardScan['retentionMode'], d?: number) => {
    const prev = mode;
    setMode(m);
    const ok = await run(async () => {
      await patch(`/api/scans/${scan.id}`, { retention: { mode: m, days: m === 'days' ? (d ?? scan.retentionDays ?? 30) : undefined } });
      await refresh();
    });
    if (!ok) setMode(prev);
  };
  const commitDays = () => {
    const n = Math.min(365, Math.max(1, Math.round(Number(days)) || 1));
    setDays(String(n));
    if (n !== scan.retentionDays) void save('days', n);
  };
  return (
    <Card title="Credential retention" subtitle="Choose how long secrets for this scan are kept. Secrets are always encrypted (AES-256-GCM envelope encryption) and never shown again.">
      <div role="radiogroup" aria-label="Credential retention" className="grid gap-3 md:grid-cols-3">
        {RETENTION.map((r) => (
          <label
            key={r.id}
            className={clsx(
              'cursor-pointer rounded-xl p-4 text-left ring-1 transition focus-within:ring-2 focus-within:ring-brand-500',
              mode === r.id ? 'bg-brand-50 ring-2 ring-brand-500' : 'bg-white ring-slate-200 hover:ring-slate-300',
            )}
          >
            <input type="radio" name={`retention-${scan.id}`} value={r.id} checked={mode === r.id} onChange={() => void save(r.id)} className="sr-only" />
            <span className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <span aria-hidden className={clsx('size-4 shrink-0 rounded-full border-4', mode === r.id ? 'border-brand-600 bg-white' : 'border-slate-200')} />
                {r.title}
              </span>
              {'badge' in r && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">{r.badge}</span>}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-slate-500">{r.desc}</span>
          </label>
        ))}
      </div>
      {mode === 'days' && (
        <div className="mt-4 flex items-center gap-2">
          <label htmlFor={`retention-days-${scan.id}`} className="text-sm font-medium text-slate-700">Keep secrets for</label>
          <Input
            id={`retention-days-${scan.id}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            value={days}
            className="w-24"
            onChange={(e) => setDays(e.target.value)}
            onBlur={commitDays}
            onKeyDown={(e) => e.key === 'Enter' && commitDays()}
          />
          <span className="text-sm text-slate-500">days (1 to 365)</span>
        </div>
      )}
    </Card>
  );
}

function StatusPill({ s }: { s: WizardSystem }) {
  if (s.config.authMode === 'demo') return <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">Demo</span>;
  if (!s.connection) return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">Not tested</span>;
  return s.connection.ok ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
      <CheckCircle2 className="size-3.5" /> Connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700">
      <XCircle className="size-3.5" /> Failed
    </span>
  );
}

function SystemAccess({ scan, s, refresh }: { scan: WizardScan; s: WizardSystem; refresh(): Promise<unknown> }) {
  const platform = usePlatform();
  const mode = s.config.authMode as string;
  const [showGuide, setShowGuide] = useState(!s.connection?.ok);
  const [roleArn, setRoleArn] = useState(s.config.roleArn ?? '');
  const [clientId, setClientId] = useState(s.config.clientId ?? '');
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const base = `/api/scans/${scan.id}/systems/${s.id}`;
  const isMs = s.provider === 'm365' || s.provider === 'azure';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The action failed.');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const saveAndTest = () =>
    run(async () => {
      if (s.provider === 'aws' && mode === 'assume_role' && roleArn !== s.config.roleArn) {
        await patch(base, { label: s.label, config: { ...s.config, roleArn: roleArn.trim(), externalId: undefined } });
      }
      if (isMs && mode === 'app_secret' && clientId !== s.config.clientId) {
        await patch(base, { label: s.label, config: { ...s.config, clientId: clientId.trim() } });
      }
      if (s.needsSecret && Object.values(secret).some(Boolean)) {
        const body: Record<string, string> = {};
        for (const [k, v] of Object.entries(secret)) if (v.trim()) body[k] = v.trim();
        await put(`${base}/credentials`, { secret: body });
        setSecret({});
      }
      await post(`${base}/test`);
    });

  const secretInput = (key: string, label: string, opts: { placeholder?: string; optional?: boolean; plain?: boolean } = {}) => (
    <Field label={<>{label}{opts.optional && <span className="font-normal text-slate-400"> (optional)</span>}</>}>
      <Input
        type={opts.plain ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={s.credential ? 'Stored (enter a new value to replace)' : opts.placeholder}
        value={secret[key] ?? ''}
        onChange={(e) => setSecret({ ...secret, [key]: e.target.value })}
      />
    </Field>
  );

  let guide: ReactNode = null;
  let form: ReactNode = null;
  if (mode === 'demo') {
    form = <Alert tone="warn">Demo system: results are simulated and no connection is made.</Alert>;
  } else if (s.provider === 'aws' && mode === 'assume_role') {
    guide = <AwsRoleGuide principal={platform.data?.awsPrincipal ?? null} externalId={s.config.externalId} />;
    form = (
      <>
        <Field label="External ID" hint="Unique to this scan. Included in the template.">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-slate-100 px-3 py-2 text-xs">{s.config.externalId}</code>
            <CopyButton value={s.config.externalId} />
          </div>
        </Field>
        <Field label="Role ARN">
          <Input value={roleArn} onChange={(e) => setRoleArn(e.target.value)} placeholder="arn:aws:iam::123456789012:role/SecurityQuickScanReadOnly" />
        </Field>
      </>
    );
  } else if (s.provider === 'aws') {
    guide = <AwsKeysGuide />;
    form = (
      <>
        {secretInput('accessKeyId', 'Access key ID', { placeholder: 'AKIA... or ASIA...', plain: true })}
        {secretInput('secretAccessKey', 'Secret access key')}
        {secretInput('sessionToken', 'Session token', { optional: true })}
      </>
    );
  } else if (isMs && mode === 'admin_consent') {
    guide = <MsConsentGuide azure={s.provider === 'azure'} />;
    form = (
      <>
        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <span className="text-slate-500">Tenant</span>
          <span className="font-medium text-slate-800">{s.config.tenantId || 'not set: edit the system in the Scope step'}</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <span className="text-slate-500">Admin consent</span>
          {s.config.consentGrantedAt ? (
            <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
              <CheckCircle2 className="size-4" /> Granted {fmtDateTime(s.config.consentGrantedAt)}
            </span>
          ) : (
            <span className="font-medium text-amber-700">Pending</span>
          )}
        </div>
        <Button
          variant="secondary"
          icon={<Link2 className="size-4" />}
          disabled={!s.config.tenantId || busy}
          onClick={() =>
            run(async () => {
              const r = await post<{ url: string }>(`${base}/consent-url`);
              setConsentUrl(r.url);
            })
          }
        >
          Generate consent link
        </Button>
        {consentUrl && (
          <div className="rounded-lg bg-brand-50 p-3 text-xs text-brand-900 ring-1 ring-brand-100">
            <p className="mb-2">Valid for 60 minutes and single use. The admin is redirected back here after consenting; you must be signed in in that browser to complete it, otherwise just open it yourself during a screen share.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate">{consentUrl}</code>
              <CopyButton value={consentUrl} />
              <a href={consentUrl} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline">
                Open <ExternalLink className="size-3" />
              </a>
            </div>
          </div>
        )}
      </>
    );
  } else if (isMs) {
    guide = <MsAppGuide azure={s.provider === 'azure'} />;
    form = (
      <>
        <Field label="Application (client) ID">
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
        </Field>
        {secretInput('clientSecret', 'Client secret value')}
      </>
    );
  } else if (s.provider === 'github') {
    guide = <GithubGuide />;
    form = secretInput('token', 'Personal access token', { placeholder: 'github_pat_...' });
  }

  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-slate-100 px-6 py-4">
        <ProviderIcon provider={s.provider} className="size-8" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-slate-900">{s.label}</div>
          <div className="text-xs text-slate-500">
            {PROVIDER_LABELS[s.provider]} · {authModes(s.provider).find((m) => m.id === mode)?.label}
          </div>
        </div>
        <StatusPill s={s} />
      </div>
      <div className={clsx('grid gap-0', guide && 'lg:grid-cols-5')}>
        {guide && (
          <div className="border-b border-slate-100 p-6 lg:col-span-3 lg:border-b-0 lg:border-r">
            <button type="button" aria-expanded={showGuide} className="mb-4 flex w-full items-center gap-2 text-sm font-semibold text-slate-800" onClick={() => setShowGuide(!showGuide)}>
              <BookOpen className="size-4 text-brand-600" /> How to get access
              <ChevronDown className={clsx('ml-auto size-4 text-slate-400 transition', showGuide && 'rotate-180')} />
            </button>
            {showGuide ? guide : <p className="text-xs text-slate-500">Expand for step-by-step instructions you can share with the tenant or account administrator.</p>}
          </div>
        )}
        <div className={clsx('space-y-4 p-6', guide && 'lg:col-span-2')}>
          {form}
          {s.credential && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <Lock className="size-3.5" />
              <span className="flex-1">
                Stored encrypted: {s.credential.hint}
                {s.credential.expiresAt && <> · auto-delete {fmtDateTime(s.credential.expiresAt)}</>}
              </span>
              <AsyncButton
                variant="ghost"
                size="sm"
                className="px-1.5 py-1 text-emerald-800 hover:bg-emerald-100"
                title="Delete secret now"
                aria-label={`Delete stored secret for ${s.label}`}
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  await del(`${base}/credentials`);
                  await refresh();
                }}
                success="Stored secret deleted."
                confirm={{
                  title: 'Delete stored secret',
                  body: <>The stored secret for <strong>{s.label}</strong> is deleted now. You need to enter it again before the connection can be tested or the scan can run.</>,
                  confirmLabel: 'Delete secret',
                  danger: true,
                }}
              />
            </div>
          )}
          {s.connection && (
            <Alert tone={s.connection.ok ? 'success' : 'error'} title={s.connection.ok ? 'Connection verified' : 'Connection failed'}>
              {s.connection.message}
              <div className="mt-1 text-[11px] opacity-70">Tested {fmtDateTime(s.connection.checkedAt)}</div>
            </Alert>
          )}
          <Button className="w-full" onClick={saveAndTest} loading={busy} icon={mode === 'demo' ? <ShieldCheck className="size-4" /> : <KeyRound className="size-4" />}>
            {s.needsSecret && Object.values(secret).some(Boolean) ? 'Save securely and test' : 'Test connection'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function StepCredentials({ scan, refresh, next, back, navigating }: StepProps) {
  const pending = scan.systems.filter((s) => !systemReady(s));
  const ready = scan.systems.length > 0 && !pending.length;
  return (
    <div className="space-y-6">
      <Retention scan={scan} refresh={refresh} />
      {!scan.systems.length && <Alert tone="warn">No systems in scope yet. Go back to the Scope step and add at least one system.</Alert>}
      {scan.systems.map((s) => (
        <SystemAccess key={s.id} scan={scan} s={s} refresh={refresh} />
      ))}
      <WizardFooter
        onBack={back}
        onNext={next}
        loading={navigating}
        disabled={!ready}
        extra={
          !ready && (
            <span className="truncate text-xs text-slate-600" title={pending.map((s) => s.label).join(', ')}>
              {scan.systems.length ? <>Still to test: <span className="font-medium text-slate-800">{pending.map((s) => s.label).join(', ')}</span></> : 'Add at least one system first.'}
            </span>
          )
        }
      />
    </div>
  );
}
