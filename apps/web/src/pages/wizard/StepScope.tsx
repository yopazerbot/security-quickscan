import { GITHUB_ORG_HINT, GITHUB_ORG_RE, PROVIDER_LABELS, type Provider } from '@qs/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { ProviderIcon } from '../../components/ProviderIcon';
import { AsyncButton, useToast } from '../../components/feedback';
import { Alert, Button, Card, Field, Input, Modal } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { WizardFooter, type StepProps, type WizardSystem } from './ScanWizard';

export interface Platform {
  awsPrincipal: string | null;
  awsError: string | null;
  msClientId: string | null;
  consentRedirectUri: string;
  demo: boolean;
}

export const usePlatform = () => useQuery({ queryKey: ['platform'], queryFn: () => get<Platform>('/api/platform'), staleTime: 300_000 });

const PROVIDER_INFO: Record<Provider, { desc: string; covers: string }> = {
  m365: { desc: 'Identity, Conditional Access, admin roles, app consent, mail domains', covers: '18 checks' },
  azure: { desc: 'Defender for Cloud, storage, Key Vault, network, RBAC', covers: '9 checks' },
  aws: { desc: 'IAM, CloudTrail, GuardDuty, S3, EC2, RDS, KMS', covers: '21 checks' },
  github: { desc: 'Org security, branch protection, secrets, Dependabot, Actions', covers: '16 checks' },
};

type Mode = { id: string; label: string; desc: string; recommended?: boolean; available: boolean; why?: string };

export function authModes(provider: Provider, p?: Platform): Mode[] {
  const demo: Mode = { id: 'demo', label: 'Demo (simulated)', desc: 'Generates realistic sample results without connecting.', available: Boolean(p?.demo) };
  if (provider === 'aws')
    return [
      { id: 'assume_role', label: 'Cross-account IAM role', desc: 'A read-only role with an external ID is deployed in the account. No secrets shared.', recommended: true, available: Boolean(p?.awsPrincipal), why: 'Platform AWS identity not configured' },
      { id: 'access_keys', label: 'Access keys', desc: 'Temporary or dedicated read-only access keys.', available: true },
      demo,
    ];
  if (provider === 'github') return [{ id: 'token', label: 'Personal access token', desc: 'Fine-grained, read-only, short expiry.', recommended: true, available: true }, demo];
  return [
    { id: 'admin_consent', label: 'Admin consent', desc: 'A tenant admin consents to the read-only scanner app. No secrets shared.', recommended: true, available: Boolean(p?.msClientId), why: 'Platform scanner app not configured' },
    { id: 'app_secret', label: 'App registration in the tenant', desc: 'An app registration created in the tenant, with read permissions and a short-lived secret.', available: true },
    demo,
  ];
}

