import { DOMAIN_LABELS, PROVIDER_LABELS, VERDICT_LABELS } from '@qs/shared';
import type { ReportModel } from './model.js';

/** Quote a CSV cell and neutralise spreadsheet formula injection. */
export function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const row = (values: unknown[]) => values.map(cell).join(',');

export function findingsCsv(m: ReportModel): string {
  const header = [
    'Status', 'Severity', 'ISO 27001 primary control', 'ISO 27001 controls', 'Check', 'Platform', 'System', 'Domain',
    'Result', 'Affected resources', 'Remediation', 'Effort', 'Triage', 'Triage note', 'CIS', 'NIS2', 'Check ID',
  ];
  const all = [...m.findings, ...m.passed, ...m.notAssessed];
  const lines = all.map((i) =>
    row([
      i.status, i.severity, i.iso[0], i.iso.join(' '), i.title, PROVIDER_LABELS[i.provider], i.systemLabel,
      DOMAIN_LABELS[i.domain as keyof typeof DOMAIN_LABELS] ?? i.domain, i.summary,
      i.resources.map((r) => [r.name ?? r.id, r.detail].filter(Boolean).join(' - ')).join('; '),
      i.remediation, i.effort, i.triage?.status ?? '', i.triage?.note ?? '', i.cis ?? '', i.nis2 ?? '', i.checkId,
    ]),
  );
  // BOM so Excel opens UTF-8 correctly.
  return `﻿${[row(header), ...lines].join('\r\n')}\r\n`;
}

export function controlsCsv(m: ReportModel): string {
  const header = ['ISO 27001:2022 control', 'Title', 'Verdict', 'Score', 'Checks passed', 'Checks failed', 'Related checks'];
  const lines = m.summary.controls.map((c) =>
    row([`A.${c.id}`, c.title, VERDICT_LABELS[c.verdict], c.score ?? '', c.passed, c.failed, c.checks.map((x) => `${x.checkId}${x.primary ? '' : ' (secondary)'}: ${x.status}`).join('; ')]),
  );
  return `﻿${[row(header), ...lines].join('\r\n')}\r\n`;
}
