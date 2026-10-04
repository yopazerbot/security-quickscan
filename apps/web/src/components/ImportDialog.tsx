import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router';
import { fileToBase64, post } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useToast } from './feedback';
import { PasswordInput } from './password-input';
import { Alert, Badge, Button, Field, Input, Modal } from './ui';

/** Largest file the server accepts (portability/format.ts MAX_FILE_BYTES). */
const MAX_FILE_MB = 48;

interface PlanOrganisation {
  exportId: string;
  name: string;
  action: 'merge' | 'new';
  targetId: string | null;
  targetName: string | null;
  scans: number;
  newScans: number;
  existingScans: number;
  from: string | null;
  to: string | null;
  notes: string[];
}

interface Plan {
  appVersion: string;
  exportedAt: string;
  exportedBy: { name: string; email: string };
  scope: 'organisation' | 'all';
  organisations: PlanOrganisation[];
  totals: { organisations: number; newOrganisations: number; scans: number; newScans: number; existingScans: number };
}

interface Result {
  organisations: { id: string; name: string; action: 'merge' | 'new'; added: number; skipped: number }[];
  totals: { organisations: number; newOrganisations: number; added: number; skipped: number };
}

const period = (o: PlanOrganisation) => (!o.from ? '-' : fmtDate(o.from) === fmtDate(o.to) ? fmtDate(o.from) : `${fmtDate(o.from)} to ${fmtDate(o.to)}`);
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * Imports a .qsx export: choose the file and passphrase, preview what merges and what is new, then import.
 * Scans already present (same original scan) are skipped, so importing the same file twice is harmless.
 */
export function ImportDialog({ onClose }: { onClose(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState('');
  const [data, setData] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = (f: File | null) => {
    setFile(f);
    setData(null);
    setPlan(null);
    setErr(null);
    setFileErr(f && f.size > MAX_FILE_MB * 1024 * 1024 ? `This file is larger than ${MAX_FILE_MB} MB. Export fewer organisations per file.` : null);
  };

  const preview = async () => {
    if (!file) return setFileErr('Choose an export file (.qsx).');
    if (fileErr) return;
    if (!pass) return setErr('Enter the passphrase of the export.');
    setBusy(true);
    setErr(null);
    try {
      const b64 = data ?? (await fileToBase64(file));
      setData(b64);
      setPlan((await post<{ plan: Plan }>('/api/import', { file: b64, passphrase: pass, dryRun: true })).plan);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The file could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!data) return;
    setBusy(true);
    setErr(null);
    try {
      const r = (await post<{ result: Result }>('/api/import', { file: data, passphrase: pass, dryRun: false })).result;
      setResult(r);
      setData(null);
      setPass('');
      await qc.invalidateQueries({ queryKey: ['customers'] });
      await qc.invalidateQueries({ queryKey: ['customer'] });
      await qc.invalidateQueries({ queryKey: ['scans'] });
      toast.success(`Imported ${n(r.totals.added, 'scan')}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <Modal open onClose={onClose} title="Import finished" footer={<Button onClick={onClose}>Done</Button>}>
        <div className="space-y-3 text-sm text-slate-600">
          <p>
            {n(result.totals.added, 'scan')} imported into {n(result.totals.organisations, 'organisation')}
            {result.totals.newOrganisations ? ` (${result.totals.newOrganisations} new)` : ''}.
            {result.totals.skipped ? ` ${n(result.totals.skipped, 'scan was', 'scans were')} already present and skipped.` : ''}
          </p>
          <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
            {result.organisations.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <Link to={`/organisations/${o.id}`} onClick={onClose} className="font-medium text-brand-700 hover:underline">
                  {o.name}
                </Link>
                <span className="text-xs text-slate-500">
                  {o.action === 'new' ? 'New organisation, ' : ''}
                  {n(o.added, 'scan')} added
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    );

  return (
    <Modal
      open
      wide
      busy={busy}
      onClose={onClose}
      title="Import scan history"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={plan ? () => setPlan(null) : onClose}>
            {plan ? 'Back' : 'Cancel'}
          </Button>
          {plan ? (
            <Button loading={busy} disabled={plan.totals.newScans === 0 && plan.totals.newOrganisations === 0} onClick={() => void apply()}>
              Import
            </Button>
          ) : (
            <Button loading={busy} onClick={() => void preview()}>
              Preview
            </Button>
          )}
        </>
      }
    >
      {plan ? (
        <div className="space-y-4 text-sm text-slate-600">
          <p>
            Export of {plan.scope === 'all' ? 'all organisations' : 'one organisation'} made on {fmtDate(plan.exportedAt)} by {plan.exportedBy.name || plan.exportedBy.email} (version{' '}
            {plan.appVersion}). {n(plan.totals.newScans, 'scan')} will be added
            {plan.totals.existingScans ? `, ${plan.totals.existingScans} already present` : ''}.
          </p>
          <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">What the import does per organisation</caption>
              <thead className="bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Organisation
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    New scans
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Already present
                  </th>
                  <th scope="col" className="hidden px-3 py-2 sm:table-cell">
                    Period
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {plan.organisations.map((o) => (
                  <tr key={o.exportId} className="align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{o.name}</div>
                      <Badge className={clsx('mt-1', o.action === 'new' ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-brand-50 text-brand-700 ring-1 ring-brand-100')}>
                        {o.action === 'new' ? 'New organisation' : `Merge into ${o.targetName}`}
                      </Badge>
                      <div className="mt-1 text-xs text-slate-500 sm:hidden">{period(o)}</div>
                      {o.notes.length > 0 && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-800">
                          {o.notes.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-900">{o.newScans}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.existingScans}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs sm:table-cell">{period(o)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.totals.newScans === 0 && plan.totals.newOrganisations === 0 && (
            <Alert tone="info" live>
              Everything in this file is already here. There is nothing to import.
            </Alert>
          )}
          {err && (
            <Alert tone="error" live>
              {err}
            </Alert>
          )}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void preview();
          }}
        >
          <p className="text-sm text-slate-600">
            Adds the scans, systems, environments and triage decisions from an export file. Organisations you can edit are merged by their original identity; scans that are
            already here are skipped. You see a preview before anything is imported.
          </p>
          <Field label="Export file" required error={fileErr} hint={`A .qsx file made with Export, at most ${MAX_FILE_MB} MB.`}>
            <Input
              type="file"
              accept=".qsx,application/octet-stream"
              className="file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-sm file:font-medium file:text-slate-700"
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
            />
          </Field>
          <Field label="Passphrase" required>
            <PasswordInput autoComplete="off" maxLength={256} value={pass} onChange={(e) => setPass(e.target.value)} />
          </Field>
          {err && (
            <Alert tone="error" live>
              {err}
            </Alert>
          )}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}
