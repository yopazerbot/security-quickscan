import { AccessAnalyzerClient, ListAnalyzersCommand } from '@aws-sdk/client-accessanalyzer';
import { BackupClient, ListBackupPlansCommand, ListBackupSelectionsCommand, ListBackupVaultsCommand, type ListBackupVaultsCommandOutput } from '@aws-sdk/client-backup';
import { CloudTrailClient, DescribeTrailsCommand, GetEventSelectorsCommand, GetTrailStatusCommand, type Trail } from '@aws-sdk/client-cloudtrail';
import {
  ConfigServiceClient,
  DescribeConfigurationRecordersCommand,
  DescribeConfigurationRecorderStatusCommand,
  DescribeDeliveryChannelsCommand,
} from '@aws-sdk/client-config-service';
import {
  DescribeFlowLogsCommand,
  type DescribeFlowLogsCommandOutput,
  type DescribeSnapshotsCommandOutput,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  DescribeSnapshotsCommand,
  DescribeVpcsCommand,
  EC2Client,
  GetEbsEncryptionByDefaultCommand,
  type IpPermission,
} from '@aws-sdk/client-ec2';
import { GuardDutyClient, GetDetectorCommand, ListDetectorsCommand } from '@aws-sdk/client-guardduty';
import {
  GenerateCredentialReportCommand,
  GetAccountAuthorizationDetailsCommand,
  GetAccountPasswordPolicyCommand,
  GetAccountSummaryCommand,
  GetCredentialReportCommand,
  IAMClient,
  ListVirtualMFADevicesCommand,
  type GetAccountAuthorizationDetailsCommandOutput,
} from '@aws-sdk/client-iam';
import { BatchGetAccountStatusCommand, Inspector2Client, ListFindingsCommand } from '@aws-sdk/client-inspector2';
import { KMSClient, DescribeKeyCommand, GetKeyRotationStatusCommand, ListKeysCommand } from '@aws-sdk/client-kms';
import {
  DescribeDBClusterSnapshotAttributesCommand,
  DescribeDBClusterSnapshotsCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotAttributesCommand,
  DescribeDBSnapshotsCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  GetBucketAclCommand,
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  // Same command name as the S3 Control (account-level) one: aliased so the policy test maps it to s3:GetBucketPublicAccessBlock.
  GetPublicAccessBlockCommand as GetBucketPublicAccessBlockCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetPublicAccessBlockCommand, S3ControlClient } from '@aws-sdk/client-s3-control';
import { DescribeHubCommand, GetEnabledStandardsCommand, GetFindingsCommand, SecurityHubClient } from '@aws-sdk/client-securityhub';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { CheckOutcome, ResourceRef } from '@qs/shared';
import { awsConsoleUrl, type AwsConsoleService } from '../links.js';
import type { ProviderModule } from '../types.js';
import { applyCoverage, applyTruncation, CheckError, fail, failIfAny, mapLimit, Memo, na, pass, sleep, warn } from '../util.js';

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsCtx {
  creds: Creds;
  accountId: string;
  arn: string;
  configuredRegions: string[];
  memo: Memo;
  signal?: AbortSignal;
}

const HOME = 'us-east-1';
const clientOpts = (ctx: AwsCtx, region = HOME) => ({ region, credentials: ctx.creds, maxAttempts: 5 });
const s3Opts = (ctx: AwsCtx, region = HOME) => ({ ...clientOpts(ctx, region), followRegionRedirects: true });

function isAccessDenied(e: any) {
  const n = String(e?.name ?? e?.Code ?? '');
  return /AccessDenied|UnauthorizedOperation|AuthorizationError/i.test(n);
}

/**
 * A read-only action the scanner role may not have yet (it was added to the policy in a later version).
 * Reported as "could not be evaluated", never as a failed control.
 */
export class MissingPermission extends Error {
  override name = 'MissingPermission';
  constructor(public readonly action: string) {
    super(`Could not be evaluated: update the read-only role (new permission ${action}).`);
  }
}

/** Await an API call that needs `action`; AccessDenied becomes MissingPermission. */
async function call<T>(action: string, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isAccessDenied(e)) throw new MissingPermission(action);
    throw e;
  }
}

const updateRoleHint = (actions: Iterable<string>) => {
  const list = [...new Set(actions)].sort();
  return list.length ? `Could not be evaluated: update the read-only role (new permission ${list.join(', ')}).` : '';
};

async function regions(ctx: AwsCtx): Promise<string[]> {
  if (ctx.configuredRegions.length) return ctx.configuredRegions;
  return ctx.memo.get('regions', async () => {
    const r = await new EC2Client(clientOpts(ctx)).send(new DescribeRegionsCommand({ AllRegions: false }));
    return (r.Regions ?? []).map((x) => x.RegionName!).filter(Boolean).sort();
  });
}

interface RegionRun<T> {
  results: { region: string; value: T }[];
  /** Regions that could not be evaluated, with the reason, e.g. "ap-east-1 (OptInRequired)". */
  skipped: string[];
  /** New permissions the role lacks (AccessDenied on a call wrapped with call()). */
  missing: Set<string>;
  total: number;
}

const REGION_UNAVAILABLE = /UnrecognizedClient|InvalidClientTokenId|OptInRequired|SubscriptionRequired|EndpointError|ENOTFOUND/i;

/**
 * Run fn per region. Regions where the service is unavailable, not opted in or denied (e.g. by an SCP) are skipped
 * and reported, never silently dropped.
 */
async function perRegion<T>(ctx: AwsCtx, fn: (region: string) => Promise<T>): Promise<RegionRun<T>> {
  const rs = await regions(ctx);
  const skipped: string[] = [];
  const missing = new Set<string>();
  const out = await mapLimit(rs, 5, async (region): Promise<{ region: string; value: T } | null> => {
    ctx.signal?.throwIfAborted();
    try {
      return { region, value: await fn(region) };
    } catch (e: any) {
      if (e instanceof MissingPermission) {
        missing.add(e.action);
        skipped.push(`${region} (missing ${e.action})`);
        return null;
      }
      if (REGION_UNAVAILABLE.test(`${e?.name} ${e?.message}`) || isAccessDenied(e)) {
        skipped.push(`${region} (${String(e?.name ?? 'unavailable')})`);
        return null;
      }
      throw e;
    }
  });
  return { results: out.filter((x): x is { region: string; value: T } => x !== null), skipped: skipped.sort(), missing, total: rs.length };
}

/** Apply region coverage to an outcome: skipped regions downgrade pass to warn, zero evaluated regions give error. */
const regionCoverage = (o: CheckOutcome, run: RegionRun<unknown>, extraMissing: Iterable<string> = []) => {
  const missing = new Set([...run.missing, ...extraMissing]);
  const hint = missing.size ? updateRoleHint(missing) : 'Check the configured regions and the scanner role permissions.';
  return applyCoverage(o, { evaluated: run.results.length, total: run.total, skipped: run.skipped, unit: 'regions', hint });
};

/** Downgrade a result that is missing part of its data because of new permissions (pass/n/a become warn). */
function withMissing(o: CheckOutcome, missing: Iterable<string>): CheckOutcome {
  const hint = updateRoleHint(missing);
  if (!hint) return o;
  const evidence = { ...o.evidence, missingPermissions: [...new Set(missing)].sort() };
  const summary = `${o.summary} Part of this check ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`;
  if (o.status === 'pass' || o.status === 'na') return { status: 'warn', summary, resources: o.resources, evidence };
  return { ...o, summary, evidence };
}

// ---------------------------------------------------------------------------------------------------------------
// Resource references
// ---------------------------------------------------------------------------------------------------------------

function ref(
  ctx: AwsCtx,
  r: { id: string; name?: string; detail?: string; type: string; region?: string; service?: AwsConsoleService; urlId?: string; isCluster?: boolean },
): ResourceRef {
  const out: ResourceRef = { id: r.id, type: r.type, account: ctx.accountId };
  if (r.name !== undefined) out.name = r.name;
  if (r.detail !== undefined) out.detail = r.detail;
  if (r.region) out.region = r.region;
  if (r.service) {
    const url = awsConsoleUrl(r.service, r.region, r.urlId ?? r.id, r.isCluster ? { isCluster: true } : undefined);
    if (url) out.url = url;
  }
  return out;
}

/** A regional account setting (no resource ARN of its own): id arn:aws:<arnService>:<region>:<account>:account. */
const regionRef = (ctx: AwsCtx, region: string, arnService: string, label: string, detail?: string, console?: AwsConsoleService) =>
  ref(ctx, { id: `arn:aws:${arnService}:${region}:${ctx.accountId}:account`, name: region, detail, type: label, region, service: console, urlId: '' });

const userRef = (ctx: AwsCtx, arn: string, name: string, detail?: string) => ref(ctx, { id: arn, name, detail, type: 'IAM user', service: 'iam-user' });
const rootRef = (ctx: AwsCtx, detail?: string) => ref(ctx, { id: `arn:aws:iam::${ctx.accountId}:root`, name: 'root', detail, type: 'Root user' });

// ---------------------------------------------------------------------------------------------------------------
// Credential report
// ---------------------------------------------------------------------------------------------------------------

interface CredRow {
  user: string;
  arn: string;
  password_enabled: string;
  password_last_used: string;
  mfa_active: string;
  access_key_1_active: string;
  access_key_1_last_rotated: string;
  access_key_1_last_used_date: string;
  access_key_2_active: string;
  access_key_2_last_rotated: string;
  access_key_2_last_used_date: string;
  user_creation_time: string;
}

