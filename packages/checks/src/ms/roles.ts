/** Built-in Entra directory role template ids used by the Microsoft 365 checks. */
export const ROLE = {
  globalAdmin: '62e90394-69f5-4237-9190-012177145e10',
  privilegedRoleAdmin: 'e8611ab8-c189-46e8-94e1-60213ab1f814',
  securityAdmin: '194ae4cb-b126-40b2-bd5b-6091b380977d',
  exchangeAdmin: '29232cdf-9323-42fd-ade2-1d097af3e4de',
  sharePointAdmin: 'f28a1f50-f6e7-4571-818b-6a12f2af6b6c',
  conditionalAccessAdmin: 'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9',
  helpdeskAdmin: '729827e3-9c14-49f7-bb1b-9608f156bbb8',
  billingAdmin: 'b0f54661-2d74-4c50-afa3-1ec803f12efe',
  userAdmin: 'fe930be7-5e62-47db-91af-98c3a49a38b1',
  authenticationAdmin: 'c4e39bd9-1100-46d3-8c65-fb160da0071f',
  privilegedAuthenticationAdmin: '7be44c8a-adaf-4e2a-84d6-ab2649e08a13',
  applicationAdmin: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
  cloudApplicationAdmin: '158c047a-c907-4556-b7ef-446551a6b5f7',
  intuneAdmin: '3a2c62db-5318-420d-8d74-23affee5d9d5',
} as const;

export const ROLE_NAMES: Record<string, string> = {
  [ROLE.globalAdmin]: 'Global Administrator',
  [ROLE.privilegedRoleAdmin]: 'Privileged Role Administrator',
  [ROLE.securityAdmin]: 'Security Administrator',
  [ROLE.exchangeAdmin]: 'Exchange Administrator',
  [ROLE.sharePointAdmin]: 'SharePoint Administrator',
  [ROLE.conditionalAccessAdmin]: 'Conditional Access Administrator',
  [ROLE.helpdeskAdmin]: 'Helpdesk Administrator',
  [ROLE.billingAdmin]: 'Billing Administrator',
  [ROLE.userAdmin]: 'User Administrator',
  [ROLE.authenticationAdmin]: 'Authentication Administrator',
  [ROLE.privilegedAuthenticationAdmin]: 'Privileged Authentication Administrator',
  [ROLE.applicationAdmin]: 'Application Administrator',
  [ROLE.cloudApplicationAdmin]: 'Cloud Application Administrator',
  [ROLE.intuneAdmin]: 'Intune Administrator',
};

/** The administrative roles CIS Microsoft 365 Foundations expects to be covered by admin MFA and session controls. */
export const CIS_ADMIN_ROLES: string[] = Object.values(ROLE);

/** Roles that can take over the tenant (or its identities) on their own. */
export const TIER0_ROLES = new Set<string>([ROLE.globalAdmin, ROLE.privilegedRoleAdmin, ROLE.privilegedAuthenticationAdmin]);

export const roleName = (id: string) => ROLE_NAMES[id] ?? id;
