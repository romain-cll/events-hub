import { z } from 'zod';

/**
 * `GET /v1/projects/:projectId/events` — le journal brut, page par page.
 *
 * ## Ce qui la sépare des deux routes analytiques
 *
 * Elles répondent à des questions ; celle-ci ne répond à rien. `/analytics`
 * rend des agrégats, `/analytics/sessions` rend un journal **replié en
 * sessions** — les deux savent ce qu'est une vue de page. Ici, aucune
 * interprétation : des événements bruts, avec leurs deux sacs `jsonb` intacts.
 *
 * C'est ce qui en fait la seule route générique sur le vocabulaire : un type
 * qu'aucun code ne connaît — celui qu'un client émettrait pour son propre métier
 * — y apparaît comme les autres, et se retrouve dans `types`. Les deux autres
 * routes ne le verraient pas.
 *
 * ## L'ordre est décroissant, et ce n'est pas un détail d'affichage
 *
 * Les événements sont rendus du plus **récent** au plus ancien. Un journal se
 * consulte par ce qui vient d'arriver : commencer par le plus vieux obligerait à
 * traverser toute la fenêtre pour voir la dernière minute.
 *
 * La pagination suit le même sens — la page suivante est **plus ancienne** — et
 * c'est aussi ce qui la rend sûre. En lecture décroissante, un événement ingéré
 * pendant le parcours s'insère en tête ; un rang le ferait réapparaître page
 * après page, là où le curseur ne bouge pas.
 */

/**
 * Un événement, tel que la route le rend. Sept champs, et deux absences qui
 * comptent autant que les présences.
 *
 * **Pas d'alias de visiteur.** La route voisine en porte un pour que le lecteur
 * puisse compter des visiteurs distincts ; ici la question ne se pose pas. Ce
 * qu'on regarde, c'est ce qu'un visiteur fait **pendant une session**, et
 * `sessionId` y suffit. L'alias serait de surcroît incohérent d'une page à
 * l'autre — il est tiré à chaque appel — donc trompeur : deux pages du même
 * journal donneraient deux jetons pour le même visiteur.
 *
 * **Pas d'identifiant d'événement.** L'`id` classe à l'intérieur du serveur, il
 * ne sort pas. Le publier inviterait à s'en faire une référence durable, ce que
 * rien ici ne promet. La position dans la page voyage dans `nextCursor`, qui est
 * opaque et ne vaut que pour redemander la suite.
 */