/** RFC 4180 CSV: quoted fields with commas, escaped quotes and line breaks; CRLF or LF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const REPORT_ATTEMPTS = 20;
const REPORT_WAIT_MS = 1500;

async function credentialReport(ctx: AwsCtx): Promise<CredRow[]> {
  return ctx.memo.get('credreport', async () => {
    const iam = new IAMClient(clientOpts(ctx));
    let complete = false;
    for (let i = 0; i < REPORT_ATTEMPTS && !complete; i++) {
      const g = await iam.send(new GenerateCredentialReportCommand({}));
      complete = g.State === 'COMPLETE';
      if (!complete) {
        ctx.signal?.throwIfAborted();
        await sleep(REPORT_WAIT_MS);
      }
    }
    if (!complete) throw new CheckError(`The IAM credential report was not ready after ${Math.round((REPORT_ATTEMPTS * REPORT_WAIT_MS) / 1000)}s; run the scan again.`);
    let rep;
    try {
      rep = await iam.send(new GetCredentialReportCommand({}));
    } catch (e: any) {
      if (/ReportInProgress|ReportNotPresent|ReportExpired|CredentialReport/i.test(String(e?.name))) {
        throw new CheckError(`The IAM credential report is not available (${e?.name}); run the scan again.`);
      }
      throw e;
    }
    const csv = new TextDecoder().decode(rep.Content);
    const [header, ...lines] = parseCsv(csv);
    if (!header) return [];
    return lines.map((l) => Object.fromEntries(header.map((col, i) => [col, l[i] ?? ''])) as unknown as CredRow);
  });
}

const DAY = 86_400_000;
const olderThan = (iso: string, days: number) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t > days * DAY;
};
const within = (iso: string | undefined, days: number) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) && Date.now() - t <= days * DAY;
};

const ADMIN_PORTS = [22, 3389, 3306, 5432, 1433, 1521, 27017, 6379, 9200, 5984, 23, 445];
/** IPv4 ranges /0 to /8 and IPv6 ranges /0 to /16 count as "the internet". */
const BROAD_V4 = 8;
const BROAD_V6 = 16;
const prefixLen = (cidr: string | undefined) => {
  const m = /\/(\d+)$/.exec(cidr ?? '');
  return m ? Number(m[1]) : NaN;
};

// ---------------------------------------------------------------------------------------------------------------
// IAM policy analysis
// ---------------------------------------------------------------------------------------------------------------

