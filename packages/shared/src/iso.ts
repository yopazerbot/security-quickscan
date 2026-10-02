/**
 * ISO/IEC 27001:2022 Annex A is the central evaluation framework. Every check maps to one
 * primary control (first entry of `frameworks.iso27001`) and optionally secondary controls.
 * Only controls that can be (partially) evidenced by a technical cloud scan are listed.
 */
export type IsoTheme = 'organizational' | 'people' | 'physical' | 'technological';

export interface IsoControl {
  id: string;
  title: string;
  theme: IsoTheme;
}

export const ISO_THEME_LABELS: Record<IsoTheme, string> = {
  organizational: 'A.5 Organizational controls',
  people: 'A.6 People controls',
  physical: 'A.7 Physical controls',
  technological: 'A.8 Technological controls',
};

const C = (id: string, title: string, theme: IsoTheme): IsoControl => ({ id, title, theme });

export const ISO_CONTROLS: IsoControl[] = [
  C('5.7', 'Threat intelligence', 'organizational'),
  C('5.9', 'Inventory of information and other associated assets', 'organizational'),
  C('5.14', 'Information transfer', 'organizational'),
  C('5.15', 'Access control', 'organizational'),
  C('5.16', 'Identity management', 'organizational'),
  C('5.17', 'Authentication information', 'organizational'),
  C('5.18', 'Access rights', 'organizational'),
  C('5.19', 'Information security in supplier relationships', 'organizational'),
  C('5.23', 'Information security for use of cloud services', 'organizational'),
  C('5.24', 'Incident management planning and preparation', 'organizational'),
  C('5.25', 'Assessment and decision on information security events', 'organizational'),
  C('5.28', 'Collection of evidence', 'organizational'),
  C('5.33', 'Protection of records', 'organizational'),
  C('5.34', 'Privacy and protection of PII', 'organizational'),
  C('6.7', 'Remote working', 'people'),
  C('8.1', 'User endpoint devices', 'technological'),
  C('8.2', 'Privileged access rights', 'technological'),
  C('8.3', 'Information access restriction', 'technological'),
  C('8.4', 'Access to source code', 'technological'),
  C('8.5', 'Secure authentication', 'technological'),
  C('8.7', 'Protection against malware', 'technological'),
  C('8.8', 'Management of technical vulnerabilities', 'technological'),
  C('8.9', 'Configuration management', 'technological'),
  C('8.12', 'Data leakage prevention', 'technological'),
  C('8.13', 'Information backup', 'technological'),
  C('8.15', 'Logging', 'technological'),
  C('8.16', 'Monitoring activities', 'technological'),
  C('8.20', 'Networks security', 'technological'),
  C('8.21', 'Security of network services', 'technological'),
  C('8.22', 'Segregation of networks', 'technological'),
  C('8.24', 'Use of cryptography', 'technological'),
  C('8.25', 'Secure development life cycle', 'technological'),
  C('8.28', 'Secure coding', 'technological'),
  C('8.32', 'Change management', 'technological'),
];

export const ISO_BY_ID: Record<string, IsoControl> = Object.fromEntries(ISO_CONTROLS.map((c) => [c.id, c]));

export function isoSort(a: string, b: string): number {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2;
}

export type ControlVerdict = 'effective' | 'partial' | 'not_effective' | 'not_assessed';

export const VERDICT_LABELS: Record<ControlVerdict, string> = {
  effective: 'Effective',
  partial: 'Partially effective',
  not_effective: 'Not effective',
  not_assessed: 'Not assessed',
};
