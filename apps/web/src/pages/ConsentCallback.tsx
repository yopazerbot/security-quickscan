import { CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Card, LinkButton, PageLoader } from '../components/ui';
import { post } from '../lib/api';

/** Landing page after a tenant admin grants (or refuses) consent to the scanner app. */
export function ConsentCallback() {
  const [params] = useSearchParams();
  const [res, setRes] = useState<{ ok: boolean; scanId?: string; message?: string } | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const body: Record<string, string> = {};
    for (const k of ['state', 'tenant', 'admin_consent', 'error', 'error_description']) {
      const v = params.get(k);
      if (v) body[k] = v;
    }
    // Remove the one-time state from the address bar and history.
    window.history.replaceState(null, '', '/consent/callback');
    post('/api/consent/complete', body).then(setRes, (e) => setRes({ ok: false, message: e instanceof Error ? e.message : undefined }));
  }, [params]);
  if (!res) return <PageLoader />;
  return (
    <div className="mx-auto mt-16 max-w-md">
      <Card>
        <div role={res.ok ? 'status' : 'alert'} className="flex flex-col items-center p-10 text-center">
          {res.ok ? <CheckCircle2 className="size-12 text-emerald-500" aria-hidden /> : <XCircle className="size-12 text-red-500" aria-hidden />}
          <h1 className="mt-4 text-lg font-semibold text-slate-900">{res.ok ? 'Admin consent granted' : 'Consent not completed'}</h1>
          <p className="mt-2 text-sm text-slate-600">
            {res.ok ? 'Return to the scan to test the connection.' : res.message || 'The consent could not be confirmed. The link may have expired or was already used.'}
          </p>
          {!res.ok && <p className="mt-2 text-sm text-slate-500">Generate a new admin consent link in the scan wizard and ask a Global Administrator of the tenant to approve all requested permissions.</p>}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {res.scanId ? (
              <LinkButton to={`/scans/${res.scanId}/wizard`}>Back to the scan</LinkButton>
            ) : (
              <LinkButton to="/" variant={res.ok ? 'primary' : 'secondary'}>
                Go to the dashboard
              </LinkButton>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