const AWS_ADMIN_POLICY = 'arn:aws:iam::aws:policy/AdministratorAccess';
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function parsePolicy(doc: string | undefined): any {
  if (!doc) return null;
  let text = doc;
  if (!text.trimStart().startsWith('{')) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True when the policy has an Allow statement for Action '*' on Resource '*' (CIS 1.16 "full *:* administrative privileges"). */
function allowsStarStar(doc: string | undefined): boolean {
  const p = parsePolicy(doc);
  return arr<any>(p?.Statement).some(
    (s) => s?.Effect === 'Allow' && !s.NotAction && arr<string>(s.Action).some((a) => a === '*' || a === '*:*') && arr<string>(s.Resource).includes('*'),
  );
}

type AuthDetails = Pick<GetAccountAuthorizationDetailsCommandOutput, 'UserDetailList' | 'GroupDetailList' | 'RoleDetailList' | 'Policies'>;

async function authDetails(ctx: AwsCtx): Promise<Required<{ [K in keyof AuthDetails]: NonNullable<AuthDetails[K]> }>> {
  return ctx.memo.get('authdetails', async () => {
    const iam = new IAMClient(clientOpts(ctx));
    const out = { UserDetailList: [] as any[], GroupDetailList: [] as any[], RoleDetailList: [] as any[], Policies: [] as any[] };
    let marker: string | undefined;
    let pages = 0;
    do {
      const r = await call(
        'iam:GetAccountAuthorizationDetails',
        iam.send(new GetAccountAuthorizationDetailsCommand({ Filter: ['User', 'Group', 'Role', 'LocalManagedPolicy'], Marker: marker, MaxItems: 1000 })),
      );
      out.UserDetailList.push(...(r.UserDetailList ?? []));
      out.GroupDetailList.push(...(r.GroupDetailList ?? []));
      out.RoleDetailList.push(...(r.RoleDetailList ?? []));
      out.Policies.push(...(r.Policies ?? []));
      marker = r.IsTruncated ? r.Marker : undefined;
      ctx.signal?.throwIfAborted();
    } while (marker && ++pages < 200);
    return out;
  });
}

/** Name of the IAM role the scanner runs as (from an assumed-role ARN), if any. */
const scannerRoleName = (arn: string) => /:assumed-role\/([^/]+)\//.exec(arn)?.[1];

// ---------------------------------------------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------------------------------------------

interface BucketInfo {
  name: string;
  region?: string;
  /** Why the bucket region could not be read. */
  error?: string;
}

const normaliseBucketRegion = (loc: string | undefined) => (!loc ? HOME : loc === 'EU' ? 'eu-west-1' : loc);

async function buckets(ctx: AwsCtx): Promise<BucketInfo[]> {
  return ctx.memo.get('buckets', async () => {
    const s3 = new S3Client(s3Opts(ctx));
    const list: { Name?: string; BucketRegion?: string }[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const r = await s3.send(new ListBucketsCommand({ MaxBuckets: 1000, ContinuationToken: token }));
      list.push(...(r.Buckets ?? []));
      token = r.ContinuationToken;
      ctx.signal?.throwIfAborted();
    } while (token && ++pages < 100);
    return mapLimit(list.filter((b) => b.Name), 8, async (b): Promise<BucketInfo> => {
      if (b.BucketRegion) return { name: b.Name!, region: b.BucketRegion };
      try {
        const loc = await s3.send(new GetBucketLocationCommand({ Bucket: b.Name }));
        return { name: b.Name!, region: normaliseBucketRegion(loc.LocationConstraint) };
      } catch (e: any) {
        return { name: b.Name!, error: String(e?.name ?? 'error') };
      }
    });
  });
}

const bucketRef = (ctx: AwsCtx, b: BucketInfo, detail?: string) =>
  ref(ctx, { id: `arn:aws:s3:::${b.name}`, name: b.name, detail, type: 'S3 bucket', region: b.region, service: 's3', urlId: b.name });

interface Bpa {
  BlockPublicAcls?: boolean;
  IgnorePublicAcls?: boolean;
  BlockPublicPolicy?: boolean;
  RestrictPublicBuckets?: boolean;
}

/** Account-level Block Public Access: the configuration, null when not configured, or an error name when unreadable. */
async function accountBpa(ctx: AwsCtx): Promise<{ config: Bpa | null; error?: string }> {
  return ctx.memo.get('account-bpa', async () => {
    try {
      const r = await new S3ControlClient(clientOpts(ctx)).send(new GetPublicAccessBlockCommand({ AccountId: ctx.accountId }));
      return { config: r.PublicAccessBlockConfiguration ?? {} };
    } catch (e: any) {
      if (/NoSuchPublicAccessBlockConfiguration/.test(e?.name)) return { config: null };
      return { config: null, error: String(e?.name ?? 'error') };
    }
  });
}

const PUBLIC_GROUPS: Record<string, string> = {
  'http://acs.amazonaws.com/groups/global/AllUsers': 'AllUsers',
  'http://acs.amazonaws.com/groups/global/AuthenticatedUsers': 'AuthenticatedUsers',
};

/** True when the bucket policy denies requests made without TLS (aws:SecureTransport = false). */
function deniesInsecureTransport(policy: string | undefined): boolean {
  const p = parsePolicy(policy);
  return arr<any>(p?.Statement).some((s) => {
    if (s?.Effect !== 'Deny' || !s.Condition) return false;
    for (const op of ['Bool', 'BoolIfExists']) {
      const cond = s.Condition[op];
      if (!cond || typeof cond !== 'object') continue;
      for (const [k, v] of Object.entries(cond)) {
        if (k.toLowerCase() === 'aws:securetransport' && arr<any>(v as any).some((x) => String(x).toLowerCase() === 'false')) return true;
      }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

const checks: Record<string, (ctx: AwsCtx) => Promise<CheckOutcome>> = {
  async 'aws.root-mfa'(ctx) {
    const s = await ctx.memo.get('summary', () => new IAMClient(clientOpts(ctx)).send(new GetAccountSummaryCommand({})));
    const map = s.SummaryMap ?? {};
    const mfa = map.AccountMFAEnabled === 1;
    const passwordPresent = map.AccountPasswordPresent;
    const keys = (map.AccountAccessKeysPresent ?? 0) > 0;
    const evidence: Record<string, unknown> = { accountMfaEnabled: mfa, accountPasswordPresent: passwordPresent ?? null, accountAccessKeysPresent: keys };

    // Recent root use (credential report): CIS 1.7 "eliminate use of the root user".
    let lastUsed: string | undefined;
    try {
      const root = (await credentialReport(ctx)).find((r) => r.user === '<root_account>');
      const dates = [root?.password_last_used, root?.access_key_1_last_used_date, root?.access_key_2_last_used_date].filter((d): d is string => !!d && Number.isFinite(Date.parse(d)));
      lastUsed = dates.sort().at(-1);
      evidence.rootLastUsed = lastUsed ?? null;
    } catch (e: any) {
      evidence.credentialReport = `not available (${e?.name ?? 'error'})`;
    }
    const recentUse = within(lastUsed, 90);

    if (!mfa) {
      if (passwordPresent === 0 && !keys) {
        return pass('The root user has no password and no access keys (centralised root access); root MFA is not needed.', { evidence, resources: [rootRef(ctx, 'no root credentials')] });
      }
      return fail('Root account does not have MFA enabled.', [rootRef(ctx, recentUse ? `root used on ${lastUsed!.slice(0, 10)}` : undefined)], evidence);
    }

    const issues: string[] = [];
    const missing: string[] = [];
    try {
      const iam = new IAMClient(clientOpts(ctx));
      let marker: string | undefined;
      let virtual = false;
      let pages = 0;
      do {
        const r = await call('iam:ListVirtualMFADevices', iam.send(new ListVirtualMFADevicesCommand({ AssignmentStatus: 'Assigned', Marker: marker })));
        virtual ||= (r.VirtualMFADevices ?? []).some((d) => d.User?.Arn?.endsWith(':root') || d.SerialNumber?.endsWith(':mfa/root-account-mfa-device'));
        marker = r.IsTruncated ? r.Marker : undefined;
      } while (marker && ++pages < 50);
      evidence.rootVirtualMfa = virtual;
      if (virtual) issues.push('root uses a virtual MFA device (prefer a hardware security key)');
    } catch (e) {
      if (!(e instanceof MissingPermission)) throw e;
      missing.push(e.action);
    }
    if (recentUse) issues.push(`root user was used on ${lastUsed!.slice(0, 10)} (within 90 days)`);
    const o = issues.length
      ? warn(`Root account has MFA, but ${issues.join('; ')}.`, [rootRef(ctx, issues.join('; '))], evidence)
      : pass('Root account has MFA enabled (hardware device) and was not used in the last 90 days.', { evidence });
    return withMissing(o, missing);
  },

  async 'aws.root-access-keys'(ctx) {
    const s = await ctx.memo.get('summary', () => new IAMClient(clientOpts(ctx)).send(new GetAccountSummaryCommand({})));
    return s.SummaryMap?.AccountAccessKeysPresent ? fail('Root account has active access keys.', [rootRef(ctx)]) : pass('No root access keys present.');
  },

  async 'aws.iam-users-mfa'(ctx) {
    const rows = (await credentialReport(ctx)).filter((r) => r.user !== '<root_account>');
    const bad = rows.filter((r) => r.password_enabled === 'true' && r.mfa_active !== 'true');
    return failIfAny(
      bad.map((r) => userRef(ctx, r.arn, r.user, `last used ${r.password_last_used}`)),
      (n) => `${n} console user(s) without MFA.`,
      `All ${rows.filter((r) => r.password_enabled === 'true').length} console users have MFA.`,
    );
  },

  async 'aws.iam-access-key-age'(ctx) {
    const rows = await credentialReport(ctx);
    const bad: ResourceRef[] = [];
    for (const r of rows) {
      for (const k of [1, 2] as const) {
        if ((r as any)[`access_key_${k}_active`] === 'true' && olderThan((r as any)[`access_key_${k}_last_rotated`], 90)) {
          bad.push({ ...userRef(ctx, r.arn, r.user, `key ${k} rotated ${(r as any)[`access_key_${k}_last_rotated`].slice(0, 10)}`), id: `${r.arn}#key${k}`, type: 'IAM access key' });
        }
      }
    }
    return failIfAny(bad, (n) => `${n} active access key(s) older than 90 days.`, 'All active access keys rotated within 90 days.');
  },

  async 'aws.iam-unused-credentials'(ctx) {
    const DAYS = 45; // CIS AWS Foundations v3.0 1.12
    const rows = (await credentialReport(ctx)).filter((r) => r.user !== '<root_account>');
    const bad: ResourceRef[] = [];
    for (const r of rows) {
      const reasons: string[] = [];
      if (r.password_enabled === 'true' && olderThan(r.user_creation_time, DAYS)) {
        if (r.password_last_used === 'no_information' || r.password_last_used === 'N/A' || olderThan(r.password_last_used, DAYS)) reasons.push(`password unused ${DAYS}+ days`);
      }
      for (const k of [1, 2] as const) {
        const used = (r as any)[`access_key_${k}_last_used_date`];
        if ((r as any)[`access_key_${k}_active`] === 'true' && olderThan((r as any)[`access_key_${k}_last_rotated`], DAYS) && (used === 'N/A' || olderThan(used, DAYS))) {
          reasons.push(`access key ${k} unused ${DAYS}+ days`);
        }
      }
      if (reasons.length) bad.push(userRef(ctx, r.arn, r.user, reasons.join(', ')));
    }
    return failIfAny(bad, (n) => `${n} user(s) with credentials unused for ${DAYS}+ days.`, `No credentials unused for ${DAYS}+ days.`, 'warn');
  },

  async 'aws.password-policy'(ctx) {
    try {
      const p = (await new IAMClient(clientOpts(ctx)).send(new GetAccountPasswordPolicyCommand({}))).PasswordPolicy!;
      const issues: string[] = [];
      if ((p.MinimumPasswordLength ?? 0) < 14) issues.push(`minimum length ${p.MinimumPasswordLength} (< 14)`);
      if ((p.PasswordReusePrevention ?? 0) < 24) issues.push(`reuse prevention ${p.PasswordReusePrevention ?? 0} (< 24)`);
      return issues.length ? warn(`Password policy is weak: ${issues.join('; ')}.`, [], { policy: p }) : pass('Password policy meets the baseline.', { evidence: { policy: p } });
    } catch (e: any) {
      if (e?.name === 'NoSuchEntityException' || e?.name === 'NoSuchEntity') {
        const rows = (await credentialReport(ctx)).filter((r) => r.password_enabled === 'true' && r.user !== '<root_account>');
        return rows.length ? fail('No account password policy is set (AWS defaults apply).') : pass('No password policy set, but no IAM users have console passwords.');
      }
      throw e;
    }
  },

  async 'aws.iam-admin-users'(ctx) {
    const d = await authDetails(ctx);
    const localAdmin = new Set(
      d.Policies.filter((p) => allowsStarStar(p.PolicyVersionList?.find((v: any) => v.IsDefaultVersion)?.Document)).map((p) => p.Arn as string),
    );
    /** Reasons a principal has admin from its attached and inline policies. */
    const reasonsFor = (attached: { PolicyArn?: string; PolicyName?: string }[] | undefined, inline: { PolicyName?: string; PolicyDocument?: string }[] | undefined) => {
      const out: string[] = [];
      for (const a of attached ?? []) {
        if (a.PolicyArn === AWS_ADMIN_POLICY) out.push('AdministratorAccess');
        else if (a.PolicyArn && localAdmin.has(a.PolicyArn)) out.push(`policy ${a.PolicyName} allows *:*`);
      }
      for (const p of inline ?? []) if (allowsStarStar(p.PolicyDocument)) out.push(`inline policy ${p.PolicyName} allows *:*`);
      return out;
    };
    const groupAdmin = new Map<string, string[]>();
    for (const g of d.GroupDetailList) {
      const r = reasonsFor(g.AttachedManagedPolicies, g.GroupPolicyList);
      if (r.length) groupAdmin.set(g.GroupName!, r);
    }
    const users: ResourceRef[] = [];
    for (const u of d.UserDetailList) {
      const reasons = reasonsFor(u.AttachedManagedPolicies, u.UserPolicyList);
      for (const g of u.GroupList ?? []) {
        const gr = groupAdmin.get(g);
        if (gr) reasons.push(`via group ${g} (${gr.join(', ')})`);
      }
      if (reasons.length) users.push(userRef(ctx, u.Arn!, u.UserName!, reasons.join('; ')));
    }
    const scanner = scannerRoleName(ctx.arn);
    const roles: ResourceRef[] = [];
    let customStarRoles = 0;
    for (const r of d.RoleDetailList) {
      if ((r.Path ?? '').startsWith('/aws-service-role/') || r.RoleName === scanner) continue;
      const reasons = reasonsFor(r.AttachedManagedPolicies, r.RolePolicyList);
      if (!reasons.length) continue;
      const sso = (r.Path ?? '').startsWith('/aws-reserved/sso.amazonaws.com/');
      if (!sso && reasons.some((x) => x !== 'AdministratorAccess')) customStarRoles++;
      roles.push(
        ref(ctx, { id: r.Arn!, name: r.RoleName, detail: `${sso ? 'IAM Identity Center permission set; ' : ''}${reasons.join('; ')}`, type: 'IAM role', service: 'iam-role' }),
      );
    }
    const evidence = { adminUsers: users.length, adminRoles: roles.length, adminGroups: [...groupAdmin.keys()], customerStarPolicies: [...localAdmin] };
    const roleNote = roles.length ? ` ${roles.length} role(s) also grant administrator access (listed for review).` : '';
    if (users.length) return fail(`${users.length} IAM user(s) have administrator access (directly, through a group or an inline *:* policy).${roleNote}`, [...users, ...roles], evidence);
    if (customStarRoles) {
      return warn(`No IAM users have administrator access, but ${customStarRoles} role(s) use a customer-managed or inline policy allowing *:* (use AdministratorAccess or scoped policies).${roleNote}`, roles, evidence);
    }
    return pass(`No IAM users have administrator access.${roleNote}`, { resources: roles, evidence });
  },

  async 'aws.cloudtrail'(ctx) {
    const ct = new CloudTrailClient(clientOpts(ctx));
    const trails = ((await ct.send(new DescribeTrailsCommand({ includeShadowTrails: true }))).trailList ?? []).filter((t) => t.IsMultiRegionTrail);
    if (!trails.length) return fail('No multi-region CloudTrail trail found.');
    const missing: string[] = [];
    interface Eval {
      trail: Trail;
      core: string[];
      extra: string[];
      notes: string[];
    }
    const evals: Eval[] = [];
    for (const t of trails) {
      const home = t.HomeRegion ?? HOME;
      const client = new CloudTrailClient(clientOpts(ctx, home));
      const own = (t.TrailARN ?? '').split(':')[4] === ctx.accountId;
      const core: string[] = [];
      const extra: string[] = [];
      const notes: string[] = [];
      // Logging status. Organisation trails owned by the management account cannot always be read from a member account.
      try {
        const st = await client.send(new GetTrailStatusCommand({ Name: t.TrailARN }));
        if (!st.IsLogging) core.push('not logging');
      } catch (e: any) {
        if (own && !t.IsOrganizationTrail) throw e;
        notes.push('organisation trail: logging status managed by the management account');
      }
      // Management events: default selectors log all management events.
      if (t.HasCustomEventSelectors) {
        if (own) {
          try {
            const sel = await call('cloudtrail:GetEventSelectors', client.send(new GetEventSelectorsCommand({ TrailName: t.TrailARN })));
            const basic = (sel.EventSelectors ?? []).some((s) => s.IncludeManagementEvents !== false && (s.ReadWriteType ?? 'All') === 'All');
            const advanced = (sel.AdvancedEventSelectors ?? []).some((s) => {
              const f = s.FieldSelectors ?? [];
              const mgmt = f.some((x) => x.Field === 'eventCategory' && (x.Equals ?? []).includes('Management'));
              const readOnlyFilter = f.some((x) => x.Field === 'readOnly');
              return mgmt && !readOnlyFilter;
            });
            if (!basic && !advanced) core.push('does not log all (read and write) management events');
          } catch (e) {
            if (!(e instanceof MissingPermission)) throw e;
            missing.push(e.action);
            notes.push('event selectors could not be read');
          }
        } else notes.push('organisation trail with custom event selectors (not readable from this account)');
      }
      if (!t.LogFileValidationEnabled) extra.push('log file validation disabled');
      if (!t.KmsKeyId) extra.push('logs not encrypted with a KMS key');
      if (!t.CloudWatchLogsLogGroupArn) extra.push('not delivered to CloudWatch Logs');
      evals.push({ trail: t, core, extra, notes });
    }
    const toRef = (e: Eval) =>
      ref(ctx, {
        id: e.trail.TrailARN!,
        name: e.trail.Name,
        detail: [...e.core, ...e.extra, ...e.notes].join(', ') || 'fully configured',
        type: e.trail.IsOrganizationTrail ? 'CloudTrail organisation trail' : 'CloudTrail trail',
        region: e.trail.HomeRegion,
        service: 'cloudtrail',
        urlId: e.trail.TrailARN!,
      });
    const evidence = { trails: evals.map((e) => ({ name: e.trail.Name, organisation: !!e.trail.IsOrganizationTrail, problems: e.core, gaps: e.extra, notes: e.notes })) };
    const working = evals.filter((e) => !e.core.length);
    const resources = evals.map(toRef);
    let o: CheckOutcome;
    if (!working.length) {
      o = fail('No multi-region trail is logging all management events.', resources, evidence);
    } else {
      const best = working.find((e) => !e.extra.length);
      o = best
        ? pass(`Multi-region trail '${best.trail.Name}' logs all management events with log file validation, KMS encryption and CloudWatch Logs delivery.${best.notes.length ? ` Note: ${best.notes.join(', ')}.` : ''}`, { resources, evidence })
        : warn(`Multi-region trail logs management events but is not fully configured: ${working[0].extra.join(', ')}.`, resources, evidence);
    }
    return withMissing(o, missing);
  },

  async 'aws.guardduty'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const gd = new GuardDutyClient(clientOpts(ctx, region));
      const ids = (await gd.send(new ListDetectorsCommand({}))).DetectorIds ?? [];
      if (!ids.length) return false;
      const d = await gd.send(new GetDetectorCommand({ DetectorId: ids[0] }));
      return d.Status === 'ENABLED';
    });
    const off = res.results.filter((r) => !r.value).map((r) => regionRef(ctx, r.region, 'guardduty', 'GuardDuty', 'not enabled', 'guardduty'));
    const n = res.results.length;
    if (n && off.length === n) return regionCoverage(fail(`GuardDuty is not enabled in any of the ${n} evaluated regions.`, off), res);
    return regionCoverage(failIfAny(off, (k) => `GuardDuty disabled in ${k} of ${n} regions.`, `GuardDuty enabled in all ${n} evaluated regions.`, 'warn'), res);
  },

  async 'aws.securityhub'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const sh = new SecurityHubClient(clientOpts(ctx, region));
      try {
        await sh.send(new DescribeHubCommand({}));
      } catch (e: any) {
        if (/InvalidAccessException|ResourceNotFound/i.test(e?.name)) return { on: false as const };
        throw e;
      }
      try {
        const r = await call('securityhub:GetEnabledStandards', sh.send(new GetEnabledStandardsCommand({ MaxResults: 100 })));
        const arns = (r.StandardsSubscriptions ?? []).filter((s) => s.StandardsStatus !== 'FAILED' && s.StandardsStatus !== 'DELETING').map((s) => s.StandardsArn ?? '');
        return { on: true as const, standards: arns.map((a) => a.split('/').slice(1, 2).join('') || a) };
      } catch (e) {
        if (!(e instanceof MissingPermission)) throw e;
        return { on: true as const, standards: null, missing: e.action };
      }
    });
    const n = res.results.length;
    const off = res.results.filter((r) => !r.value.on).map((r) => regionRef(ctx, r.region, 'securityhub', 'Security Hub', 'not enabled', 'securityhub'));
    if (n && off.length === n) return regionCoverage(fail(`Security Hub is not enabled in any of the ${n} evaluated regions.`, off), res);
    const baseline = (s: string[]) => s.some((x) => /aws-foundational-security-best-practices|cis-aws-foundations-benchmark/.test(x));
    const noStandard = res.results
      .filter((r) => r.value.on && r.value.standards && !baseline(r.value.standards))
      .map((r) => regionRef(ctx, r.region, 'securityhub', 'Security Hub', 'enabled without the FSBP or CIS standard', 'securityhub'));
    const missing = res.results.flatMap((r) => (r.value.on && 'missing' in r.value && r.value.missing ? [r.value.missing] : []));
    const evidence = { standards: Object.fromEntries(res.results.map((r) => [r.region, r.value.on ? (r.value.standards ?? 'unknown') : 'disabled'])) };
    let o: CheckOutcome;
    if (off.length || noStandard.length) {
      const parts = [off.length ? `disabled in ${off.length} of ${n} regions` : '', noStandard.length ? `enabled without the AWS Foundational Security Best Practices or CIS standard in ${noStandard.length} region(s)` : ''].filter(Boolean);
      o = warn(`Security Hub is ${parts.join('; ')}.`, [...off, ...noStandard], evidence);
    } else o = pass(`Security Hub enabled with the FSBP or CIS standard in all ${n} evaluated regions.`, { evidence });
    return regionCoverage(withMissing(o, missing), res);
  },

  async 'aws.securityhub-findings'(ctx) {
    const MAX_PAGES = 10;
    const res = await perRegion(ctx, async (region) => {
      const sh = new SecurityHubClient(clientOpts(ctx, region));
      const findings: any[] = [];
      let token: string | undefined;
      let pages = 0;
      try {
        do {
          const r = await call(
            'securityhub:GetFindings',
            sh.send(
              new GetFindingsCommand({
                Filters: {
                  ComplianceStatus: [{ Value: 'FAILED', Comparison: 'EQUALS' }],
                  RecordState: [{ Value: 'ACTIVE', Comparison: 'EQUALS' }],
                  WorkflowStatus: [
                    { Value: 'NEW', Comparison: 'EQUALS' },
                    { Value: 'NOTIFIED', Comparison: 'EQUALS' },
                  ],
                  SeverityLabel: [
                    { Value: 'CRITICAL', Comparison: 'EQUALS' },
                    { Value: 'HIGH', Comparison: 'EQUALS' },
                  ],
                },
                MaxResults: 100,
                NextToken: token,
              }),
            ),
          );
          findings.push(...(r.Findings ?? []));
          token = r.NextToken;
          ctx.signal?.throwIfAborted();
        } while (token && ++pages < MAX_PAGES);
      } catch (e: any) {
        if (/InvalidAccessException|ResourceNotFound/i.test(e?.name)) return null;
        throw e;
      }
      return { findings, truncated: !!token };
    });
    const enabled = res.results.filter((r) => r.value);
    if (!enabled.length) return regionCoverage(na('Security Hub is not enabled in any evaluated region (see the Security Hub check).'), res);
    const seen = new Set<string>();
    const controls = new Map<string, { title: string; region: string; critical: number; high: number; resources: Set<string> }>();
    for (const r of enabled) {
      for (const f of r.value!.findings) {
        if (seen.has(f.Id)) continue;
        seen.add(f.Id);
        const key = f.Compliance?.SecurityControlId ?? f.ProductFields?.ControlId ?? f.GeneratorId ?? f.Title ?? 'unknown';
        const c = controls.get(key) ?? { title: f.Title ?? key, region: f.Region ?? r.region, critical: 0, high: 0, resources: new Set<string>() };
        if (f.Severity?.Label === 'CRITICAL') c.critical++;
        else c.high++;
        for (const x of f.Resources ?? []) if (x.Id) c.resources.add(x.Id);
        controls.set(key, c);
      }
    }
    const resources = [...controls.entries()]
      .sort((a, b) => b[1].critical - a[1].critical || b[1].critical + b[1].high - (a[1].critical + a[1].high))
      .map(([key, c]) =>
        ref(ctx, {
          id: `arn:aws:securityhub:${c.region}:${ctx.accountId}:security-control/${key}`,
          name: `${key}: ${c.title}`,
          detail: `${c.critical + c.high} failed finding(s) (${c.critical} critical, ${c.high} high) on ${c.resources.size} resource(s)`,
          type: 'Security Hub control',
          region: c.region,
          service: 'securityhub',
          urlId: '',
        }),
      );
    const critical = [...controls.values()].reduce((a, c) => a + c.critical, 0);
    const total = seen.size;
    const truncated = enabled.some((r) => r.value!.truncated);
    const o = total
      ? fail(`${total} active critical/high failed findings across ${controls.size} control(s) (${critical} critical).`, resources, { findings: total, critical, controls: controls.size })
      : pass(`No active critical or high failed Security Hub findings in ${enabled.length} region(s).`);
    return regionCoverage(applyTruncation(o, truncated, total, 'findings'), res);
  },

  async 'aws.config'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const cfg = new ConfigServiceClient(clientOpts(ctx, region));
      const st = await cfg.send(new DescribeConfigurationRecorderStatusCommand({}));
      const recording = (st.ConfigurationRecordersStatus ?? []).some((r) => r.recording);
      const missing: string[] = [];
      let allSupported: boolean | null = null;
      let global: boolean | null = null;
      let channel: boolean | null = null;
      try {
        const rec = await call('config:DescribeConfigurationRecorders', cfg.send(new DescribeConfigurationRecordersCommand({})));
        const groups = (rec.ConfigurationRecorders ?? []).map((r) => r.recordingGroup ?? {});
        allSupported = groups.some((g) => g.allSupported || g.recordingStrategy?.useOnly === 'ALL_SUPPORTED_RESOURCE_TYPES');
        global = groups.some((g) => g.includeGlobalResourceTypes);
      } catch (e) {
        if (!(e instanceof MissingPermission)) throw e;
        missing.push(e.action);
      }
      try {
        const ch = await call('config:DescribeDeliveryChannels', cfg.send(new DescribeDeliveryChannelsCommand({})));
        channel = (ch.DeliveryChannels ?? []).length > 0;
      } catch (e) {
        if (!(e instanceof MissingPermission)) throw e;
        missing.push(e.action);
      }
      return { recording, allSupported, global, channel, missing };
    });
    const n = res.results.length;
    const off = res.results.filter((r) => !r.value.recording).map((r) => regionRef(ctx, r.region, 'config', 'AWS Config recorder', 'not recording', 'config'));
    if (n && off.length === n) return regionCoverage(fail(`AWS Config is not recording in any of the ${n} evaluated regions.`, off), res);
    const on = res.results.filter((r) => r.value.recording);
    const gaps: ResourceRef[] = [];
    for (const r of on) {
      const g: string[] = [];
      if (r.value.allSupported === false) g.push('does not record all supported resource types');
      if (r.value.channel === false) g.push('no delivery channel');
      if (g.length) gaps.push(regionRef(ctx, r.region, 'config', 'AWS Config recorder', g.join(', '), 'config'));
    }
    const globalKnown = on.some((r) => r.value.global !== null);
    const noGlobal = globalKnown && !on.some((r) => r.value.global);
    const missing = res.results.flatMap((r) => r.value.missing);
    const parts = [
      off.length ? `not recording in ${off.length} of ${n} regions` : '',
      gaps.length ? `incomplete in ${gaps.length} region(s)` : '',
      noGlobal ? 'global resources (IAM) are not recorded in any region' : '',
    ].filter(Boolean);
    const o = parts.length
      ? warn(`AWS Config is ${parts.join('; ')}.`, [...off, ...gaps])
      : pass(`AWS Config records all resource types with a delivery channel in all ${n} evaluated regions, including global resources.`);
    return regionCoverage(withMissing(o, missing), res);
  },

  async 'aws.s3-account-bpa'(ctx) {
    const { config: c, error } = await accountBpa(ctx);
    if (error) throw Object.assign(new Error(error), { name: error });
    if (!c) return fail('Account-level S3 Block Public Access is not configured.');
    const all = c.BlockPublicAcls && c.IgnorePublicAcls && c.BlockPublicPolicy && c.RestrictPublicBuckets;
    return all ? pass('All four account-level Block Public Access settings are on.') : warn('Account-level Block Public Access is only partially enabled.', [], { configuration: c });
  },

  async 'aws.s3-public-buckets'(ctx) {
    const list = await buckets(ctx);
    if (!list.length) return na('No S3 buckets in this account.');
    const acct = (await accountBpa(ctx)).config ?? {};
    const pub: ResourceRef[] = [];
    const unknown: string[] = list.filter((b) => b.error).map((b) => `${b.name} (${b.error})`);
    const missing = new Set<string>();
    let blockedOnly = 0;
    await mapLimit(list.filter((b) => !b.error), 8, async (b) => {
      const s3 = new S3Client(s3Opts(ctx, b.region));
      try {
        let bpa: Bpa = {};
        try {
          bpa = (await call('s3:GetBucketPublicAccessBlock', s3.send(new GetBucketPublicAccessBlockCommand({ Bucket: b.name })))).PublicAccessBlockConfiguration ?? {};
        } catch (e: any) {
          if (!/NoSuchPublicAccessBlockConfiguration/.test(e?.name)) throw e;
        }
        let policyPublic = false;
        try {
          policyPublic = !!(await s3.send(new GetBucketPolicyStatusCommand({ Bucket: b.name }))).PolicyStatus?.IsPublic;
        } catch (e: any) {
          if (!/NoSuchBucketPolicy/.test(e?.name)) throw e;
        }
        const acl = await call('s3:GetBucketAcl', s3.send(new GetBucketAclCommand({ Bucket: b.name })));
        const aclGrants = (acl.Grants ?? []).filter((g) => g.Grantee?.URI && PUBLIC_GROUPS[g.Grantee.URI]).map((g) => `${PUBLIC_GROUPS[g.Grantee!.URI!]}: ${g.Permission}`);
        const restrict = !!(bpa.RestrictPublicBuckets || acct.RestrictPublicBuckets);
        const ignoreAcls = !!(bpa.IgnorePublicAcls || acct.IgnorePublicAcls);
        const reasons: string[] = [];
        if (policyPublic && !restrict) reasons.push('public via bucket policy');
        if (aclGrants.length && !ignoreAcls) reasons.push(`public via ACL (${aclGrants.join(', ')})`);
        if (reasons.length) pub.push(bucketRef(ctx, b, reasons.join('; ')));
        else if (policyPublic || aclGrants.length) blockedOnly++;
      } catch (e: any) {
        if (e instanceof MissingPermission) {
          missing.add(e.action);
          unknown.push(`${b.name} (missing ${e.action})`);
        } else if (isAccessDenied(e) || /NoSuchBucket|PermanentRedirect|AuthorizationHeaderMalformed/.test(String(e?.name))) {
          unknown.push(`${b.name} (${String(e?.name ?? 'error')})`);
        } else throw e;
      }
    });
    const evaluated = list.length - unknown.length;
    const blockedNote = blockedOnly ? ` ${blockedOnly} bucket(s) have a public policy or ACL that Block Public Access neutralises.` : '';
    const outcome = pub.length
      ? fail(`${pub.length} of ${evaluated} evaluated buckets are public (bucket policy or ACL not blocked by Block Public Access).${blockedNote}`, pub)
      : pass(`None of ${evaluated} evaluated buckets are public (bucket policy, ACL and Block Public Access evaluated).${blockedNote}`);
    return applyCoverage(outcome, {
      evaluated,
      total: list.length,
      skipped: unknown.sort(),
      unit: 'buckets',
      hint: missing.size ? updateRoleHint(missing) : 'The scanner role cannot read the bucket settings (check bucket policies that deny the role).',
    });
  },

  async 'aws.s3-secure-transport'(ctx) {
    const list = await buckets(ctx);
    if (!list.length) return na('No S3 buckets in this account.');
    const bad: ResourceRef[] = [];
    const unknown: string[] = list.filter((b) => b.error).map((b) => `${b.name} (${b.error})`);
    const missing = new Set<string>();
    await mapLimit(list.filter((b) => !b.error), 8, async (b) => {
      try {
        let policy: string | undefined;
        try {
          policy = (await call('s3:GetBucketPolicy', new S3Client(s3Opts(ctx, b.region)).send(new GetBucketPolicyCommand({ Bucket: b.name })))).Policy;
        } catch (e: any) {
          if (!/NoSuchBucketPolicy/.test(e?.name)) throw e;
        }
        if (!deniesInsecureTransport(policy)) bad.push(bucketRef(ctx, b, policy ? 'policy does not deny aws:SecureTransport=false' : 'no bucket policy'));
      } catch (e: any) {
        if (e instanceof MissingPermission) {
          missing.add(e.action);
          unknown.push(`${b.name} (missing ${e.action})`);
        } else if (isAccessDenied(e) || /NoSuchBucket|PermanentRedirect/.test(String(e?.name))) {
          unknown.push(`${b.name} (${String(e?.name ?? 'error')})`);
        } else throw e;
      }
    });
    const evaluated = list.length - unknown.length;
    const outcome = failIfAny(bad, (n) => `${n} of ${evaluated} evaluated buckets do not deny plain HTTP requests (aws:SecureTransport).`, `All ${evaluated} evaluated buckets deny plain HTTP requests.`);
    return applyCoverage(outcome, {
      evaluated,
      total: list.length,
      skipped: unknown.sort(),
      unit: 'buckets',
      hint: missing.size ? updateRoleHint(missing) : 'The scanner role cannot read the bucket policies.',
    });
  },

  async 'aws.ebs-encryption'(ctx) {
    const res = await perRegion(ctx, async (region) => (await new EC2Client(clientOpts(ctx, region)).send(new GetEbsEncryptionByDefaultCommand({}))).EbsEncryptionByDefault);
    const off = res.results.filter((r) => !r.value).map((r) => regionRef(ctx, r.region, 'ec2', 'EBS default encryption', 'EBS encryption by default off'));
    const n = res.results.length;
    if (n && off.length === n) return regionCoverage(fail(`EBS encryption by default is disabled in all ${n} evaluated regions.`, off), res);
    return regionCoverage(failIfAny(off, (k) => `EBS encryption by default disabled in ${k} of ${n} regions.`, 'EBS encryption by default enabled in all evaluated regions.', 'warn'), res);
  },

  async 'aws.sg-admin-ports'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const ec2 = new EC2Client(clientOpts(ctx, region));
      const out: ResourceRef[] = [];
      let token: string | undefined;
      do {
        const r = await ec2.send(new DescribeSecurityGroupsCommand({ NextToken: token, MaxResults: 1000 }));
        for (const sg of r.SecurityGroups ?? []) {
          const ports = new Set<number>();
          const sources = new Set<string>();
          let allTraffic = false;
          for (const p of sg.IpPermissions ?? []) {
            const broad = [
              ...(p.IpRanges ?? []).filter((x) => prefixLen(x.CidrIp) <= BROAD_V4).map((x) => x.CidrIp!),
              ...(p.Ipv6Ranges ?? []).filter((x) => prefixLen(x.CidrIpv6) <= BROAD_V6).map((x) => x.CidrIpv6!),
            ];
            if (!broad.length) continue;
            const all = p.IpProtocol === '-1';
            const matched = ADMIN_PORTS.filter((port) => all || ((p.FromPort ?? 0) <= port && port <= (p.ToPort ?? 65535)));
            if (!matched.length || (p.IpProtocol !== '-1' && p.IpProtocol !== 'tcp' && p.IpProtocol !== '6')) continue;
            allTraffic ||= all;
            matched.forEach((x) => ports.add(x));
            broad.forEach((x) => sources.add(x));
          }
          if (!ports.size) continue;
          const portText = allTraffic ? 'all traffic open' : `ports ${[...ports].sort((a, b) => a - b).join(', ')}`;
          out.push(
            ref(ctx, {
              id: `arn:aws:ec2:${region}:${ctx.accountId}:security-group/${sg.GroupId}`,
              name: `${sg.GroupName} (${sg.GroupId})`,
              detail: `${portText} from ${[...sources].sort().join(', ')}`,
              type: 'Security group',
              region,
              service: 'ec2-sg',
              urlId: sg.GroupId!,
            }),
          );
        }
        token = r.NextToken;
        ctx.signal?.throwIfAborted();
      } while (token);
      return out;
    });
    const bad = res.results.flatMap((r) => r.value);
    return regionCoverage(
      failIfAny(bad, (n) => `${n} security group(s) expose admin/database ports to the internet (0.0.0.0/0, ::/0 or other very broad ranges).`, 'No security groups expose admin ports to the internet.'),
      res,
    );
  },

  async 'aws.default-sg-closed'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const ec2 = new EC2Client(clientOpts(ctx, region));
      const out: ResourceRef[] = [];
      let total = 0;
      let token: string | undefined;
      do {
        const r = await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: ['default'] }], NextToken: token, MaxResults: 1000 }));
        for (const sg of r.SecurityGroups ?? []) {
          total++;
          const count = (rules: IpPermission[] | undefined) => (rules ?? []).length;
          const inbound = count(sg.IpPermissions);
          const outbound = count(sg.IpPermissionsEgress);
          if (inbound || outbound) {
            out.push(
              ref(ctx, {
                id: `arn:aws:ec2:${region}:${ctx.accountId}:security-group/${sg.GroupId}`,
                name: `default (${sg.VpcId ?? sg.GroupId})`,
                detail: `${inbound} inbound and ${outbound} outbound rule(s)`,
                type: 'Default security group',
                region,
                service: 'ec2-sg',
                urlId: sg.GroupId!,
              }),
            );
          }
        }
        token = r.NextToken;
        ctx.signal?.throwIfAborted();
      } while (token);
      return { out, total };
    });
    const total = res.results.reduce((a, r) => a + r.value.total, 0);
    if (!total) return regionCoverage(na('No VPCs (default security groups) found.'), res);
    return regionCoverage(
      failIfAny(res.results.flatMap((r) => r.value.out), (n) => `${n} of ${total} default security groups still have rules.`, `All ${total} default security groups restrict all traffic.`),
      res,
    );
  },

  async 'aws.vpc-flow-logs'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const ec2 = new EC2Client(clientOpts(ctx, region));
      const vpcs: { id: string; name?: string; isDefault: boolean }[] = [];
      let token: string | undefined;
      do {
        const r = await call('ec2:DescribeVpcs', ec2.send(new DescribeVpcsCommand({ NextToken: token, MaxResults: 1000 })));
        for (const v of r.Vpcs ?? []) vpcs.push({ id: v.VpcId!, name: v.Tags?.find((t) => t.Key === 'Name')?.Value, isDefault: !!v.IsDefault });
        token = r.NextToken;
      } while (token);
      if (!vpcs.length) return { out: [] as ResourceRef[], total: 0 };
      const logged = new Set<string>();
      token = undefined;
      do {
        const r: DescribeFlowLogsCommandOutput = await call('ec2:DescribeFlowLogs', ec2.send(new DescribeFlowLogsCommand({ NextToken: token, MaxResults: 1000 })));
        for (const f of r.FlowLogs ?? []) if (f.ResourceId && (f.FlowLogStatus ?? 'ACTIVE') === 'ACTIVE') logged.add(f.ResourceId);
        token = r.NextToken;
        ctx.signal?.throwIfAborted();
      } while (token);
      const out = vpcs
        .filter((v) => !logged.has(v.id))
        .map((v) =>
          ref(ctx, {
            id: `arn:aws:ec2:${region}:${ctx.accountId}:vpc/${v.id}`,
            name: v.name ? `${v.name} (${v.id})` : v.id,
            detail: v.isDefault ? 'default VPC, no flow log' : 'no flow log',
            type: 'VPC',
            region,
            service: 'vpc',
            urlId: v.id,
          }),
        );
      return { out, total: vpcs.length };
    });
    const total = res.results.reduce((a, r) => a + r.value.total, 0);
    if (!total) return regionCoverage(na('No VPCs found.'), res);
    return regionCoverage(failIfAny(res.results.flatMap((r) => r.value.out), (n) => `${n} of ${total} VPCs have no active flow log.`, `All ${total} VPCs have flow logs.`), res);
  },

  async 'aws.public-snapshots'(ctx) {
    const RDS_ATTRIBUTE_CAP = 200;
    const res = await perRegion(ctx, async (region) => {
      const ec2 = new EC2Client(clientOpts(ctx, region));
      const rds = new RDSClient(clientOpts(ctx, region));
      const out: ResourceRef[] = [];
      const missing: string[] = [];
      let sources = 0;
      let truncated = false;
      const source = async (fn: () => Promise<void>) => {
        try {
          await fn();
          sources++;
        } catch (e) {
          if (!(e instanceof MissingPermission)) throw e;
          missing.push(e.action);
        }
      };
      // EBS snapshots restorable by everyone (createVolumePermission group "all").
      await source(async () => {
        let token: string | undefined;
        do {
          const r: DescribeSnapshotsCommandOutput = await call('ec2:DescribeSnapshots', ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ['self'], RestorableByUserIds: ['all'], NextToken: token, MaxResults: 1000 })));
          for (const s of r.Snapshots ?? []) {
            out.push(
              ref(ctx, {
                id: `arn:aws:ec2:${region}::snapshot/${s.SnapshotId}`,
                name: s.Tags?.find((t) => t.Key === 'Name')?.Value ?? s.SnapshotId,
                detail: `EBS snapshot of ${s.VolumeId ?? 'unknown volume'} is public`,
                type: 'EBS snapshot',
                region,
                service: 'ec2-snapshot',
                urlId: s.SnapshotId!,
              }),
            );
          }
          token = r.NextToken;
        } while (token);
      });
      // Public AMIs.
      await source(async () => {
        const r = await call('ec2:DescribeImages', ec2.send(new DescribeImagesCommand({ Owners: ['self'], Filters: [{ Name: 'is-public', Values: ['true'] }] })));
        for (const i of r.Images ?? []) {
          out.push(
            ref(ctx, { id: `arn:aws:ec2:${region}::image/${i.ImageId}`, name: i.Name ?? i.ImageId, detail: 'AMI is public', type: 'AMI', region, service: 'ec2-ami', urlId: i.ImageId! }),
          );
        }
      });
      // Manual RDS snapshots shared with "all".
      await source(async () => {
        const snaps: string[] = [];
        let marker: string | undefined;
        do {
          const r = await call('rds:DescribeDBSnapshots', rds.send(new DescribeDBSnapshotsCommand({ SnapshotType: 'manual', Marker: marker })));
          snaps.push(...(r.DBSnapshots ?? []).map((s) => s.DBSnapshotIdentifier!).filter(Boolean));
          marker = r.Marker;
        } while (marker);
        if (snaps.length > RDS_ATTRIBUTE_CAP) truncated = true;
        await mapLimit(snaps.slice(0, RDS_ATTRIBUTE_CAP), 4, async (id) => {
          const a = await call('rds:DescribeDBSnapshotAttributes', rds.send(new DescribeDBSnapshotAttributesCommand({ DBSnapshotIdentifier: id })));
          const restore = (a.DBSnapshotAttributesResult?.DBSnapshotAttributes ?? []).find((x) => x.AttributeName === 'restore');
          if ((restore?.AttributeValues ?? []).includes('all')) {
            out.push(
              ref(ctx, { id: `arn:aws:rds:${region}:${ctx.accountId}:snapshot:${id}`, name: id, detail: 'RDS snapshot is public', type: 'RDS snapshot', region, service: 'rds-snapshot', urlId: id }),
            );
          }
        });
      });
      // Manual Aurora / Multi-AZ cluster snapshots shared with "all".
      await source(async () => {
        const snaps: string[] = [];
        let marker: string | undefined;
        do {
          const r = await call('rds:DescribeDBClusterSnapshots', rds.send(new DescribeDBClusterSnapshotsCommand({ SnapshotType: 'manual', Marker: marker })));
          snaps.push(...(r.DBClusterSnapshots ?? []).map((s) => s.DBClusterSnapshotIdentifier!).filter(Boolean));
          marker = r.Marker;
        } while (marker);
        if (snaps.length > RDS_ATTRIBUTE_CAP) truncated = true;
        await mapLimit(snaps.slice(0, RDS_ATTRIBUTE_CAP), 4, async (id) => {
          const a = await call('rds:DescribeDBClusterSnapshotAttributes', rds.send(new DescribeDBClusterSnapshotAttributesCommand({ DBClusterSnapshotIdentifier: id })));
          const restore = (a.DBClusterSnapshotAttributesResult?.DBClusterSnapshotAttributes ?? []).find((x) => x.AttributeName === 'restore');
          if ((restore?.AttributeValues ?? []).includes('all')) {
            out.push(
              ref(ctx, { id: `arn:aws:rds:${region}:${ctx.accountId}:cluster-snapshot:${id}`, name: id, detail: 'RDS cluster snapshot is public', type: 'RDS cluster snapshot', region }),
            );
          }
        });
      });
      ctx.signal?.throwIfAborted();
      return { out, missing, sources, truncated };
    });
    const missing = res.results.flatMap((r) => r.value.missing);
    const bad = res.results.flatMap((r) => r.value.out);
    const evaluatedSources = res.results.reduce((a, r) => a + r.value.sources, 0);
    if (res.results.length && !evaluatedSources) {
      return { status: 'error', summary: updateRoleHint(missing), evidence: { missingPermissions: [...new Set(missing)].sort() } };
    }
    let o = failIfAny(bad, (n) => `${n} snapshot(s) or AMI(s) are shared publicly.`, 'No public EBS snapshots, AMIs or RDS snapshots found.');
    if (res.results.some((r) => r.value.truncated)) o = applyTruncation(o, true, RDS_ATTRIBUTE_CAP, 'manual RDS snapshots per region');
    return regionCoverage(withMissing(o, missing), res);
  },

  async 'aws.ec2-imdsv2'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const ec2 = new EC2Client(clientOpts(ctx, region));
      const out: ResourceRef[] = [];
      let total = 0;
      let token: string | undefined;
      do {
        const r = await ec2.send(new DescribeInstancesCommand({ NextToken: token, MaxResults: 1000 }));
        for (const i of (r.Reservations ?? []).flatMap((x) => x.Instances ?? [])) {
          if (i.State?.Name === 'terminated') continue;
          total++;
          if (i.MetadataOptions?.HttpTokens !== 'required' && i.MetadataOptions?.HttpEndpoint !== 'disabled') {
            out.push(
              ref(ctx, {
                id: `arn:aws:ec2:${region}:${ctx.accountId}:instance/${i.InstanceId}`,
                name: i.Tags?.find((t) => t.Key === 'Name')?.Value ?? i.InstanceId,
                detail: `${i.InstanceId}, IMDSv1 allowed`,
                type: 'EC2 instance',
                region,
                service: 'ec2-instance',
                urlId: i.InstanceId!,
              }),
            );
          }
        }
        token = r.NextToken;
        ctx.signal?.throwIfAborted();
      } while (token);
      return { out, total };
    });
    const total = res.results.reduce((a, r) => a + r.value.total, 0);
    if (!total) return regionCoverage(na('No EC2 instances found.'), res);
    const bad = res.results.flatMap((r) => r.value.out);
    return regionCoverage(failIfAny(bad, (n) => `${n} of ${total} instances allow IMDSv1.`, `All ${total} instances require IMDSv2.`), res);
  },

  async 'aws.rds-public'(ctx) {
    const { dbs, run } = await rdsInstances(ctx);
    if (!dbs.length) return regionCoverage(na('No RDS instances found.'), run);
    return regionCoverage(
      failIfAny(
        dbs.filter((d) => d.db.PubliclyAccessible).map((d) => rdsRef(ctx, d, 'publicly accessible')),
        (n) => `${n} RDS instance(s) are publicly accessible.`,
        `None of ${dbs.length} RDS instances are publicly accessible.`,
      ),
      run,
    );
  },

  async 'aws.rds-encryption'(ctx) {
    const { dbs, run } = await rdsInstances(ctx);
    if (!dbs.length) return regionCoverage(na('No RDS instances found.'), run);
    return regionCoverage(
      failIfAny(
        dbs.filter((d) => !d.db.StorageEncrypted).map((d) => rdsRef(ctx, d, 'storage not encrypted')),
        (n) => `${n} RDS instance(s) without storage encryption.`,
        `All ${dbs.length} RDS instances are encrypted.`,
      ),
      run,
    );
  },

  async 'aws.rds-backup'(ctx) {
    const { dbs: all, run } = await rdsInstances(ctx);
    // Read replicas have no automated backups of their own; their source carries the backup obligation.
    const dbs = all.filter((d) => !d.db.ReadReplicaSourceDBInstanceIdentifier && !d.db.ReadReplicaSourceDBClusterIdentifier);
    const replicas = all.length - dbs.length;
    const note = replicas ? ` ${replicas} read replica(s) skipped.` : '';
    if (!dbs.length) return regionCoverage(na(all.length ? `Only read replicas found (${replicas}); backups are evaluated on their source.` : 'No RDS instances found.'), run);
    return regionCoverage(
      failIfAny(
        dbs.filter((d) => (d.db.BackupRetentionPeriod ?? 0) < 7).map((d) => rdsRef(ctx, d, `retention ${d.db.BackupRetentionPeriod ?? 0} days`)),
        (n) => `${n} RDS instance(s) keep backups for less than 7 days.${note}`,
        `All ${dbs.length} RDS instances retain backups for 7+ days.${note}`,
        'warn',
      ),
      run,
    );
  },

  async 'aws.backup-plans'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const b = new BackupClient(clientOpts(ctx, region));
      const plans: { id: string; name: string; arn: string; selections: number }[] = [];
      let token: string | undefined;
      do {
        const r = await call('backup:ListBackupPlans', b.send(new ListBackupPlansCommand({ NextToken: token, MaxResults: 100 })));
        for (const p of r.BackupPlansList ?? []) plans.push({ id: p.BackupPlanId!, name: p.BackupPlanName ?? p.BackupPlanId!, arn: p.BackupPlanArn!, selections: 0 });
        token = r.NextToken;
      } while (token);
      await mapLimit(plans, 4, async (p) => {
        const r = await call('backup:ListBackupSelections', b.send(new ListBackupSelectionsCommand({ BackupPlanId: p.id, MaxResults: 100 })));
        p.selections = (r.BackupSelectionsList ?? []).length;
      });
      const vaults: { name: string; locked: boolean }[] = [];
      token = undefined;
      do {
        const r: ListBackupVaultsCommandOutput = await call('backup:ListBackupVaults', b.send(new ListBackupVaultsCommand({ NextToken: token, MaxResults: 100 })));
        for (const v of r.BackupVaultList ?? []) vaults.push({ name: v.BackupVaultName!, locked: !!v.Locked });
        token = r.NextToken;
        ctx.signal?.throwIfAborted();
      } while (token);
      return { plans, vaults };
    });
    const plans = res.results.flatMap((r) => r.value.plans.map((p) => ({ ...p, region: r.region })));
    const locked = res.results.flatMap((r) => r.value.vaults.filter((v) => v.locked).map((v) => `${v.name} (${r.region})`));
    const toRef = (p: (typeof plans)[number], detail: string) =>
      ref(ctx, { id: p.arn, name: p.name, detail, type: 'AWS Backup plan', region: p.region, service: 'backup', urlId: p.id });
    const n = res.results.length;
    const evidence = { plans: plans.length, plansWithResources: plans.filter((p) => p.selections).length, lockedVaults: locked };
    let o: CheckOutcome;
    if (!n) o = na('No regions evaluated.');
    else if (!plans.length) o = fail(`No AWS Backup plans found in any of the ${n} evaluated regions.`, [], evidence);
    else if (!plans.some((p) => p.selections)) o = warn(`${plans.length} AWS Backup plan(s) exist but none has resources assigned.`, plans.map((p) => toRef(p, 'no resource assignments')), evidence);
    else {
      const covered = plans.filter((p) => p.selections);
      const lockNote = locked.length ? ` ${locked.length} vault(s) protected by Vault Lock.` : ' No vault uses Vault Lock (consider it for immutable, ransomware-resistant copies).';
      o = pass(`${covered.length} AWS Backup plan(s) with resource assignments.${lockNote}`, { evidence, resources: covered.map((p) => toRef(p, `${p.selections} resource assignment(s)`)) });
    }
    return regionCoverage(o, res);
  },

  async 'aws.inspector'(ctx) {
    const MAX_PAGES = 10;
    const res = await perRegion(ctx, async (region) => {
      const ins = new Inspector2Client(clientOpts(ctx, region));
      const st = await call('inspector2:BatchGetAccountStatus', ins.send(new BatchGetAccountStatusCommand({ accountIds: [ctx.accountId] })));
      const rs = st.accounts?.[0]?.resourceState;
      const types = { EC2: rs?.ec2?.status === 'ENABLED', ECR: rs?.ecr?.status === 'ENABLED', Lambda: rs?.lambda?.status === 'ENABLED' };
      let critical = 0;
      let truncated = false;
      if (Object.values(types).some(Boolean)) {
        let token: string | undefined;
        let pages = 0;
        do {
          const r = await call(
            'inspector2:ListFindings',
            ins.send(
              new ListFindingsCommand({
                filterCriteria: { severity: [{ comparison: 'EQUALS', value: 'CRITICAL' }], findingStatus: [{ comparison: 'EQUALS', value: 'ACTIVE' }] },
                maxResults: 100,
                nextToken: token,
              }),
            ),
          );
          critical += (r.findings ?? []).length;
          token = r.nextToken;
          ctx.signal?.throwIfAborted();
        } while (token && ++pages < MAX_PAGES);
        truncated = !!token;
      }
      return { types, critical, truncated };
    });
    const n = res.results.length;
    const regionsOn = res.results.filter((r) => Object.values(r.value.types).some(Boolean));
    const refFor = (region: string, detail: string) => regionRef(ctx, region, 'inspector2', 'Amazon Inspector', detail, 'inspector');
    if (n && !regionsOn.length) return regionCoverage(fail(`Amazon Inspector is not enabled in any of the ${n} evaluated regions.`, res.results.map((r) => refFor(r.region, 'not enabled'))), res);
    const resources: ResourceRef[] = [];
    let partial = 0;
    for (const r of res.results) {
      const off = Object.entries(r.value.types).filter(([, on]) => !on).map(([k]) => k);
      const parts: string[] = [];
      if (off.length === 3) parts.push('not enabled');
      else if (off.length) parts.push(`not scanning ${off.join(', ')}`);
      if (off.length) partial++;
      if (r.value.critical) parts.push(`${r.value.critical}${r.value.truncated ? '+' : ''} active critical finding(s)`);
      if (parts.length) resources.push(refFor(r.region, parts.join('; ')));
    }
    const critical = res.results.reduce((a, r) => a + r.value.critical, 0);
    const truncated = res.results.some((r) => r.value.truncated);
    const evidence = { criticalFindings: critical, regions: Object.fromEntries(res.results.map((r) => [r.region, r.value.types])) };
    const issues = [
      critical ? `${critical}${truncated ? '+' : ''} active critical finding(s)` : '',
      partial ? `incomplete coverage (EC2, ECR, Lambda) in ${partial} of ${n} regions` : '',
    ].filter(Boolean);
    const o = issues.length ? warn(`Amazon Inspector: ${issues.join('; ')}.`, resources, evidence) : pass(`Amazon Inspector scans EC2, ECR and Lambda in all ${n} evaluated regions with no active critical findings.`, { evidence });
    return regionCoverage(o, res);
  },

  async 'aws.kms-rotation'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const kms = new KMSClient(clientOpts(ctx, region));
      const out: ResourceRef[] = [];
      const denied: string[] = [];
      let total = 0;
      let marker: string | undefined;
      do {
        const r = await kms.send(new ListKeysCommand({ Marker: marker }));
        for (const k of r.Keys ?? []) {
          try {
            const d = (await kms.send(new DescribeKeyCommand({ KeyId: k.KeyId }))).KeyMetadata!;
            if (d.KeyManager !== 'CUSTOMER' || d.KeyState !== 'Enabled' || d.KeySpec !== 'SYMMETRIC_DEFAULT' || d.Origin !== 'AWS_KMS') continue;
            const rot = await kms.send(new GetKeyRotationStatusCommand({ KeyId: k.KeyId }));
            // Count a key only once its rotation status was actually read.
            total++;
            if (!rot.KeyRotationEnabled) out.push(ref(ctx, { id: d.Arn!, name: d.Description || k.KeyId, detail: 'automatic rotation off', type: 'KMS key', region, service: 'kms' }));
          } catch (e) {
            if (!isAccessDenied(e)) throw e;
            denied.push(`${k.KeyId} (${region})`);
          }
        }
        marker = r.Truncated ? r.NextMarker : undefined;
        ctx.signal?.throwIfAborted();
      } while (marker);
      return { out, total, denied };
    });
    const total = res.results.reduce((a, r) => a + r.value.total, 0);
    const denied = res.results.flatMap((r) => r.value.denied);
    const outcome =
      !total && !denied.length
        ? na('No customer managed symmetric KMS keys found.')
        : failIfAny(res.results.flatMap((r) => r.value.out), (n) => `${n} of ${total} customer managed keys without rotation.`, `All ${total} evaluated customer managed keys rotate automatically.`, 'warn');
    const keyCoverage = applyCoverage(outcome, { evaluated: total, total: total + denied.length, skipped: denied, unit: 'KMS keys', hint: 'The scanner role cannot read these keys (key policy denies kms:DescribeKey or kms:GetKeyRotationStatus).' });
    return regionCoverage(keyCoverage, res);
  },

  async 'aws.access-analyzer'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const r = await new AccessAnalyzerClient(clientOpts(ctx, region)).send(new ListAnalyzersCommand({}));
      return (r.analyzers ?? []).some((a) => a.status === 'ACTIVE');
    });
    const off = res.results.filter((r) => !r.value).map((r) => regionRef(ctx, r.region, 'access-analyzer', 'IAM Access Analyzer', 'no active analyzer'));
    const n = res.results.length;
    if (n && off.length === n) return regionCoverage(fail(`IAM Access Analyzer is not enabled in any of the ${n} evaluated regions.`, off), res);
    return regionCoverage(failIfAny(off, (k) => `Access Analyzer missing in ${k} of ${n} regions.`, 'Access Analyzer active in all evaluated regions.', 'warn'), res);
  },
};

