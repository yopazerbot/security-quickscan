/** Generates docs/CHECKS.md from the check catalog. Run: npm run docs:checks */
import { writeFileSync } from 'node:fs';
import { CHECKS, DOMAIN_LABELS, ISO_BY_ID, ISO_CONTROLS, PROVIDER_LABELS, PROVIDERS, isoSort } from '../packages/shared/src/index.js';

const esc = (s: string) => s.replace(/\|/g, '\\|');
const lines: string[] = [];
lines.push('# Check catalogue', '');
lines.push(`Security QuickScan runs **${CHECKS.length} read-only checks**. Each check maps to one primary ISO/IEC 27001:2022 Annex A control (bold) and optional secondary controls.`);
lines.push('The "Default from" column is the lowest risk profile at which the check is included by default; any check can be included or excluded per scan.', '');
lines.push('_This file is generated from `packages/shared/src/catalog` by `npm run docs:checks`._', '');

for (const p of PROVIDERS) {
  const list = CHECKS.filter((c) => c.provider === p);
  lines.push(`## ${PROVIDER_LABELS[p]} (${list.length})`, '');
  lines.push('| Check | Severity | Domain | ISO 27001:2022 | Default from | Other refs |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of list) {
    const iso = c.frameworks.iso27001.map((x, i) => (i === 0 ? `**A.${x}**` : `A.${x}`)).join(', ');
    const refs = [c.frameworks.cis, c.frameworks.nis2 && `NIS2 ${c.frameworks.nis2}`].filter(Boolean).join('; ');
    lines.push(`| ${esc(c.title)} | ${c.severity} | ${DOMAIN_LABELS[c.domain]} | ${iso} | ${c.minRisk} | ${esc(refs)} |`);
  }
  lines.push('');
}

lines.push('## Annex A coverage', '');
lines.push('| Control | Title | Primary checks | Secondary checks |');
lines.push('| --- | --- | --- | --- |');
for (const ctrl of [...ISO_CONTROLS].sort((a, b) => isoSort(a.id, b.id))) {
  const primary = CHECKS.filter((c) => c.frameworks.iso27001[0] === ctrl.id).length;
  const secondary = CHECKS.filter((c) => c.frameworks.iso27001.slice(1).includes(ctrl.id)).length;
  if (primary + secondary === 0) continue;
  lines.push(`| A.${ctrl.id} | ${ISO_BY_ID[ctrl.id].title} | ${primary} | ${secondary} |`);
}
lines.push('');
writeFileSync(new URL('../docs/CHECKS.md', import.meta.url), lines.join('\n'));
console.log(`docs/CHECKS.md: ${CHECKS.length} checks`);
