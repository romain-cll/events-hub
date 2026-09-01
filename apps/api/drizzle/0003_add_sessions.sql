CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"visitor_key" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "session_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_project_visitor_idx" ON "sessions" USING btree ("project_id","visitor_key");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_session_occurred_idx" ON "events" USING btree ("session_id","occurred_at");