function SystemForm({ provider, system, scanId, onClose, onSaved }: { provider: Provider; system?: WizardSystem; scanId: string; onClose(): void; onSaved(): void }) {
  const platform = usePlatform();
  const { me } = useAuth();
  const toast = useToast();
  const methodName = useId();
  const modes = authModes(provider, platform.data).map((m) => (me?.user.isDemo && m.id !== 'demo' ? { ...m, available: false, why: 'Not available in a demo session' } : m));
  const firstAvail = modes.find((m) => m.available && m.recommended)?.id ?? modes.find((m) => m.available)?.id ?? modes[0].id;
  const c = system?.config ?? {};
  const [label, setLabel] = useState(system?.label ?? PROVIDER_LABELS[provider]);
  const [mode, setMode] = useState<string>(c.authMode ?? firstAvail);
  const [tenantId, setTenantId] = useState(c.tenantId ?? '');
  const [subs, setSubs] = useState((c.subscriptionIds ?? []).join(', '));
  const [accountId, setAccountId] = useState(c.accountId ?? '');
  const [regions, setRegions] = useState((c.regions ?? []).join(', '));
  const [org, setOrgRaw] = useState(c.org ?? '');
  const [orgTouched, setOrgTouched] = useState(false);
  const setOrg = (v: string) => {
    setOrgTouched(true);
    setOrgRaw(v);
  };
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orgError =
    provider === 'github' && ((org && !GITHUB_ORG_RE.test(org)) || (!org && mode !== 'demo') && orgTouched) ? GITHUB_ORG_HINT : undefined;
  const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

  // Edits the server treats as a new target: the stored secret is deleted and the connection must be tested again.
  const hasSecret = Boolean(system?.credential);
  const modeChanged = Boolean(system) && mode !== c.authMode;
  const targetChanged =
    Boolean(system) &&
    mode !== 'demo' &&
    ((provider === 'github' && org.trim() !== (c.org ?? '')) ||
      ((provider === 'm365' || provider === 'azure') && (tenantId.trim() || undefined) !== (c.tenantId || undefined)) ||
      (provider === 'aws' && (accountId.trim() || undefined) !== (c.accountId || undefined)));

  const save = async () => {
    setBusy(true);
    setErr(null);
    let config: any = { authMode: mode };
    if (provider === 'm365' || provider === 'azure') config = { ...config, tenantId: tenantId.trim() || undefined, clientId: c.clientId, subscriptionIds: provider === 'azure' ? list(subs) : [] };
    if (provider === 'aws') config = { ...config, accountId: accountId.trim() || undefined, roleArn: c.roleArn, regions: list(regions) };
    if (provider === 'github') config = { ...config, org: org.trim() };
    try {
      if (system) {
        const r = await patch<{ ok: boolean; connectionReset?: boolean; credentialsPurged?: boolean }>(`/api/scans/${scanId}/systems/${system.id}`, { label, config });
        if (r.credentialsPurged) toast.success(`${label} saved. The stored secret was deleted: enter it again in the Access step.`);
        else if (r.connectionReset && system.connection) toast.success(`${label} saved. Test the connection again in the Access step.`);
        else toast.success(`${label} saved.`);
      } else await post(`/api/scans/${scanId}/systems`, { provider, label, config });
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={
        <span className="flex items-center gap-2">
          <ProviderIcon provider={provider} /> {system ? 'Edit' : 'Add'} {PROVIDER_LABELS[provider]}
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={Boolean(orgError)}>{system ? 'Save' : 'Add system'}</Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Display name" hint="Used in the report, e.g. 'Production AWS' or 'Contoso tenant'.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
        </Field>
        {(provider === 'm365' || provider === 'azure') && mode !== 'demo' && (
          <Field label="Tenant ID or primary domain" hint="e.g. contoso.onmicrosoft.com or the tenant GUID">
            <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
          </Field>
        )}
        {provider === 'azure' && mode !== 'demo' && (
          <Field label="Subscription IDs (optional)" hint="Leave empty to scan all subscriptions the scanner can read.">
            <Input value={subs} onChange={(e) => setSubs(e.target.value)} placeholder="comma separated GUIDs" />
          </Field>
        )}
        {provider === 'aws' && mode !== 'demo' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="AWS account ID" hint="12 digits. Verified against the credentials.">
              <Input value={accountId} onChange={(e) => setAccountId(e.target.value.replace(/\D/g, ''))} maxLength={12} />
            </Field>
            <Field label="Regions (optional)" hint="Empty: all enabled regions.">
              <Input value={regions} onChange={(e) => setRegions(e.target.value)} placeholder="eu-west-1, eu-central-1" />
            </Field>
          </div>
        )}
        {provider === 'github' && (
          <Field
            label={mode === 'demo' ? 'Organisation (optional for a simulated system)' : 'Organisation'}
            hint="The login from the address github.com/<login>, e.g. 'contoso'."
            error={orgError}
          >
            <Input value={org} onChange={(e) => setOrg(e.target.value)} maxLength={39} placeholder={mode === 'demo' ? 'demo-org' : 'contoso'} />
          </Field>
        )}
        <div role="radiogroup" aria-labelledby={`${methodName}-label`}>
          <div id={`${methodName}-label`} className="mb-2 text-sm font-medium text-slate-700">
            Access method
          </div>
          <div className="grid gap-2">
            {modes.map((m) => (
              <label
                key={m.id}
                className={clsx(
                  'flex items-start gap-3 rounded-xl p-3 text-left ring-1 transition focus-within:ring-2 focus-within:ring-brand-500',
                  mode === m.id ? 'bg-brand-50 ring-2 ring-brand-500' : 'bg-white ring-slate-200 hover:ring-slate-300',
                  m.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                )}
              >
                <input type="radio" name={methodName} value={m.id} checked={mode === m.id} disabled={!m.available} onChange={() => setMode(m.id)} className="sr-only" />
                <span aria-hidden className={clsx('mt-0.5 size-4 shrink-0 rounded-full border-4', mode === m.id ? 'border-brand-600 bg-white' : 'border-slate-200')} />
                <span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    {m.label}
                    {m.recommended && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">Recommended</span>}
                  </span>
                  <span className="block text-xs text-slate-600">{m.available ? m.desc : m.why}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        {modeChanged && hasSecret && (
          <Alert tone="warn" live>
            Changing the access method deletes the stored secret.
          </Alert>
        )}
        {targetChanged && !(modeChanged && hasSecret) && (
          <Alert tone="warn" live>
            {hasSecret
              ? 'Changing the tenant, organisation or account deletes the stored secret and needs a new connection test.'
              : 'Changing the tenant, organisation or account needs a new connection test.'}
          </Alert>
        )}
        {err && (
          <Alert tone="error" live>
            {err}
          </Alert>
        )}
      </div>
    </Modal>
  );
}

export function StepScope({ scan, refresh, next, navigating }: StepProps) {
  const [adding, setAdding] = useState<Provider | null>(null);
  const [editing, setEditing] = useState<WizardSystem | null>(null);

  return (
    <>
      <Card title="Which systems are in scope?" subtitle="Add one or more environments. You can add the same platform more than once (e.g. several AWS accounts).">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {(Object.keys(PROVIDER_INFO) as Provider[]).map((p) => {
            const count = scan.systems.filter((s) => s.provider === p).length;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setAdding(p)}
                className={clsx(
                  'group flex flex-col rounded-2xl p-5 text-left ring-1 transition hover:-translate-y-0.5 hover:shadow-md',
                  count ? 'bg-brand-50/50 ring-brand-200' : 'bg-white ring-slate-200',
                )}
              >
                <div className="flex items-center justify-between">
                  <ProviderIcon provider={p} className="size-8" />
                  {count > 0 && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">{count} added</span>}
                </div>
                <div className="mt-4 text-sm font-semibold text-slate-900">{PROVIDER_LABELS[p]}</div>
                <div className="mt-1 flex-1 text-xs leading-relaxed text-slate-500">{PROVIDER_INFO[p].desc}</div>
                <div className="mt-4 flex items-center justify-between text-xs">
                  <span className="text-slate-500">{PROVIDER_INFO[p].covers}</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-brand-600 group-hover:text-brand-700">
                    <Plus className="size-3.5" /> Add
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {scan.systems.length > 0 && (
        <Card className="mt-6" title={`In scope (${scan.systems.length})`}>
          <ul className="-m-6 divide-y divide-slate-100">
            {scan.systems.map((s) => (
              <li key={s.id} className="flex items-center gap-4 px-6 py-3.5">
                <ProviderIcon provider={s.provider} className="size-7" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900">{s.label}</div>
                  <div className="truncate text-xs text-slate-500">
                    {[s.config.tenantId, s.config.accountId, s.config.org, authModes(s.provider).find((m) => m.id === s.config.authMode)?.label].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Button variant="ghost" size="sm" icon={<Pencil className="size-3.5" />} aria-label={`Edit ${s.label}`} onClick={() => setEditing(s)}>Edit</Button>
                <AsyncButton
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:bg-red-50"
                  icon={<Trash2 className="size-3.5" />}
                  aria-label={`Remove ${s.label}`}
                  onClick={async () => {
                    await del(`/api/scans/${scan.id}/systems/${s.id}`);
                    await refresh();
                  }}
                  success={`${s.label} removed.`}
                  confirm={{
                    title: 'Remove system?',
                    body: <><strong>{s.label}</strong> is removed from this scan. Any stored credentials for it are deleted.</>,
                    confirmLabel: 'Remove',
                    danger: true,
                  }}
                >
                  Remove
                </AsyncButton>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {adding && <SystemForm provider={adding} scanId={scan.id} onClose={() => setAdding(null)} onSaved={async () => { setAdding(null); await refresh(); }} />}
      {editing && <SystemForm provider={editing.provider} system={editing} scanId={scan.id} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} />}
      <WizardFooter
        onNext={next}
        loading={navigating}
        disabled={!scan.systems.length}
        extra={!scan.systems.length && <span className="text-xs text-slate-500">Add at least one system to continue.</span>}
      />
    </>
  );
}
