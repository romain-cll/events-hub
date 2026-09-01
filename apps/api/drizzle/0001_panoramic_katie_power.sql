CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Purge préalable : `project_id` est NOT NULL et sans valeur par défaut, donc
-- l'ALTER échouerait sur toute ligne déjà présente. Les seuls événements en
-- base à ce stade sont des essais manuels d'ingestion, sans projet auquel les
-- rattacher — on les supprime plutôt que d'inventer un projet fictif.
DELETE FROM "events";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_project_id_idx" ON "events" USING btree ("project_id");