export const eventRowSchema = z.object({
  /**
   * La session à laquelle l'événement appartient.
   *
   * Attribuée à l'ingestion et persistée — ce n'est pas un regroupement refait
   * à la lecture. **Stable d'un appel à l'autre**, contrairement à l'alias de
   * visiteur de la route voisine : c'est ce qui permet de suivre un fil d'une
   * page de journal à la suivante.
   *
   * Ce qu'elle ne permet pas : relier deux sessions d'une même personne. Rien
   * dans cette réponse ne le rend possible, et c'est voulu.
   *
   * **`null` quand l'événement n'a pas de visiteur** — un deploy, un webhook de
   * paiement, une sonde d'uptime. Ce n'est pas une donnée qui manquerait : il
   * n'y a rien à rattacher, et il n'y aura jamais rien. C'est la seule route qui
   * rende ces événements, et c'est précisément ce qui en fait le journal du hub
   * plutôt que celui d'un outil d'analyse web.
   */
  sessionId: z.uuid().nullable(),
  /**
   * Le début **réel** de la session, même antérieur à `from`.
   *
   * Identique sur toutes les lignes d'une même session. Comparé à `from`, il
   * dit si le fil qu'on lit commence ici ou s'il était déjà en cours quand la
   * fenêtre s'est ouverte — un premier événement visible ne distingue pas les
   * deux cas.
   *
   * `null` exactement quand `sessionId` l'est : pas de session, pas de début.
   */
  sessionStartedAt: z.iso.datetime({ offset: true }).nullable(),
  /**
   * Le type, tel que l'émetteur l'a écrit.
   *
   * Aucune liste fermée : c'est une chaîne, pas une énumération, et le contrat
   * n'en connaît aucune valeur. Un `z.enum` ici figerait le vocabulaire du SDK
   * dans le contrat et refuserait à la validation le premier type métier qu'un
   * client inventerait.
   */
  type: z.string(),
  /**
   * D'où l'événement est entré.
   *
   * Une **énumération**, là où `type` juste au-dessus est une chaîne libre — et
   * la différence n'est pas une inconséquence. Les types sont inventés par les
   * clients, donc leur ensemble n'est pas connu ici et ne doit pas être fermé.
   * Les sources sont inventées par nous, dans le schéma : ajouter la troisième
   * serait notre propre déploiement, celui-là même où ce fichier changerait.
   *
   * Elle n'est pas déclarée par l'émetteur : le serveur la déduit de la nature
   * de la clé présentée. C'est ce qui la rend digne de confiance à l'affichage —
   * et ce qui permet de distinguer un événement **sans** visiteur d'un événement
   * dont la session n'aurait pas été résolue.
   */
  source: z.enum(['browser', 'server']),
  /** L'instant de l'événement, tel qu'il a été enregistré. */
  occurredAt: z.iso.datetime({ offset: true }),
  /**
   * Le contexte du navigateur au moment de l'événement — chemin, URL, langue,
   * dimensions d'écran, referrer.
   *
   * Un sac opaque, rendu **intact**. Le serveur n'en lit aucune clé sur ce
   * chemin, et le contrat n'en décrit donc aucune : les nommer ici en ferait une
   * promesse que l'ingestion ne tient pas — le SDK peut en ajouter, un appelant
   * direct peut en omettre.
   */
  attributes: z.record(z.string(), z.unknown()),
  /**
   * Ce que l'événement dit de lui-même, propre à son type.
   *
   * Même statut qu'`attributes` : opaque, intact, non décrit. C'est ce qui rend
   * un type inconnu affichable sans que rien ne le connaisse.
   */
  properties: z.record(z.string(), z.unknown()),
});

export type EventRow = z.infer<typeof eventRowSchema>;

/**
 * Une page du journal, et de quoi demander la suivante.
 *
 * ## Il n'y a pas de total, et il n'en manque pas
 *
 * Aucun `total`, aucun numéro de page. La pagination est un **curseur** : elle
 * sait dire « voici la suite », pas « voici la page 7 sur 34 ». Compter les
 * événements d'une fenêtre demanderait un `count(*)` sur toute la fenêtre à
 * chaque page — le coût exact que la pagination existe pour éviter.
 *
 * L'écran est dessiné pour s'en passer : il affiche la tranche de temps de la
 * page qu'il montre, ce qu'un curseur sait dire par construction.
 */
export const eventsPageSchema = z.object({
  /** Borne incluse. */
  from: z.iso.datetime({ offset: true }),
  /** Borne **exclue**. */
  to: z.iso.datetime({ offset: true }),
  /**
   * Les types présents dans la fenêtre, par ordre alphabétique.
   *
   * ⚠️ **Calculés en ignorant le filtre.** C'est le point important de ce
   * champ : ils décrivent la fenêtre, pas la sélection. Les filtrer ferait
   * rétrécir le menu à mesure qu'on s'en sert — on décoche un type et il
   * disparaît, donc on ne peut plus le recocher.
   *
   * Ils sont ce qui rend le filtre possible sans seconde route, et ils
   * n'existent que là : ni `/analytics` ni `/analytics/sessions` ne dit quels
   * types une fenêtre contient.
   */
  types: z.array(z.string()),
  /** La page, du plus récent au plus ancien. */
  events: z.array(eventRowSchema),
  /**
   * Le jeton à renvoyer en `?after=` pour la page suivante, ou `null` sur la
   * dernière.
   *
   * **Opaque** : sa forme appartient au serveur, et rien ne doit la lire ni la
   * fabriquer. `null` est la seule valeur qui ait un sens pour l'appelant — il
   * n'y a plus rien après.
   *
   * Il ne va que vers le passé : il n'existe pas de curseur « précédent ».
   * Remonter vers le présent, c'est réutiliser un jeton qu'on a déjà eu, ce que
   * l'appelant seul peut faire puisque lui seul les a vus passer.
   */
  nextCursor: z.string().nullable(),
});

export type EventsPage = z.infer<typeof eventsPageSchema>;
