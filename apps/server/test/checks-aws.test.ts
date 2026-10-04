import { AccessAnalyzerClient } from '@aws-sdk/client-accessanalyzer';
import { BackupClient } from '@aws-sdk/client-backup';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { ConfigServiceClient } from '@aws-sdk/client-config-service';
import { EC2Client } from '@aws-sdk/client-ec2';
import { GuardDutyClient } from '@aws-sdk/client-guardduty';
import { IAMClient } from '@aws-sdk/client-iam';
import { Inspector2Client } from '@aws-sdk/client-inspector2';
import { KMSClient } from '@aws-sdk/client-kms';
import { RDSClient } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { S3ControlClient } from '@aws-sdk/client-s3-control';
import { SecurityHubClient } from '@aws-sdk/client-securityhub';
import { STSClient } from '@aws-sdk/client-sts';
import { runSystem } from '@qs/checks';
import type { CheckOutcome } from '@qs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ACC = '111122223333';
const CLIENTS = [
  STSClient,
  EC2Client,
  IAMClient,
  KMSClient,
  RDSClient,
  S3Client,
  S3ControlClient,
  CloudTrailClient,
  SecurityHubClient,
  ConfigServiceClient,
  BackupClient,
  Inspector2Client,
  GuardDutyClient,
  AccessAnalyzerClient,
] as any[];

type Handler = (command: string, input: any, region: string, client: string) => unknown;

/** Route AWS SDK calls to a handler (command name, input, region, client class name). */
function mockAws(handler: Handler) {
  for (const C of CLIENTS) {
    vi.spyOn(C.prototype, 'send').mockImplementation(async function (this: any, cmd: any) {
      const r = this.config.region;
      const region = typeof r === 'function' ? await r() : r;
      if (cmd.constructor.name === 'GetCallerIdentityCommand') return { Account: ACC, Arn: `arn:aws:sts::${ACC}:assumed-role/SecurityQuickScanReadOnly/session` };
      return handler(cmd.constructor.name, cmd.input, region, C.name);
    });
  }
}

const awsError = (name: string) => Object.assign(new Error(name), { name });
const SECRET = { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'x'.repeat(40) };
const CONFIG = { authMode: 'access_keys', regions: ['eu-west-1'] };

async function run(checkIds: string[], handler: Handler, config: unknown = CONFIG) {
  mockAws(handler);
  const out: Record<string, CheckOutcome> = {};
  await runSystem({
    systemId: '00000000-0000-0000-0000-000000000001',
    provider: 'aws',
    config,
    secret: SECRET,
    checkIds,
    env: {},
    onStart: async () => {},
    onResult: async (id, o) => {
      out[id] = o;
    },
    shouldStop: async () => false,
  });
  return out;
}

