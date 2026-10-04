import { CHECKS_BY_ID, type CheckOutcome, type ResourceRef } from '@qs/shared';
import { sleep } from './util.js';
import { githubOrgSettingsUrl, githubRepoUrl, githubUrl } from './links.js';
import { awsConsoleUrl, type AwsConsoleService } from './links.js';
import { azurePortalUrl, entraUrl, type EntraKind } from './links.js';

/**
 * Demo data for the fictional company "Noordkust Logistics NV".
 * Only reserved example domains and documentation account IDs are used, so nothing points at a real organisation.
 */
export const DEMO_COMPANY = {
  name: 'Noordkust Logistics NV',
  domain: 'noordkust.example',
  tenantId: '0f1e2d3c-4b5a-4968-8776-655443322110',
  awsAccount: '111122223333',
  githubOrg: 'noordkust-demo',
};

const D = DEMO_COMPANY.domain;
const ACC = DEMO_COMPANY.awsAccount;
const ORG = DEMO_COMPANY.githubOrg;
const upn = (u: string) => `${u}@${D}`;
const user = (u: string, detail?: string): ResourceRef => msUser(u, detail);
// AWS resources (demo account, region eu-west-1 unless stated otherwise).
const AWS_REGION = 'eu-west-1';
const iam = (u: string, detail?: string): ResourceRef => {
  const id = `arn:aws:iam::${ACC}:user/${u}`;
  return { id, name: u, detail, type: 'IAM user', account: ACC, url: awsConsoleUrl('iam-user', undefined, id) };
};
const iamRole = (r: string, detail?: string, path = '/'): ResourceRef => {
  const id = `arn:aws:iam::${ACC}:role${path}${r}`;
  return { id, name: r, detail, type: 'IAM role', account: ACC, url: awsConsoleUrl('iam-role', undefined, id) };
};
const awsRoot = (detail?: string): ResourceRef => ({ id: `arn:aws:iam::${ACC}:root`, name: 'root', detail, type: 'Root user', account: ACC });
const awsRes = (
  service: AwsConsoleService | undefined,
  type: string,
  arn: string,
  name: string,
  detail?: string,
  opts: { region?: string; urlId?: string } = {},
): ResourceRef => {
  const region = opts.region ?? AWS_REGION;
  const url = service ? awsConsoleUrl(service, region, opts.urlId ?? arn) : undefined;
  return { id: arn, name, detail, type, region, account: ACC, ...(url ? { url } : {}) };
};
const awsRegion = (arnService: string, type: string, region: string, detail?: string, service?: AwsConsoleService) =>
  awsRes(service, type, `arn:aws:${arnService}:${region}:${ACC}:account`, region, detail, { region, urlId: '' });
