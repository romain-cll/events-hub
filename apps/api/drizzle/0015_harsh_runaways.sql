CREATE TABLE "stripe_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"visitor_id" text NOT NULL,
	"learned_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_customers_projectId_customerId_unique" UNIQUE("project_id","customer_id")
);
--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ADD COLUMN "written_event_id" uuid;--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ADD CONSTRAINT "stripe_webhook_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ADD CONSTRAINT "stripe_webhook_events_written_event_id_events_id_fk" FOREIGN KEY ("written_event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_project_customer_idx" ON "stripe_webhook_events" USING btree ("project_id","customer_id");--> statement-breakpoint
-- Remplissage unique, écrit à la main : `drizzle-kit` génère le schéma, pas la
-- reprise des données.
--
-- Sans lui, tout ce qui a été ingéré avant ce lot resterait hors de portée du
-- nouvel index — des paiements dont on connaît pourtant le client, et qu'on
-- saurait rattacher au visiteur dès que la paire s'apprend. Les laisser
-- inatteignables reviendrait à jeter du revenu déjà mesuré.
--
-- La jointure passe par l'identifiant d'événement Stripe rangé dans les
-- propriétés : c'est le seul lien qui existait jusqu'ici entre les deux tables.
-- Nommer une clé d'une verticale est sans conséquence ici — une migration est du
-- SQL, pas une source scannée par les tests d'architecture.
UPDATE "stripe_webhook_events" AS w
SET "project_id" = e."project_id",
    "written_event_id" = e."id",
    "customer_id" = e."properties" ->> 'stripe.customer.id'
FROM "events" AS e
WHERE e."properties" ->> 'stripe.event.id' = w."event_id";
