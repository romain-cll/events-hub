ALTER TABLE "events" ADD COLUMN "visitor_key" text;--> statement-breakpoint
CREATE INDEX "events_project_visitor_idx" ON "events" USING btree ("project_id","visitor_key");