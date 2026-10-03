import {
  DOMAIN_LABELS,
  GRADE_COLORS,
  INDUSTRIES,
  ISO_BY_ID,
  PROVIDER_LABELS,
  REGULATIONS,
  PRODUCT_NAME,
  REPORT_TITLE,
  REPORT_TITLE_SHORT,
  VERDICT_LABELS,
  executiveSummarySentences,
  gradeFor,
  partialLabel,
  type ControlVerdict,
  type Severity,
} from '@qs/shared';
import PDFDocument from 'pdfkit';
import type { ReportItem, ReportModel } from './model.js';

const C = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  line: '#e2e8f0',
  soft: '#f8fafc',
  pass: '#059669',
  warn: '#d97706',
  fail: '#dc2626',
  na: '#94a3b8',
};
const SEV: Record<Severity, string> = { critical: '#7f1d1d', high: '#dc2626', medium: '#d97706', low: '#2563eb', info: '#64748b' };
// Same verdict colours as the web report.
const VERDICT: Record<ControlVerdict, string> = { effective: '#047857', partial: '#b45309', not_effective: '#b91c1c', not_assessed: C.na };
const GRADE = GRADE_COLORS;

type Doc = PDFKit.PDFDocument;
const M = 50;

const fmtDate = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '-');

function ensure(doc: Doc, h: number) {
  if (doc.y + h > doc.page.height - M - 30) doc.addPage();
}

function h1(doc: Doc, text: string, accent: string) {
  doc.addPage();
  doc.rect(M, M, 4, 26).fill(accent);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(20).text(text, M + 14, M + 2);
  doc.moveDown(1.2);
  doc.x = M;
}

function h2(doc: Doc, text: string) {
  ensure(doc, 60);
  doc.moveDown(0.6);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(13).text(text, M);
  doc.moveDown(0.4);
}

function para(doc: Doc, text: string, opts: PDFKit.Mixins.TextOptions & { color?: string; size?: number } = {}) {
  doc.fillColor(opts.color ?? C.body).font('Helvetica').fontSize(opts.size ?? 10).text(text, { width: doc.page.width - 2 * M, lineGap: 2, ...opts });
}

function pill(doc: Doc, x: number, y: number, text: string, color: string, w?: number) {
  doc.font('Helvetica-Bold').fontSize(7.5);
  const width = w ?? doc.widthOfString(text) + 12;
  doc.roundedRect(x, y, width, 14, 7).fill(color);
  const keepY = doc.y;
  doc.fillColor('#ffffff').text(text, x, y + 3.5, { width, align: 'center', lineBreak: false });
  doc.y = keepY;
  return width;
}

function bar(doc: Doc, x: number, y: number, w: number, pct: number, color: string) {
  doc.roundedRect(x, y, w, 7, 3.5).fill(C.line);
  if (pct > 0) doc.roundedRect(x, y, Math.max(7, (w * pct) / 100), 7, 3.5).fill(color);
}

/** Score colours follow the grade bands (as in the web app). */
const scoreColor = (s: number | null) => (s === null ? C.na : GRADE[gradeFor(s)]);
const statusColor = (s: string) => (s === 'pass' ? C.pass : s === 'warn' ? C.warn : s === 'fail' ? C.fail : C.na);
const STATUS_LABEL: Record<string, string> = { pass: 'PASS', warn: 'WARNING', fail: 'FAIL', na: 'N/A', error: 'ERROR' };

/** "Cloud Security Quick Scan Report" -> ["Cloud Security", "Quick Scan Report"]. */
function splitTitle(title: string): [string, string] {
  const words = title.split(' ');
  const cut = Math.min(2, words.length - 1);
  return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
}

function retentionText(m: ReportModel): string {
  if (m.scan.retentionMode === 'purge_on_completion') return 'secrets were deleted automatically when the scan finished';
  if (m.scan.retentionMode === 'days') {
    const expiry = m.systems.map((s) => s.credentialsExpireAt).filter((d): d is Date => Boolean(d)).sort((a, b) => +new Date(b) - +new Date(a))[0];
    const days = m.scan.retentionDays;
    const kept = days ? `secrets are stored encrypted and kept for ${days} day${days === 1 ? '' : 's'}, then deleted automatically` : 'secrets are stored encrypted for a limited time, then deleted automatically';
    return expiry ? `${kept} (on ${fmtDate(expiry)} at the latest)` : kept;
  }
  return 'secrets are stored encrypted until they are deleted manually';
}

