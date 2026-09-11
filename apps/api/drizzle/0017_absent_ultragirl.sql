ALTER TABLE "sessions" ADD COLUMN "campaign_source" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "campaign_medium" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "campaign_name" text;--> statement-breakpoint
CREATE INDEX "sessions_project_campaign_idx" ON "sessions" USING btree ("project_id","campaign_source");--> statement-breakpoint
-- Reprise de données, écrite à la main : `drizzle-kit` génère le schéma, pas la
-- reprise.
--
-- Les paramètres de campagne sont en base depuis toujours, noyés dans l'URL que
-- le SDK range dans ses attributs. Sans ce remplissage, l'analyse de campagne
-- commencerait aujourd'hui alors que la donnée existe — et le décalage de
-- versions du SDK laisserait en plus un trou permanent sur les sessions ouvertes
-- par un bundle antérieur.
--
-- L'extraction porte sur le **plus ancien événement de chaque session**, ce qui
-- reproduit exactement la règle d'exécution : la campagne est celle de
-- l'ouverture, pas celle d'une page vue plus tard.
--
-- Nommer une clé du SDK est sans conséquence ici : une migration est du SQL, pas
-- une source scannée par les tests d'architecture — et c'est une affirmation
-- ponctuelle, dans un diff, qui ne tournera qu'une fois.
--
-- Deux limites assumées : pas de décodage pourcent (faisable en SQL pur,
-- illisible, et les noms de campagne le sont rarement), et rien à reprendre pour
-- une session dont le premier événement ne porte plus d'URL exploitable.
UPDATE "sessions" AS s
SET "campaign_source" = c.source,
    "campaign_medium" = c.medium,
    "campaign_name" = c.name
FROM (
  SELECT DISTINCT ON (e."session_id")
    e."session_id" AS session_id,
    nullif(lower(trim(replace(substring(e."attributes" ->> 'page.url' from 'utm_source=([^&#]*)'), '+', ' '))), '') AS source,
    nullif(lower(trim(replace(substring(e."attributes" ->> 'page.url' from 'utm_medium=([^&#]*)'), '+', ' '))), '') AS medium,
    nullif(lower(trim(replace(substring(e."attributes" ->> 'page.url' from 'utm_campaign=([^&#]*)'), '+', ' '))), '') AS name
  FROM "events" AS e
  WHERE e."session_id" IS NOT NULL
  ORDER BY e."session_id", e."occurred_at" ASC, e."id" ASC
) AS c
WHERE s."id" = c.session_id
  AND (c.source IS NOT NULL OR c.medium IS NOT NULL OR c.name IS NOT NULL);