async function rdsInstances(ctx: AwsCtx) {
  return ctx.memo.get('rds', async () => {
    const res = await perRegion(ctx, async (region) => {
      const rds = new RDSClient(clientOpts(ctx, region));
      const out = [];
      let marker: string | undefined;
      do {
        const r = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }));
        out.push(...(r.DBInstances ?? []));
        marker = r.Marker;
        ctx.signal?.throwIfAborted();
      } while (marker);
      return out;
    });
    return { dbs: res.results.flatMap((r) => r.value.map((db) => ({ region: r.region, db }))), run: res };
  });
}

const rdsRef = (ctx: AwsCtx, d: { region: string; db: { DBInstanceArn?: string; DBInstanceIdentifier?: string } }, detail: string) =>
  ref(ctx, { id: d.db.DBInstanceArn!, name: d.db.DBInstanceIdentifier, detail, type: 'RDS instance', region: d.region, service: 'rds' });

/** A missing new permission is reported as "could not be evaluated", never as a failed control. */
const guarded = Object.fromEntries(
  Object.entries(checks).map(([id, fn]) => [
    id,
    async (ctx: AwsCtx): Promise<CheckOutcome> => {
      try {
        return await fn(ctx);
      } catch (e) {
        if (e instanceof MissingPermission) return { status: 'error', summary: e.message, evidence: { missingPermissions: [e.action] } };
        throw e;
      }
    },
  ]),
);