export function cover(doc: Doc, m: ReportModel, logo: Buffer | null) {
  const accent = m.branding.accentColor;
  const W = doc.page.width;
  doc.rect(0, 0, W, 300).fill(accent);
  doc.rect(0, 300, W, 6).fill(C.ink);
  if (logo) {
    try {
      doc.image(logo, M, 50, { fit: [160, 60] });
    } catch {
      /* ignore broken logo */
    }
  }
  // Title words split over two lines; always white on the accent band.
  const [titleTop, titleBottom] = splitTitle(REPORT_TITLE);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(30).text(titleTop, M, 150);
  doc.text(titleBottom);
  doc.font('Helvetica').fontSize(13).fillColor('#e0e7ff').text('Assessment against ISO/IEC 27001:2022 Annex A', M, 240);

  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(24).text(m.customer.name, M, 360, { width: W - 2 * M - 140 });
  const tw = W - 2 * M - 150;
  doc.font('Helvetica').fontSize(11).fillColor(C.muted).text(`Scan date: ${fmtDate(m.scan.finishedAt ?? m.scan.startedAt)}`, M, doc.y + 8, { width: tw });
  doc.text(`Scope: ${m.systems.map((s) => s.providerLabel).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`, { width: tw });
  doc.text(`Report generated: ${fmtDate(m.generatedAt)}`, { width: tw });

  // Grade badge
  const cx = W - M - 60;
  const cy = 400;
  const g = m.summary.grade;
  if (g === null) {
    doc.circle(cx, cy, 52).fill(C.muted);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(15).text('Not\nassessed', cx - 46, cy - 18, { width: 92, align: 'center' });
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(`${m.summary.coverage.assessed} of ${m.summary.coverage.inScope} checks assessed`, cx - 60, cy + 60, { width: 120, align: 'center' });
  } else {
    doc.circle(cx, cy, 52).fill(GRADE[g] ?? C.ink);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(46).text(g, cx - 52, cy - 26, { width: 104, align: 'center' });
    doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(`Score ${m.summary.score}/100`, cx - 60, cy + 60, { width: 120, align: 'center' });
    const partial = partialLabel(m.summary);
    if (partial) doc.fillColor(C.warn).font('Helvetica-Bold').fontSize(8.5).text(partial, cx - 60, doc.y + 2, { width: 120, align: 'center' });
  }

  const by = [m.branding.consultantName, m.branding.companyName].filter(Boolean).join(', ');
  if (by || m.branding.contactEmail) {
    doc.fillColor(C.muted).font('Helvetica').fontSize(10).text('Prepared by', M, 640);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12).text(by || m.branding.contactEmail, M, 655, { width: W - 2 * M });
    // Below the name, however many lines it wrapped to.
    doc.font('Helvetica').fontSize(10).fillColor(C.muted).text([m.branding.contactEmail, m.branding.website].filter(Boolean).join('  |  '), M, doc.y + 2, { width: W - 2 * M });
  }
}

