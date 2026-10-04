/**
 * Deep links into the provider consoles, attached to ResourceRef.url so a finding can be opened where it lives.
 * All builders are pure and never throw; they return undefined when a usable link cannot be built.
 */

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------------------------
// Microsoft Entra admin center
// ---------------------------------------------------------------------------------------------------------------

export type EntraKind = 'user' | 'group' | 'app' | 'servicePrincipal' | 'caPolicy' | 'role';

export const ENTRA_BASE = 'https://entra.microsoft.com';

/**
 * Entra admin center link.
 * - user: object id of the user.
 * - group: object id of the group.
 * - app: appId (client id) of the application registration.
 * - servicePrincipal: object id of the enterprise application (pass `appId` in extra when known, the blade shows more).
 * - caPolicy: Conditional Access policy id.
 * - role: directory role template id (or role definition id).
 */
export function entraUrl(kind: EntraKind, id: string, extra?: { appId?: string }): string | undefined {
  if (!id) return undefined;
  const v = (p: string) => `${ENTRA_BASE}/#view/${p}`;
  switch (kind) {
    case 'user':
      return v(`Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${enc(id)}`);
    case 'group':
      return v(`Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${enc(id)}`);
    case 'app':
      return v(`Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/${enc(id)}`);
    case 'servicePrincipal':
      return v(
        `Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Overview/objectId/${enc(id)}${extra?.appId ? `/appId/${enc(extra.appId)}` : ''}`,
      );
    case 'caPolicy':
      return v(`Microsoft_AAD_ConditionalAccess/PolicyBlade/policyId/${enc(id)}`);
    case 'role':
      return v(`Microsoft_AAD_IAM/RoleMenuBlade/~/RoleMembers/objectId/${enc(id)}`);
    default:
      return undefined;
  }
}

/** Entra admin center pages that are not tied to one object (e.g. the authentication methods policy). */
export function entraPageUrl(blade: string): string {
  return `${ENTRA_BASE}/#view/${blade.replace(/^\/+/, '')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Azure portal
// ---------------------------------------------------------------------------------------------------------------

export const AZURE_PORTAL_BASE = 'https://portal.azure.com';

/** Azure portal link for any ARM resource id (/subscriptions/{id}/resourceGroups/.../providers/...). */
export function azurePortalUrl(armId: string): string | undefined {
  if (!armId) return undefined;
  const id = armId.startsWith('/') ? armId : `/${armId}`;
  if (!/^\/subscriptions\/[^/]+/i.test(id) && !/^\/providers\//i.test(id)) return undefined;
  return `${AZURE_PORTAL_BASE}/#@/resource${id}`;
}

/** Canonical ARM id of a subscription. */
export const azureSubscriptionId = (subscriptionId: string) => `/subscriptions/${subscriptionId}`;

// ---------------------------------------------------------------------------------------------------------------
// AWS console
// ---------------------------------------------------------------------------------------------------------------

export type AwsConsoleService =
  | 's3'
  | 'iam-user'
  | 'iam-role'
  | 'iam-policy'
  | 'ec2-sg'
  | 'ec2-instance'
  | 'ec2-snapshot'
  | 'ec2-ami'
  | 'rds'
  | 'rds-snapshot'
  | 'kms'
  | 'cloudtrail'
  | 'vpc'
  | 'guardduty'
  | 'securityhub'
  | 'config'
  | 'backup'
  | 'inspector';

const AWS_REGION_RE = /^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-\d$/;

/** Last path segment of an ARN resource part (arn:aws:iam::1:user/path/name => name), or the input itself. */
export function arnResourceName(idOrArn: string): string {
  if (!idOrArn.startsWith('arn:')) return idOrArn;
  const resource = idOrArn.split(':').slice(5).join(':');
  const parts = resource.split('/');
  return parts[parts.length - 1] || resource;
}

/** Region of an ARN (empty for global services). */
export function arnRegion(arn: string): string | undefined {
  if (!arn.startsWith('arn:')) return undefined;
  return arn.split(':')[3] || undefined;
}

