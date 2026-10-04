export const PROVIDERS = ['m365', 'azure', 'aws', 'github'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  m365: 'Microsoft 365 / Entra ID',
  azure: 'Microsoft Azure',
  aws: 'Amazon Web Services',
  github: 'GitHub',
};

export const PROVIDER_SHORT: Record<Provider, string> = { m365: 'M365', azure: 'Azure', aws: 'AWS', github: 'GitHub' };

export const DOMAINS = [
  'identity',
  'privileged',
  'logging',
  'data',
  'network',
  'supply_chain',
  'governance',
] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_SHORT: Record<Domain, string> = {
  identity: 'Identity',
  privileged: 'Privileged',
  logging: 'Logging',
  data: 'Data',
  network: 'Network',
  supply_chain: 'Supply chain',
  governance: 'Governance',
};

export const DOMAIN_LABELS: Record<Domain, string> = {
  identity: 'Identity & Access',
  privileged: 'Privileged Access',
  logging: 'Logging & Detection',
  data: 'Data Protection',
  network: 'Network Exposure',
  supply_chain: 'Code & Supply Chain',
  governance: 'Governance & Hygiene',
};

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  high: 6,
  medium: 3,
  low: 1,
  info: 0,
};

export const RESULT_STATUSES = ['pass', 'fail', 'warn', 'na', 'error'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const ROLES = ['admin', 'consultant', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Display labels for roles. The stored value 'consultant' is shown as "Analyst". */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  consultant: 'Analyst',
  viewer: 'Viewer',
};

export const SCAN_STATUSES = ['draft', 'queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const RETENTION_MODES = ['purge_on_completion', 'days', 'manual'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export interface Frameworks {
  /** ISO/IEC 27001:2022 Annex A controls. First entry is the primary control. */
  iso27001: [string, ...string[]];
  cis?: string;
  nis2?: string;
}

export interface CheckMeta {
  id: string;
  provider: Provider;
  domain: Domain;
  title: string;
  description: string;
  severity: Severity;
  effort: 'low' | 'medium' | 'high';
  remediation: string;
  references: string[];
  frameworks: Frameworks;
  /** Permissions or licences this check relies on, shown in guidance. */
  requires?: string;
}

export interface ResourceRef {
  id: string;
  name?: string;
  detail?: string;
  /** Deep link to the resource in the provider console (Entra, Azure portal, AWS console, github.com). */
  url?: string;
  /** Resource type, e.g. 'S3 bucket', 'Conditional Access policy', 'Repository'. */
  type?: string;
  region?: string;
  /** Account, subscription, tenant or organisation the resource belongs to. */
  account?: string;
}

export interface CheckOutcome {
  status: ResultStatus;
  summary: string;
  resources?: ResourceRef[];
  evidence?: Record<string, unknown>;
}
