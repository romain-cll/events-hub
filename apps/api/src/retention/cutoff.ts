import { sql, type SQL } from 'drizzle-orm';

/**
 * Au-delà de combien de mois une donnée d'ingestion cesse d'être identifiable.
 *
 * Vingt-cinq mois, et pas treize : la comparaison d'une année sur l'autre est
 * exactement ce qu'on vient chercher dans un hub d'événements, et elle demande
 * de garder le mois N-12 encore un mois complet après la fin du mois N. Treize
 * mois donneraient un axe qui se dérobe au moment où on s'en sert.
 *
 * ## Une constante du code, pas un réglage d'environnement
 *
 * Comme `SESSION_GAP_MS`, et pour une raison plus forte : cette politique est
 * **destructrice et irréversible**. Un `RETENTION_MONTHS=1` posé par erreur dans
 * un fichier d'environnement effacerait deux ans d'historique en une nuit, sans
 * qu'aucun diff ne l'ait jamais montré. La changer doit passer par un commit.
 *
 * Seul `RETENTION_ENABLED` existe, et il ne gouverne que le déclenchement
 * planifié — voir `RetentionService`.
 *
 * ## La borne est calculée en SQL, jamais en JavaScript
 *
 * `setUTCMonth` déborde sur les fins de mois : le 31 mars moins un mois donne le
 * 3 mars. `make_interval` applique la règle calendaire de Postgres, qui ramène
 * au dernier jour du mois cible. Et surtout la borne reste sur **la même
 * horloge que les lignes qu'elle compare** — celle du serveur de base — au lieu
 * de dépendre de celle du processus Node, qui peut en dériver.
 *
 * D'où le type de retour : un fragment, pas une `Date`. Il s'utilise partout où
 * Drizzle accepte un `SQLWrapper`, donc aussi bien dans un `where()` que dans du
 * SQL brut.
 *
 * ## Deux conséquences de purger sur `occurredAt`
 *
 * La colonne est **fournie par le client**, pas dérivée par le serveur. Deux
 * effets, tous deux assumés ici et à traiter ailleurs :
 *
 * - un événement **antidaté** disparaît plus tôt que son arrivée ne le
 *   laisserait croire. C'est cohérent : toutes les lectures fenêtrent sur
 *   `occurredAt`, donc il était déjà invisible partout avant d'être purgé ;
 * - un événement **postdaté n'est jamais purgé**, et aucune garde n'existe à
 *   l'ingestion pour refuser une date dans le futur. C'est un trou réel, mais le
 *   fermer est un travail d'ingestion — le faire ici reviendrait à laisser la
 *   purge rattraper une donnée qu'on n'aurait jamais dû accepter.
 *
 * L'alternative — une colonne d'horodatage posée par le serveur — a été écartée
 * dans le plan de ce lot : `ADD COLUMN NOT NULL DEFAULT now()` a un défaut
 * volatil, donc réécrit la table entière sous `ACCESS EXCLUSIVE`, et daterait
 * tout l'historique d'aujourd'hui — le soustrayant à la purge pour vingt-cinq
 * mois de plus.
 */
export const RETENTION_MONTHS = 25;

/**
 * L'instant avant lequel une donnée d'ingestion n'a plus le droit d'identifier
 * qui que ce soit.
 *
 * Une fonction et non une constante : la borne glisse avec l'horloge, et une
 * valeur figée au démarrage laisserait un processus de longue durée purger
 * toujours la même fenêtre.
 *
 * Le fichier est **plat** — aucun provider, aucune dépendance Nest. C'est ce qui
 * permet à `EventStore` de s'en servir sans que `EventsModule` ait à importer
 * `RetentionModule`, donc sans cycle entre les deux.
 */
export function retentionCutoff(): SQL {
  // Parenthésé : le fragment est presque toujours inséré à droite d'un
  // comparateur, où la précédence de Postgres jouerait déjà en notre faveur.
  // Elle cesse de jouer le jour où quelqu'un l'insère ailleurs, et ce jour-là
  // l'erreur serait silencieuse — la requête resterait valide, elle comparerait
  // autre chose.
  return sql`(now() - make_interval(months => ${RETENTION_MONTHS}::int))`;
}
