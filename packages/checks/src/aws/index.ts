import { AccessAnalyzerClient, ListAnalyzersCommand } from '@aws-sdk/client-accessanalyzer';
import { CloudTrailClient, DescribeTrailsCommand, GetTrailStatusCommand } from '@aws-sdk/client-cloudtrail';
import { ConfigServiceClient, DescribeConfigurationRecorderStatusCommand } from '@aws-sdk/client-config-service';
import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
  GetEbsEncryptionByDefaultCommand,
} from '@aws-sdk/client-ec2';
import { GuardDutyClient, GetDetectorCommand, ListDetectorsCommand } from '@aws-sdk/client-guardduty';
import {
  GenerateCredentialReportCommand,
  GetAccountPasswordPolicyCommand,
  GetAccountSummaryCommand,
  GetCredentialReportCommand,
  IAMClient,
  ListEntitiesForPolicyCommand,
} from '@aws-sdk/client-iam';
import { KMSClient, DescribeKeyCommand, GetKeyRotationStatusCommand, ListKeysCommand } from '@aws-sdk/client-kms';
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { GetBucketLocationCommand, GetBucketPolicyStatusCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { GetPublicAccessBlockCommand, S3ControlClient } from '@aws-sdk/client-s3-control';
import { DescribeHubCommand, SecurityHubClient } from '@aws-sdk/client-securityhub';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { CheckOutcome, ResourceRef } from '@qs/shared';
import type { ProviderModule } from '../types.js';
import { CheckError, fail, failIfAny, mapLimit, Memo, na, pass, sleep, warn } from '../util.js';

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

function isAccessDenied(e: any) {
  const n = String(e?.name ?? e?.Code ?? '');
  return /AccessDenied|UnauthorizedOperation|AuthorizationError/i.test(n);
}

async function regions(ctx: AwsCtx): Promise<string[]> {
  if (ctx.configuredRegions.length) return ctx.configuredRegions;
  return ctx.memo.get('regions', async () => {
    const r = await new EC2Client(clientOpts(ctx)).send(new DescribeRegionsCommand({ AllRegions: false }));
    return (r.Regions ?? []).map((x) => x.RegionName!).filter(Boolean).sort();
  });
}

/** Run fn per region; regions where the service is unavailable or not opted in are skipped. */
async function perRegion<T>(ctx: AwsCtx, fn: (region: string) => Promise<T>): Promise<{ region: string; value: T }[]> {
  const rs = await regions(ctx);
  const out = await mapLimit(rs, 5, async (region): Promise<{ region: string; value: T } | null> => {
    ctx.signal?.throwIfAborted();
    try {
      return { region, value: await fn(region) };
    } catch (e: any) {
      if (/UnrecognizedClient|InvalidClientTokenId|OptInRequired|SubscriptionRequired|EndpointError|ENOTFOUND/i.test(`${e?.name} ${e?.message}`)) return null;
      throw e;
    }
  });
  return out.filter((x): x is { region: string; value: T } => x !== null);
}

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

async function credentialReport(ctx: AwsCtx): Promise<CredRow[]> {
  return ctx.memo.get('credreport', async () => {
    const iam = new IAMClient(clientOpts(ctx));
    for (let i = 0; i < 20; i++) {
      const g = await iam.send(new GenerateCredentialReportCommand({}));
      if (g.State === 'COMPLETE') break;
      await sleep(1500);
    }
    const rep = await iam.send(new GetCredentialReportCommand({}));
    const csv = new TextDecoder().decode(rep.Content);
    const [header, ...lines] = csv.trim().split('\n');
    const cols = header.split(',');
    return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])) as unknown as CredRow);
  });
}

const DAY = 86_400_000;
const olderThan = (iso: string, days: number) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t > days * DAY;
};

const ADMIN_PORTS = [22, 3389, 3306, 5432, 1433, 1521, 27017, 6379, 9200, 5984, 23, 445];

