import { CHECKS_BY_ID, DOMAIN_LABELS, EVIDENCE_LABELS, ISO_BY_ID, PROVIDER_LABELS, VERDICT_LABELS, type ResultStatus } from '@qs/shared';
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
    'Status', 'Severity', 'ISO 27001 primary control', 'ISO 27001 controls', 'Check', 'Platform', 'System', 'Identity', 'System key', 'Domain',
    'Result', 'Affected resources', 'Resource URLs', 'Remediation', 'Effort', 'Triage', 'Triage note', 'CIS', 'NIS2', 'Check ID',
  ];
  const all = [...m.findings, ...m.passed, ...m.notAssessed];
  const lines = all.map((i) =>
    row([
      statusText(i.status, i.triage), i.severity, i.iso[0], i.iso.join(' '), i.title, PROVIDER_LABELS[i.provider], i.systemLabel, i.systemIdentity ?? '', i.systemKey,
      DOMAIN_LABELS[i.domain as keyof typeof DOMAIN_LABELS] ?? i.domain, i.summary,
      i.resources.map((r) => [r.name ?? r.id, r.detail].filter(Boolean).join(' - ')).join('; '),
      i.resources.map((r) => r.url).filter(Boolean).join(' '),
      i.remediation, i.effort, i.triage ? TRIAGE_TEXT[i.triage.status] : '', i.triage?.note ?? '', i.cis ?? '', i.nis2 ?? '', i.checkId,
    ]),
  );
  // BOM so Excel opens UTF-8 correctly.
  return `﻿${[row(header), ...lines].join('\r\n')}\r\n`;
}

/** Worst first, so "fail (risk accepted)" is listed before "pass" for a system. */
const STATUS_ORDER: ResultStatus[] = ['fail', 'warn', 'error', 'na', 'pass'];

export function controlsCsv(m: ReportModel): string {
  const header = ['ISO 27001:2022 control', 'Title', 'Verdict', 'Evidence', 'Score', 'Checks passed', 'Checks failed', 'Results per system', 'Related checks'];
  // Per check id, the raw results with the triage of this report, e.g. "fail (risk accepted)".
  const all = [...m.findings, ...m.passed, ...m.notAssessed];
  const byCheck = new Map<string, string[]>();
  for (const i of all) {
    const list = byCheck.get(i.checkId) ?? [];
    list.push(statusText(i.status, i.triage));
    byCheck.set(i.checkId, list);
  }
  const related = (checkId: string, primary: boolean) => {
    const statuses = [...new Set(byCheck.get(checkId) ?? [])].join(', ') || 'not assessed';
    return `${CHECKS_BY_ID[checkId]?.title ?? checkId} [${checkId}]${primary ? '' : ' (secondary)'}: ${statuses}`;
  };
  const labelOf = new Map(m.systems.map((s) => [s.id, s.label]));
  const itemOf = new Map(all.map((i) => [`${i.systemId}|${i.checkId}`, i]));
  /** "AWS production: fail; AWS sandbox: pass": the worst result per system that fed the control. */
  const perSystem = (checks: ReportModel['summary']['controls'][number]['checks']) => {
    const worst = new Map<string, { rank: number; text: string }>();
    for (const x of checks) {
      if (!x.systemId) continue;
      const item = itemOf.get(`${x.systemId}|${x.checkId}`);
      const text = statusText(x.status, item?.triage ?? (x.triage ? { status: x.triage, note: '' } : null));
      const rank = STATUS_ORDER.indexOf(x.status);
      const cur = worst.get(x.systemId);
      if (!cur || rank < cur.rank) worst.set(x.systemId, { rank, text });
    }
    return [...worst.entries()].map(([id, w]) => `${labelOf.get(id) ?? id}: ${w.text}`).join('; ');
  };
  const lines = m.summary.controls.map((c) =>
    row([
      `A.${c.id}`, c.title, VERDICT_LABELS[c.verdict], c.evidence ? EVIDENCE_LABELS[c.evidence] : '', c.score ?? '', c.passed, c.failed,
      perSystem(c.checks),
      [...new Map(c.checks.map((x) => [x.checkId, x.primary])).entries()].map(([id, primary]) => related(id, primary)).join('; '),
    ]),
  );
  const notCovered = (m.summary.notCovered ?? []).map((id) =>
    row([`A.${id}`, ISO_BY_ID[id]?.title ?? id, NOT_COVERED_TEXT, EVIDENCE_LABELS.none, '', '', '', '', '']),
  );
  return `\uFEFF${[row(header), ...lines, ...notCovered].join('\r\n')}\r\n`;
}

export const NOT_COVERED_TEXT = 'Not covered by automated checks';