function summaryPage(doc: Doc, m: ReportModel) {
  const accent = m.branding.accentColor;
  h1(doc, 'Executive summary', accent);
  const s = m.summary;
  para(
    doc,
    `${m.customer.name} was assessed with automated, read-only checks across ${m.systems.length} system(s). ` +
      executiveSummarySentences(s).join(' ') +
      ` Based on the organisation context at the time of the scan the risk profile is ${m.riskProfile.level.toUpperCase()}, which determined the evaluation criteria and the weighting of the score.` +
      (m.scan.status === 'failed'
        ? ' Note: this scan did not complete, so the results are partial and the score may not reflect the full environment.'
        : m.scan.status === 'cancelled'
          ? ' Note: this scan was cancelled before it completed, so the results are partial.'
          : ''),
  );

  // KPI tiles
  doc.moveDown(1);
  const y = doc.y;
  // Failed + warnings + passed + accepted/triaged + not assessed = every check in the report.
  const tiles: [string, string, string][] = [
    ['Score', s.score === null ? '-' : `${s.score}`, s.grade === null ? C.muted : (GRADE[s.grade] ?? C.ink)],
    ['Failed', `${s.counts.fail}`, C.fail],
    ['Warnings', `${s.counts.warn}`, C.warn],
    ['Passed', `${s.counts.pass}`, C.pass],
    ['Accepted / triaged', `${s.counts.accepted + s.counts.false_positive}`, C.muted],
    ['Not assessed', `${s.counts.na + s.counts.error}`, C.muted],
  ];
  const tw = (doc.page.width - 2 * M - (tiles.length - 1) * 8) / tiles.length;
  tiles.forEach(([label, value, color], i) => {
    const x = M + i * (tw + 8);
    doc.roundedRect(x, y, tw, 58, 6).fill(C.soft);
    doc.rect(x, y, 3, 58).fill(color);
    doc.fillColor(color).font('Helvetica-Bold').fontSize(22).text(value, x + 12, y + 10, { width: tw - 16 });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(label.toUpperCase(), x + 12, y + 36, { width: tw - 16 });
  });
  doc.y = y + 75;
  doc.x = M;

  h2(doc, 'Findings by severity');
  const sevs: Severity[] = ['critical', 'high', 'medium', 'low'];
  const max = Math.max(1, ...sevs.map((k) => s.severityCounts[k]));
  for (const k of sevs) {
    const yy = doc.y;
    doc.fillColor(C.body).font('Helvetica').fontSize(9.5).text(k[0].toUpperCase() + k.slice(1), M, yy, { width: 70 });
    bar(doc, M + 75, yy + 2, 300, (s.severityCounts[k] / max) * 100, SEV[k]);
    doc.fillColor(C.ink).font('Helvetica-Bold').text(String(s.severityCounts[k]), M + 385, yy);
    doc.y = yy + 18;
  }

  h2(doc, 'Score by security domain');
  for (const d of s.domainScores.filter((x) => x.score !== null)) {
    const yy = doc.y;
    doc.fillColor(C.body).font('Helvetica').fontSize(9.5).text(DOMAIN_LABELS[d.domain], M, yy, { width: 150 });
    bar(doc, M + 155, yy + 2, 220, d.score!, scoreColor(d.score));
    doc.fillColor(C.ink).font('Helvetica-Bold').text(`${d.score}%`, M + 385, yy);
    doc.y = yy + 18;
  }

  if (m.comparison) {
    h2(doc, 'Compared to the previous scan');
    const c = m.comparison;
    const scores =
      c.differentScope || c.previousScore === null || s.score === null
        ? `Previous scan on ${fmtDate(c.previousDate)} covered a different scope, so only the ${c.sharedSystems} system(s) in both scans are compared and the scores are not. `
        : `Previous scan on ${fmtDate(c.previousDate)} scored ${c.previousScore} (grade ${c.previousGrade ?? '-'}); now ${s.score} (grade ${s.grade}). `;
    para(doc, scores + `${c.resolved.length} issue(s) resolved, ${c.newFindings.length} new, ${c.persisting.length} persisting.`);
  }

  h2(doc, 'Risk profile');
  const ctx = m.customer.context;
  para(doc, `Level: ${m.riskProfile.level.toUpperCase()}  |  Sector: ${INDUSTRIES.find(([id]) => id === ctx.industry)?.[1] ?? ctx.industry}  |  Employees: ${ctx.employees}`);
  const regs = ctx.regulations.map((r) => REGULATIONS.find(([id]) => id === r)?.[1] ?? r);
  if (regs.length) para(doc, `Regulatory context: ${regs.join(', ')}`);
  if (m.riskProfile.drivers.length) para(doc, `Drivers: ${m.riskProfile.drivers.join('; ')}.`, { color: C.muted, size: 9 });
}

function isoPage(doc: Doc, m: ReportModel) {
  h1(doc, 'ISO/IEC 27001:2022 Annex A assessment', m.branding.accentColor);
  para(
    doc,
    'Each automated check is mapped to the Annex A control it provides evidence for (primary) and related controls (secondary). The verdict reflects technical evidence only; organisational aspects of a control (policies, procedures, awareness) are outside the scope of an automated scan.',
    { color: C.muted, size: 9 },
  );
  doc.moveDown(0.8);
  const counts = { effective: 0, partial: 0, not_effective: 0, not_assessed: 0 };
  for (const c of m.summary.controls) counts[c.verdict]++;
  let x = M;
  const py = doc.y;
  for (const v of ['effective', 'partial', 'not_effective', 'not_assessed'] as ControlVerdict[]) {
    x += pill(doc, x, py, `${counts[v]}  ${VERDICT_LABELS[v].toUpperCase()}`, VERDICT[v]) + 6;
  }
  doc.x = M;
  doc.y = py + 26;

  // table header
  const cols = { id: M, title: M + 42, verdict: M + 300, score: M + 405 };
  const head = () => {
    const y = doc.y;
    doc.rect(M, y, doc.page.width - 2 * M, 18).fill(C.ink);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
    doc.text('Control', cols.id + 4, y + 5);
    doc.text('Title', cols.title, y + 5);
    doc.text('Verdict', cols.verdict, y + 5);
    doc.text('Score', cols.score, y + 5);
    doc.y = y + 22;
  };
  head();
  m.summary.controls.forEach((c, i) => {
    if (doc.y > doc.page.height - M - 60) {
      doc.addPage();
      head();
    }
    const y = doc.y;
    if (i % 2 === 0) doc.rect(M, y - 3, doc.page.width - 2 * M, 20).fill(C.soft);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text(`A.${c.id}`, cols.id + 4, y + 2);
    doc.font('Helvetica').fillColor(C.body).text(c.title, cols.title, y + 2, { width: 250, height: 12, ellipsis: true });
    pill(doc, cols.verdict, y, VERDICT_LABELS[c.verdict], VERDICT[c.verdict], 95);
    if (c.score !== null) {
      bar(doc, cols.score, y + 4, 50, c.score, VERDICT[c.verdict]);
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8.5).text(`${c.score}%`, cols.score + 56, y + 2);
    }
    doc.y = y + 20;
  });
}

