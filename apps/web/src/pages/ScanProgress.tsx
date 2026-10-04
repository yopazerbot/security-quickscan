import { CHECKS_BY_ID, ISO_BY_ID, partialLabel, PROVIDER_LABELS } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, CircleStop, FileText, Loader2, PartyPopper, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AsyncButton } from '../components/feedback';
import { ProviderIcon } from '../components/ProviderIcon';
import { SystemBadge } from '../components/SystemBadge';
import { Alert, Button, Card, ErrorState, LinkButton, PageHeader, PageLoader, StatusBadge } from '../components/ui';
import { ApiError, get, post } from '../lib/api';
import { accessCan } from '../lib/auth';
import { fmtDuration, GRADE_HEX, NOT_ASSESSED_HEX, STATUS_STYLE } from '../lib/format';
import { systemIdentity } from '../lib/systems';
import { useDocumentTitle } from '../lib/use-document-title';
import type { WizardScan } from './wizard/ScanWizard';

interface Snapshot {
  status: string;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  results: { systemId: string; checkId: string; status: keyof typeof STATUS_STYLE; summary: string; finishedAt: string | null }[];
  live: {
    /** Null when too few checks could be assessed to grade. */
    score: number | null;
    grade: string | null;
    counts: Record<string, number>;
    severityCounts: Record<string, number>;
    coverage?: { assessed: number; inScope: number };
    partial?: boolean;
  };
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

/** Errors that will not go away by retrying: stop streaming and polling. */
const isFatal = (e: unknown) => e instanceof ApiError && [401, 403, 404].includes(e.status);

function useScanStream(scanId: string) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      es?.close();
      if (poll) clearInterval(poll);
      poll = null;
    };
    const startPolling = () => {
      if (poll || stopped) return;
      poll = setInterval(async () => {
        try {
          const s = await get<Snapshot>(`/api/scans/${scanId}/progress`);
          if (stopped) return;
          setSnap(s);
          if (TERMINAL.includes(s.status) && poll) clearInterval(poll);
        } catch (e) {
          // Signed out, access withdrawn or scan deleted: stop asking and show why.
          if (isFatal(e) && !stopped) {
            stop();
            setError(e as Error);
          }
        }
      }, 2500);
    };
    es = new EventSource(`/api/scans/${scanId}/events`);
    es.addEventListener('progress', (e) => {
      const s = JSON.parse((e as MessageEvent).data) as Snapshot;
      setSnap(s);
      if (TERMINAL.includes(s.status)) es?.close();
    });
    es.addEventListener('access_revoked', (e) => {
      let reason = 'access';
      try {
        reason = JSON.parse((e as MessageEvent).data)?.reason ?? 'access';
      } catch {
        // Keep the default reason.
      }
      stop();
      if (reason === 'session') {
        setError(new ApiError(401, 'Your session has ended. Sign in again to follow this scan.'));
        window.dispatchEvent(new Event('qs:unauthorized'));
      } else setError(new ApiError(403, 'You no longer have access to this organisation.'));
    });
    es.onerror = () => {
      es?.close();
      if (!stopped) startPolling();
    };
    return stop;
  }, [scanId]);
  return { snap, error };
}

