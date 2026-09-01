import { z } from 'zod';

/**
 * `GET` et `PATCH` sur `/v1/projects/:projectId/event-types` — le vocabulaire
 * d'un projet.
 *
 * ## Il n'y a pas de `POST`, et c'est le point
 *
 * Un type est créé par l'**ingestion**, à sa première apparition, jamais à la
 * main. C'est ce qui permet à un client d'inventer son propre type métier sans
 * rien déclarer chez nous au préalable — la promesse même du hub. Ces deux
 * routes ne servent qu'à *décorer* et *restreindre* ce qui est déjà arrivé.
 */
export const eventTypeSchema = z.object({
  id: z.uuid(),
  /**
   * La clé technique, en `snake_case`, telle qu'elle est écrite sur chaque
   * événement.
   *
   * **Immuable** : aucune route ne la modifie. Elle est référencée par tous les
   * événements déjà écrits et par les filtres du journal ; la renommer
   * orphelinerait l'historique du projet d'un coup.
   */
  name: z.string(),
  /**
   * Le libellé d'affichage, ou `null`.
   *
   * `null` ne veut pas dire « vide » mais **« jamais nommé »** : l'interface
   * retombe alors sur `name`. La distinction se voit, et c'est voulu — quelqu'un
   * qui a délibérément saisi le même texte que le nom technique n'est pas dans
   * le même état que quelqu'un qui n'a rien fait.
   */
  label: z.string().nullable(),
  /**
   * Seule une source serveur peut légitimement émettre ce type.
   *
   * Le drapeau agit **à la lecture** : les événements de ce type venus d'un
   * navigateur cessent d'être rendus, sans être détruits. C'est ce qui le rend
   * rétroactif — poser le drapeau après coup fait disparaître ce qui a été
   * forgé avant, ce qu'aucun contrôle à l'écriture ne saurait faire.
   *
   * Faux par défaut : un client peut vouloir des funnels web sur ses propres
   * types, et un défaut restrictif casserait le cas courant pour couvrir le cas
   * rare.
   */
  serverOnly: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type EventType = z.infer<typeof eventTypeSchema>;

export const eventTypesSchema = z.array(eventTypeSchema);
