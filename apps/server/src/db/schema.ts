import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const roleEnum = pgEnum('role', ['admin', 'consultant', 'viewer']);
export const providerEnum = pgEnum('provider', ['m365', 'azure', 'aws', 'github']);
export const scanStatusEnum = pgEnum('scan_status', ['draft', 'queued', 'running', 'completed', 'failed', 'cancelled']);
export const resultStatusEnum = pgEnum('result_status', ['pending', 'running', 'pass', 'fail', 'warn', 'na', 'error']);
export const retentionEnum = pgEnum('retention_mode', ['purge_on_completion', 'days', 'manual']);
export const triageEnum = pgEnum('triage_status', ['open', 'accepted', 'false_positive']);
export const sharePermissionEnum = pgEnum('share_permission', ['view', 'edit']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: roleEnum('role').notNull().default('viewer'),
    active: boolean('active').notNull().default(true),
    entraOid: text('entra_oid'),
    isBreakglass: boolean('is_breakglass').notNull().default(false),
    /** Shared visitor account for demo PIN login; only sees demo organisations. */
    isDemo: boolean('is_demo').notNull().default(false),
    /** Argon2id hash for local password sign-in; null = the user can only use single sign-on. */
    passwordHash: text('password_hash'),
    passwordChangedAt: ts('password_changed_at'),
    /** Set with a temporary password from an administrator: the next password sign-in must change it first. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastLoginAt: ts('last_login_at'),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`), uniqueIndex('users_oid_uq').on(t.entraOid)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the session token; the raw token only lives in the cookie. */
    idHash: text('id_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    authMethod: text('auth_method').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    /** Last re-authentication within this session (recent sign-in for sensitive settings). */
    reauthAt: ts('reauth_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Short-lived OIDC / consent state, so nothing sensitive needs to be put in cookies. */
export const authStates = pgTable('auth_states', {
  stateHash: text('state_hash').primaryKey(),
  kind: text('kind').notNull(),
  data: jsonb('data').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const loginAttempts = pgTable('login_attempts', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: ts('locked_until'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  contactName: text('contact_name').notNull().default(''),
  contactEmail: text('contact_email').notNull().default(''),
  country: text('country').notNull().default(''),
  notes: text('notes').notNull().default(''),
  context: jsonb('context').notNull(),
  /** Seeded fictional organisation (only created when DEMO_MODE=true). */
  isDemo: boolean('is_demo').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  /** Need-to-know: only the owner, users it is shared with and admins can see an organisation. */
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [index('customers_owner_idx').on(t.ownerId)]);

/** Organisation shares: who else may view or edit an organisation, granted by its owner or an admin. */
export const customerAssignments = pgTable(
  'customer_assignments',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    permission: sharePermissionEnum('permission').notNull().default('view'),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.customerId] }), index('customer_assignments_customer_idx').on(t.customerId)],
);

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: scanStatusEnum('status').notNull().default('draft'),
    wizardStep: integer('wizard_step').notNull().default(0),
    context: jsonb('context').notNull(),
    riskProfile: jsonb('risk_profile').notNull(),
    retentionMode: retentionEnum('retention_mode').notNull().default('purge_on_completion'),
    retentionDays: integer('retention_days'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    workerId: text('worker_id'),
    heartbeatAt: ts('heartbeat_at'),
    summary: jsonb('summary'),
    score: integer('score'),
    grade: text('grade'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    queuedAt: ts('queued_at'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('scans_customer_idx').on(t.customerId), index('scans_status_idx').on(t.status)],
);

export const scanSystems = pgTable(
  'scan_systems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    provider: providerEnum('provider').notNull(),
    label: text('label').notNull(),
    /** Non-secret configuration (tenant, account, org, auth mode, generated external ID). */
    config: jsonb('config').notNull(),
    connectionOk: boolean('connection_ok'),
    connectionMessage: text('connection_message'),
    connectionDetails: jsonb('connection_details'),
    connectionCheckedAt: ts('connection_checked_at'),
    /** Config frozen when the scan starts; the worker scans exactly what was validated. */
    startedConfig: jsonb('started_config'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('scan_systems_scan_idx').on(t.scanId)],
);

export const credentials = pgTable('credentials', {
  systemId: uuid('system_id')
    .primaryKey()
    .references(() => scanSystems.id, { onDelete: 'cascade' }),
  /** Envelope-encrypted secret (see crypto/envelope.ts). */
  blob: bytea('blob').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  hint: text('hint').notNull().default(''),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  lastUsedAt: ts('last_used_at'),
  /** Hard expiry; the retention job deletes the row after this time. */
  expiresAt: ts('expires_at'),
});

export const scanCriteria = pgTable(
  'scan_criteria',
  {
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    checkId: text('check_id').notNull(),
    included: boolean('included').notNull(),
    reason: text('reason').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.scanId, t.checkId] })],
);

export const checkResults = pgTable(
  'check_results',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    systemId: uuid('system_id')
      .notNull()
      .references(() => scanSystems.id, { onDelete: 'cascade' }),
    checkId: text('check_id').notNull(),
    status: resultStatusEnum('status').notNull().default('pending'),
    summary: text('summary').notNull().default(''),
    resources: jsonb('resources').notNull().default([]),
    evidence: jsonb('evidence'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('check_results_uq').on(t.scanId, t.systemId, t.checkId), index('check_results_updated_idx').on(t.scanId, t.updatedAt)],
);

/** Triage per organisation (customers row) + check, carried over to future scans. */
export const findingTriage = pgTable(
  'finding_triage',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    checkId: text('check_id').notNull(),
    /** System identity the decision applies to (e.g. aws:111122223333); '*' = every system (legacy rows). */
    systemKey: text('system_key').notNull().default('*'),
    status: triageEnum('status').notNull().default('open'),
    note: text('note').notNull().default(''),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.checkId, t.systemKey] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    userId: uuid('user_id'),
    userEmail: text('user_email'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    details: jsonb('details'),
  },
  (t) => [index('audit_at_idx').on(t.at)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Microsoft tenants that granted admin consent to the platform scanner app, bound to exactly one
 * organisation. Prevents using the platform app against another organisation's tenant.
 */
/**
 * One Microsoft tenant belongs to one organisation. The binding outlives the organisation (customer_id becomes null)
 * so a deleted organisation does not free its tenant for someone else; an admin releases it explicitly.
 */
export const msTenantBindings = pgTable('ms_tenant_bindings', {
  tenantId: text('tenant_id').primaryKey(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});
