import { z } from 'zod';

/**
 * Contrat d'entrée de `POST /v1/events`.
 *
 * `apiKey` a remplacé `projectId` : le client ne désigne plus sa cible, il
 * présente une clé qui la désigne pour lui. C'est ce qui empêche d'écrire dans
 * le projet d'autrui en devinant un UUID — le corps de la requête n'a plus
 * voix au chapitre sur la destination.
 *
 * Les deux préfixes sont acceptés : `eh_pk_` pour le SDK navigateur, `eh_sk_`
 * pour une source serveur. Le schéma ne fait que constater la forme — c'est
 * `ProjectKeysService.resolve` qui en tire la nature de la clé, et donc la
 * `source` de l'événement. Le client ne déclare jamais d'où il émet : il
 * présente une clé, et la clé le dit pour lui.
 *
 * Le format est vérifié ici pour que `eh_pk_truncat` produise un 400 lisible
 * plutôt qu'un 401 « clé inconnue » qui enverrait chercher au mauvais endroit.
 * Le fait que la clé *existe*, qu'elle soit active et que l'origine soit
 * autorisée n'est pas du ressort du schéma : voir `ProjectKeysService.resolve`.
 *
 * `strictObject` : une clé inconnue fait échouer la requête au lieu d'être
 * silencieusement ignorée. Sur une ingestion, un `occuredAt` mal orthographié
 * qui passe en 201 est le pire des scénarios — la donnée est perdue et
 * personne ne le sait.
 *
 * `occurredAt` est validé comme ISO 8601 *puis* converti en `Date` : c'est ce
 * que la colonne `timestamptz(3)` attend, et `new Date()` seul avale sans
 * broncher des formes qui ne sont pas de l'ISO 8601 (`"2026"`, `"aujourd'hui"`
 * selon le moteur). `offset: true` accepte aussi bien `…Z` que `…+02:00` —
 * Postgres range de toute façon un instant absolu normalisé UTC.
 *
 * Le `Date` JavaScript tronque de lui-même sous la milliseconde, donc une
 * entrée à 6 décimales est bornée ici, avant l'écriture : ce qui est écrit
 * reste égal à ce qui est relu.
 */
export const createEventSchema = z.strictObject({
  apiKey: z.string().regex(/^eh_(pk|sk)_[0-9a-f]{32}$/, {
    message:
      'Clé d’ingestion malformée : attendu « eh_pk_ » ou « eh_sk_ » suivi de 32 caractères hexadécimaux.',
  }),
  type: z.string().trim().min(1).max(128),
  occurredAt: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value)),
  // Libres par construction : leur forme dépend du `type`, elle n'est pas
  // contrainte ici. Absentes -> `{}`, jamais `null` (la colonne est NOT NULL).
  attributes: z.record(z.string(), z.unknown()).default({}),
  properties: z.record(z.string(), z.unknown()).default({}),
  /**
   * Le consentement du visiteur au dépôt d'un identifiant durable, tel que la
   * plateforme de consentement du client éditeur le rapporte.
   *
   * Optionnel à deux titres. Au sens du contrat d'abord : un SDK antérieur qui
   * ne l'envoie pas reste accepté, et c'est ce qui permet de l'ajouter sans
   * quitter `/v1`. Au sens du domaine ensuite — l'absence n'est **pas** un
   * refus, voir `decideVisitorCookie`.
   *
   * Champ de premier niveau, et jamais une clé d'`attributes` : les deux sacs
   * sont opaques pour le socle, y lire quoi que ce soit reviendrait à leur
   * supposer une forme.
   */
  consent: z.boolean().optional(),
});

/** Payload tel qu'il arrive sur le fil (`occurredAt` est une chaîne). */
export type CreateEventPayload = z.input<typeof createEventSchema>;

/** Payload validé et normalisé, tel que le service le reçoit. */
export type CreateEventDto = z.output<typeof createEventSchema>;
