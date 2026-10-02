import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, KeyRound, ListChecks, Rocket, Server, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { AsyncButton, useAction } from '../../components/feedback';
import { Button, ErrorState, PageHeader, PageLoader } from '../../components/ui';
import { del, get, patch } from '../../lib/api';
import { useCan } from '../../lib/auth';
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
  /** Steps with local unsaved state set this; the wizard awaits it before switching steps. */
  saveRef: RefObject<(() => Promise<unknown>) | null>;
  navigating: boolean;
}

export const systemReady = (s: WizardSystem) => s.config.authMode === 'demo' || Boolean(s.connection?.ok);

/** Registers a step's save function with the wizard while the step is mounted. */
export function useStepSave(saveRef: StepProps['saveRef'], save: () => Promise<unknown>) {
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(
    () => () => {
      saveRef.current = null;
    },
    [saveRef],
  );
}

/** Why step i cannot be opened yet, or null when it can. */
function lockReason(scan: WizardScan, i: number): string | null {
  if (i >= 1 && !scan.systems.length) return 'Add at least one system in the Scope step first';
  if (i >= 2 && !scan.systems.every(systemReady)) return 'Every system needs a successful connection test first';
  return null;
}

/**
 * The customer context and risk profile come from the customer record, so the wizard starts at Scope.
 * The stored wizardStep still counts the former context step as 0, hence the offset.
 */
const STEP_OFFSET = 1;
const reached = (scan: WizardScan) => Math.max(0, scan.wizardStep - STEP_OFFSET);

const STEPS = [
  { label: 'Scope', desc: 'Systems', icon: Server },
  { label: 'Access', desc: 'Credentials', icon: KeyRound },
  { label: 'Criteria', desc: 'What to evaluate', icon: ListChecks },
  { label: 'Launch', desc: 'Authorise & run', icon: Rocket },
];

export function WizardFooter({ onBack, onNext, nextLabel = 'Continue', disabled, loading, extra }: { onBack?: () => void; onNext(): void; nextLabel?: string; disabled?: boolean; loading?: boolean; extra?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-8 mt-8 flex items-center justify-between gap-4 border-t border-slate-200 bg-white px-8 py-4 shadow-[0_-4px_12px_-8px_rgba(15,23,42,0.15)]">
      <div>{onBack && <Button variant="secondary" onClick={onBack}>Back</Button>}</div>
      <div className="flex min-w-0 items-center gap-3">
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
  const nav = useNavigate();
  const qc = useQueryClient();
  const run = useAction();
  const can = useCan();
  const q = useQuery({ queryKey: ['scan', scanId], queryFn: () => get<WizardScan>(`/api/scans/${scanId}`) });
  const [step, setStep] = useState<number | null>(null);
  const [navigating, setNavigating] = useState(false);
  const saveRef = useRef<(() => Promise<unknown>) | null>(null);

  useEffect(() => {
    if (!q.data || step !== null) return;
    let s = Math.min(reached(q.data), STEPS.length - 1);
    while (s > 0 && lockReason(q.data, s)) s--;
    setStep(s);
  }, [q.data, step]);

  if (q.isError && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data || step === null) return <PageLoader />;
  const scan = q.data;
  if (scan.status !== 'draft') return <Navigate to={`/scans/${scan.id}/${scan.status === 'completed' || scan.status === 'cancelled' ? 'report' : 'progress'}`} replace />;

  const go = async (n: number) => {
    if (n === step || n < 0 || n >= STEPS.length || navigating || lockReason(scan, n)) return;
    const save = saveRef.current;
    if (save) {
      setNavigating(true);
      const ok = await run(save);
      setNavigating(false);
      if (!ok) return;
    }
    setStep(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (n > reached(scan)) void run(async () => {
      await patch(`/api/scans/${scan.id}`, { wizardStep: n + STEP_OFFSET });
      await q.refetch();
    });
  };
  const props: StepProps = { scan, refresh: () => q.refetch(), next: () => void go(step + 1), back: () => void go(step - 1), saveRef, navigating };

  const discard = async () => {
    await del(`/api/scans/${scan.id}`);
    nav(`/customers/${scan.customer.id}`, { replace: true });
    qc.removeQueries({ queryKey: ['scan', scan.id] });
    void qc.invalidateQueries({ queryKey: ['customer', scan.customer.id] });
  };

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
        actions={
          can.write && (
            <AsyncButton
              variant="ghost"
              size="sm"
              className="text-red-600 hover:bg-red-50"
              icon={<Trash2 className="size-3.5" />}
              onClick={discard}
              success="Draft discarded."
              confirm={{
                title: 'Discard draft',
                body: <>The draft scan <strong>{scan.name}</strong> is deleted, together with its systems and any stored credentials. This cannot be undone.</>,
                confirmLabel: 'Discard',
                danger: true,
              }}
            >
              Discard draft
            </AsyncButton>
          )
        }
      />
      <nav aria-label="Scan wizard steps" className="mb-8 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-slate-200/70">
        <ol className="grid grid-cols-4 gap-1">
          {STEPS.map((s, i) => {
            const done = i < step;
            const lock = lockReason(scan, i) ?? (i > reached(scan) ? 'Complete the previous steps first' : null);
            const current = i === step;
            const Icon = s.icon;
            return (
              <li key={s.label}>
                <button
                  type="button"
                  aria-current={current ? 'step' : undefined}
                  aria-disabled={lock && !current ? true : undefined}
                  aria-label={`Step ${i + 1}: ${s.label}${lock && !current ? ` (${lock})` : ''}`}
                  title={lock && !current ? lock : undefined}
                  onClick={() => !lock && void go(i)}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                    current ? 'bg-brand-50' : lock ? 'cursor-not-allowed opacity-50' : 'hover:bg-slate-50',
                  )}
                >
                  <span
                    className={clsx(
                      'flex size-8 shrink-0 items-center justify-center rounded-lg',
                      current ? 'bg-brand-600 text-white' : done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500',
                    )}
                  >
                    {done ? <Check className="size-4" aria-hidden /> : <Icon className="size-4" aria-hidden />}
                  </span>
                  <span className="hidden min-w-0 md:block">
                    <span className={clsx('block truncate text-sm font-semibold', current ? 'text-brand-700' : 'text-slate-800')}>{s.label}</span>
                    <span className="block truncate text-xs text-slate-500">{s.desc}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <div key={step} className="animate-fade-in">
        {step === 0 && <StepScope {...props} />}
        {step === 1 && <StepCredentials {...props} />}
        {step === 2 && <StepCriteria {...props} />}
        {step === 3 && <StepLaunch {...props} />}
      </div>
    </>
  );
}
