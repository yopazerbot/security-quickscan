ALTER TABLE "customers" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "imported_by" uuid;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "imported_from_version" text;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_origin_idx" ON "customers" USING btree ("origin_id");--> statement-breakpoint
CREATE INDEX "scans_customer_origin_idx" ON "scans" USING btree ("customer_id","origin_id");