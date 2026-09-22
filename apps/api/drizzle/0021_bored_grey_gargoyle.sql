-- Une ligne chaque fois que le montant mensuel d'un abonnement change.
--
-- Elle existe avant même qu'on sache la lire : la décomposition du MRR demande
-- l'écart entre deux instants, et cet écart n'est reconstructible nulle part —
-- Stripe n'expose aucun état passé, son API Events ne remonte que trente jours,
-- et notre propre projection écrase l'ancien montant. Chaque mois sans cette
-- table est un mois absent du waterfall pour toujours.
--
-- `monthly_before` est nullable, et `null` n'est pas `0` : le premier dit que
-- l'abonnement n'existait pas — une entrée dans la série — le second qu'il
-- existait sans rien valoir.
--
-- Aucune cause n'est rangée ici. « Expansion », « churn », « nouveau » se
-- déduisent des deux montants ; les figer en base les trancherait avant que la
-- lecture ait dit ce dont elle a besoin.
--
-- L'historique démarre à la mise en service : les abonnements déjà en base
-- n'auront de révision qu'au premier changement. La courbe partira plate.
CREATE TABLE "stripe_subscription_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	"currency" text NOT NULL,
	"monthly_before" integer,
	"monthly_after" integer NOT NULL,
	"status" text NOT NULL,
	"recorded_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stripe_subscription_revisions" ADD CONSTRAINT "stripe_subscription_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_subscription_revisions" ADD CONSTRAINT "stripe_subscription_revisions_subscription_id_stripe_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."stripe_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_subscription_revisions_project_observed_idx" ON "stripe_subscription_revisions" USING btree ("project_id","observed_at");