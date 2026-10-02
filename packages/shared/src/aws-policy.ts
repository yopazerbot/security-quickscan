/**
 * Exact read-only AWS actions used by the checks (least privilege for the customer role).
 * Keep in sync with packages/checks/src/aws and infra/aws-scanner-role.yaml (a unit test verifies this).
 * Note: iam:GenerateCredentialReport only (re)generates IAM's own credential report; it changes no configuration.
 */
export const AWS_SCANNER_ACTIONS = [
  'access-analyzer:ListAnalyzers',
  'cloudtrail:DescribeTrails',
  'cloudtrail:GetTrailStatus',
  'config:DescribeConfigurationRecorderStatus',
  'ec2:DescribeInstances',
  'ec2:DescribeRegions',
  'ec2:DescribeSecurityGroups',
  'ec2:GetEbsEncryptionByDefault',
  'guardduty:GetDetector',
  'guardduty:ListDetectors',
  'iam:GenerateCredentialReport',
  'iam:GetAccountPasswordPolicy',
  'iam:GetAccountSummary',
  'iam:GetCredentialReport',
  'iam:ListEntitiesForPolicy',
  'kms:DescribeKey',
  'kms:GetKeyRotationStatus',
  'kms:ListKeys',
  'rds:DescribeDBInstances',
  's3:GetAccountPublicAccessBlock',
  's3:GetBucketLocation',
  's3:GetBucketPolicyStatus',
  's3:ListAllMyBuckets',
  'securityhub:DescribeHub',
] as const;
