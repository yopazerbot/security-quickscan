CREATE TYPE "public"."share_permission" AS ENUM('view', 'edit');--> statement-breakpoint
ALTER TABLE "customer_assignments" ADD COLUMN "permission" "share_permission" DEFAULT 'view' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_assignments" ADD COLUMN "granted_by" uuid;--> statement-breakpoint
ALTER TABLE "customer_assignments" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_assignments" ADD CONSTRAINT "customer_assignments_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Need-to-know backfill: the creator owns each real organisation; existing assignments become shares
-- (view for viewer accounts, edit otherwise); an owner does not need a share of their own organisation.
UPDATE "customers" SET "owner_id" = "created_by" WHERE "is_demo" = false;--> statement-breakpoint
UPDATE "customer_assignments" AS ca SET "permission" = CASE WHEN u."role" = 'viewer' THEN 'view'::"share_permission" ELSE 'edit'::"share_permission" END FROM "users" AS u WHERE u."id" = ca."user_id";--> statement-breakpoint
DELETE FROM "customer_assignments" AS ca USING "customers" AS c WHERE c."id" = ca."customer_id" AND c."owner_id" = ca."user_id";--> statement-breakpoint
ALTER TABLE "scans" DROP COLUMN "authorization";--> statement-breakpoint
ALTER TABLE "scans" DROP COLUMN "authorization_doc";--> statement-breakpoint
ALTER TABLE "scans" DROP COLUMN "authorization_doc_name";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "all_customers";