/**
 * AWS console link. IAM and S3 are global (region optional); the other services need a region and
 * return undefined without a valid one. `id` may be an ARN for IAM, KMS and CloudTrail.
 * For dashboard-style services (guardduty, securityhub, config, inspector) id may be empty.
 */
export function awsConsoleUrl(service: AwsConsoleService, region: string | undefined, id: string, extra?: { isCluster?: boolean }): string | undefined {
  const r = region && AWS_REGION_RE.test(region) ? region : undefined;
  const iam = (frag: string) => `https://us-east-1.console.aws.amazon.com/iam/home#/${frag}`;
  const regional = (path: string, frag: string) =>
    r ? `https://${r}.console.aws.amazon.com/${path}?region=${r}#${frag}` : undefined;
  switch (service) {
    case 's3':
      if (!id) return undefined;
      return `https://s3.console.aws.amazon.com/s3/buckets/${enc(arnResourceName(id))}${r ? `?region=${r}` : ''}`;
    case 'iam-user':
      return id ? iam(`users/details/${enc(arnResourceName(id))}`) : undefined;
    case 'iam-role':
      return id ? iam(`roles/details/${enc(arnResourceName(id))}`) : undefined;
    case 'iam-policy':
      // The policy details page is keyed by the URL-encoded policy ARN.
      return id ? iam(`policies/details/${enc(id)}`) : undefined;
    case 'ec2-sg':
      return id ? regional('ec2/home', `SecurityGroup:groupId=${enc(id)}`) : undefined;
    case 'ec2-instance':
      return id ? regional('ec2/home', `InstanceDetails:instanceId=${enc(id)}`) : undefined;
    case 'ec2-snapshot':
      return id ? regional('ec2/home', `SnapshotDetails:snapshotId=${enc(id)}`) : undefined;
    case 'ec2-ami':
      return id ? regional('ec2/home', `ImageDetails:imageId=${enc(id)}`) : undefined;
    case 'rds':
      return id ? regional('rds/home', `database:id=${enc(arnResourceName(id))};is-cluster=${extra?.isCluster ? 'true' : 'false'}`) : undefined;
    case 'rds-snapshot':
      return id ? regional('rds/home', `db-snapshot:id=${enc(arnResourceName(id))}`) : undefined;
    case 'kms':
      return id ? regional('kms/home', `/kms/keys/${enc(arnResourceName(id))}`) : undefined;
    case 'cloudtrail':
      return regional('cloudtrail/home', id ? `/trails/${id}` : '/trails');
    case 'vpc':
      return id ? regional('vpcconsole/home', `VpcDetails:VpcId=${enc(id)}`) : undefined;
    case 'guardduty':
      return regional('guardduty/home', '/summary');
    case 'securityhub':
      return regional('securityhub/home', '/summary');
    case 'config':
      return regional('config/home', '/dashboard');
    case 'backup':
      return regional('backup/home', id ? `/backupplan/details/${enc(id)}` : '/backupplan');
    case 'inspector':
      return r ? `https://${r}.console.aws.amazon.com/inspector/v2/home?region=${r}#/dashboard` : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------------------------

export const GITHUB_BASE = 'https://github.com';

/**
 * github.com link for a path such as 'acme/api/settings/branches' or 'organizations/acme/settings/security'.
 * Path segments are URL-encoded; a query string or fragment is kept as is.
 */
export function githubUrl(path: string): string {
  const m = /^([^?#]*)(.*)$/.exec(path.trim()) ?? ['', path, ''];
  const segments = m[1]
    .split('/')
    .filter(Boolean)
    .map((s) => enc(decodeSafe(s)));
  return `${GITHUB_BASE}/${segments.join('/')}${m[2]}`;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Repository link, optionally to a sub page (e.g. 'settings/branches', 'security/code-scanning'). */
export const githubRepoUrl = (fullName: string, sub?: string) => githubUrl(sub ? `${fullName}/${sub}` : fullName);

/** Organisation settings page (e.g. 'security', 'actions', 'installations', 'hooks'). */
export const githubOrgSettingsUrl = (org: string, sub?: string) =>
  githubUrl(sub ? `organizations/${org}/settings/${sub}` : `organizations/${org}/settings/profile`);
