CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"scope" text NOT NULL,
	"livemode" boolean NOT NULL,
	"connected_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_projectId_provider_unique" UNIQUE("project_id","provider")
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;