import { CHECKS, PROVIDER_LABELS, type Provider } from '@qs/shared';
import { CircleDashed, FlaskConical, Rocket, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ProviderIcon } from '../../components/ProviderIcon';
import { useAction } from '../../components/feedback';
import { Alert, Card } from '../../components/ui';
import { post } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { WizardFooter, systemReady, type StepProps, type WizardSystem } from './ScanWizard';

/** What happens to stored secrets, in exact terms. */
function retentionLabel(scan: StepProps['scan']): string {
  if (scan.retentionMode === 'purge_on_completion') return 'Deleted automatically when the scan finishes';
  if (scan.retentionMode === 'days')
    return scan.retentionDays ? `Kept for ${scan.retentionDays} ${scan.retentionDays === 1 ? 'day' : 'days'}, then deleted automatically` : 'Kept for a set number of days, then deleted automatically';
  return 'Kept until someone deletes them';
}

/** Every check for a platform runs: there is no selection of criteria. */
const checksPerProvider = (p: Provider) => CHECKS.filter((c) => c.provider === p).length;
const plural = (n: number) => `${n} ${n === 1 ? 'check' : 'checks'}`;

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
  const [busy, setBusy] = useState(false);
  const total = scan.systems.reduce((n, s) => n + checksPerProvider(s.provider), 0);
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
        <Card className="lg:col-span-3" title="Summary" subtitle="Every best-practice check for these systems runs. Mark findings that do not apply afterwards in the report.">
          <ul className="space-y-3">
            {scan.systems.map((s) => (
              <li key={s.id} className="flex items-center gap-3">
                <ProviderIcon provider={s.provider} className="size-6" decorative />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">{s.label}</div>
                  <div className="text-xs text-slate-500">
                    {PROVIDER_LABELS[s.provider]} · {plural(checksPerProvider(s.provider))}
                  </div>
                </div>
                <SystemStatus s={s} />
              </li>
            ))}
          </ul>
          <dl className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Checks to run</dt>
              <dd className="font-medium">{plural(total)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Secrets</dt>
              <dd className="text-right font-medium">{retentionLabel(scan)}</dd>
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
