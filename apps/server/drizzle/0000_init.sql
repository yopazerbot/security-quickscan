CREATE TYPE "public"."provider" AS ENUM('m365', 'azure', 'aws', 'github');--> statement-breakpoint
CREATE TYPE "public"."result_status" AS ENUM('pending', 'running', 'pass', 'fail', 'warn', 'na', 'error');--> statement-breakpoint
CREATE TYPE "public"."retention_mode" AS ENUM('purge_on_completion', 'days', 'manual');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'consultant', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('draft', 'queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."triage_status" AS ENUM('open', 'accepted', 'false_positive');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"user_email" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "auth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"system_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"status" "result_status" DEFAULT 'pending' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"system_id" uuid PRIMARY KEY NOT NULL,
	"blob" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_assignments" (
	"user_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	CONSTRAINT "customer_assignments_user_id_customer_id_pk" PRIMARY KEY("user_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_name" text DEFAULT '' NOT NULL,
	"contact_email" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"context" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_triage" (
	"customer_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"status" "triage_status" DEFAULT 'open' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_triage_customer_id_check_id_pk" PRIMARY KEY("customer_id","check_id")
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_criteria" (
	"scan_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"included" boolean NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	CONSTRAINT "scan_criteria_scan_id_check_id_pk" PRIMARY KEY("scan_id","check_id")
);
--> statement-breakpoint
CREATE TABLE "scan_systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"label" text NOT NULL,
	"config" jsonb NOT NULL,
	"connection_ok" boolean,
	"connection_message" text,
	"connection_details" jsonb,
	"connection_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "scan_status" DEFAULT 'draft' NOT NULL,
	"wizard_step" integer DEFAULT 0 NOT NULL,
	"context" jsonb NOT NULL,
	"risk_profile" jsonb NOT NULL,
	"retention_mode" "retention_mode" DEFAULT 'purge_on_completion' NOT NULL,
	"retention_days" integer,
	"authorization" jsonb,
	"authorization_doc" "bytea",
	"authorization_doc_name" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"summary" jsonb,
	"score" integer,
	"grade" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" text NOT NULL,
	"auth_method" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "role" DEFAULT 'viewer' NOT NULL,
	"all_customers" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"entra_oid" text,
	"is_breakglass" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_system_id_scan_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."scan_systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_system_id_scan_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."scan_systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_assignments" ADD CONSTRAINT "customer_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_assignments" ADD CONSTRAINT "customer_assignments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_triage" ADD CONSTRAINT "finding_triage_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_triage" ADD CONSTRAINT "finding_triage_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_criteria" ADD CONSTRAINT "scan_criteria_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_systems" ADD CONSTRAINT "scan_systems_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "check_results_uq" ON "check_results" USING btree ("scan_id","system_id","check_id");--> statement-breakpoint
CREATE INDEX "check_results_updated_idx" ON "check_results" USING btree ("scan_id","updated_at");--> statement-breakpoint
CREATE INDEX "scan_systems_scan_idx" ON "scan_systems" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "scans_customer_idx" ON "scans" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "scans_status_idx" ON "scans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_oid_uq" ON "users" USING btree ("entra_oid");