const doc = (statement: unknown) => encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: statement }));
const STAR = doc([{ Effect: 'Allow', Action: '*', Resource: '*' }]);
const READ_ONLY = doc([{ Effect: 'Allow', Action: ['s3:Get*'], Resource: '*' }]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('aws.iam-admin-users', () => {
  const details = {
    UserDetailList: [
      { UserName: 'alice', Arn: `arn:aws:iam::${ACC}:user/alice`, GroupList: ['admins'], AttachedManagedPolicies: [], UserPolicyList: [] },
      { UserName: 'bob', Arn: `arn:aws:iam::${ACC}:user/bob`, GroupList: [], AttachedManagedPolicies: [], UserPolicyList: [{ PolicyName: 'everything', PolicyDocument: STAR }] },
      { UserName: 'carol', Arn: `arn:aws:iam::${ACC}:user/carol`, GroupList: ['readers'], AttachedManagedPolicies: [], UserPolicyList: [{ PolicyName: 'ro', PolicyDocument: READ_ONLY }] },
    ],
    GroupDetailList: [
      { GroupName: 'admins', Arn: `arn:aws:iam::${ACC}:group/admins`, AttachedManagedPolicies: [{ PolicyName: 'AdministratorAccess', PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }], GroupPolicyList: [] },
      { GroupName: 'readers', Arn: `arn:aws:iam::${ACC}:group/readers`, AttachedManagedPolicies: [], GroupPolicyList: [] },
    ],
    RoleDetailList: [
      { RoleName: 'deploy', Path: '/', Arn: `arn:aws:iam::${ACC}:role/deploy`, AttachedManagedPolicies: [{ PolicyName: 'full-power', PolicyArn: `arn:aws:iam::${ACC}:policy/full-power` }], RolePolicyList: [] },
      { RoleName: 'AWSServiceRoleForSupport', Path: '/aws-service-role/support.amazonaws.com/', Arn: `arn:aws:iam::${ACC}:role/aws-service-role/support.amazonaws.com/AWSServiceRoleForSupport`, AttachedManagedPolicies: [{ PolicyName: 'AdministratorAccess', PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }], RolePolicyList: [] },
      { RoleName: 'SecurityQuickScanReadOnly', Path: '/', Arn: `arn:aws:iam::${ACC}:role/SecurityQuickScanReadOnly`, AttachedManagedPolicies: [], RolePolicyList: [{ PolicyName: 'x', PolicyDocument: STAR }] },
    ],
    Policies: [{ PolicyName: 'full-power', Arn: `arn:aws:iam::${ACC}:policy/full-power`, PolicyVersionList: [{ IsDefaultVersion: true, Document: STAR }] }],
    IsTruncated: false,
  };

  it('detects admin via group, inline *:* and roles, skipping service-linked and scanner roles', async () => {
    const r = await run(['aws.iam-admin-users'], (c) => (c === 'GetAccountAuthorizationDetailsCommand' ? details : undefined));
    const o = r['aws.iam-admin-users'];
    expect(o.status).toBe('fail');
    const ids = (o.resources ?? []).map((x) => x.id);
    expect(ids).toContain(`arn:aws:iam::${ACC}:user/alice`);
    expect(ids).toContain(`arn:aws:iam::${ACC}:user/bob`);
    expect(ids).toContain(`arn:aws:iam::${ACC}:role/deploy`);
    expect(ids).not.toContain(`arn:aws:iam::${ACC}:user/carol`);
    expect(ids.some((i) => i.includes('AWSServiceRoleForSupport'))).toBe(false);
    expect(ids.some((i) => i.includes('SecurityQuickScanReadOnly'))).toBe(false);
    const alice = o.resources!.find((x) => x.id.endsWith('user/alice'))!;
    expect(alice.detail).toContain('via group admins');
    expect(alice.url).toContain('console.aws.amazon.com/iam');
    expect(alice.account).toBe(ACC);
    expect(o.resources!.find((x) => x.id.endsWith('user/bob'))!.detail).toContain('inline policy everything');
  });

  it('warns when only a role uses a customer-managed *:* policy', async () => {
    const onlyRole = { ...details, UserDetailList: [details.UserDetailList[2]] };
    const r = await run(['aws.iam-admin-users'], (c) => (c === 'GetAccountAuthorizationDetailsCommand' ? onlyRole : undefined));
    expect(r['aws.iam-admin-users'].status).toBe('warn');
    expect(r['aws.iam-admin-users'].resources?.[0].id).toBe(`arn:aws:iam::${ACC}:role/deploy`);
  });

  it('reports a missing new permission as error, not fail', async () => {
    const r = await run(['aws.iam-admin-users'], (c) => {
      if (c === 'GetAccountAuthorizationDetailsCommand') throw awsError('AccessDenied');
      return undefined;
    });
    expect(r['aws.iam-admin-users'].status).toBe('error');
    expect(r['aws.iam-admin-users'].summary).toContain('update the read-only role (new permission iam:GetAccountAuthorizationDetails)');
  });
});

describe('aws.cloudtrail', () => {
  const trail = (extra: Record<string, unknown> = {}) => ({
    Name: 'main',
    TrailARN: `arn:aws:cloudtrail:eu-west-1:${ACC}:trail/main`,
    HomeRegion: 'eu-west-1',
    IsMultiRegionTrail: true,
    LogFileValidationEnabled: true,
    KmsKeyId: `arn:aws:kms:eu-west-1:${ACC}:key/k`,
    CloudWatchLogsLogGroupArn: `arn:aws:logs:eu-west-1:${ACC}:log-group:ct:*`,
    HasCustomEventSelectors: true,
    ...extra,
  });

  it('fails when the only trail does not log all management events', async () => {
    const r = await run(['aws.cloudtrail'], (c) => {
      if (c === 'DescribeTrailsCommand') return { trailList: [trail()] };
      if (c === 'GetTrailStatusCommand') return { IsLogging: true };
      if (c === 'GetEventSelectorsCommand') return { EventSelectors: [{ IncludeManagementEvents: true, ReadWriteType: 'WriteOnly' }] };
      return undefined;
    });
    expect(r['aws.cloudtrail'].status).toBe('fail');
    expect(r['aws.cloudtrail'].resources?.[0].detail).toContain('management events');
  });

  it('fails with only data-event advanced selectors, passes with full management events', async () => {
    const data = await run(['aws.cloudtrail'], (c) => {
      if (c === 'DescribeTrailsCommand') return { trailList: [trail()] };
      if (c === 'GetTrailStatusCommand') return { IsLogging: true };
      if (c === 'GetEventSelectorsCommand') return { AdvancedEventSelectors: [{ FieldSelectors: [{ Field: 'eventCategory', Equals: ['Data'] }] }] };
      return undefined;
    });
    expect(data['aws.cloudtrail'].status).toBe('fail');
    const good = await run(['aws.cloudtrail'], (c) => {
      if (c === 'DescribeTrailsCommand') return { trailList: [trail()] };
      if (c === 'GetTrailStatusCommand') return { IsLogging: true };
      if (c === 'GetEventSelectorsCommand') return { AdvancedEventSelectors: [{ FieldSelectors: [{ Field: 'eventCategory', Equals: ['Management'] }] }] };
      return undefined;
    });
    expect(good['aws.cloudtrail'].status).toBe('pass');
  });

  it('warns when KMS and CloudWatch Logs are missing, and evaluates an organisation trail from its fields', async () => {
    const r = await run(['aws.cloudtrail'], (c) => {
      if (c === 'DescribeTrailsCommand') {
        return {
          trailList: [
            trail({ TrailARN: `arn:aws:cloudtrail:eu-west-1:999988887777:trail/org`, Name: 'org', IsOrganizationTrail: true, HasCustomEventSelectors: false, KmsKeyId: undefined, CloudWatchLogsLogGroupArn: undefined }),
          ],
        };
      }
      if (c === 'GetTrailStatusCommand') throw awsError('TrailNotFoundException');
      return undefined;
    });
    expect(r['aws.cloudtrail'].status).toBe('warn');
    expect(r['aws.cloudtrail'].summary).toContain('KMS');
  });
});

describe('aws.s3-public-buckets', () => {
  const s3 = (opts: { bucketBpa?: Record<string, boolean> }) => (c: string, input: any) => {
    if (c === 'ListBucketsCommand') return { Buckets: [{ Name: 'open-data', BucketRegion: 'eu-west-1' }] };
    if (c === 'GetPublicAccessBlockCommand') {
      if (input.AccountId) throw awsError('NoSuchPublicAccessBlockConfiguration');
      if (opts.bucketBpa) return { PublicAccessBlockConfiguration: opts.bucketBpa };
      throw awsError('NoSuchPublicAccessBlockConfiguration');
    }
    if (c === 'GetBucketPolicyStatusCommand') throw awsError('NoSuchBucketPolicy');
    if (c === 'GetBucketAclCommand') return { Grants: [{ Grantee: { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AllUsers' }, Permission: 'READ' }] };
    return undefined;
  };

  it('fails on a bucket made public by its ACL', async () => {
    const r = await run(['aws.s3-public-buckets'], s3({}));
    const o = r['aws.s3-public-buckets'];
    expect(o.status).toBe('fail');
    expect(o.resources?.[0].id).toBe('arn:aws:s3:::open-data');
    expect(o.resources?.[0].detail).toContain('ACL');
    expect(o.resources?.[0].region).toBe('eu-west-1');
    expect(o.resources?.[0].url).toContain('s3.console.aws.amazon.com');
  });

  it('passes when bucket-level Block Public Access ignores public ACLs', async () => {
    const r = await run(['aws.s3-public-buckets'], s3({ bucketBpa: { IgnorePublicAcls: true, RestrictPublicBuckets: true } }));
    expect(r['aws.s3-public-buckets'].status).toBe('pass');
  });

  it('reports a denied GetBucketAcl as error, not fail', async () => {
    const r = await run(['aws.s3-public-buckets'], (c, input) => {
      if (c === 'GetBucketAclCommand') throw awsError('AccessDenied');
      return s3({})(c, input);
    });
    expect(r['aws.s3-public-buckets'].status).toBe('error');
    expect(r['aws.s3-public-buckets'].summary).toContain('new permission s3:GetBucketAcl');
  });
});

describe('aws.rds-backup', () => {
  it('skips read replicas', async () => {
    const r = await run(['aws.rds-backup'], (c) => {
      if (c === 'DescribeDBInstancesCommand') {
        return {
          DBInstances: [
            { DBInstanceIdentifier: 'db', DBInstanceArn: `arn:aws:rds:eu-west-1:${ACC}:db:db`, BackupRetentionPeriod: 7 },
            { DBInstanceIdentifier: 'db-replica', DBInstanceArn: `arn:aws:rds:eu-west-1:${ACC}:db:db-replica`, BackupRetentionPeriod: 0, ReadReplicaSourceDBInstanceIdentifier: 'db' },
          ],
        };
      }
      return undefined;
    });
    expect(r['aws.rds-backup'].status).toBe('pass');
    expect(r['aws.rds-backup'].summary).toContain('1 read replica(s) skipped');
  });
});

describe('aws network checks', () => {
  it('fails when a default security group has rules', async () => {
    const r = await run(['aws.default-sg-closed'], (c) => {
      if (c === 'DescribeSecurityGroupsCommand') {
        return {
          SecurityGroups: [
            { GroupId: 'sg-1', GroupName: 'default', VpcId: 'vpc-1', IpPermissions: [{ IpProtocol: '-1', UserIdGroupPairs: [{ GroupId: 'sg-1' }] }], IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] },
            { GroupId: 'sg-2', GroupName: 'default', VpcId: 'vpc-2', IpPermissions: [], IpPermissionsEgress: [] },
          ],
        };
      }
      return undefined;
    });
    const o = r['aws.default-sg-closed'];
    expect(o.status).toBe('fail');
    expect(o.resources).toHaveLength(1);
    expect(o.resources?.[0].id).toBe(`arn:aws:ec2:eu-west-1:${ACC}:security-group/sg-1`);
  });

  it('de-duplicates admin port rules per group and flags broad ranges', async () => {
    const r = await run(['aws.sg-admin-ports'], (c) => {
      if (c === 'DescribeSecurityGroupsCommand') {
        return {
          SecurityGroups: [
            {
              GroupId: 'sg-a',
              GroupName: 'app',
              IpPermissions: [
                { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
                { IpProtocol: 'tcp', FromPort: 3389, ToPort: 3389, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
              ],
            },
            { GroupId: 'sg-b', GroupName: 'office', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '203.0.113.0/24' }] }] },
          ],
        };
      }
      return undefined;
    });
    const o = r['aws.sg-admin-ports'];
    expect(o.status).toBe('fail');
    expect(o.resources).toHaveLength(1);
    expect(o.resources?.[0].detail).toContain('22, 3389');
    expect(o.resources?.[0].detail).toContain('10.0.0.0/8');
  });

  it('reports a denied DescribeVpcs in every region as error with the permission to add', async () => {
    const r = await run(['aws.vpc-flow-logs'], (c) => {
      if (c === 'DescribeVpcsCommand') throw awsError('UnauthorizedOperation');
      return undefined;
    });
    expect(r['aws.vpc-flow-logs'].status).toBe('error');
    expect(r['aws.vpc-flow-logs'].summary).toContain('update the read-only role (new permission ec2:DescribeVpcs)');
  });

  it('flags VPCs without flow logs', async () => {
    const r = await run(['aws.vpc-flow-logs'], (c) => {
      if (c === 'DescribeVpcsCommand') return { Vpcs: [{ VpcId: 'vpc-1' }, { VpcId: 'vpc-2', IsDefault: true }] };
      if (c === 'DescribeFlowLogsCommand') return { FlowLogs: [{ ResourceId: 'vpc-1', FlowLogStatus: 'ACTIVE' }] };
      return undefined;
    });
    expect(r['aws.vpc-flow-logs'].status).toBe('fail');
    expect(r['aws.vpc-flow-logs'].resources?.map((x) => x.id)).toEqual([`arn:aws:ec2:eu-west-1:${ACC}:vpc/vpc-2`]);
  });
});

describe('aws.public-snapshots', () => {
  it('fails on a public EBS snapshot and a public RDS snapshot', async () => {
    const r = await run(['aws.public-snapshots'], (c, input) => {
      if (c === 'DescribeSnapshotsCommand') {
        expect(input.RestorableByUserIds).toEqual(['all']);
        return { Snapshots: [{ SnapshotId: 'snap-1', VolumeId: 'vol-1' }] };
      }
      if (c === 'DescribeImagesCommand') return { Images: [] };
      if (c === 'DescribeDBSnapshotsCommand') return { DBSnapshots: [{ DBSnapshotIdentifier: 'rs1' }, { DBSnapshotIdentifier: 'rs2' }] };
      if (c === 'DescribeDBSnapshotAttributesCommand') {
        return { DBSnapshotAttributesResult: { DBSnapshotAttributes: [{ AttributeName: 'restore', AttributeValues: input.DBSnapshotIdentifier === 'rs1' ? ['all'] : ['444455556666'] }] } };
      }
      if (c === 'DescribeDBClusterSnapshotsCommand') return { DBClusterSnapshots: [] };
      return undefined;
    });
    const o = r['aws.public-snapshots'];
    expect(o.status).toBe('fail');
    expect(o.resources?.map((x) => x.id).sort()).toEqual([`arn:aws:ec2:eu-west-1::snapshot/snap-1`, `arn:aws:rds:eu-west-1:${ACC}:snapshot:rs1`]);
  });

  it('warns (never passes) when part of the sources is denied, errors when all are', async () => {
    const partial = await run(['aws.public-snapshots'], (c) => {
      if (c === 'DescribeSnapshotsCommand') return { Snapshots: [] };
      if (c === 'DescribeImagesCommand') return { Images: [] };
      if (c.startsWith('DescribeDB')) throw awsError('AccessDenied');
      return undefined;
    });
    expect(partial['aws.public-snapshots'].status).toBe('warn');
    expect(partial['aws.public-snapshots'].summary).toContain('rds:DescribeDBSnapshots');
    const none = await run(['aws.public-snapshots'], () => {
      throw awsError('AccessDenied');
    });
    expect(none['aws.public-snapshots'].status).toBe('error');
  });
});

describe('IAM credential report', () => {
  it('parses a quoted CSV with CRLF and waits for COMPLETE', async () => {
    const csv = [
      'user,arn,user_creation_time,password_enabled,password_last_used,password_last_changed,password_next_rotation,mfa_active,access_key_1_active,access_key_1_last_rotated,access_key_1_last_used_date,access_key_2_active,access_key_2_last_rotated,access_key_2_last_used_date',
      `"<root_account>","arn:aws:iam::${ACC}:root","2020-01-01T00:00:00+00:00","not_supported","2026-01-01T00:00:00+00:00","not_supported","not_supported","true","false","N/A","N/A","false","N/A","N/A"`,
      `"dave","arn:aws:iam::${ACC}:user/dave","2024-01-01T00:00:00+00:00","true","2026-09-01T00:00:00+00:00","N/A","note, with ""comma""","false","false","N/A","N/A","false","N/A","N/A"`,
      `"erin","arn:aws:iam::${ACC}:user/erin","2024-01-01T00:00:00+00:00","true","2026-09-01T00:00:00+00:00","N/A","N/A","true","false","N/A","N/A","false","N/A","N/A"`,
    ].join('\r\n');
    let generated = 0;
    const r = await run(['aws.iam-users-mfa'], (c) => {
      if (c === 'GenerateCredentialReportCommand') return { State: ++generated < 2 ? 'STARTED' : 'COMPLETE' };
      if (c === 'GetCredentialReportCommand') return { Content: new TextEncoder().encode(csv) };
      return undefined;
    });
    const o = r['aws.iam-users-mfa'];
    expect(generated).toBe(2);
    expect(o.status).toBe('fail');
    expect(o.resources?.map((x) => x.id)).toEqual([`arn:aws:iam::${ACC}:user/dave`]);
    expect(o.summary).toBe('1 console user(s) without MFA.');
  });
});

describe('aws.root-mfa', () => {
  it('passes with centralised root access and warns on a virtual root MFA device', async () => {
    const central = await run(['aws.root-mfa'], (c) => {
      if (c === 'GetAccountSummaryCommand') return { SummaryMap: { AccountMFAEnabled: 0, AccountPasswordPresent: 0, AccountAccessKeysPresent: 0 } };
      if (c === 'GenerateCredentialReportCommand') return { State: 'COMPLETE' };
      if (c === 'GetCredentialReportCommand') return { Content: new TextEncoder().encode('user,arn\n') };
      return undefined;
    });
    expect(central['aws.root-mfa'].status).toBe('pass');
    const virtual = await run(['aws.root-mfa'], (c) => {
      if (c === 'GetAccountSummaryCommand') return { SummaryMap: { AccountMFAEnabled: 1, AccountPasswordPresent: 1 } };
      if (c === 'ListVirtualMFADevicesCommand') return { VirtualMFADevices: [{ SerialNumber: `arn:aws:iam::${ACC}:mfa/root-account-mfa-device`, User: { Arn: `arn:aws:iam::${ACC}:root` } }] };
      if (c === 'GenerateCredentialReportCommand') return { State: 'COMPLETE' };
      if (c === 'GetCredentialReportCommand') return { Content: new TextEncoder().encode('user,arn\n') };
      return undefined;
    });
    expect(virtual['aws.root-mfa'].status).toBe('warn');
    expect(virtual['aws.root-mfa'].summary).toContain('hardware');
  });
});

describe('aws.securityhub-findings and aws.ebs-encryption', () => {
  it('summarises failed critical/high findings by control and de-duplicates them', async () => {
    const f = (id: string, control: string, label: string) => ({ Id: id, Title: `${control} title`, Region: 'eu-west-1', Compliance: { SecurityControlId: control }, Severity: { Label: label }, Resources: [{ Id: `res-${id}` }] });
    const r = await run(['aws.securityhub-findings'], (c) => {
      if (c === 'GetFindingsCommand') return { Findings: [f('1', 'S3.8', 'CRITICAL'), f('2', 'S3.8', 'HIGH'), f('3', 'EC2.19', 'HIGH'), f('1', 'S3.8', 'CRITICAL')] };
      return undefined;
    });
    const o = r['aws.securityhub-findings'];
    expect(o.status).toBe('fail');
    expect(o.resources).toHaveLength(2);
    expect(o.resources?.[0].name).toContain('S3.8');
    expect(o.summary).toContain('3 active critical/high failed findings across 2 control(s) (1 critical)');
  });

  it('fails EBS default encryption when it is off in every region', async () => {
    const r = await run(['aws.ebs-encryption'], (c) => (c === 'GetEbsEncryptionByDefaultCommand' ? { EbsEncryptionByDefault: false } : undefined), { ...CONFIG, regions: ['eu-west-1', 'eu-central-1'] });
    expect(r['aws.ebs-encryption'].status).toBe('fail');
  });
});
