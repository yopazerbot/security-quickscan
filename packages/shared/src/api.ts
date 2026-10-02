import { z } from 'zod';
import { customerContextSchema } from './risk.js';
import { PROVIDERS, RETENTION_MODES, ROLES } from './types.js';

const guid = z.string().regex(/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/, 'Must be a GUID');
const tenantRef = z
  .string()
  .trim()
  .regex(/^([0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+)$/, 'Tenant ID (GUID) or primary domain');

export const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).default(''),
  contactEmail: z.union([z.literal(''), z.email().max(320)]).default(''),
  country: z.string().trim().max(100).default(''),
  notes: z.string().max(10000).default(''),
  context: customerContextSchema,
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

export const awsConfigSchema = z.object({
  authMode: z.enum(['assume_role', 'access_keys', 'demo']),
  accountId: z.string().regex(/^\d{12}$/, '12 digit AWS account ID').optional(),
  roleArn: z
    .string()
    .regex(/^arn:aws(-[a-z]+)?:iam::\d{12}:role\/[\w+=,.@\/-]{1,512}$/, 'IAM role ARN')
    .optional(),
  regions: z.array(z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/)).max(40).default([]),
});

export const msConfigSchema = z.object({
  authMode: z.enum(['admin_consent', 'app_secret', 'demo']),
  tenantId: tenantRef.optional(),
  clientId: guid.optional(),
  subscriptionIds: z.array(guid).max(100).default([]),
});

export const githubConfigSchema = z.object({
  authMode: z.enum(['token', 'demo']),
  org: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/, 'GitHub organisation login'),
});

export const systemInputSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('aws'), label: z.string().trim().min(1).max(100), config: awsConfigSchema }),
  z.object({ provider: z.literal('m365'), label: z.string().trim().min(1).max(100), config: msConfigSchema }),
  z.object({ provider: z.literal('azure'), label: z.string().trim().min(1).max(100), config: msConfigSchema }),
  z.object({ provider: z.literal('github'), label: z.string().trim().min(1).max(100), config: githubConfigSchema }),
]);
export type SystemInput = z.infer<typeof systemInputSchema>;

export const awsSecretSchema = z.object({
  accessKeyId: z.string().regex(/^(AKIA|ASIA)[A-Z0-9]{16}$/, 'Access key ID'),
  secretAccessKey: z.string().min(30).max(128),
  sessionToken: z.string().max(4000).optional(),
});
export const msSecretSchema = z.object({ clientSecret: z.string().min(10).max(500) });
export const githubSecretSchema = z.object({ token: z.string().regex(/^(ghp_|github_pat_|gho_|ghs_)[A-Za-z0-9_]{20,255}$/, 'GitHub token') });

export const retentionSchema = z.object({
  mode: z.enum(RETENTION_MODES),
  days: z.number().int().min(1).max(365).optional(),
});

export const authorizationSchema = z.object({
  authorizerName: z.string().trim().min(1).max(200),
  authorizerRole: z.string().trim().min(1).max(200),
  authorizerEmail: z.email().max(320),
  authorizedOn: z.iso.date(),
  validUntil: z.iso.date(),
  confirmed: z.literal(true),
});
export type Authorization = z.infer<typeof authorizationSchema>;

export const userInputSchema = z.object({
  email: z.email().max(320),
  name: z.string().trim().min(1).max(200),
  role: z.enum(ROLES),
  allCustomers: z.boolean().default(false),
  active: z.boolean().default(true),
});

export const providerSchema = z.enum(PROVIDERS);

export const triageSchema = z.object({
  status: z.enum(['open', 'accepted', 'false_positive']),
  note: z.string().max(5000).default(''),
});

export const brandingSchema = z.object({
  companyName: z.string().trim().max(200).default(''),
  consultantName: z.string().trim().max(200).default(''),
  contactEmail: z.union([z.literal(''), z.email()]).default(''),
  website: z.string().trim().max(200).default(''),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f46e5'),
  disclaimer: z.string().max(4000).default(''),
  classification: z.enum(['TLP:CLEAR', 'TLP:GREEN', 'TLP:AMBER', 'TLP:AMBER+STRICT', 'TLP:RED']).default('TLP:AMBER'),
});
export type Branding = z.infer<typeof brandingSchema>;