function itemList(doc: Doc, title: string, items: ReportItem[]) {
  if (!items.length) return;
  h2(doc, title);
  for (const f of items) {
    ensure(doc, 22);
    const y = doc.y;
    pill(doc, M, y, f.severity.toUpperCase(), SEV[f.severity], 58);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text(f.title, M + 66, y + 2, { width: 300, continued: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(`${f.systemLabel}  |  A.${f.iso[0]}`, M + 370, y + 3, { width: doc.page.width - 2 * M - 370, align: 'right' });
    doc.y = Math.max(doc.y, y + 18);
  }
}

function findingDetail(doc: Doc, f: ReportItem, accent: string) {
  ensure(doc, 140);
  const y = doc.y + 6;
  const W = doc.page.width - 2 * M;
  doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.line).lineWidth(1).stroke();
  doc.y = y + 10;
  const yy = doc.y;
  let x = M;
  x += pill(doc, x, yy, f.severity.toUpperCase(), SEV[f.severity]) + 5;
  x += pill(doc, x, yy, STATUS_LABEL[f.status], statusColor(f.status)) + 5;
  if (f.triage && f.triage.status !== 'open') x += pill(doc, x, yy, f.triage.status === 'accepted' ? 'RISK ACCEPTED' : 'FALSE POSITIVE', C.na) + 5;
  if (f.isNew) pill(doc, x, yy, 'NEW', accent);
  doc.y = yy + 20;
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12).text(f.title, M, doc.y, { width: W });
  doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(
    `${PROVIDER_LABELS[f.provider]}  |  ${f.systemLabel}  |  ISO 27001: ${f.iso.map((i) => `A.${i} ${ISO_BY_ID[i]?.title ?? ''}`).join(', ')}${f.cis ? `  |  ${f.cis}` : ''}${f.nis2 ? `  |  NIS2 ${f.nis2}` : ''}`,
    { width: W },
  );
  doc.moveDown(0.4);
  para(doc, f.description, { size: 9.5 });
  doc.moveDown(0.3);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text('Result: ', { continued: true }).font('Helvetica').fillColor(C.body).text(f.summary, { width: W });
  if (f.resources.length) {
    doc.moveDown(0.3);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text(`Affected resources (${f.resources.length})`);
    const shown = f.resources.slice(0, 12);
    for (const r of shown) {
      ensure(doc, 14);
      doc.fillColor(C.body).font('Helvetica').fontSize(8.5).text(`-  ${r.name ?? r.id}${r.detail ? `  (${r.detail})` : ''}`, M + 8, doc.y, { width: W - 8 });
    }
    if (f.resources.length > shown.length) doc.fillColor(C.muted).fontSize(8.5).text(`... and ${f.resources.length - shown.length} more (see CSV export)`, M + 8);
  }
  doc.moveDown(0.4);
  ensure(doc, 40);
  const ry = doc.y;
  const rh = doc.heightOfString(f.remediation, { width: W - 24 }) + 26;
  doc.roundedRect(M, ry, W, rh, 5).fill('#ecfdf5');
  doc.fillColor('#065f46').font('Helvetica-Bold').fontSize(9).text(`Recommendation  (effort: ${f.effort})`, M + 12, ry + 8);
  doc.font('Helvetica').fontSize(9).text(f.remediation, M + 12, doc.y + 2, { width: W - 24 });
  doc.y = ry + rh + 4;
  if (f.triage?.note) para(doc, `Triage note: ${f.triage.note}`, { color: C.muted, size: 8.5 });
  doc.x = M;
}

