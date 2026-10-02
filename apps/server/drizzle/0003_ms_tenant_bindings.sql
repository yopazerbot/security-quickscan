CREATE TABLE "ms_tenant_bindings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ms_tenant_bindings" ADD CONSTRAINT "ms_tenant_bindings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ms_tenant_bindings" ADD CONSTRAINT "ms_tenant_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;