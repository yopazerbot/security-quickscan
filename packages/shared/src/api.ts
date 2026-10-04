import { z } from 'zod';
import { ENVIRONMENT_MAX } from './system-key.js';
import { PROVIDERS, RETENTION_MODES, ROLES } from './types.js';

const guid = z.string().regex(/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/, 'Must be a GUID');
const tenantRef = z
  .string()
  .trim()
  .regex(/^([0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+)$/, 'Tenant ID (GUID) or primary domain');

/**
 * An organisation is just a name: every scan runs all best-practice checks for its systems.
 * Fields older clients still send (contact details, context questionnaire) are ignored.
 */
export const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
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

export const GITHUB_ORG_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
export const GITHUB_ORG_HINT = 'Use the organisation login as in github.com/<login>: letters, digits and hyphens, no spaces.';

export const githubConfigSchema = z
  .object({
    authMode: z.enum(['token', 'demo']),
    org: z.string().trim().max(39).optional(),
  })
  .transform((c) => ({ ...c, org: c.org || (c.authMode === 'demo' ? 'demo-org' : '') }))
  .refine((c) => GITHUB_ORG_RE.test(c.org), { message: GITHUB_ORG_HINT, path: ['org'] });

/**
 * Optional free-text environment of a system (production, acceptance, uat...); never a fixed list. Empty or null
 * clears it; leaving the field out of an update keeps the current value.
 */
export const environmentSchema = z
  .string()
  .max(200)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'No control characters')
  .refine((v) => v.replace(/\s+/g, ' ').trim().length <= ENVIRONMENT_MAX, `At most ${ENVIRONMENT_MAX} characters`)
  .nullable()
  .optional();

const systemBase = { label: z.string().trim().min(1).max(100), environment: environmentSchema };

export const systemInputSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('aws'), ...systemBase, config: awsConfigSchema }),
  z.object({ provider: z.literal('m365'), ...systemBase, config: msConfigSchema }),
  z.object({ provider: z.literal('azure'), ...systemBase, config: msConfigSchema }),
  z.object({ provider: z.literal('github'), ...systemBase, config: githubConfigSchema }),
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

export const userInputSchema = z.object({
  email: z.email().max(320),
  name: z.string().trim().min(1).max(200),
  role: z.enum(ROLES),
  active: z.boolean().default(true),
});

/**
 * PATCH /api/users/:id. Every field is optional and has no default, so omitted fields stay unchanged.
 * newOwnerId: required when deactivating or demoting to viewer a user who owns organisations.
 */
export const userUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    role: z.enum(ROLES),
    active: z.boolean(),
    newOwnerId: z.uuid(),
  })
  .partial();
export type UserUpdate = z.infer<typeof userUpdateSchema>;

export const providerSchema = z.enum(PROVIDERS);

export const triageSchema = z.object({
  /** systemKey() of the system the decision applies to. */
  systemKey: z.string().min(1).max(300),
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
});
export type Branding = z.infer<typeof brandingSchema>;
