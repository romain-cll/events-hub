CREATE TABLE "event_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"label" text,
	"server_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_types_project_name_key" UNIQUE("project_id","name")
);
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_keys" ADD COLUMN "is_secret" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- `source` est NOT NULL sans défaut dans le schéma : un ajout direct échouerait
-- sur les lignes existantes. On pose un défaut le temps du remplissage, puis on
-- le retire — ce qui reste correspond exactement au schéma.
-- Tout ce qui existe aujourd'hui vient du SDK navigateur, seule source d'events
-- jusqu'ici : `browser` n'est pas une supposition, c'est le seul chemin qui
-- existait.
ALTER TABLE "events" ADD COLUMN "source" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
-- Le registre est inscrit à la volée à l'ingestion ; les types déjà émis n'ont
-- jamais eu l'occasion d'y passer. On les rattrape ici pour qu'un projet
-- existant ne parte pas avec un vocabulaire vide.
INSERT INTO "event_types" ("project_id", "name")
SELECT DISTINCT "project_id", "type" FROM "events"
ON CONFLICT ("project_id", "name") DO NOTHING;--> statement-breakpoint
ALTER TABLE "event_types" ADD CONSTRAINT "event_types_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_types_project_id_idx" ON "event_types" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "events_project_type_idx" ON "events" USING btree ("project_id","type");