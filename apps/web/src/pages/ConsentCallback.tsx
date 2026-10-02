import { CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Card, PageLoader } from '../components/ui';
import { post } from '../lib/api';

/** Landing page after a customer admin grants (or refuses) consent to the scanner app. */
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
    post('/api/consent/complete', body).then(setRes, (e) => setRes({ ok: false, message: e.message }));
  }, [params]);
  if (!res) return <PageLoader />;
  return (
    <div className="mx-auto mt-16 max-w-md">
      <Card>
        <div className="flex flex-col items-center p-10 text-center">
          {res.ok ? <CheckCircle2 className="size-12 text-emerald-500" /> : <XCircle className="size-12 text-red-500" />}
          <h1 className="mt-4 text-lg font-semibold text-slate-900">{res.ok ? 'Admin consent granted' : 'Consent not completed'}</h1>
          <p className="mt-2 text-sm text-slate-500">{res.ok ? 'Return to the scan to test the connection.' : res.message}</p>
          {res.scanId && <Link to={`/scans/${res.scanId}/wizard`} className="mt-6"><Button>Back to the scan</Button></Link>}
        </div>
      </Card>
    </div>
  );
}