function Ring({ pct, size = 168, stroke = 14, color, children }: { pct: number; size?: number; stroke?: number; color: string; children: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#eef2f7" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.6s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

/** Tile look per status: queued checks get a dashed outline so they never read as N/A (solid grey). */
function tileClass(status: Snapshot['results'][number]['status']) {
  if (status === 'pending') return 'border border-dashed border-slate-400 bg-white';
  return clsx(STATUS_STYLE[status].dot, status === 'running' && 'animate-pulse ring-2 ring-brand-300', status !== 'running' && 'animate-pop');
}

const LEGEND = ['pending', 'running', 'pass', 'warn', 'fail', 'na', 'error'] as const;

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ScanProgress() {
  const { scanId } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const scan = useQuery({ queryKey: ['scan', scanId], queryFn: () => get<WizardScan>(`/api/scans/${scanId}`) });
  const { snap, error: streamError } = useScanStream(scanId!);
  const active = Boolean(snap && !TERMINAL.includes(snap.status) && !streamError);
  const now = useNow(active);

  useEffect(() => {
    if (snap && TERMINAL.includes(snap.status)) {
      void qc.invalidateQueries({ queryKey: ['scan', scanId] });
      void qc.invalidateQueries({ queryKey: ['scans'] });
    }
  }, [snap?.status, qc, scanId, snap]);

  const bySystem = useMemo(() => {
    const m = new Map<string, Snapshot['results']>();
    for (const r of snap?.results ?? []) m.set(r.systemId, [...(m.get(r.systemId) ?? []), r]);
    return m;
  }, [snap]);

  const pageTitle = !snap
    ? 'Scan progress'
    : snap.status === 'completed'
      ? 'Scan finished'
      : snap.status === 'cancelled'
        ? 'Scan cancelled'
        : snap.status === 'failed'
          ? 'Scan failed'
          : snap.status === 'queued'
            ? 'Scan queued'
            : 'Scanning...';
  useDocumentTitle(pageTitle);

  if (streamError) return <ErrorState error={streamError} />;
  if (scan.error) return <ErrorState error={scan.error} onRetry={isFatal(scan.error) ? undefined : () => void scan.refetch()} />;
  if (!scan.data || !snap) return <PageLoader />;
  const total = snap.results.length;
  const done = snap.results.filter((r) => !['pending', 'running'].includes(r.status)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const elapsed = snap.startedAt ? (snap.finishedAt ? new Date(snap.finishedAt).getTime() : now) - new Date(snap.startedAt).getTime() : 0;
  const eta = done > 3 && active ? (elapsed / done) * (total - done) : null;
  const feed = snap.results
    .filter((r) => r.finishedAt && r.status !== 'pending' && r.status !== 'running')
    .sort((a, b) => (b.finishedAt! > a.finishedAt! ? 1 : -1))
    .slice(0, 8);
  const sysLabel = new Map(scan.data.systems.map((s) => [s.id, s]));
  const finished = snap.status === 'completed' || snap.status === 'cancelled';
  const failed = snap.status === 'failed';
  // A report needs at least one finished check; a scan cancelled before anything ran has nothing to show.
  const hasResults = done > 0;
  const customerUrl = `/organisations/${scan.data.customer.id}`;
  const can = accessCan(scan.data.customer.myAccess);
  const rescan = async () => {
    const r = await post<{ id: string }>(`/api/scans/${scanId}/rescan`);
    void qc.invalidateQueries({ queryKey: ['scans'] });
    nav(`/scans/${r.id}/wizard`);
  };
  const title = pageTitle;
  const statusText =
    snap.status === 'queued'
      ? 'Waiting for a scan worker...'
      : active
        ? 'Running read-only checks in parallel'
        : snap.status === 'completed'
          ? 'All checks have completed'
          : snap.status === 'cancelled'
            ? hasResults
              ? 'The scan was cancelled; results are partial'
              : 'The scan was cancelled before any check finished'
            : 'The scan stopped because of an error';
  const graded = done > 0 && snap.live.grade !== null && snap.live.score !== null;
  const liveHex = graded ? GRADE_HEX[snap.live.grade!] : NOT_ASSESSED_HEX;
  const partial = graded && snap.live.coverage ? partialLabel({ partial: Boolean(snap.live.partial), coverage: snap.live.coverage }) : null;

  return (
    <>
      <PageHeader
        crumbs={<Link to={customerUrl} className="hover:text-slate-700">{scan.data.customer.name}</Link>}
        title={title}
        subtitle={scan.data.name}
        actions={
          <>
            {active && can.edit &&
              (snap.cancelRequested ? (
                <Button variant="secondary" icon={<Loader2 className="size-4 animate-spin" />} disabled>
                  Cancelling...
                </Button>
              ) : (
                <AsyncButton
                  variant="secondary"
                  icon={<CircleStop className="size-4" />}
                  onClick={() => post(`/api/scans/${scanId}/cancel`)}
                  success="Cancellation requested. Running checks finish first."
                  confirm={{
                    title: 'Cancel this scan?',
                    body: 'Checks that are still queued will not run. Results collected so far are kept and shown as a partial report.',
                    confirmLabel: 'Cancel scan',
                    danger: true,
                  }}
                >
                  Cancel scan
                </AsyncButton>
              ))}
            {finished && hasResults && (
              <LinkButton to={`/scans/${scanId}/report`} size="lg" icon={<ArrowRight className="size-4" />}>
                View report
              </LinkButton>
            )}
          </>
        }
      />

      {/* Screen readers hear each state change (queued, running, finished, failed, cancelled) once. */}
      <div role="status" aria-live="polite" className="sr-only">
        {title}. {statusText}.
      </div>

      {snap.status === 'cancelled' && !hasResults && (
        <Alert tone="warn" className="mb-6" title="No results to report">
          <p>The scan was cancelled before any check finished, so there is no report.{can.edit ? ' Start a new scan with the same scope when you are ready.' : ' Ask the owner to rescan.'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {can.edit && (
              <AsyncButton icon={<RefreshCw className="size-4" />} onClick={rescan}>
                Start a rescan
              </AsyncButton>
            )}
            <LinkButton to={customerUrl} variant="ghost" icon={<ArrowLeft className="size-4" />}>
              Back to organisation
            </LinkButton>
          </div>
        </Alert>
      )}

      {failed && (
        <Alert tone="error" className="mb-6" title={<span className="flex items-center gap-2"><XCircle className="size-4" aria-hidden /> The scan failed before all checks could run</span>}>
          <p>
            {can.edit
              ? done > 0
                ? `${done} of ${total} checks completed before the failure. You can review their results as a partial report, or start a new scan with the same scope.`
                : 'No checks completed. Start a new scan with the same scope, or go back to the organisation to review the connected systems.'
              : done > 0
                ? `${done} of ${total} checks completed before the failure. You can review their results as a partial report. Ask the owner to rescan.`
                : 'No checks completed. Ask the owner to rescan.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {done > 0 && (
              <LinkButton to={`/scans/${scanId}/report`} icon={<FileText className="size-4" />}>
                View partial report
              </LinkButton>
            )}
            {can.edit && (
              <AsyncButton variant={done > 0 ? 'secondary' : 'primary'} icon={<RefreshCw className="size-4" />} onClick={rescan}>
                Start a rescan
              </AsyncButton>
            )}
            <LinkButton to={customerUrl} variant="ghost" icon={<ArrowLeft className="size-4" />}>
              Back to organisation
            </LinkButton>
          </div>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-col items-center gap-8 p-8 sm:flex-row">
            <Ring pct={pct} color={failed ? '#dc2626' : finished ? '#10b981' : '#4f46e5'}>
              <div className="text-4xl font-semibold tracking-tight text-slate-900">{pct}%</div>
              <div className="text-xs font-medium text-slate-500">
                {done} of {total} checks
              </div>
            </Ring>
            <div className="flex-1 space-y-5">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                {active ? (
                  <Loader2 className="size-4 animate-spin text-brand-600" aria-hidden />
                ) : snap.status === 'completed' ? (
                  <PartyPopper className="size-4 text-emerald-600" aria-hidden />
                ) : failed ? (
                  <XCircle className="size-4 text-red-600" aria-hidden />
                ) : null}
                {statusText}
              </div>
              <div className="grid grid-cols-5 gap-2">
                {(['pass', 'warn', 'fail', 'na', 'error'] as const).map((k) => (
                  <div key={k} className="rounded-xl bg-slate-50 px-3 py-2.5 text-center">
                    <div className={clsx('mx-auto mb-1 size-2 rounded-full', STATUS_STYLE[k].dot)} />
                    <div className="text-xl font-semibold text-slate-900">{snap.live.counts[k] ?? 0}</div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{STATUS_STYLE[k].label}</div>
                  </div>
                ))}
              </div>
              <div className="flex gap-6 text-sm text-slate-500">
                <span>
                  Elapsed <span className="font-semibold text-slate-800">{fmtDuration(elapsed)}</span>
                </span>
                {eta !== null && (
                  <span>
                    Remaining <span className="font-semibold text-slate-800">~{fmtDuration(eta)}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex flex-col items-center p-8 text-center">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{finished ? 'Final score' : 'Live score'}</div>
            <Ring pct={graded ? snap.live.score! : 0} size={140} stroke={12} color={graded ? liveHex : '#cbd5e1'}>
              <div className={clsx('font-bold', graded ? 'text-4xl' : 'text-4xl text-slate-600')} style={graded ? { color: liveHex } : undefined}>
                {graded ? snap.live.grade : '-'}
              </div>
              <div className="px-4 text-xs text-slate-600">{graded ? `${snap.live.score}/100` : done ? 'Not assessed' : 'Waiting'}</div>
            </Ring>
            {partial && <div className="mt-3 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-200">{partial}</div>}
            {done > 0 && !graded && <p className="mt-3 text-xs text-slate-600">Too few checks could be assessed so far to give a grade.</p>}
            <div className="mt-4 flex gap-3 text-xs">
              {(['critical', 'high', 'medium'] as const).map((s) => (
                <span key={s} className="capitalize text-slate-500">
                  <span className="font-semibold text-slate-800">{snap.live.severityCounts[s] ?? 0}</span> {s}
                </span>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500">
            {LEGEND.map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span className={clsx('size-3 rounded-sm', k === 'pending' ? 'border border-dashed border-slate-400 bg-white' : STATUS_STYLE[k].dot)} aria-hidden />
                {STATUS_STYLE[k].label}
              </li>
            ))}
          </ul>
          {[...bySystem.entries()].map(([sid, rows]) => {
            const s = sysLabel.get(sid);
            const d = rows.filter((r) => !['pending', 'running'].includes(r.status)).length;
            const identity = s ? systemIdentity(s.provider, s.connection?.details, s.config) : null;
            const count = (k: string) => rows.filter((r) => r.status === k).length;
            const tally: [string, number, string][] = [
              ['passed', count('pass'), 'text-emerald-700'],
              ['failed', count('fail'), 'text-red-700'],
              ['warnings', count('warn'), 'text-amber-700'],
            ];
            return (
              <Card key={sid}>
                <div className="p-5">
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    {s && <ProviderIcon provider={s.provider} className="size-7" decorative />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-slate-900">{s?.label}</div>
                      <div className="truncate text-xs text-slate-500">
                        {s && PROVIDER_LABELS[s.provider]}
                        {identity && <> · {identity}</>}
                      </div>
                    </div>
                    <div role="group" className="flex items-center gap-3 text-xs text-slate-600" aria-label={`${s?.label ?? 'System'} results so far`}>
                      {tally.map(([l, n, tone]) => (
                        <span key={l}>
                          <span className={clsx('font-semibold', n === 0 ? 'text-slate-600' : tone)}>{n}</span> {l}
                        </span>
                      ))}
                    </div>
                    <span className="text-sm font-medium text-slate-600">
                      {d}/{rows.length}
                      <span className="sr-only"> checks done</span>
                    </span>
                  </div>
                  <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                    <div className="h-full rounded-full bg-brand-600 transition-all duration-500" style={{ width: `${(d / rows.length) * 100}%` }} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {rows.map((r) => {
                      const m = CHECKS_BY_ID[r.checkId];
                      return (
                        <div
                          key={r.checkId}
                          role="img"
                          aria-label={`${m?.title} on ${s?.label ?? 'this system'}: ${STATUS_STYLE[r.status].label}`}
                          title={`${m?.title} (A.${m?.frameworks.iso27001[0]} ${ISO_BY_ID[m?.frameworks.iso27001[0] ?? '']?.title ?? ''})\n${s?.label ?? ''}${identity ? ` (${identity})` : ''}\n${STATUS_STYLE[r.status].label}${r.summary ? `: ${r.summary}` : ''}`}
                          className={clsx('size-7 rounded-md transition-colors duration-500', tileClass(r.status))}
                        />
                      );
                    })}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
        <Card title="Live results">
          {feed.length === 0 ? (
            <p className="text-sm text-slate-500">Results appear here as checks complete.</p>
          ) : (
            <ul className="-my-2 divide-y divide-slate-100">
              {feed.map((r) => (
                <li key={`${r.systemId}:${r.checkId}`} className="animate-fade-in py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-800">{CHECKS_BY_ID[r.checkId]?.title}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  {sysLabel.get(r.systemId) && (
                    <div className="mt-1">
                      <SystemBadge provider={sysLabel.get(r.systemId)!.provider} label={sysLabel.get(r.systemId)!.label} size="xs" showIdentity={false} />
                    </div>
                  )}
                  <div className="mt-0.5 truncate text-xs text-slate-500">{r.summary}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
