import { CHECKS_BY_ID, DOMAIN_LABELS, PROVIDER_LABELS, VERDICT_LABELS, type ResultStatus } from '@qs/shared';
import type { ReportItem, ReportModel } from './model.js';

/** Quote a CSV cell and neutralise spreadsheet formula injection. */
export function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const row = (values: unknown[]) => values.map(cell).join(',');

/** Readable result labels, the same words as the web report. */
export const STATUS_TEXT: Record<ResultStatus, string> = { pass: 'pass', fail: 'fail', warn: 'warning', na: 'not applicable', error: 'error (not assessed)' };
export const TRIAGE_TEXT: Record<'open' | 'accepted' | 'false_positive', string> = { open: 'open', accepted: 'risk accepted', false_positive: 'false positive' };

/** "fail (risk accepted)": the raw result plus the triage in effect for this report. */
export function statusText(status: ResultStatus, triage: ReportItem['triage']): string {
  const base = STATUS_TEXT[status] ?? status;
  return triage && triage.status !== 'open' && (status === 'fail' || status === 'warn') ? `${base} (${TRIAGE_TEXT[triage.status]})` : base;
}

export function findingsCsv(m: ReportModel): string {
  const header = [
    'Status', 'Severity', 'ISO 27001 primary control', 'ISO 27001 controls', 'Check', 'Platform', 'System', 'Domain',
    'Result', 'Affected resources', 'Remediation', 'Effort', 'Triage', 'Triage note', 'CIS', 'NIS2', 'Check ID',
  ];
  const all = [...m.findings, ...m.passed, ...m.notAssessed];
  const lines = all.map((i) =>
    row([
      statusText(i.status, i.triage), i.severity, i.iso[0], i.iso.join(' '), i.title, PROVIDER_LABELS[i.provider], i.systemLabel,
      DOMAIN_LABELS[i.domain as keyof typeof DOMAIN_LABELS] ?? i.domain, i.summary,
      i.resources.map((r) => [r.name ?? r.id, r.detail].filter(Boolean).join(' - ')).join('; '),
      i.remediation, i.effort, i.triage ? TRIAGE_TEXT[i.triage.status] : '', i.triage?.note ?? '', i.cis ?? '', i.nis2 ?? '', i.checkId,
    ]),
  );
  // BOM so Excel opens UTF-8 correctly.
  return `﻿${[row(header), ...lines].join('\r\n')}\r\n`;
}

export function controlsCsv(m: ReportModel): string {
  const header = ['ISO 27001:2022 control', 'Title', 'Verdict', 'Score', 'Checks passed', 'Checks failed', 'Related checks'];
  // Per check id, the raw results with the triage of this report, e.g. "fail (risk accepted)".
  const byCheck = new Map<string, string[]>();
  for (const i of [...m.findings, ...m.passed, ...m.notAssessed]) {
    const list = byCheck.get(i.checkId) ?? [];
    list.push(statusText(i.status, i.triage));
    byCheck.set(i.checkId, list);
  }
  const related = (checkId: string, primary: boolean) => {
    const statuses = [...new Set(byCheck.get(checkId) ?? [])].join(', ') || 'not assessed';
    return `${CHECKS_BY_ID[checkId]?.title ?? checkId} [${checkId}]${primary ? '' : ' (secondary)'}: ${statuses}`;
  };
  const lines = m.summary.controls.map((c) =>
    row([
      `A.${c.id}`, c.title, VERDICT_LABELS[c.verdict], c.score ?? '', c.passed, c.failed,
      [...new Map(c.checks.map((x) => [x.checkId, x.primary])).entries()].map(([id, primary]) => related(id, primary)).join('; '),
    ]),
  );
  return `﻿${[row(header), ...lines].join('\r\n')}\r\n`;
}