const bucket = (b: string, detail: string) => awsRes('s3', 'S3 bucket', `arn:aws:s3:::${b}`, b, detail, { urlId: b });
const sg = (id: string, name: string, detail: string) => awsRes('ec2-sg', 'Security group', `arn:aws:ec2:${AWS_REGION}:${ACC}:security-group/${id}`, `${name} (${id})`, detail, { urlId: id });
const ec2i = (id: string, name: string) => awsRes('ec2-instance', 'EC2 instance', `arn:aws:ec2:${AWS_REGION}:${ACC}:instance/${id}`, name, `${id}, IMDSv1 allowed`, { urlId: id });
const rdsDb = (id: string, detail: string) => awsRes('rds', 'RDS instance', `arn:aws:rds:${AWS_REGION}:${ACC}:db:${id}`, id, detail);
const repo = (r: string, detail?: string, page?: string): ResourceRef => ({
  id: `${ORG}/${r}`,
  name: `${ORG}/${r}`,
  detail,
  type: 'Repository',
  url: githubRepoUrl(`${ORG}/${r}`, page),
  account: ORG,
});
const ghMember = (login: string, detail?: string): ResourceRef => ({ id: login, name: login, detail, type: 'Member', url: githubUrl(login), account: ORG });
const ghSetting = (name: string, page: string, detail?: string): ResourceRef => ({
  id: `${ORG}/settings/${page}`,
  name,
  detail,
  type: 'Organisation setting',
  url: githubOrgSettingsUrl(ORG, page),
  account: ORG,
});
// Microsoft resources (demo tenant and subscriptions): deterministic object ids, so links stay stable.
function demoGuid(seed: string): string {
  let hex = '';
  for (let salt = 0; hex.length < 32; salt++) {
    let h = 2166136261 ^ salt;
    for (const c of `${salt}:${seed}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    hex += (h >>> 0).toString(16).padStart(8, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const AZ_SUBS: Record<string, string> = { 'noordkust-prod': demoGuid('sub:noordkust-prod'), 'noordkust-dev': demoGuid('sub:noordkust-dev') };
const subArm = (name: string) => `/subscriptions/${AZ_SUBS[name] ?? demoGuid(`sub:${name}`)}`;
const sub = (name: string, detail?: string): ResourceRef => ({ id: subArm(name), name, detail, type: 'Subscription', account: name, url: azurePortalUrl(subArm(name)) });
const azRes = (subName: string, rg: string, provider: string, name: string, type: string, detail?: string, region = 'westeurope'): ResourceRef => {
  const id = `${subArm(subName)}/resourceGroups/${rg}/providers/${provider}/${name}`;
  return { id, name, detail, type, region, account: subName, url: azurePortalUrl(id) };
};
const entra = (kind: EntraKind, type: string, name: string, detail?: string): ResourceRef => {
  const id = demoGuid(`${kind}:${name}`);
  return { id, name, detail, type, account: D, url: entraUrl(kind, kind === 'app' ? demoGuid(`appId:${name}`) : id) };
};
const msUser = (u: string, detail?: string) => entra('user', 'User', upn(u), detail);
const caPol = (name: string, detail?: string) => entra('caPolicy', 'Conditional Access policy', name, detail);
const msRole = (name: string, detail?: string) => entra('role', 'Directory role', name, detail);
const msSp = (name: string, detail?: string) => entra('servicePrincipal', 'Enterprise application', name, detail);
const msApp = (name: string, detail?: string) => entra('app', 'App registration', name, detail);

interface Scenario {
  /** Outcome when the control is not (yet) in place. */
  bad: CheckOutcome;
  /** Summary when the control is in place. */
  good: string;
  /** Optional: result is always n/a (e.g. no such resources in this environment). */
  na?: string;
}

const fail = (summary: string, resources: ResourceRef[] = [], evidence?: Record<string, unknown>): CheckOutcome => ({ status: 'fail', summary, resources, evidence });
const warn = (summary: string, resources: ResourceRef[] = [], evidence?: Record<string, unknown>): CheckOutcome => ({ status: 'warn', summary, resources, evidence });

const SCENARIOS: Record<string, Scenario> = {
  // ---------- Microsoft 365 / Entra ID ----------
  'm365.mfa-all-users': {
    bad: warn(
      "MFA is enforced for all users and all cloud apps by 'CA001 - Require MFA - all users', but it excludes 3 user(s), 1 group(s): more than break-glass accounts. Review the exclusions.",
      [
        caPol('CA001 - Require MFA - all users', 'enabled'),
        user('breakglass01', 'excluded'),
        user('breakglass02', 'excluded'),
        user('scanner.magazijn', 'excluded'),
        entra('group', 'Group', 'SG-Chauffeurs-NoMFA', 'excluded (group)'),
      ],
      { exclusions: ['breakglass01@noordkust.example (User)', 'breakglass02@noordkust.example (User)', 'scanner.magazijn@noordkust.example (User)', 'SG-Chauffeurs-NoMFA (Group)'] },
    ),
    good: "MFA is enforced for all users and all cloud apps by 'CA001 - Require MFA - all users', with break-glass exclusions: breakglass01@noordkust.example, breakglass02@noordkust.example.",
  },
  'm365.legacy-auth': {
    bad: fail(
      "Legacy authentication is not blocked for all users and all cloud apps. 1 related policy(ies) do not count: 'CA002 - Block legacy authentication' (policy is disabled; client app types miss other).",
      [caPol('CA002 - Block legacy authentication', 'does not count: policy is disabled; client app types miss other')],
    ),
    good: "Legacy authentication (Exchange ActiveSync and other clients) is blocked for all users and all cloud apps by 'CA002 - Block legacy authentication'.",
  },
  'm365.admin-mfa': {
    bad: warn(
      'All administrator roles require MFA, but 14 role(s) are not held to a phishing-resistant authentication strength: Global Administrator, Privileged Role Administrator, Security Administrator, Exchange Administrator and 10 more.',
      [caPol('CA001 - Require MFA - all users', 'enabled'), msRole('Global Administrator', 'MFA without phishing-resistant strength'), msRole('Privileged Role Administrator', 'MFA without phishing-resistant strength')],
    ),
    good: "All 14 administrator roles must use phishing-resistant MFA ('CA003 - Admins phishing-resistant MFA').",
  },
  'm365.admin-session-controls': {
    bad: fail('No enforced Conditional Access session controls (sign-in frequency, no persistent browser) for administrator roles.', [
      caPol('CA004 - Admin session lifetime', 'does not count: policy is disabled'),
    ]),
    good: 'All 14 administrator roles have a sign-in frequency of 4 hours or less and no persistent browser sessions.',
  },
  'm365.device-code-flow': {
    bad: fail('Device code flow is not blocked by Conditional Access: attackers can use device code phishing to obtain tokens.'),
    good: "Device code flow is blocked for all users and all cloud apps by 'CA005 - Block device code flow', with break-glass exclusions: breakglass01@noordkust.example.",
  },
  'm365.global-admin-count': {
    bad: fail('6 Global Administrator(s) (1 PIM-eligible), recommended 2-4.', [
      user('admin.pieters', 'active'),
      user('k.janssens', 'active'),
      user('it-support', 'active, via group SG-Tier0-Admins'),
      user('l.maes', 'eligible (PIM)'),
      user('breakglass01', 'active'),
      user('msp-partner', 'active, guest of the managed service provider'),
    ]),
    good: '3 Global Administrator(s) (1 PIM-eligible).',
  },
  'm365.admins-cloud-only': {
    bad: fail('2 privileged account(s) are synchronised from on-premises AD.', [
      user('k.janssens', 'Global Administrator, synchronised from on-premises (active)'),
      user('l.maes', 'Exchange Administrator, synchronised from on-premises (eligible)'),
    ]),
    good: 'All active and eligible privileged role members are cloud-only accounts.',
  },
  'm365.privileged-guests': {
    bad: fail('1 guest(s) and 1 service principal(s) hold privileged directory roles.', [
      entra('user', 'User', 'msp-partner_partner.example#EXT#@noordkust.example', 'guest: Global Administrator (active)'),
      entra('servicePrincipal', 'Service principal', 'TMS Provisioning', 'service principal: User Administrator (active)'),
    ]),
    good: 'No guests or service principals hold privileged directory roles.',
  },
  'm365.mfa-registration': {
    bad: warn('86% of users registered for MFA (19 missing).', [user('chauffeur.planning'), user('magazijn.antwerpen'), user('s.peeters'), user('t.wouters'), user('receptie')], { registered: 118, total: 137, percentage: 86 }),
    good: '98% of 137 users are registered for MFA.',
  },
  'm365.user-consent': {
    bad: fail('Users can consent to any application requesting any delegated permission.', [], { assigned: ['ManagePermissionGrantsForSelf.microsoft-user-default-legacy'] }),
    good: 'User consent is limited to verified publishers and low-impact permissions.',
  },
  'm365.user-app-registration': { bad: warn('All users can register applications.'), good: 'Users cannot register applications.' },
  'm365.guest-invites': {
    bad: warn('All member users can invite guests.', [], { allowInvitesFrom: 'adminsGuestInvitersAndAllMembers' }),
    good: 'Guest invitations are restricted to admins and users in the Guest Inviter role.',
  },
  'm365.guest-access': { bad: warn('Guests have limited access to directory objects (default); consider the most restrictive setting.'), good: 'Guest access is restricted to their own directory objects.' },
  'm365.stale-accounts': {
    bad: warn(
      '7 enabled account(s) without a successful sign-in for 90+ days.',
      [
        user('j.devos', 'Member, last successful sign-in 2026-05-03'),
        user('stagiair2024', 'Member, last successful sign-in 2025-08-29'),
        user('scanner.magazijn', 'Member, last successful sign-in never'),
        entra('user', 'User', 'consultant_partner.example#EXT#@noordkust.example', 'Guest, last successful sign-in 2026-02-12'),
        user('oud.boekhouding', 'Member, last successful sign-in 2026-04-21'),
        user('test.user', 'Member, last successful sign-in never'),
        user('h.claes', 'Member, last successful sign-in 2026-06-01'),
      ],
      { lastSuccessfulSignIn: { [upn('j.devos')]: '2026-05-03T07:12:44Z', [upn('stagiair2024')]: '2025-08-29T15:40:02Z', [upn('scanner.magazijn')]: null } },
    ),
    good: 'No stale enabled accounts.',
  },
  'm365.risky-app-permissions': {
    bad: fail('1 application(s) hold Tier-0 Microsoft Graph permissions that allow taking over the tenant, 2 hold tenant-wide write permissions.', [
      msSp('Legacy Provisioning Script', 'Tier-0: Directory.ReadWrite.All'),
      msSp('TMS Mail Connector', 'write: Mail.ReadWrite, Mail.Send'),
      msSp('Legacy Backup Tool', 'write: Files.ReadWrite.All, Sites.FullControl.All'),
      msSp('Planning Dashboard', 'read-all: Calendars.Read; delegated for all users: Mail.Read'),
    ]),
    good: 'No applications hold high-impact Microsoft Graph application permissions or tenant-wide delegated grants.',
  },
  'm365.app-credentials': {
    bad: fail('1 privileged or multi-tenant application(s) use long-lived client secrets. 2 more have credential hygiene issues.', [
      msApp('TMS Mail Connector', '1 client secret(s) valid for more than 1 year (until 2028-03-31) (privileged)'),
      msApp('Planning Dashboard', '1 client secret(s) valid for more than 1 year (until 2027-11-15)'),
      msApp('Old Intranet SSO', '2 expired credential(s) still present'),
    ]),
    good: 'None of 23 application registrations have long-lived client secrets or expired credentials.',
  },
  'm365.pim': {
    bad: warn('No PIM-eligible assignments for privileged roles: privileged roles are permanently assigned.', [
      user('admin.pieters', 'permanent Global Administrator'),
      user('k.janssens', 'permanent Global Administrator'),
      user('it-support', 'permanent Helpdesk Administrator'),
    ]),
    good: 'PIM is used: 9 eligible privileged assignment(s); permanent assignments limited to 2 break-glass Global Administrator(s).',
  },
  'm365.risk-policies': {
    bad: fail('No enforced sign-in or user risk Conditional Access policies for all users and apps. 1 related policy(ies) do not count.', [
      caPol('CA006 - Risky sign-ins (pilot)', 'does not count: does not apply to all users'),
    ]),
    good: 'Sign-in risk and user risk Conditional Access policies are enforced for all users.',
  },
  'm365.device-compliance': { bad: fail('No Conditional Access policy requires managed devices.'), good: "Conditional Access requires compliant or joined devices ('CA007 - Require compliant device')." },
  'm365.weak-auth-methods': {
    bad: warn('Weak methods enabled: Sms, Voice.', [{ id: 'Sms', name: 'Sms', type: 'Authentication method', account: D }, { id: 'Voice', name: 'Voice', type: 'Authentication method', account: D }], {
      policyMigrationState: 'migrationInProgress',
      enabled: ['Sms', 'Voice'],
    }),
    good: 'SMS and voice authentication are disabled.',
  },
  'm365.authenticator-number-matching': {
    bad: warn('Number matching is on, but additional context is not shown to all users: application name default, geographic location default.', [], {
      numberMatching: 'enabled',
      applicationName: 'default',
      geographicLocation: 'default',
    }),
    good: 'Microsoft Authenticator requires number matching and shows the application name and location.',
  },
  'm365.email-auth': {
    bad: warn('1 of 2 mail domain(s) have SPF, DKIM or DMARC gaps.', [
      { id: D, name: D, detail: 'DMARC p=none, DKIM not configured for Exchange Online (no selector1/selector2 CNAME)', type: 'Mail domain', url: `https://admin.microsoft.com/#/Domains/Details/${D}` },
    ]),
    good: 'All 2 mail domains have valid SPF, DKIM and enforcing DMARC.',
  },
  'm365.secure-score': {
    bad: warn('Secure Score is 48% (162/338). Biggest gaps: Ensure all users can complete MFA, Block legacy authentication, Turn on Microsoft Defender for Office 365 Safe Links.', [], {
      currentScore: 162,
      maxScore: 338,
      percentage: 48,
      weakestControls: [
        { control: 'Ensure all users can complete multifactor authentication', category: 'Identity', score: 0, maxScore: 9 },
        { control: 'Block legacy authentication', category: 'Identity', score: 0, maxScore: 8 },
        { control: 'Turn on Microsoft Defender for Office 365 Safe Links', category: 'Apps', score: 2, maxScore: 9 },
      ],
    }),
    good: 'Secure Score is 74% (250/338).',
  },

  // ---------- Azure ----------
  'azure.defender-plans': {
    bad: fail('1 subscription(s) have none of the Defender plans their workloads need.', [
      sub('noordkust-prod', 'not enabled: Arm, CloudPosture, VirtualMachines, StorageAccounts, KeyVaults, SqlServers (required: Arm, CloudPosture, VirtualMachines, StorageAccounts, KeyVaults, SqlServers)'),
      sub('noordkust-dev', 'not enabled: CloudPosture, AppServices (required: Arm, CloudPosture, StorageAccounts, AppServices)'),
    ]),
    good: 'Defender for Cloud plans are enabled for every deployed workload type (plus Resource Manager and CSPM).',
  },
  'azure.security-contact': { bad: warn('1 subscription(s) without a security contact.', [sub('noordkust-dev', 'no security contact e-mail')]), good: 'Security contacts are configured.' },
  'azure.activity-log-export': {
    bad: fail('1 subscription(s) do not export the activity log; 1 subscription(s) miss required categories (required: Administrative, Alert, Policy, Security).', [
      sub('noordkust-dev', 'no diagnostic setting'),
      sub('noordkust-prod', 'missing categories: Alert, Policy'),
    ]),
    good: 'Activity logs (Administrative, Alert, Policy, Security) are exported on all subscriptions.',
  },
  'azure.storage-public': {
    bad: fail('2 of 5 storage accounts allow anonymous blob access.', [
      azRes('noordkust-prod', 'rg-documents', 'Microsoft.Storage/storageAccounts', 'stnoordkustdocs', 'Storage account', 'anonymous blob access allowed'),
      azRes('noordkust-dev', 'rg-dev', 'Microsoft.Storage/storageAccounts', 'stnkdevtemp', 'Storage account', 'anonymous blob access allowed'),
    ]),
    good: 'All 5 storage accounts disallow anonymous blob access.',
  },
  'azure.storage-transport': {
    bad: fail('2 of 5 storage account(s) do not enforce HTTPS and TLS 1.2+.', [
      azRes('noordkust-prod', 'rg-legacy', 'Microsoft.Storage/storageAccounts', 'stnklegacyftp', 'Storage account', 'minimum TLS1_0'),
      azRes('noordkust-dev', 'rg-dev', 'Microsoft.Storage/storageAccounts', 'stnkdevtemp', 'Storage account', 'secure transfer not explicitly required, minimum TLS version not set'),
    ]),
    good: 'All 5 storage accounts enforce HTTPS and TLS 1.2+.',
  },
  'azure.storage-network': {
    bad: fail('3 of 5 storage account(s) are reachable from all networks; 1 more allow shared keys or lack soft delete.', [
      azRes('noordkust-prod', 'rg-documents', 'Microsoft.Storage/storageAccounts', 'stnoordkustdocs', 'Storage account', 'reachable from all networks, shared key access allowed'),
      azRes('noordkust-prod', 'rg-legacy', 'Microsoft.Storage/storageAccounts', 'stnklegacyftp', 'Storage account', 'reachable from all networks, shared key access allowed, blob soft delete off'),
      azRes('noordkust-dev', 'rg-dev', 'Microsoft.Storage/storageAccounts', 'stnkdevtemp', 'Storage account', 'reachable from all networks, shared key access allowed, blob soft delete off'),
      azRes('noordkust-prod', 'rg-tms', 'Microsoft.Storage/storageAccounts', 'sttmsdata', 'Storage account', 'shared key access allowed'),
    ]),
    good: 'All 5 storage accounts restrict network access, disable shared keys and keep blob soft delete on.',
  },
  'azure.keyvault-protection': {
    bad: fail('2 of 3 Key Vaults lack soft delete or purge protection; 1 more use access policies instead of RBAC.', [
      azRes('noordkust-prod', 'rg-security', 'Microsoft.KeyVault/vaults', 'kv-noordkust-prod', 'Key Vault', 'no purge protection, access policies instead of RBAC'),
      azRes('noordkust-dev', 'rg-dev', 'Microsoft.KeyVault/vaults', 'kv-nk-dev', 'Key Vault', 'no purge protection, access policies instead of RBAC'),
      azRes('noordkust-prod', 'rg-tms', 'Microsoft.KeyVault/vaults', 'kv-nk-tms', 'Key Vault', 'access policies instead of RBAC'),
    ]),
    good: 'All 3 Key Vaults have soft delete, purge protection and RBAC authorization.',
  },
  'azure.nsg-admin-ports': {
    bad: fail('3 NSG rule(s) expose administrative or database ports to the internet or very broad ranges.', [
      ['noordkust-prod', 'rg-tms', 'nsg-tms-app', 'Allow-RDP', 'ports 3389 from * (priority 300)'],
      ['noordkust-prod', 'rg-network', 'nsg-jumphost', 'ssh-anywhere', 'ports 22 from Internet (priority 100)'],
      ['noordkust-dev', 'rg-dev', 'nsg-dev-db', 'db-temp', 'ports 1433, 5432 from 0.0.0.0/0 (priority 200)'],
    ].map(([s, rg, nsg, rule, detail]) => {
      const n = azRes(s, rg, 'Microsoft.Network/networkSecurityGroups', nsg, 'NSG rule', detail);
      return { ...n, id: `${n.id}/securityRules/${rule}`, name: `${nsg}/${rule}` };
    })),
    good: 'None of 6 NSGs expose administrative or database ports to the internet.',
  },
  'azure.sql-public': {
    bad: warn('1 of 2 SQL server(s) allow access from all Azure services (including other tenants).', [
      azRes('noordkust-prod', 'rg-tms', 'Microsoft.Sql/servers', 'sql-nk-tms', 'SQL server', 'allows access from all Azure services'),
    ]),
    good: 'None of the 2 SQL servers are open to the internet or all Azure services.',
  },
  'azure.sql-auditing-tde': {
    bad: fail('1 of 2 SQL server(s) lack auditing or transparent data encryption.', [
      azRes('noordkust-prod', 'rg-tms', 'Microsoft.Sql/servers', 'sql-nk-tms', 'SQL server', 'auditing off, no Entra admin'),
      azRes('noordkust-dev', 'rg-dev', 'Microsoft.Sql/servers', 'sql-nk-dev', 'SQL server', 'no Microsoft Entra admin configured'),
    ]),
    good: 'All 2 SQL servers have auditing, TDE on every database and a Microsoft Entra admin.',
  },
  'azure.defender-recommendations': {
    bad: fail(
      '7 unhealthy high-severity Defender for Cloud recommendation(s) across 3 recommendation type(s).',
      [
        azRes('noordkust-prod', 'rg-tms', 'Microsoft.Compute/virtualMachines', 'vm-tms-app01', 'Defender recommendation', 'Machines should have vulnerability findings resolved'),
        azRes('noordkust-prod', 'rg-tms', 'Microsoft.Compute/virtualMachines', 'vm-tms-app02', 'Defender recommendation', 'Machines should have vulnerability findings resolved'),
        azRes('noordkust-prod', 'rg-network', 'Microsoft.Compute/virtualMachines', 'vm-jumphost', 'Defender recommendation', 'Management ports of virtual machines should be protected with just-in-time network access control'),
        azRes('noordkust-dev', 'rg-dev', 'Microsoft.Sql/servers', 'sql-nk-dev', 'Defender recommendation', 'SQL databases should have vulnerability findings resolved'),
      ],
      { highSeverityUnhealthy: 7, byRecommendation: { 'Machines should have vulnerability findings resolved': 4, 'Management ports of virtual machines should be protected with just-in-time network access control': 2, 'SQL databases should have vulnerability findings resolved': 1 } },
    ),
    good: 'No unhealthy high-severity Defender for Cloud recommendations.',
  },
  'azure.backup-vaults': {
    bad: warn('2 of 2 backup vault(s) do not have immutability enabled.', [
      azRes('noordkust-prod', 'rg-backup', 'Microsoft.RecoveryServices/vaults', 'rsv-nk-prod', 'Recovery Services vault', 'immutability off'),
      azRes('noordkust-prod', 'rg-backup', 'Microsoft.DataProtection/backupVaults', 'bv-nk-blobs', 'Backup vault', 'immutability off'),
    ]),
    good: 'All 2 backup vaults have soft delete and immutability enabled.',
  },
  'azure.subscription-owners': {
    bad: warn('1 subscription(s) have more than 3 Owner or User Access Administrator principals.', [
      sub('noordkust-prod', '4 (1 group) Owner(s), 1 User Access Administrator(s): more than 3 privileged principals'),
      { ...user('admin.pieters', 'Owner'), account: 'noordkust-prod' },
      { ...user('k.janssens', 'Owner'), account: 'noordkust-prod' },
      { ...user('l.maes', 'Owner'), account: 'noordkust-prod' },
      { ...entra('group', 'Group', 'SG-Azure-Platform', 'Owner, group: members inherit the role'), account: 'noordkust-prod' },
      { ...entra('servicePrincipal', 'Service principal', 'sp-terraform-prod', 'User Access Administrator'), account: 'noordkust-prod' },
    ]),
    good: 'All subscriptions have 2 or 3 Owners and no more than 3 Owner or User Access Administrator principals.',
  },

  // ---------- AWS ----------
  'aws.root-mfa': {
    bad: fail('Root account does not have MFA enabled.', [awsRoot('root password last used 2026-08-19')], { accountMfaEnabled: false, accountPasswordPresent: 1, rootLastUsed: '2026-08-19T07:42:11+00:00' }),
    good: 'Root account has MFA enabled (hardware device) and was not used in the last 90 days.',
  },
  'aws.root-access-keys': { bad: fail('Root account has active access keys.', [awsRoot('access key 1 last used 2026-06-02')]), good: 'No root access keys present.' },
  'aws.iam-users-mfa': {
    bad: fail('3 console user(s) without MFA.', [iam('b.vermeulen', 'last used 2026-09-28'), iam('finance-reporting', 'last used 2026-09-30'), iam('tms-admin', 'last used 2026-08-14')]),
    good: 'All 4 console users have MFA.',
  },
  'aws.iam-access-key-age': {
    bad: fail('3 active access key(s) older than 90 days.', [
      { ...iam('ci-deploy', 'key 1 rotated 2024-03-11'), id: `arn:aws:iam::${ACC}:user/ci-deploy#key1`, type: 'IAM access key' },
      { ...iam('backup-sync', 'key 1 rotated 2023-11-02'), id: `arn:aws:iam::${ACC}:user/backup-sync#key1`, type: 'IAM access key' },
      { ...iam('tms-integration', 'key 2 rotated 2025-01-20'), id: `arn:aws:iam::${ACC}:user/tms-integration#key2`, type: 'IAM access key' },
    ]),
    good: 'All active access keys rotated within 90 days.',
  },
  'aws.iam-unused-credentials': {
    bad: warn('2 user(s) with credentials unused for 45+ days.', [iam('old-sftp-user', 'access key 1 unused 45+ days'), iam('d.smet', 'password unused 45+ days')]),
    good: 'No credentials unused for 45+ days.',
  },
  'aws.password-policy': { bad: warn('Password policy is weak: minimum length 8 (< 14); reuse prevention 0 (< 24).'), good: 'Password policy meets the baseline.' },
  'aws.iam-admin-users': {
    bad: fail('2 IAM user(s) have administrator access (directly, through a group or an inline *:* policy). 2 role(s) also grant administrator access (listed for review).', [
      iam('tms-admin', 'AdministratorAccess'),
      iam('ci-deploy', 'via group deployers (inline policy deploy-all allows *:*)'),
      iamRole('OrganizationAccountAccessRole', 'AdministratorAccess'),
      iamRole('AWSReservedSSO_AdministratorAccess_3f1c2b9a7d6e5f40', 'IAM Identity Center permission set; AdministratorAccess', '/aws-reserved/sso.amazonaws.com/eu-west-1/'),
    ]),
    good: 'No IAM users have administrator access. 2 role(s) also grant administrator access (listed for review).',
  },
  'aws.cloudtrail': {
    bad: warn('Multi-region trail logs management events but is not fully configured: log file validation disabled, logs not encrypted with a KMS key, not delivered to CloudWatch Logs.', [
      awsRes('cloudtrail', 'CloudTrail trail', `arn:aws:cloudtrail:${AWS_REGION}:${ACC}:trail/management-events`, 'management-events', 'log file validation disabled, logs not encrypted with a KMS key, not delivered to CloudWatch Logs'),
    ]),
    good: "Multi-region trail 'org-trail' logs all management events with log file validation, KMS encryption and CloudWatch Logs delivery.",
  },
  'aws.guardduty': {
    bad: warn('GuardDuty disabled in 2 of 4 regions.', [awsRegion('guardduty', 'GuardDuty', 'us-east-1', 'not enabled', 'guardduty'), awsRegion('guardduty', 'GuardDuty', 'eu-central-1', 'not enabled', 'guardduty')]),
    good: 'GuardDuty enabled in all 4 evaluated regions.',
  },
  'aws.securityhub': {
    bad: fail('Security Hub is not enabled in any of the 4 evaluated regions.', ['eu-west-1', 'eu-central-1', 'us-east-1', 'eu-west-3'].map((r) => awsRegion('securityhub', 'Security Hub', r, 'not enabled', 'securityhub'))),
    good: 'Security Hub enabled with the FSBP or CIS standard in all 4 evaluated regions.',
  },
  'aws.securityhub-findings': {
    bad: fail('23 active critical/high failed findings across 4 control(s) (3 critical).', [
      awsRes('securityhub', 'Security Hub control', `arn:aws:securityhub:${AWS_REGION}:${ACC}:security-control/S3.8`, 'S3.8: S3 general purpose buckets should block public access', '2 failed finding(s) (2 critical, 0 high) on 2 resource(s)', { urlId: '' }),
      awsRes('securityhub', 'Security Hub control', `arn:aws:securityhub:${AWS_REGION}:${ACC}:security-control/EC2.19`, 'EC2.19: Security groups should not allow unrestricted access to high-risk ports', '3 failed finding(s) (1 critical, 2 high) on 3 resource(s)', { urlId: '' }),
      awsRes('securityhub', 'Security Hub control', `arn:aws:securityhub:${AWS_REGION}:${ACC}:security-control/EC2.8`, 'EC2.8: EC2 instances should use IMDSv2', '5 failed finding(s) (0 critical, 5 high) on 5 resource(s)', { urlId: '' }),
      awsRes('securityhub', 'Security Hub control', `arn:aws:securityhub:${AWS_REGION}:${ACC}:security-control/IAM.6`, 'IAM.6: Hardware MFA should be enabled for the root user', '1 failed finding(s) (0 critical, 1 high) on 1 resource(s)', { urlId: '' }),
    ]),
    good: 'No active critical or high failed Security Hub findings in 4 region(s).',
  },
  'aws.config': {
    bad: fail('AWS Config is not recording in any of the 4 evaluated regions.', ['eu-west-1', 'eu-central-1', 'us-east-1', 'eu-west-3'].map((r) => awsRegion('config', 'AWS Config recorder', r, 'not recording', 'config'))),
    good: 'AWS Config records all resource types with a delivery channel in all 4 evaluated regions, including global resources.',
  },
  'aws.s3-account-bpa': { bad: fail('Account-level S3 Block Public Access is not configured.'), good: 'All four account-level Block Public Access settings are on.' },
  'aws.s3-public-buckets': {
    bad: fail('2 of 14 evaluated buckets are public (bucket policy or ACL not blocked by Block Public Access).', [
      bucket('noordkust-invoices-archive', 'public via ACL (AllUsers: READ)'),
      bucket('nk-marketing-assets', 'public via bucket policy'),
    ]),
    good: 'None of 14 evaluated buckets are public (bucket policy, ACL and Block Public Access evaluated).',
  },
  'aws.s3-secure-transport': {
    bad: fail('9 of 14 evaluated buckets do not deny plain HTTP requests (aws:SecureTransport).', [
      bucket('noordkust-invoices-archive', 'no bucket policy'),
      bucket('nk-tms-exports', 'no bucket policy'),
      bucket('nk-edi-inbound', 'policy does not deny aws:SecureTransport=false'),
      bucket('nk-backup-sync', 'no bucket policy'),
    ]),
    good: 'All 14 evaluated buckets deny plain HTTP requests.',
  },
  'aws.public-snapshots': {
    bad: fail('2 snapshot(s) or AMI(s) are shared publicly.', [
      awsRes('ec2-snapshot', 'EBS snapshot', `arn:aws:ec2:${AWS_REGION}::snapshot/snap-0f1e2d3c4b5a69788`, 'tms-app-01 pre-upgrade', 'EBS snapshot of vol-0a1b2c3d4e5f60789 is public', { urlId: 'snap-0f1e2d3c4b5a69788' }),
      awsRes('rds-snapshot', 'RDS snapshot', `arn:aws:rds:${AWS_REGION}:${ACC}:snapshot:reporting-db-migration`, 'reporting-db-migration', 'RDS snapshot is public', { urlId: 'reporting-db-migration' }),
    ]),
    good: 'No public EBS snapshots, AMIs or RDS snapshots found.',
  },
  'aws.ebs-encryption': {
    bad: fail('EBS encryption by default is disabled in all 4 evaluated regions.', ['eu-west-1', 'eu-central-1', 'us-east-1', 'eu-west-3'].map((r) => awsRegion('ec2', 'EBS default encryption', r, 'EBS encryption by default off'))),
    good: 'EBS encryption by default enabled in all evaluated regions.',
  },
  'aws.sg-admin-ports': {
    bad: fail('3 security group(s) expose admin/database ports to the internet (0.0.0.0/0, ::/0 or other very broad ranges).', [
      sg('sg-0a1b2c3d4e5f60718', 'tms-windows-app', 'ports 3389 from 0.0.0.0/0'),
      sg('sg-0b2c3d4e5f6071829', 'bastion-legacy', 'ports 22 from 0.0.0.0/0, ::/0'),
      sg('sg-0c3d4e5f607182930', 'reporting-db', 'ports 5432 from 0.0.0.0/0'),
    ]),
    good: 'No security groups expose admin ports to the internet.',
  },
  'aws.default-sg-closed': {
    bad: fail('2 of 3 default security groups still have rules.', [
      awsRes('ec2-sg', 'Default security group', `arn:aws:ec2:${AWS_REGION}:${ACC}:security-group/sg-0d4e5f6071829304a`, 'default (vpc-0a1b2c3d4e5f60718)', '1 inbound and 1 outbound rule(s)', { urlId: 'sg-0d4e5f6071829304a' }),
      awsRes('ec2-sg', 'Default security group', `arn:aws:ec2:eu-central-1:${ACC}:security-group/sg-0e5f6071829304a5b`, 'default (vpc-0b2c3d4e5f6071829)', '1 inbound and 1 outbound rule(s)', { region: 'eu-central-1', urlId: 'sg-0e5f6071829304a5b' }),
    ]),
    good: 'All 3 default security groups restrict all traffic.',
  },
  'aws.vpc-flow-logs': {
    bad: fail('2 of 3 VPCs have no active flow log.', [
      awsRes('vpc', 'VPC', `arn:aws:ec2:${AWS_REGION}:${ACC}:vpc/vpc-0a1b2c3d4e5f60718`, 'tms-prod (vpc-0a1b2c3d4e5f60718)', 'no flow log', { urlId: 'vpc-0a1b2c3d4e5f60718' }),
      awsRes('vpc', 'VPC', `arn:aws:ec2:eu-central-1:${ACC}:vpc/vpc-0b2c3d4e5f6071829`, 'vpc-0b2c3d4e5f6071829', 'default VPC, no flow log', { region: 'eu-central-1', urlId: 'vpc-0b2c3d4e5f6071829' }),
    ]),
    good: 'All 3 VPCs have flow logs.',
  },
  'aws.ec2-imdsv2': {
    bad: fail('5 of 9 instances allow IMDSv1.', [
      ec2i('i-0a12b34c56d78e901', 'tms-app-01'),
      ec2i('i-0b23c45d67e89f012', 'tms-app-02'),
      ec2i('i-0c34d56e78f90a123', 'sftp-gateway'),
      ec2i('i-0d45e67f89a01b234', 'reporting-worker'),
      ec2i('i-0e56f78a90b12c345', 'bastion-legacy'),
    ]),
    good: 'All 9 instances require IMDSv2.',
  },
  'aws.rds-public': { bad: fail('1 RDS instance(s) are publicly accessible.', [rdsDb('reporting-db', 'publicly accessible')]), good: 'None of 3 RDS instances are publicly accessible.' },
  'aws.rds-encryption': { bad: fail('1 RDS instance(s) without storage encryption.', [rdsDb('tms-legacy', 'storage not encrypted')]), good: 'All 3 RDS instances are encrypted.' },
  'aws.rds-backup': {
    bad: warn('1 RDS instance(s) keep backups for less than 7 days. 1 read replica(s) skipped.', [rdsDb('reporting-db', 'retention 1 days')]),
    good: 'All 3 RDS instances retain backups for 7+ days. 1 read replica(s) skipped.',
  },
  'aws.backup-plans': {
    bad: fail('No AWS Backup plans found in any of the 4 evaluated regions.', [], { plans: 0, plansWithResources: 0, lockedVaults: [] }),
    good: '2 AWS Backup plan(s) with resource assignments. 1 vault(s) protected by Vault Lock.',
  },
  'aws.inspector': {
    bad: warn('Amazon Inspector: 4 active critical finding(s); incomplete coverage (EC2, ECR, Lambda) in 3 of 4 regions.', [
      awsRegion('inspector2', 'Amazon Inspector', 'eu-west-1', 'not scanning Lambda; 4 active critical finding(s)', 'inspector'),
      awsRegion('inspector2', 'Amazon Inspector', 'eu-central-1', 'not enabled', 'inspector'),
      awsRegion('inspector2', 'Amazon Inspector', 'us-east-1', 'not enabled', 'inspector'),
    ]),
    good: 'Amazon Inspector scans EC2, ECR and Lambda in all 4 evaluated regions with no active critical findings.',
  },
  'aws.kms-rotation': {
    bad: warn('2 of 4 customer managed keys without rotation.', [
      awsRes('kms', 'KMS key', `arn:aws:kms:${AWS_REGION}:${ACC}:key/5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d`, 'tms-data-key', 'automatic rotation off'),
      awsRes('kms', 'KMS key', `arn:aws:kms:${AWS_REGION}:${ACC}:key/7f3e4d5c-6b7a-4c8d-9e0f-1a2b3c4d5e6f`, 'backup-key', 'automatic rotation off'),
    ]),
    good: 'All 4 evaluated customer managed keys rotate automatically.',
  },
  'aws.access-analyzer': {
    bad: fail('IAM Access Analyzer is not enabled in any of the 4 evaluated regions.', ['eu-west-1', 'eu-central-1', 'us-east-1', 'eu-west-3'].map((r) => awsRegion('access-analyzer', 'IAM Access Analyzer', r, 'no active analyzer'))),
    good: 'Access Analyzer active in all evaluated regions.',
  },

  // ---------- GitHub ----------
  'gh.org-2fa': {
    bad: fail('The organisation does not require two-factor authentication.', [ghSetting('Authentication security', 'security', 'Require two-factor authentication is off')]),
    good: 'Two-factor authentication is required for all members.',
  },
  'gh.base-permissions': {
    bad: fail('Base permission is "write" for all members.', [ghSetting('Member privileges', 'member_privileges', 'base permission write')], { default_repository_permission: 'write' }),
    good: 'Base permission is "read".',
  },
  'gh.owner-count': {
    bad: fail('7 organisation owners.', ['pieters-nk', 'kjanssens', 'devops-bot', 'lmaes', 'rvdb', 'msp-dev', 'ci-admin'].map((u) => ghMember(u, 'organisation owner'))),
    good: '3 organisation owners.',
  },
  'gh.outside-collaborators': {
    bad: fail(
      '2 of 3 outside collaborator(s) have write or admin access.',
      [
        ghMember('agency-ux', 'outside collaborator, highest permission admin: website (admin)'),
        ghMember('freelance-dev42', 'outside collaborator, highest permission write: driver-app (write), route-planner (read)'),
        ghMember('old-contractor', 'outside collaborator, highest permission read: edi-connector (read)'),
      ],
      { outsideCollaborators: 3, withWriteOrAdmin: 2 },
    ),
    good: 'No outside collaborators.',
  },
  'gh.public-repo-creation': {
    bad: warn('Members can create public repositories.', [ghSetting('Repository creation', 'member_privileges', 'public repositories allowed')]),
    good: 'Members cannot create public repositories.',
  },
  'gh.private-forking': {
    bad: warn('Members can fork private repositories.', [ghSetting('Repository forking', 'member_privileges', 'forking of private repositories allowed')]),
    good: 'Forking of private repositories is disabled.',
  },
  'gh.public-repos': {
    bad: warn('2 public repositories: confirm they are intended to be public.', [repo('website', 'public'), repo('tms-api-client', 'public, contains internal hostnames in README')]),
    good: 'No public repositories.',
  },
  'gh.branch-protection': {
    bad: fail(
      '3 of 11 repositories have an unprotected default branch, 2 more are only partially protected.',
      [
        repo('driver-app', 'main not protected', 'settings/rules'),
        repo('edi-connector', 'master not protected (ruleset "Protect main" is in evaluate mode (not enforced))', 'settings/rules'),
        repo('infra-terraform', 'main not protected', 'settings/rules'),
        repo('route-planner', 'main missing: stale approvals dismissed on new commits, rules also apply to administrators (enforce admins or no ruleset bypass actors)', 'settings/rules'),
        repo('website', 'main missing: at least 1 required approving review', 'settings/rules'),
      ],
      { evaluated: 11, unprotected: 3, partial: 2 },
    ),
    good: 'All 11 evaluated repositories fully protect their default branch.',
  },
  'gh.secret-scanning': {
    bad: fail('Secret scanning disabled on 4 of 11 repositories.', [
      repo('driver-app', 'private, secret scanning off', 'settings/security_analysis'),
      repo('edi-connector', 'private, secret scanning off', 'settings/security_analysis'),
      repo('infra-terraform', 'private, secret scanning off', 'settings/security_analysis'),
      repo('route-planner', 'private, secret scanning off', 'settings/security_analysis'),
    ]),
    good: 'Secret scanning enabled on all 11 evaluated repositories.',
  },
  'gh.push-protection': {
    bad: warn('Push protection disabled on 2 of 11 repositories.', [repo('infra-terraform', 'push protection off', 'settings/security_analysis'), repo('route-planner', 'push protection off', 'settings/security_analysis')]),
    good: 'Push protection enabled on all 11 evaluated repositories.',
  },
  'gh.secret-scanning-alerts': {
    bad: fail(
      '4 open secret scanning alert(s) across 2 repositories: rotate the exposed credentials.',
      [
        repo('infra-terraform', '3 open alerts: Amazon AWS Access Key ID, Azure Storage Account Key', 'security/secret-scanning'),
        repo('website', '1 open alert: Slack Incoming Webhook URL', 'security/secret-scanning'),
      ],
      { openAlerts: 4, truncated: false },
    ),
    good: 'No open secret scanning alerts.',
  },
  'gh.dependabot-alerts': {
    bad: fail(
      '11 open critical/high Dependabot alerts across 3 repositories. Dependabot security updates not enabled on 2 repositories with alerts on.',
      [
        repo('driver-app', '4 critical, 3 high', 'security/dependabot'),
        repo('route-planner', '0 critical, 3 high', 'security/dependabot'),
        repo('website', '0 critical, 1 high', 'security/dependabot'),
        repo('edi-connector', 'Dependabot security updates not enabled', 'settings/security_analysis'),
        repo('driver-app', 'Dependabot security updates not enabled', 'settings/security_analysis'),
      ],
      { noSecurityUpdates: 2 },
    ),
    good: 'No open critical or high Dependabot alerts.',
  },
  'gh.code-scanning-alerts': {
    bad: warn('5 open critical/high code scanning alerts. Code scanning not enabled on 2 of 11 repositories.', [
      repo('edi-connector', '3 alerts', 'security/code-scanning'),
      repo('route-planner', '2 alerts', 'security/code-scanning'),
      repo('driver-app', 'Code scanning: no analysis in the last 90 days (last 2026-03-02)', 'settings/security_analysis'),
      repo('infra-terraform', 'Code scanning not enabled', 'settings/security_analysis'),
    ]),
    good: 'No open critical or high code scanning alerts.',
  },
  'gh.actions-allowed': {
    bad: warn('All actions and reusable workflows are allowed.', [ghSetting('Actions policy', 'actions', 'allowed_actions: all')], { allowed_actions: 'all' }),
    good: 'Allowed actions restricted to GitHub-owned, verified creators, 6 listed pattern(s).',
  },
  'gh.workflow-permissions': {
    bad: fail('Default GITHUB_TOKEN has read/write permissions.', [ghSetting('Workflow permissions', 'actions', 'default_workflow_permissions: write')], { default_workflow_permissions: 'write' }),
    good: 'Default workflow token is read-only and cannot approve PRs.',
  },
  'gh.deploy-keys': {
    bad: warn('2 write-enabled deploy key(s).', [
      { ...repo('infra-terraform', 'write key "jenkins-old"', 'settings/keys'), id: `${ORG}/infra-terraform#81234567`, type: 'Deploy key' },
      { ...repo('website', 'write key "hosting-sync"', 'settings/keys'), id: `${ORG}/website#81234890`, type: 'Deploy key' },
    ]),
    good: 'All deploy keys in 11 evaluated repositories are read-only.',
  },
  'gh.webhooks': {
    bad: warn('1 webhook(s) without verified HTTPS.', [
      { id: '412345678', name: 'http://jenkins.noordkust.example', detail: 'plain HTTP', type: 'Webhook', url: githubOrgSettingsUrl(ORG, 'hooks/412345678'), account: ORG },
    ]),
    good: 'All 3 webhooks use verified HTTPS.',
  },
  'gh.members-without-2fa': {
    bad: fail('3 account(s) without two-factor authentication (2FA is not enforced).', [
      ghMember('magazijn-scripts', 'member without 2FA'),
      ghMember('rvdb', 'member without 2FA'),
      ghMember('old-contractor', 'outside collaborator without 2FA'),
    ]),
    good: 'Two-factor authentication is enforced, so every member and collaborator has 2FA.',
  },
  'gh.app-installations': {
    bad: warn(
      '2 of 5 GitHub App(s) have broad write permissions (code, workflows, secrets or administration).',
      [
        { id: '51234567', name: 'legacy-ci-bot', detail: 'write: administration, contents, workflows; selected repositories', type: 'GitHub App', url: githubOrgSettingsUrl(ORG, 'installations/51234567'), account: ORG },
        { id: '51234890', name: 'docs-sync', detail: 'write: contents; all repositories', type: 'GitHub App', url: githubOrgSettingsUrl(ORG, 'installations/51234890'), account: ORG },
      ],
      { installations: 5, broad: 2, critical: 0 },
    ),
    good: 'None of the 5 installed GitHub Apps hold broad write permissions.',
  },
  'gh.security-defaults': {
    bad: warn('New repositories do not get Dependabot security updates, secret scanning, secret scanning push protection by default.', [
      ghSetting('Code security defaults', 'security_analysis', 'off for new repositories: Dependabot security updates, secret scanning, secret scanning push protection'),
    ]),
    good: 'New repositories get dependency graph, Dependabot alerts, Dependabot security updates, secret scanning, secret scanning push protection by default.',
  },
};

