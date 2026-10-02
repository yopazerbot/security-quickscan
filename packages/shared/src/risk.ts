import { z } from 'zod';
import { DOMAINS, RISK_LEVELS, type Domain, type RiskLevel } from './types.js';

export const INDUSTRIES = [
  ['finance', 'Financial services / Insurance'],
  ['healthcare', 'Healthcare / Life sciences'],
  ['public', 'Public sector / Government'],
  ['energy', 'Energy / Utilities / Critical infrastructure'],
  ['software', 'Software / SaaS / IT services'],
  ['manufacturing', 'Manufacturing / Industry'],
  ['retail', 'Retail / E-commerce'],
  ['legal', 'Legal / Accounting / Consulting'],
  ['education', 'Education / Research'],
  ['logistics', 'Transport / Logistics'],
  ['nonprofit', 'Non-profit'],
  ['other', 'Other'],
] as const;

export const REGULATIONS = [
  ['nis2_essential', 'NIS2 (essential entity)'],
  ['nis2_important', 'NIS2 (important entity)'],
  ['dora', 'DORA'],
  ['gdpr_special', 'GDPR special category data'],
  ['iso27001', 'ISO 27001 (certified or target)'],
  ['soc2', 'SOC 2'],
  ['pci', 'PCI DSS'],
  ['cyberfundamentals', 'CyberFundamentals (CCB)'],
] as const;

const industryIds = INDUSTRIES.map(([id]) => id) as [string, ...string[]];
const regulationIds = REGULATIONS.map(([id]) => id) as [string, ...string[]];

export const customerContextSchema = z.object({
  industry: z.enum(industryIds),
  employees: z.enum(['1-10', '11-50', '51-250', '251-1000', '1000+']),
  regulations: z.array(z.enum(regulationIds)).max(20),
  dataSensitivity: z.enum(['low', 'moderate', 'high', 'very_high']),
  internetExposure: z.enum(['none', 'limited', 'significant']),
  remoteWork: z.enum(['none', 'hybrid', 'full']),
  itManagement: z.enum(['internal', 'msp', 'mixed']),
  developsSoftware: z.boolean(),
  previousIncidents: z.boolean(),
  securityMaturity: z.enum(['initial', 'developing', 'defined', 'managed']),
  crownJewels: z.string().max(2000).default(''),
});
export type CustomerContext = z.infer<typeof customerContextSchema>;

export interface RiskProfile {
  level: RiskLevel;
  points: number;
  drivers: string[];
  domainWeights: Record<Domain, number>;
}

const HIGH_RISK_INDUSTRIES = new Set(['finance', 'healthcare', 'public', 'energy']);

export function computeRiskProfile(ctx: CustomerContext): RiskProfile {
  let points = 0;
  const drivers: string[] = [];
  const add = (p: number, why: string) => {
    points += p;
    if (p > 0) drivers.push(why);
  };

  if (HIGH_RISK_INDUSTRIES.has(ctx.industry)) add(3, 'Sector is a frequent target and/or heavily regulated');
  if (ctx.industry === 'software') add(2, 'Software supplier: supply-chain impact on its own customers');
  add({ '1-10': 0, '11-50': 1, '51-250': 2, '251-1000': 3, '1000+': 4 }[ctx.employees], 'Organisation size widens the attack surface');
  if (ctx.regulations.includes('nis2_essential')) add(3, 'NIS2 essential entity');
  else if (ctx.regulations.includes('nis2_important')) add(2, 'NIS2 important entity');
  if (ctx.regulations.includes('dora')) add(3, 'Subject to DORA');
  if (ctx.regulations.includes('pci')) add(2, 'Processes cardholder data (PCI DSS)');
  if (ctx.regulations.includes('gdpr_special')) add(2, 'Processes GDPR special category data');
  add({ low: 0, moderate: 1, high: 3, very_high: 4 }[ctx.dataSensitivity], 'Sensitive data processed');
  add({ none: 0, limited: 1, significant: 3 }[ctx.internetExposure], 'Internet-facing services');
  add({ none: 0, hybrid: 1, full: 2 }[ctx.remoteWork], 'Remote workforce relies on cloud identity');
  if (ctx.itManagement !== 'internal') add(1, 'IT (partly) managed by a third party');
  if (ctx.developsSoftware) add(1, 'Develops software in-house');
  if (ctx.previousIncidents) add(2, 'Previous security incidents');
  add({ initial: 3, developing: 2, defined: 1, managed: 0 }[ctx.securityMaturity], 'Limited security maturity');

  const level: RiskLevel = points >= 18 ? 'critical' : points >= 12 ? 'high' : points >= 6 ? 'medium' : 'low';

  const w = Object.fromEntries(DOMAINS.map((d) => [d, 1])) as Record<Domain, number>;
  w.privileged = 1.3;
  if (ctx.dataSensitivity === 'high' || ctx.dataSensitivity === 'very_high') w.data = 1.5;
  if (ctx.internetExposure === 'significant') w.network = 1.5;
  if (ctx.developsSoftware || ctx.industry === 'software') w.supply_chain = 1.4;
  if (ctx.remoteWork === 'full') w.identity = 1.3;
  if (ctx.regulations.some((r) => ['nis2_essential', 'nis2_important', 'dora', 'iso27001'].includes(r))) {
    w.logging = 1.3;
    w.governance = 1.2;
  }

  return { level, points, drivers, domainWeights: w };
}

export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

export const DEFAULT_CONTEXT: CustomerContext = {
  industry: 'other',
  employees: '11-50',
  regulations: [],
  dataSensitivity: 'moderate',
  internetExposure: 'limited',
  remoteWork: 'hybrid',
  itManagement: 'internal',
  developsSoftware: false,
  previousIncidents: false,
  securityMaturity: 'developing',
  crownJewels: '',
};
