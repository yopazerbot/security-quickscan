import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, KeyRound, Rocket, Server, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { AsyncButton, useAction } from '../../components/feedback';
import { Button, ErrorState, PageHeader, PageLoader } from '../../components/ui';
import { ApiError, del, get, patch } from '../../lib/api';
import { accessCan, type CustomerAccess } from '../../lib/auth';
import { useDocumentTitle } from '../../lib/use-document-title';
import { StepCredentials } from './StepCredentials';
import { StepLaunch } from './StepLaunch';
import { StepScope } from './StepScope';

export interface WizardScan {
  id: string;
  name: string;
  status: string;
  wizardStep: number;
  retentionMode: 'purge_on_completion' | 'days' | 'manual';
  retentionDays: number | null;
  customer: { id: string; name: string; myAccess: CustomerAccess | null };
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
 * The stored wizardStep still counts the former context step as 0, hence the offset. Drafts saved at the former
 * Criteria step (stored 3) or Review step (stored 4) open at Review, which is the last step now.
 */
const STEP_OFFSET = 1;
const reached = (scan: WizardScan) => Math.max(0, scan.wizardStep - STEP_OFFSET);

const STEPS = [
  { id: 'scope', label: 'Scope', desc: 'Systems', icon: Server },
  { id: 'access', label: 'Access', desc: 'Credentials', icon: KeyRound },
  { id: 'review', label: 'Review', desc: 'Check and start', icon: Rocket },
];

/** Scroll behaviour that respects the user's reduced-motion setting. */
export const scrollBehavior = (): ScrollBehavior => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

export function WizardFooter({ onBack, onNext, nextLabel = 'Continue', disabled, loading, extra }: { onBack?: () => void; onNext(): void; nextLabel?: string; disabled?: boolean; loading?: boolean; extra?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-4 shadow-[0_-4px_12px_-8px_rgba(15,23,42,0.15)] sm:-mx-8 sm:gap-4 sm:px-8">
      <div>{onBack && <Button variant="secondary" onClick={onBack}>Back</Button>}</div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
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
  const q = useQuery({ queryKey: ['scan', scanId], queryFn: () => get<WizardScan>(`/api/scans/${scanId}`) });
  const [params, setParams] = useSearchParams();
  const [step, setStep] = useState<number | null>(null);
  const [navigating, setNavigating] = useState(false);
  const saveRef = useRef<(() => Promise<unknown>) | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  useDocumentTitle(q.data ? `New quick scan: ${q.data.customer.name}` : 'New quick scan');

  useEffect(() => {
    if (!q.data || step !== null) return;
    // ?step=review (e.g. returning from the organisation form) opens that step when it is reachable.
    const asked = STEPS.findIndex((x) => x.id === params.get('step'));
    let s = asked >= 0 && asked <= reached(q.data) ? asked : Math.min(reached(q.data), STEPS.length - 1);
    while (s > 0 && lockReason(q.data, s)) s--;
    setStep(s);
    if (params.has('step')) {
      const p = new URLSearchParams(params);
      p.delete('step');
      setParams(p, { replace: true });
    }
  }, [q.data, step, params, setParams]);

  // A write was refused with 403 or 404: access may have been removed, so reload the scan (which then shows why).
  const refetchScan = q.refetch;
  useEffect(() => {
    const onDenied = () => void refetchScan();
    window.addEventListener('qs:access-denied', onDenied);
    return () => window.removeEventListener('qs:access-denied', onDenied);
  }, [refetchScan]);

  // After a step change, move focus to the new step's heading: the button that was pressed is gone.
  useEffect(() => {
    if (step === null || !focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const lostAccess = q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404);
  if (q.isError && (!q.data || lostAccess)) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data || step === null) return <PageLoader />;
  const scan = q.data;
  if (scan.status !== 'draft') return <Navigate to={`/scans/${scan.id}/${scan.status === 'completed' || scan.status === 'cancelled' ? 'report' : 'progress'}`} replace />;
  // View-only access cannot edit a draft, so send the user back to the organisation.
  if (!accessCan(scan.customer.myAccess).edit) return <Navigate to={`/organisations/${scan.customer.id}`} replace />;

  const go = async (n: number) => {
    if (n === step || n < 0 || n >= STEPS.length || navigating || lockReason(scan, n)) return;
    const save = saveRef.current;
    if (save) {
      setNavigating(true);
      const ok = await run(save);
      setNavigating(false);
      if (!ok) return;
    }
    focusHeading.current = true;
    setStep(n);
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    if (n > reached(scan)) void run(async () => {
      await patch(`/api/scans/${scan.id}`, { wizardStep: n + STEP_OFFSET });
      await q.refetch();
    });
  };
  const props: StepProps = { scan, refresh: () => q.refetch(), next: () => void go(step + 1), back: () => void go(step - 1), saveRef, navigating };

  const discard = async () => {
    await del(`/api/scans/${scan.id}`);
    nav(`/organisations/${scan.customer.id}`, { replace: true });
    qc.removeQueries({ queryKey: ['scan', scan.id] });
    void qc.invalidateQueries({ queryKey: ['customer', scan.customer.id] });
  };

  return (
    <>
      <PageHeader
        crumbs={
          <>
            <Link to="/organisations" className="hover:text-slate-700">Organisations</Link> /{' '}
            <Link to={`/organisations/${scan.customer.id}`} className="hover:text-slate-700">{scan.customer.name}</Link>
          </>
        }
        title="New quick scan"
        subtitle={scan.name}
        actions={
          <AsyncButton
            variant="ghost"
            size="sm"
            className="text-red-600 hover:bg-red-50"
            icon={<Trash2 className="size-3.5" />}
            onClick={discard}
            success="Draft discarded."
            confirm={{
              title: 'Discard draft?',
              body: <>The draft scan <strong>{scan.name}</strong> is deleted, together with its systems and any stored credentials. This cannot be undone.</>,
              confirmLabel: 'Discard',
              danger: true,
            }}
          >
            Discard draft
          </AsyncButton>
        }
      />
      <nav aria-label="Scan wizard steps" className="mb-8 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-slate-200/70">
        <ol className="grid grid-cols-3 gap-1">
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
      <div key={step} className="motion-safe:animate-fade-in">
        <h2 ref={headingRef} tabIndex={-1} className="mb-4 text-lg font-semibold text-slate-900 focus:outline-none">
          <span className="text-slate-500">
            Step {step + 1} of {STEPS.length}:
          </span>{' '}
          {STEPS[step].label}
        </h2>
        {step === 0 && <StepScope {...props} />}
        {step === 1 && <StepCredentials {...props} />}
        {step === 2 && <StepLaunch {...props} />}
      </div>
    </>
  );
}