function appendix(doc: Doc, m: ReportModel) {
  h1(doc, 'Scope, method and limitations', m.branding.accentColor);
  h2(doc, 'Systems in scope');
  for (const s of m.systems) {
    para(doc, `${s.label}  -  ${s.providerLabel}${s.identity ? `  -  ${s.identity}` : ''}`);
  }
  h2(doc, 'Method');
  para(
    doc,
    `The assessment was performed between ${fmtDate(m.scan.startedAt)} and ${fmtDate(m.scan.finishedAt)} using read-only API access (Microsoft Graph, Azure Resource Manager, AWS APIs and the GitHub REST API). No changes were made to the environments. ` +
      'Evaluation criteria were selected based on the organisation\'s risk profile and reviewed before the scan. Scores are weighted by severity and by the domain weights derived from the risk profile.',
  );
  h2(doc, 'Limitations');
  para(
    doc,
    'This is a point-in-time, automated configuration review. It does not include penetration testing, review of on-premises systems, endpoint configuration, or organisational controls (policies, processes, awareness). Results depend on the permissions and licences available to the scanning identity; checks that could not be evaluated are listed below. A passed check is not a guarantee of security.',
  );
  h2(doc, 'Access revocation');
  para(
    doc,
    `Credentials handling for this scan: ${retentionText(m)}. ` +
      'We recommend removing the scanner access (IAM role, app consent / registration, Azure role assignments, GitHub token) once it is no longer needed.',
  );

  if (m.notAssessed.length) {
    h2(doc, 'Checks not assessed');
    for (const i of m.notAssessed) {
      ensure(doc, 26);
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text(`${i.title}  (${i.systemLabel})`, M);
      doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(i.summary, { width: doc.page.width - 2 * M });
      doc.moveDown(0.2);
    }
  }
  if (m.excluded.length) {
    h2(doc, 'Criteria excluded from scope');
    for (const e of m.excluded) para(doc, `${e.title}  (${PROVIDER_LABELS[e.provider]})${e.reason ? `: ${e.reason}` : ''}`, { size: 9 });
  }
  if (m.passed.length) {
    h2(doc, 'Passed checks');
    for (const p of m.passed) {
      ensure(doc, 14);
      doc.fillColor(C.pass).font('Helvetica-Bold').fontSize(9).text('PASS  ', M, doc.y, { continued: true }).fillColor(C.body).font('Helvetica').text(`${p.title}  (${p.systemLabel}, A.${p.iso[0]})`);
    }
  }
  if (m.branding.disclaimer) {
    h2(doc, 'Disclaimer');
    para(doc, m.branding.disclaimer, { size: 8.5, color: C.muted });
  }
}

export function renderPdf(m: ReportModel, logo: Buffer | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: M,
      bufferPages: true,
      info: { Title: `${REPORT_TITLE} - ${m.customer.name}`, Author: m.branding.companyName || m.branding.consultantName || PRODUCT_NAME, Subject: 'ISO 27001 Annex A technical assessment', Creator: PRODUCT_NAME },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    cover(doc, m, logo);
    summaryPage(doc, m);
    isoPage(doc, m);

    h1(doc, 'Priorities', m.branding.accentColor);
    if (!m.topRisks.length) para(doc, 'No open findings. Well done.');
    itemList(doc, 'Top risks', m.topRisks);
    itemList(doc, 'Quick wins (low effort, meaningful impact)', m.quickWins);

    if (m.findings.length) {
      h1(doc, 'Detailed findings', m.branding.accentColor);
      for (const f of m.findings) findingDetail(doc, f, m.branding.accentColor);
    }
    appendix(doc, m);

    // Footer on every page except the cover.
    const range = doc.bufferedPageRange();
    for (let i = 1; i < range.count; i++) {
      doc.switchToPage(i);
      const y = doc.page.height - 35;
      doc.page.margins.bottom = 0;
      doc.moveTo(M, y - 8).lineTo(doc.page.width - M, y - 8).strokeColor(C.line).lineWidth(0.5).stroke();
      doc.fillColor(C.muted).font('Helvetica').fontSize(7.5);
      doc.text(`${m.customer.name}  |  ${REPORT_TITLE_SHORT}`, M, y, { width: 350, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, doc.page.width - M - 100, y, { width: 100, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
