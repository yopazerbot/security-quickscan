ALTER TABLE "ms_tenant_bindings" DROP CONSTRAINT "ms_tenant_bindings_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "ms_tenant_bindings" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ms_tenant_bindings" ADD CONSTRAINT "ms_tenant_bindings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_triage" ADD COLUMN "system_key" text DEFAULT '*' NOT NULL;--> statement-breakpoint
ALTER TABLE "finding_triage" DROP CONSTRAINT "finding_triage_customer_id_check_id_pk";--> statement-breakpoint
ALTER TABLE "finding_triage" ADD CONSTRAINT "finding_triage_customer_id_check_id_system_key_pk" PRIMARY KEY("customer_id","check_id","system_key");--> statement-breakpoint
ALTER TABLE "scan_systems" ADD COLUMN "started_config" jsonb;--> statement-breakpoint
CREATE INDEX "customer_assignments_customer_idx" ON "customer_assignments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customers_owner_idx" ON "customers" USING btree ("owner_id");--> statement-breakpoint
-- Viewer accounts can only ever view: store the effective permission.
UPDATE "customer_assignments" AS ca SET "permission" = 'view' FROM "users" AS u WHERE u."id" = ca."user_id" AND u."role" = 'viewer';--> statement-breakpoint
-- Audit log stays append-only, except for the two maintenance functions below (retention and redaction),
-- which switch on a transaction-local flag that the trigger honours.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('qs.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND current_setting('qs.audit_redact', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_purge(older_than interval) RETURNS integer AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('qs.audit_purge', 'on', true);
  DELETE FROM audit_log WHERE "at" < now() - older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('qs.audit_purge', 'off', true);
  RETURN n;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- The removed scan approval feature stored authoriser emails and letter file names; redact them.
DO $$
BEGIN
  PERFORM set_config('qs.audit_redact', 'on', true);
  UPDATE audit_log SET details = (details - 'authorizer' - 'filename') || '{"redacted": true}'::jsonb
    WHERE action LIKE 'scan.authorization%' AND (details ? 'authorizer' OR details ? 'filename');
  PERFORM set_config('qs.audit_redact', 'off', true);
END $$;
