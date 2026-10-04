import { ExternalLink } from 'lucide-react';
import { CopyButton } from './ui';

export interface Resource {
  id: string;
  name?: string;
  detail?: string;
  url?: string;
  type?: string;
  region?: string;
  account?: string;
}

/** Affected resources of a finding: console links open in a new tab, and every id can be copied. */
export function ResourceList({ resources }: { resources: Resource[] }) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg ring-1 ring-slate-200 print:max-h-none print:overflow-visible">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Affected resources</caption>
        <tbody className="divide-y divide-slate-100">
          {resources.map((r, i) => {
            const name = r.name ?? r.id;
            const meta = [r.type, r.region, r.account].filter(Boolean).join(' · ');
            return (
              <tr key={`${i}-${r.id}`} className="align-top">
                <td className="px-3 py-2">
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium break-all text-brand-700 hover:underline">
                      {name}
                      <ExternalLink className="size-3 shrink-0" aria-hidden />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <span className="font-medium break-all text-slate-800">{name}</span>
                  )}
                  {meta && <div className="mt-0.5 text-[11px] text-slate-500">{meta}</div>}
                  {r.url && <div className="print-only break-all text-[10px] text-slate-500">{r.url}</div>}
                </td>
                <td className="px-3 py-2 text-slate-600">{r.detail}</td>
                <td className="no-print w-px whitespace-nowrap px-1 py-1 text-right">
                  <CopyButton value={r.id} ariaLabel={`Copy the id of ${name}`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
