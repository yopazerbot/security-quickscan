import { PROVIDER_LABELS } from '@qs/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleDashed, FlaskConical, Rocket, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ProviderIcon } from '../../components/ProviderIcon';
import { useAction } from '../../components/feedback';
import { Alert, Card } from '../../components/ui';
import { get, post } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { WizardFooter, systemReady, type StepProps, type WizardSystem } from './ScanWizard';

const RETENTION_LABEL: Record<string, string> = {
  purge_on_completion: 'Deleted when the scan completes',
  days: 'Kept for a limited number of days',
  manual: 'Kept until manually deleted',
};

function SystemStatus({ s }: { s: WizardSystem }) {
  if (s.config.authMode === 'demo') return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700"><FlaskConical className="size-3.5" aria-hidden /> Simulated</span>;
  if (!s.connection) return <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500"><CircleDashed className="size-3.5" aria-hidden /> Not tested</span>;
  return s.connection.ok ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700" title={`Tested ${fmtDateTime(s.connection.checkedAt)}`}><ShieldCheck className="size-3.5" aria-hidden /> Connected</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700" title={s.connection.message}><XCircle className="size-3.5" aria-hidden /> Test failed</span>
  );
}

export function StepLaunch({ scan, back, navigating }: StepProps) {
  const nav = useNavigate();
  const run = useAction();
  const crit = useQuery({ queryKey: ['criteria', scan.id], queryFn: () => get<any[]>(`/api/scans/${scan.id}/criteria`) });
  const [busy, setBusy] = useState(false);
  const included = (crit.data ?? []).filter((c) => c.included).length;
  const unreadySystems = scan.systems.filter((s) => !systemReady(s));

  const start = async () => {
    setBusy(true);
    const ok = await run(() => post(`/api/scans/${scan.id}/start`));
    if (ok) nav(`/scans/${scan.id}/progress`);
    else setBusy(false);
  };

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Summary" subtitle="Check the scope before you start the scan.">
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
              <dd className="font-medium">{crit.data ? `${included} checks` : '...'}</dd>
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

        <div className="space-y-6 lg:col-span-2">
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
        disabled={unreadySystems.length > 0 || navigating}
        nextLabel="Start scan"
        extra={<Rocket className="size-5 text-brand-500" aria-hidden />}
      />
    </>
  );
}