export const awsModule: ProviderModule<AwsCtx> = {
  async connect(config, secret, env, memo, systemId) {
    let creds: Creds;
    if (config.authMode === 'assume_role') {
      if (!env.aws) throw new CheckError('The platform AWS identity is not configured (SCANNER_AWS_ACCESS_KEY_ID / SCANNER_AWS_SECRET_ACCESS_KEY).');
      if (!config.roleArn || !config.externalId) throw new CheckError('Role ARN and external ID are required.');
      const sts = new STSClient({ region: HOME, credentials: env.aws });
      const r = await sts.send(
        new AssumeRoleCommand({
          RoleArn: config.roleArn,
          ExternalId: config.externalId,
          RoleSessionName: `security-quickscan-${systemId.slice(0, 8)}`,
          DurationSeconds: 3600,
        }),
      );
      creds = { accessKeyId: r.Credentials!.AccessKeyId!, secretAccessKey: r.Credentials!.SecretAccessKey!, sessionToken: r.Credentials!.SessionToken };
    } else {
      if (!secret?.accessKeyId) throw new CheckError('Access keys are missing.');
      creds = { accessKeyId: secret.accessKeyId, secretAccessKey: secret.secretAccessKey, sessionToken: secret.sessionToken || undefined };
    }
    const id = await new STSClient({ region: HOME, credentials: creds }).send(new GetCallerIdentityCommand({}));
    if (config.accountId && id.Account !== config.accountId) {
      throw new CheckError(`Credentials belong to account ${id.Account}, expected ${config.accountId}.`);
    }
    return { creds, accountId: id.Account!, arn: id.Arn!, configuredRegions: config.regions ?? [], memo };
  },

  async identity(ctx) {
    const probes: string[] = [];
    try {
      await new IAMClient(clientOpts(ctx)).send(new GetAccountSummaryCommand({}));
      probes.push('IAM read');
      const all = (await new EC2Client(clientOpts(ctx)).send(new DescribeRegionsCommand({ AllRegions: true }))).Regions ?? [];
      probes.push('EC2 read');
      // Configured regions must exist and be enabled, otherwise every regional check would silently skip them.
      const status = new Map(all.map((r) => [r.RegionName, r.OptInStatus]));
      const unknown = ctx.configuredRegions.filter((r) => !status.has(r));
      const disabled = ctx.configuredRegions.filter((r) => status.get(r) === 'not-opted-in');
      if (unknown.length || disabled.length) {
        const parts = [unknown.length ? `unknown region(s): ${unknown.join(', ')}` : '', disabled.length ? `region(s) not enabled for this account: ${disabled.join(', ')}` : ''].filter(Boolean);
        return {
          ok: false,
          message: `Connected to account ${ctx.accountId}, but the configured regions cannot be scanned (${parts.join('; ')}). Fix the region list or enable the regions in the AWS account.`,
          details: { accountId: ctx.accountId, arn: ctx.arn, probes, unknownRegions: unknown, disabledRegions: disabled },
        };
      }
    } catch (e: any) {
      return { ok: false, message: `Authenticated as ${ctx.arn}, but read permissions are missing (${e?.name}). Deploy the QuickScan read-only role (or attach SecurityAudit).` };
    }
    return { ok: true, message: `Connected to account ${ctx.accountId} as ${ctx.arn}.`, details: { accountId: ctx.accountId, arn: ctx.arn, probes } };
  },

  checks: guarded,
};

export { isAccessDenied };
