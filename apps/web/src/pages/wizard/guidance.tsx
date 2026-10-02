import { AWS_SCANNER_ACTIONS } from '@qs/shared';
import type { ReactNode } from 'react';
import { CodeBlock } from '../../components/ui';

export const GRAPH_PERMISSIONS = [
  'Directory.Read.All',
  'Policy.Read.All',
  'RoleManagement.Read.Directory',
  'AuditLog.Read.All',
  'Application.Read.All',
  'Reports.Read.All',
  'SecurityEvents.Read.All',
];

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-3 text-sm text-slate-700 [counter-reset:step]">{children}</ol>;
}

export function Step({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative pl-9 [counter-increment:step] before:absolute before:left-0 before:top-0 before:flex before:size-6 before:items-center before:justify-center before:rounded-full before:bg-brand-100 before:text-xs before:font-semibold before:text-brand-700 before:content-[counter(step)]">
      <div className="font-medium text-slate-900">{title}</div>
      {children && <div className="mt-1 space-y-2 text-slate-600">{children}</div>}
    </li>
  );
}

const Perms = ({ list }: { list: string[] }) => (
  <div className="flex flex-wrap gap-1.5">
    {list.map((p) => (
      <code key={p} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
        {p}
      </code>
    ))}
  </div>
);

export function cloudFormation(principal: string, externalId: string) {
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: Read-only access for Security QuickScan (delete the stack after the assessment)
Resources:
  QuickScanRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: SecurityQuickScanReadOnly
      MaxSessionDuration: 3600
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: ${principal}
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                sts:ExternalId: ${externalId}
      Policies:
        - PolicyName: SecurityQuickScanReadOnly
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Resource: '*'
                Action:
${AWS_SCANNER_ACTIONS.map((a) => `                  - ${a}`).join('\n')}
Outputs:
  RoleArn:
    Value: !GetAtt QuickScanRole.Arn`;
}

export function AwsRoleGuide({ principal, externalId }: { principal: string | null; externalId: string }) {
  return (
    <Steps>
      <Step title="Deploy the read-only role in the customer account">
        <p>
          Ask the customer (or do it together) to create a CloudFormation stack in <strong>us-east-1</strong> from the template below. It grants only the {AWS_SCANNER_ACTIONS.length} read
          actions the checks use (no access to data such as S3 objects or secrets), and only our platform identity can assume it, with this engagement's unique external ID.
        </p>
        {principal ? <CodeBlock>{cloudFormation(principal, externalId)}</CodeBlock> : <p className="text-red-600">The platform AWS identity is not configured.</p>}
      </Step>
      <Step title="Copy the RoleArn output and paste it below" />
      <Step title="Test the connection">The role is assumed for at most one hour per scan; no long-lived customer secret is shared.</Step>
      <Step title="After the assessment">Delete the stack to remove access.</Step>
    </Steps>
  );
}

export function AwsKeysGuide() {
  return (
    <Steps>
      <Step title="Prefer temporary credentials">
        Use IAM Identity Center short-term credentials (access key starting with <code>ASIA</code> plus session token) for a principal with the read-only policy
        shown in the CloudFormation template (or the AWS managed <code className="mx-1 rounded bg-slate-100 px-1">SecurityAudit</code> policy).
      </Step>
      <Step title="Or create a dedicated IAM user">
        Create user <code>security-quickscan</code> without console access, attach that policy, and create an access key of type "Third-party service".
      </Step>
      <Step title="Paste the keys below">They are encrypted immediately and never shown again.</Step>
      <Step title="After the assessment">Deactivate and delete the access key and user.</Step>
    </Steps>
  );
}

export function MsConsentGuide({ azure }: { azure: boolean }) {
  return (
    <Steps>
      <Step title="Enter the customer tenant ID or primary domain">Find it in the Entra admin center, Overview page (Tenant ID).</Step>
      <Step title="Generate the admin consent link">
        Send the link to a Global Administrator or Privileged Role Administrator of the customer, or open it yourself during a screen share. It grants our read-only
        scanner application these Microsoft Graph application permissions:
        <Perms list={GRAPH_PERMISSIONS} />
        No secret of the customer is exchanged.
      </Step>
      {azure && (
        <Step title="Grant Azure read access">
          After consent, assign the scanner service principal <strong>Reader</strong> and <strong>Security Reader</strong> on each subscription (or a management group):
          <CodeBlock>{`az ad sp show --id <scanner-client-id> --query id -o tsv
az role assignment create --assignee <scanner-client-id> --role "Reader" --scope /subscriptions/<subscription-id>
az role assignment create --assignee <scanner-client-id> --role "Security Reader" --scope /subscriptions/<subscription-id>`}</CodeBlock>
        </Step>
      )}
      <Step title="Test the connection" />
      <Step title="After the assessment">
        Remove the enterprise application "Security QuickScan" from the customer tenant{azure ? ' and delete the role assignments' : ''}.
      </Step>
    </Steps>
  );
}

export function MsAppGuide({ azure }: { azure: boolean }) {
  return (
    <Steps>
      <Step title="Register an application in the customer tenant">Entra admin center, App registrations, New registration. Name it "Security QuickScan (temporary)", single tenant, no redirect URI.</Step>
      <Step title="Add Microsoft Graph application permissions">
        API permissions, Add a permission, Microsoft Graph, <strong>Application permissions</strong>:
        <Perms list={GRAPH_PERMISSIONS} />
        Then click <strong>Grant admin consent</strong>.
      </Step>
      {azure && (
        <Step title="Grant Azure read access">
          Assign the app <strong>Reader</strong> and <strong>Security Reader</strong> on the subscriptions in scope (Subscription, Access control (IAM), Add role assignment).
        </Step>
      )}
      <Step title="Create a short-lived client secret">Certificates and secrets, New client secret, choose a custom expiry of 7 days. Copy the secret value (not the ID).</Step>
      <Step title="Enter the tenant ID, application (client) ID and secret below" />
      <Step title="After the assessment">Delete the app registration.</Step>
    </Steps>
  );
}

export function GithubGuide() {
  return (
    <Steps>
      <Step title="Create a fine-grained personal access token">
        An organisation owner opens Settings, Developer settings, Fine-grained tokens, Generate new token. Resource owner: the organisation. Expiration: 7 days. Repository access: All
        repositories.
      </Step>
      <Step title="Select read-only permissions">
        Repository: <Perms list={['Administration: read', 'Metadata: read', 'Dependabot alerts: read', 'Code scanning alerts: read', 'Secret scanning alerts: read']} />
        Organisation: <Perms list={['Administration: read', 'Members: read', 'Webhooks: read']} />
      </Step>
      <Step title="Approve the token if the organisation requires it">Organisation settings, Personal access tokens, Pending requests.</Step>
      <Step title="Paste the token below">
        A token of an owner gives full visibility. A classic token with <code>read:org</code>, <code>repo</code>, <code>security_events</code> and <code>admin:org_hook</code> also works
        but grants more than read access.
      </Step>
      <Step title="After the assessment">Revoke the token.</Step>
    </Steps>
  );
}
