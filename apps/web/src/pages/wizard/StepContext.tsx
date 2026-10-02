import { DEFAULT_CONTEXT, type CustomerContext } from '@qs/shared';
import { useState } from 'react';
import { ContextForm, RiskProfilePanel } from '../../components/ContextForm';
import { Card } from '../../components/ui';
import { patch } from '../../lib/api';
import { WizardFooter, useStepSave, type StepProps } from './ScanWizard';

export function StepContext({ scan, refresh, next, saveRef, navigating }: StepProps) {
  const [ctx, setCtx] = useState<CustomerContext>({ ...DEFAULT_CONTEXT, ...scan.context });

  // Errors propagate to the wizard, which shows a toast and stays on this step.
  useStepSave(saveRef, async () => {
    await patch(`/api/scans/${scan.id}`, { context: ctx });
    await refresh();
  });

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
      <WizardFooter onNext={next} loading={navigating} nextLabel="Save and continue" />
    </>
  );
}