const checks: Record<string, (ctx: AwsCtx) => Promise<CheckOutcome>> = {
  async 'aws.root-mfa'(ctx) {
    const s = await ctx.memo.get('summary', () => new IAMClient(clientOpts(ctx)).send(new GetAccountSummaryCommand({})));
    return s.SummaryMap?.AccountMFAEnabled === 1 ? pass('Root account has MFA enabled.') : fail('Root account does not have MFA enabled.', [{ id: `arn:aws:iam::${ctx.accountId}:root`, name: 'root' }]);
  },

  async 'aws.root-access-keys'(ctx) {
    const s = await ctx.memo.get('summary', () => new IAMClient(clientOpts(ctx)).send(new GetAccountSummaryCommand({})));
    return s.SummaryMap?.AccountAccessKeysPresent ? fail('Root account has active access keys.', [{ id: `arn:aws:iam::${ctx.accountId}:root`, name: 'root' }]) : pass('No root access keys present.');
  },

  async 'aws.iam-users-mfa'(ctx) {
    const rows = (await credentialReport(ctx)).filter((r) => r.user !== '<root_account>');
    const bad = rows.filter((r) => r.password_enabled === 'true' && r.mfa_active !== 'true');
    return failIfAny(
      bad.map((r) => ({ id: r.arn, name: r.user, detail: `last used ${r.password_last_used}` })),
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
          bad.push({ id: `${r.arn}#key${k}`, name: r.user, detail: `key ${k} rotated ${(r as any)[`access_key_${k}_last_rotated`].slice(0, 10)}` });
        }
      }
    }
    return failIfAny(bad, (n) => `${n} active access key(s) older than 90 days.`, 'All active access keys rotated within 90 days.');
  },

  async 'aws.iam-unused-credentials'(ctx) {
    const rows = (await credentialReport(ctx)).filter((r) => r.user !== '<root_account>');
    const bad: ResourceRef[] = [];
    for (const r of rows) {
      const reasons: string[] = [];
      if (r.password_enabled === 'true' && olderThan(r.user_creation_time, 90)) {
        if (r.password_last_used === 'no_information' || r.password_last_used === 'N/A' || olderThan(r.password_last_used, 90)) reasons.push('password unused 90+ days');
      }
      for (const k of [1, 2] as const) {
        const used = (r as any)[`access_key_${k}_last_used_date`];
        if ((r as any)[`access_key_${k}_active`] === 'true' && olderThan((r as any)[`access_key_${k}_last_rotated`], 90) && (used === 'N/A' || olderThan(used, 90))) {
          reasons.push(`access key ${k} unused 90+ days`);
        }
      }
      if (reasons.length) bad.push({ id: r.arn, name: r.user, detail: reasons.join(', ') });
    }
    return failIfAny(bad, (n) => `${n} user(s) with credentials unused for 90+ days.`, 'No unused credentials found.', 'warn');
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
    const r = await new IAMClient(clientOpts(ctx)).send(
      new ListEntitiesForPolicyCommand({ PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess', EntityFilter: 'User' }),
    );
    const users = r.PolicyUsers ?? [];
    return failIfAny(
      users.map((u) => ({ id: u.UserId!, name: u.UserName })),
      (n) => `${n} IAM user(s) have AdministratorAccess attached directly.`,
      'No IAM users have AdministratorAccess attached directly.',
    );
  },

  async 'aws.cloudtrail'(ctx) {
    const ct = new CloudTrailClient(clientOpts(ctx));
    const trails = (await ct.send(new DescribeTrailsCommand({ includeShadowTrails: true }))).trailList ?? [];
    const good: string[] = [];
    const issues: ResourceRef[] = [];
    for (const t of trails.filter((t) => t.IsMultiRegionTrail)) {
      const st = await new CloudTrailClient(clientOpts(ctx, t.HomeRegion ?? HOME)).send(new GetTrailStatusCommand({ Name: t.TrailARN }));
      const problems: string[] = [];
      if (!st.IsLogging) problems.push('not logging');
      if (!t.LogFileValidationEnabled) problems.push('log file validation disabled');
      if (problems.length) issues.push({ id: t.TrailARN!, name: t.Name, detail: problems.join(', ') });
      else good.push(t.Name!);
    }
    if (good.length) return pass(`Multi-region trail(s) active with validation: ${good.join(', ')}.`, { resources: issues });
    if (issues.length) return warn('Multi-region trail exists but is not fully configured.', issues);
    return fail('No multi-region CloudTrail trail found.');
  },

  async 'aws.guardduty'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const gd = new GuardDutyClient(clientOpts(ctx, region));
      const ids = (await gd.send(new ListDetectorsCommand({}))).DetectorIds ?? [];
      if (!ids.length) return false;
      const d = await gd.send(new GetDetectorCommand({ DetectorId: ids[0] }));
      return d.Status === 'ENABLED';
    });
    const off = res.filter((r) => !r.value).map((r) => ({ id: r.region, name: r.region }));
    if (off.length === res.length) return fail('GuardDuty is not enabled in any region.', off);
    return failIfAny(off, (n) => `GuardDuty disabled in ${n} of ${res.length} regions.`, `GuardDuty enabled in all ${res.length} regions.`, 'warn');
  },

  async 'aws.securityhub'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      try {
        await new SecurityHubClient(clientOpts(ctx, region)).send(new DescribeHubCommand({}));
        return true;
      } catch (e: any) {
        if (/InvalidAccessException|ResourceNotFound/i.test(e?.name)) return false;
        throw e;
      }
    });
    const off = res.filter((r) => !r.value).map((r) => ({ id: r.region, name: r.region }));
    if (off.length === res.length) return fail('Security Hub is not enabled in any region.');
    return failIfAny(off, (n) => `Security Hub disabled in ${n} of ${res.length} regions.`, 'Security Hub enabled in all regions.', 'warn');
  },

  async 'aws.config'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const st = await new ConfigServiceClient(clientOpts(ctx, region)).send(new DescribeConfigurationRecorderStatusCommand({}));
      return (st.ConfigurationRecordersStatus ?? []).some((r) => r.recording);
    });
    const off = res.filter((r) => !r.value).map((r) => ({ id: r.region, name: r.region }));
    if (off.length === res.length) return fail('AWS Config is not recording in any region.');
    return failIfAny(off, (n) => `AWS Config not recording in ${n} of ${res.length} regions.`, 'AWS Config recording in all regions.', 'warn');
  },

  async 'aws.s3-account-bpa'(ctx) {
    try {
      const r = await new S3ControlClient(clientOpts(ctx)).send(new GetPublicAccessBlockCommand({ AccountId: ctx.accountId }));
      const c = r.PublicAccessBlockConfiguration ?? {};
      const all = c.BlockPublicAcls && c.IgnorePublicAcls && c.BlockPublicPolicy && c.RestrictPublicBuckets;
      return all ? pass('All four account-level Block Public Access settings are on.') : warn('Account-level Block Public Access is only partially enabled.', [], { configuration: c });
    } catch (e: any) {
      if (/NoSuchPublicAccessBlockConfiguration/.test(e?.name)) return fail('Account-level S3 Block Public Access is not configured.');
      throw e;
    }
  },

  async 'aws.s3-public-buckets'(ctx) {
    const buckets = (await new S3Client(clientOpts(ctx)).send(new ListBucketsCommand({}))).Buckets ?? [];
    if (!buckets.length) return na('No S3 buckets in this account.');
    const pub: ResourceRef[] = [];
    let unknown = 0;
    await mapLimit(buckets, 8, async (b) => {
      try {
        const loc = await new S3Client(clientOpts(ctx)).send(new GetBucketLocationCommand({ Bucket: b.Name }));
        const region = loc.LocationConstraint || HOME;
        const st = await new S3Client(clientOpts(ctx, region === 'EU' ? 'eu-west-1' : region)).send(new GetBucketPolicyStatusCommand({ Bucket: b.Name }));
        if (st.PolicyStatus?.IsPublic) pub.push({ id: `arn:aws:s3:::${b.Name}`, name: b.Name, detail: region });
      } catch (e: any) {
        if (!/NoSuchBucketPolicy/.test(e?.name)) unknown++;
      }
    });
    if (pub.length) return fail(`${pub.length} of ${buckets.length} buckets are public via bucket policy.`, pub);
    return pass(`None of ${buckets.length} buckets are public via bucket policy${unknown ? ` (${unknown} could not be evaluated)` : ''}.`);
  },

  async 'aws.ebs-encryption'(ctx) {
    const res = await perRegion(ctx, async (region) => (await new EC2Client(clientOpts(ctx, region)).send(new GetEbsEncryptionByDefaultCommand({}))).EbsEncryptionByDefault);
    const off = res.filter((r) => !r.value).map((r) => ({ id: r.region, name: r.region }));
    return failIfAny(off, (n) => `EBS encryption by default disabled in ${n} of ${res.length} regions.`, 'EBS encryption by default enabled in all regions.', 'warn');
  },

  async 'aws.sg-admin-ports'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const ec2 = new EC2Client(clientOpts(ctx, region));
      const out: ResourceRef[] = [];
      let token: string | undefined;
      do {
        const r = await ec2.send(new DescribeSecurityGroupsCommand({ NextToken: token, MaxResults: 1000 }));
        for (const sg of r.SecurityGroups ?? []) {
          for (const p of sg.IpPermissions ?? []) {
            const open = (p.IpRanges ?? []).some((x) => x.CidrIp === '0.0.0.0/0') || (p.Ipv6Ranges ?? []).some((x) => x.CidrIpv6 === '::/0');
            if (!open) continue;
            const all = p.IpProtocol === '-1';
            const ports = ADMIN_PORTS.filter((port) => all || ((p.FromPort ?? 0) <= port && port <= (p.ToPort ?? 65535)));
            if (ports.length) out.push({ id: sg.GroupId!, name: `${sg.GroupName} (${region})`, detail: all ? 'all traffic open' : `ports ${ports.join(', ')}` });
          }
        }
        token = r.NextToken;
        ctx.signal?.throwIfAborted();
      } while (token);
      return out;
    });
    const bad = res.flatMap((r) => r.value);
    return failIfAny(bad, (n) => `${n} security group rule(s) expose admin/database ports to the internet.`, 'No security groups expose admin ports to the internet.');
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
            out.push({ id: i.InstanceId!, name: i.Tags?.find((t) => t.Key === 'Name')?.Value, detail: region });
          }
        }
        token = r.NextToken;
        ctx.signal?.throwIfAborted();
      } while (token);
      return { out, total };
    });
    const total = res.reduce((a, r) => a + r.value.total, 0);
    if (!total) return na('No EC2 instances found.');
    const bad = res.flatMap((r) => r.value.out);
    return failIfAny(bad, (n) => `${n} of ${total} instances allow IMDSv1.`, `All ${total} instances require IMDSv2.`);
  },

  async 'aws.rds-public'(ctx) {
    const dbs = await rdsInstances(ctx);
    if (!dbs.length) return na('No RDS instances found.');
    return failIfAny(
      dbs.filter((d) => d.db.PubliclyAccessible).map((d) => ({ id: d.db.DBInstanceArn!, name: d.db.DBInstanceIdentifier, detail: d.region })),
      (n) => `${n} RDS instance(s) are publicly accessible.`,
      `None of ${dbs.length} RDS instances are publicly accessible.`,
    );
  },

  async 'aws.rds-encryption'(ctx) {
    const dbs = await rdsInstances(ctx);
    if (!dbs.length) return na('No RDS instances found.');
    return failIfAny(
      dbs.filter((d) => !d.db.StorageEncrypted).map((d) => ({ id: d.db.DBInstanceArn!, name: d.db.DBInstanceIdentifier, detail: d.region })),
      (n) => `${n} RDS instance(s) without storage encryption.`,
      `All ${dbs.length} RDS instances are encrypted.`,
    );
  },

  async 'aws.rds-backup'(ctx) {
    const dbs = await rdsInstances(ctx);
    if (!dbs.length) return na('No RDS instances found.');
    return failIfAny(
      dbs
        .filter((d) => (d.db.BackupRetentionPeriod ?? 0) < 7)
        .map((d) => ({ id: d.db.DBInstanceArn!, name: d.db.DBInstanceIdentifier, detail: `retention ${d.db.BackupRetentionPeriod ?? 0} days` })),
      (n) => `${n} RDS instance(s) keep backups for less than 7 days.`,
      `All ${dbs.length} RDS instances retain backups for 7+ days.`,
      'warn',
    );
  },

  async 'aws.kms-rotation'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const kms = new KMSClient(clientOpts(ctx, region));
      const out: ResourceRef[] = [];
      let total = 0;
      let marker: string | undefined;
      do {
        const r = await kms.send(new ListKeysCommand({ Marker: marker }));
        for (const k of r.Keys ?? []) {
          try {
            const d = (await kms.send(new DescribeKeyCommand({ KeyId: k.KeyId }))).KeyMetadata!;
            if (d.KeyManager !== 'CUSTOMER' || d.KeyState !== 'Enabled' || d.KeySpec !== 'SYMMETRIC_DEFAULT' || d.Origin !== 'AWS_KMS') continue;
            total++;
            const rot = await kms.send(new GetKeyRotationStatusCommand({ KeyId: k.KeyId }));
            if (!rot.KeyRotationEnabled) out.push({ id: d.Arn!, name: d.Description || k.KeyId, detail: region });
          } catch (e) {
            if (!isAccessDenied(e)) throw e;
          }
        }
        marker = r.Truncated ? r.NextMarker : undefined;
        ctx.signal?.throwIfAborted();
      } while (marker);
      return { out, total };
    });
    const total = res.reduce((a, r) => a + r.value.total, 0);
    if (!total) return na('No customer managed symmetric KMS keys found.');
    return failIfAny(res.flatMap((r) => r.value.out), (n) => `${n} of ${total} customer managed keys without rotation.`, `All ${total} customer managed keys rotate automatically.`, 'warn');
  },

  async 'aws.access-analyzer'(ctx) {
    const res = await perRegion(ctx, async (region) => {
      const r = await new AccessAnalyzerClient(clientOpts(ctx, region)).send(new ListAnalyzersCommand({}));
      return (r.analyzers ?? []).some((a) => a.status === 'ACTIVE');
    });
    const off = res.filter((r) => !r.value).map((r) => ({ id: r.region, name: r.region }));
    if (off.length === res.length) return fail('IAM Access Analyzer is not enabled in any region.');
    return failIfAny(off, (n) => `Access Analyzer missing in ${n} of ${res.length} regions.`, 'Access Analyzer active in all regions.', 'warn');
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
    return res.flatMap((r) => r.value.map((db) => ({ region: r.region, db })));
  });
}

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
      await new EC2Client(clientOpts(ctx)).send(new DescribeRegionsCommand({}));
      probes.push('EC2 read');
    } catch (e: any) {
      return { ok: false, message: `Authenticated as ${ctx.arn}, but read permissions are missing (${e?.name}). Deploy the QuickScan read-only role (or attach SecurityAudit).` };
    }
    return { ok: true, message: `Connected to account ${ctx.accountId} as ${ctx.arn}.`, details: { accountId: ctx.accountId, arn: ctx.arn, probes } };
  },

  checks,
};

export { isAccessDenied };
