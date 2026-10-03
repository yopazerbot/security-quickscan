import { CheckCircle2, Clock, RotateCw, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Card, LinkButton, PageLoader } from '../components/ui';
import { ApiError, post } from '../lib/api';
import { useDocumentTitle } from '../lib/use-document-title';

/** How a consent attempt ended, which decides the guidance and the actions offered. */
type Outcome =
  | { kind: 'ok'; scanId?: string }
  | { kind: 'denied'; scanId?: string; message: string }
  | { kind: 'missing' }
  | { kind: 'conflict'; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'pending'; message: string }
  | { kind: 'changed'; message: string }
  | { kind: 'error'; message: string };

function classify(e: unknown): Outcome {
  const message = e instanceof Error ? e.message : 'The consent could not be confirmed.';
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 409 && /already linked/i.test(message)) return { kind: 'conflict', message };
  if (status === 400 && /earlier consent/i.test(message)) return { kind: 'stale', message };
  if (status === 400 && /does not confirm/i.test(message)) return { kind: 'pending', message };
  if (status === 400 && /changed while consent was pending/i.test(message)) return { kind: 'changed', message };
  return { kind: 'error', message };
}

const GUIDANCE: Partial<Record<Outcome['kind'], string>> = {
  missing: 'The consent result was lost during sign-in. Generate a new consent link from the wizard.',
  stale: 'Generate a new consent link from the wizard and ask a Global Administrator of the tenant to open it and accept all requested permissions.',
  pending: 'Microsoft can take a minute to show a new consent. Try again shortly; the same consent result is used.',
  changed: 'Check the tenant ID or domain of the system in the wizard, then generate a new consent link.',
  error: 'Generate a new admin consent link in the scan wizard and ask a Global Administrator of the tenant to approve all requested permissions.',
  denied: 'Generate a new admin consent link in the scan wizard and ask a Global Administrator of the tenant to approve all requested permissions.',
};

/** Landing page after a tenant admin grants (or refuses) consent to the scanner app. */
export function ConsentCallback() {
  useDocumentTitle('Admin consent');
  const [params] = useSearchParams();
  const [res, setRes] = useState<Outcome | null>(null);
  const [retrying, setRetrying] = useState(false);
  const body = useRef<Record<string, string> | null>(null);
  const once = useRef(false);

  const complete = async () => {
    try {
      const r = await post<{ ok: boolean; scanId?: string; message?: string }>('/api/consent/complete', body.current);
      setRes(r.ok ? { kind: 'ok', scanId: r.scanId } : { kind: 'denied', scanId: r.scanId, message: r.message || 'Consent was not granted.' });
    } catch (e) {
      setRes(classify(e));
    }
  };

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const b: Record<string, string> = {};
    for (const k of ['state', 'tenant', 'admin_consent', 'error', 'error_description']) {
      const v = params.get(k);
      if (v) b[k] = v;
    }
    // Remove the one-time state from the address bar and history; it stays in memory for a retry.
    window.history.replaceState(null, '', '/consent/callback');
    if (!b.state) {
      setRes({ kind: 'missing' });
      return;
    }
    body.current = b;
    void complete();
  }, [params]);

  if (!res) return <PageLoader />;
  const ok = res.kind === 'ok';
  const scanId = res.kind === 'ok' || res.kind === 'denied' ? res.scanId : undefined;
  const title = ok ? 'Admin consent granted' : res.kind === 'pending' ? 'Consent not confirmed yet' : res.kind === 'conflict' ? 'Tenant already in use' : 'Consent not completed';
  const message =
    res.kind === 'ok'
      ? 'Return to the scan to test the connection.'
      : res.kind === 'missing'
        ? null
        : res.message || 'The consent could not be confirmed. The link may have expired or was already used.';
  const guidance = GUIDANCE[res.kind];
  const Icon = ok ? CheckCircle2 : res.kind === 'pending' ? Clock : XCircle;
  return (
    <div className="mx-auto mt-16 max-w-md">
      <Card>
        <div role={ok ? 'status' : 'alert'} className="flex flex-col items-center p-10 text-center">
          <Icon className={ok ? 'size-12 text-emerald-600' : res.kind === 'pending' ? 'size-12 text-amber-600' : 'size-12 text-red-600'} aria-hidden />
          <h1 className="mt-4 text-lg font-semibold text-slate-900">{title}</h1>
          {message && <p className="mt-2 text-sm text-slate-600">{message}</p>}
          {guidance && <p className="mt-2 text-sm text-slate-600">{guidance}</p>}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {res.kind === 'pending' && (
              <Button
                icon={<RotateCw className="size-4" aria-hidden />}
                loading={retrying}
                onClick={async () => {
                  setRetrying(true);
                  await complete();
                  setRetrying(false);
                }}
              >
                Try again
              </Button>
            )}
            {scanId ? (
              <LinkButton to={`/scans/${scanId}/wizard`} variant={ok ? 'primary' : 'secondary'}>
                Back to the scan
              </LinkButton>
            ) : (
              <LinkButton to="/organisations" variant={res.kind === 'pending' ? 'secondary' : 'primary'}>
                Go to organisations
              </LinkButton>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
