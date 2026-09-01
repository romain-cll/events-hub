CREATE TABLE "project_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"value" text NOT NULL,
	"type" text DEFAULT 'public' NOT NULL,
	"allowed_origins" text[] NOT NULL,
	"name" text,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_keys_value_unique" UNIQUE("value")
);
--> statement-breakpoint
ALTER TABLE "project_keys" ADD CONSTRAINT "project_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_keys_project_id_idx" ON "project_keys" USING btree ("project_id");