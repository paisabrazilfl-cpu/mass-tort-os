CREATE TABLE "system_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_snapshots" ADD CONSTRAINT "system_snapshots_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_snapshots" ADD CONSTRAINT "system_snapshots_created_by_user_id_mtos_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mtos_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "system_snapshots_firm_created_idx" ON "system_snapshots" USING btree ("firm_id","created_at");
