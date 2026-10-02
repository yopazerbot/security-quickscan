import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, Check, KeyRound, ListChecks, Rocket, Server } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { Button, PageHeader, PageLoader } from '../../components/ui';
import { get, patch } from '../../lib/api';
import { StepContext } from './StepContext';
import { StepCredentials } from './StepCredentials';
import { StepCriteria } from './StepCriteria';
import { StepLaunch } from './StepLaunch';
import { StepScope } from './StepScope';

export interface WizardScan {
  id: string;
  name: string;
  status: string;
  wizardStep: number;
  context: any;
  riskProfile: any;
  retentionMode: 'purge_on_completion' | 'days' | 'manual';
  retentionDays: number | null;
  authorization: any;
  hasAuthorizationDoc: boolean;
  authorizationDocName: string | null;
  customer: { id: string; name: string };
  systems: WizardSystem[];
}

export interface WizardSystem {
  id: string;
  provider: 'm365' | 'azure' | 'aws' | 'github';
  label: string;
  config: any;
  needsSecret: boolean;
  credential: { hint: string; expiresAt: string | null; createdAt: string } | null;
  connection: { ok: boolean; message: string; details: any; checkedAt: string } | null;
}

export interface StepProps {
  scan: WizardScan;
  refresh(): Promise<unknown>;
  next(): void;
  back(): void;
}

const STEPS = [
  { label: 'Context', desc: 'Risk profile', icon: Building2 },
  { label: 'Scope', desc: 'Systems', icon: Server },
  { label: 'Access', desc: 'Credentials', icon: KeyRound },
  { label: 'Criteria', desc: 'What to evaluate', icon: ListChecks },
  { label: 'Launch', desc: 'Authorise & run', icon: Rocket },
];

export function WizardFooter({ onBack, onNext, nextLabel = 'Continue', disabled, loading, extra }: { onBack?: () => void; onNext(): void; nextLabel?: string; disabled?: boolean; loading?: boolean; extra?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-8 mt-8 flex items-center justify-between border-t border-slate-200 bg-slate-50/90 px-8 py-4 backdrop-blur">
      <div>{onBack && <Button variant="secondary" onClick={onBack}>Back</Button>}</div>
      <div className="flex items-center gap-3">
        {extra}
        <Button onClick={onNext} disabled={disabled} loading={loading} size="lg">
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}

export function ScanWizard() {
  const { scanId } = useParams();
  const q = useQuery({ queryKey: ['scan', scanId], queryFn: () => get<WizardScan>(`/api/scans/${scanId}`) });
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    if (q.data && step === null) setStep(Math.min(q.data.wizardStep, STEPS.length - 1));
  }, [q.data, step]);

  if (q.isLoading || !q.data || step === null) return <PageLoader />;
  const scan = q.data;
  if (scan.status !== 'draft') return <Navigate to={`/scans/${scan.id}/${scan.status === 'completed' || scan.status === 'cancelled' ? 'report' : 'progress'}`} replace />;

  const go = (n: number) => {
    setStep(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (n > scan.wizardStep) void patch(`/api/scans/${scan.id}`, { wizardStep: n }).then(() => q.refetch());
  };
  const props: StepProps = { scan, refresh: () => q.refetch(), next: () => go(step + 1), back: () => go(step - 1) };

  return (
    <>
      <PageHeader
        crumbs={
          <>
            <Link to="/customers" className="hover:text-slate-700">Customers</Link> /{' '}
            <Link to={`/customers/${scan.customer.id}`} className="hover:text-slate-700">{scan.customer.name}</Link>
          </>
        }
        title="New quick scan"
        subtitle={scan.name}
      />
      <nav className="mb-8 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-slate-200/70">
        <ol className="grid grid-cols-5 gap-1">
          {STEPS.map((s, i) => {
            const done = i < step;
            const reachable = i <= scan.wizardStep;
            const Icon = s.icon;
            return (
              <li key={s.label}>
                <button
                  disabled={!reachable}
                  onClick={() => reachable && go(i)}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition',
                    i === step ? 'bg-brand-50' : reachable ? 'hover:bg-slate-50' : 'cursor-default opacity-50',
                  )}
                >
                  <span
                    className={clsx(
                      'flex size-8 shrink-0 items-center justify-center rounded-lg',
                      i === step ? 'bg-brand-600 text-white' : done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500',
                    )}
                  >
                    {done ? <Check className="size-4" /> : <Icon className="size-4" />}
                  </span>
                  <span className="hidden min-w-0 md:block">
                    <span className={clsx('block truncate text-sm font-semibold', i === step ? 'text-brand-700' : 'text-slate-800')}>{s.label}</span>
                    <span className="block truncate text-xs text-slate-500">{s.desc}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <div key={step} className="animate-fade-in">
        {step === 0 && <StepContext {...props} />}
        {step === 1 && <StepScope {...props} />}
        {step === 2 && <StepCredentials {...props} />}
        {step === 3 && <StepCriteria {...props} />}
        {step === 4 && <StepLaunch {...props} />}
      </div>
    </>
  );
}
