import { z } from 'zod';

/**
 * Ce que `PATCH /v1/projects/:projectId/event-types/:id` accepte.
 *
 * **`name` n'y figure pas**, et c'est le point du fichier. Il est écrit sur
 * chaque ligne d'`events` et désigné par les filtres du journal : le renommer
 * orphelinerait l'historique du projet d'un coup. `strictObject` fait qu'une
 * tentative produit un 400 explicite plutôt qu'un champ ignoré en silence —
 * quelqu'un qui essaie doit apprendre que `label` existe pour ça.
 *
 * Les deux champs sont optionnels mais l'objet ne peut pas être vide : un PATCH
 * qui ne demande rien est presque toujours un bug d'appelant, et le laisser
 * répondre 200 masquerait un champ mal orthographié côté client.
 */
export const updateEventTypeSchema = z
  .strictObject({
    /**
     * `null` remet le type à « jamais nommé » : l'interface réaffiche alors
     * `name`. C'est distinct de la chaîne vide, qui n'est pas acceptée — un
     * libellé vide serait une ligne blanche à l'écran, pas un retour au défaut.
     */
    label: z.string().trim().min(1).max(64).nullable().optional(),
    serverOnly: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message:
      'Rien à modifier : indiquez « label », « serverOnly », ou les deux.',
  });

export type UpdateEventTypeDto = z.output<typeof updateEventTypeSchema>;
