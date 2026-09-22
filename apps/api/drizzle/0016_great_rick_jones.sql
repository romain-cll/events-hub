ALTER TABLE "sessions" ADD COLUMN "browser" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "os" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_type" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "is_bot" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Aucune reprise de données n'est possible ici, et c'est la preuve que
-- l'invariant a tenu : le User-Agent des sessions passées n'existe nulle part.
-- Il entrait dans `CoreService`, servait à dériver la clé visiteur, et mourait
-- avec la requête.
--
-- Conséquence à connaître avant de lire les courbes : le trafic historique reste
-- compté comme il l'a toujours été — `is_bot` à `false` — et le compteur de
-- sessions de robots ne monte qu'à partir de ce déploiement. Ce n'est pas une
-- invasion, c'est une mise en service.
