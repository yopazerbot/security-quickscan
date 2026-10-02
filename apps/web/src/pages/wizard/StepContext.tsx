import { DEFAULT_CONTEXT, type CustomerContext } from '@qs/shared';
import { useState } from 'react';
import { ContextForm, RiskProfilePanel } from '../../components/ContextForm';
import { Alert, Card } from '../../components/ui';
import { patch } from '../../lib/api';
import { WizardFooter, type StepProps } from './ScanWizard';

export function StepContext({ scan, refresh, next }: StepProps) {
  const [ctx, setCtx] = useState<CustomerContext>({ ...DEFAULT_CONTEXT, ...scan.context });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/api/scans/${scan.id}`, { context: ctx });
      await refresh();
      next();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Confirm the customer context" subtitle="Pre-filled from the customer record. Changes are saved to the customer as well.">
          <ContextForm value={ctx} onChange={setCtx} />
        </Card>
        <div>
          <div className="sticky top-8">
            <Card>
              <div className="p-6">
                <RiskProfilePanel context={ctx} />
              </div>
            </Card>
          </div>
        </div>
      </div>
      {err && <Alert tone="error" className="mt-4">{err}</Alert>}
      <WizardFooter onNext={save} loading={busy} nextLabel="Save and continue" />
    </>
  );
}