/** Deterministic pseudo-random generator. */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export interface DemoOptions {
  /** 0..1: share of controls that are in place. Higher maturity passes a superset of what lower maturity passes. */
  maturity?: number;
  /** Simulate API latency (live runs). */
  delay?: boolean;
}

export const DEFAULT_DEMO_MATURITY = 0.55;

/**
 * Each check gets a fixed "difficulty" in [0,1). A control is in place when difficulty < maturity, so a more
 * mature scan of the same company fixes a superset of the issues of a less mature scan.
 */
export function demoOutcomeSync(checkId: string, maturity = DEFAULT_DEMO_MATURITY): CheckOutcome {
  const meta = CHECKS_BY_ID[checkId];
  const s = SCENARIOS[checkId];
  const difficulty = rng(`noordkust:${checkId}`)();
  if (s?.na) return { status: 'na', summary: s.na };
  if (difficulty < maturity) return { status: 'pass', summary: s?.good ?? `${meta?.title ?? checkId}: configured as recommended.` };
  if (s) return structuredClone(s.bad);
  return { status: 'warn', summary: `${meta?.title ?? checkId}: not fully configured.` };
}

export async function demoOutcome(systemId: string, checkId: string, opts: DemoOptions = {}): Promise<CheckOutcome> {
  if (opts.delay !== false) await sleep(400 + rng(`${systemId}:${checkId}`)() * 1600);
  return demoOutcomeSync(checkId, opts.maturity ?? DEFAULT_DEMO_MATURITY);
}

export const DEMO_SCENARIO_IDS = Object.keys(SCENARIOS);
