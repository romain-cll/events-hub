-- Purge préalable : `visitor_key` est NOT NULL et sans valeur par défaut. Les
-- événements déjà en base ont été ingérés avant l'existence de la clé visiteur
-- — il n'y a rien de vrai à y écrire, et inventer une valeur reviendrait à
-- fabriquer un visiteur qui n'a jamais existé. Ce sont des essais manuels
-- d'ingestion, on les supprime.
DELETE FROM "events";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "visitor_key" text NOT NULL;
