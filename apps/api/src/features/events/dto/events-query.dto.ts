import { z } from 'zod';

import { isEventCursor } from '../../../events/event-store.service';

/** Fenêtre appliquée quand l'appelant n'en demande pas : les 7 derniers jours. */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/**
 * `to` est résolu d'abord, comme dans le module Analytics : un `?from=` seul
 * doit donner « depuis cette date jusqu'à maintenant ».
 */
function resolve<T>({
  from,
  to,
  ...rest
}: T & { from?: Date; to?: Date }): T & { from: Date; to: Date } {
  const upper = to ?? new Date();

  return {
    ...(rest as T),
    from: from ?? new Date(upper.getTime() - DEFAULT_WINDOW_MS),
    to: upper,
  };
}

/**
 * Une liste de types, écrite en une valeur séparée par des virgules.
 *
 * ## Pourquoi une chaîne et pas un paramètre répété
 *
 * `?types=a&types=b` est ambigu à l'arrivée : un seul `?types=a` donne une
 * chaîne, deux donnent un tableau, et le schéma doit rattraper les deux formes.
 * Une valeur unique n'a qu'une forme, donc qu'une lecture.
 *
 * ## Une liste vide n'existe pas ici
 *
 * `?types=` est refusé plutôt qu'interprété. Dans une query string, « aucun
 * type » et « pas de filtre » ne se distinguent pas — les deux s'écrivent
 * pareil ou presque, et confondre les deux rendrait tout le journal là où
 * l'appelant n'attendait rien. Un client qui n'a rien sélectionné n'a pas de
 * question à poser : il n'appelle pas.
 */
const types = z
  .string()
  .transform((value) => value.split(','))
  .refine((list) => list.every((type) => type.length > 0), {
    message: '`types` ne doit pas contenir de valeur vide.',
  });

/**
 * L'entrée de `GET /v1/projects/:projectId/events` : une fenêtre, un filtre,
 * une position.
 *
 * ## Le strict n'est pas décoratif
 *
 * `strictObject`, comme pour les routes analytiques : un paramètre inconnu
 * déclenche un 400 au lieu d'être ignoré. Sur une route de lecture, un filtre
 * silencieusement ignoré rend une page qui a l'air d'être la bonne — c'est le
 * genre d'erreur qu'on ne voit jamais.
 *
 * ## Le curseur est validé, pas décodé
 *
 * `isEventCursor` vient du Core, qui est le seul à connaître la forme du jeton.
 * Ce fichier ne la lit pas : il demande « est-ce un des tiens ? ». Sans ce
 * garde, un `?after=` bricolé — ou simplement tronqué par un copier-coller —
 * remonterait en 500 depuis les entrailles du store, alors que c'est une
 * requête malformée et rien d'autre.
 */
export const eventsQuerySchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
    types: types.optional(),
    after: z
      .string()
      .refine(isEventCursor, {
        message: '`after` n’est pas un curseur valide.',
      })
      .optional(),
  })
  .transform(resolve)
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Requête validée et résolue, telle que le service la reçoit. */
export type EventsQueryDto = z.output<typeof eventsQuerySchema>;
