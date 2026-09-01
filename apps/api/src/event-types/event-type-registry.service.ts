import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import {
  DRIZZLE,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from '../database/database.module';
import { eventTypes, type EventType } from '../database/schema';

/** Les colonnes rendues, nommées une fois pour les deux lectures. */
const PROJECTION = {
  id: eventTypes.id,
  name: eventTypes.name,
  label: eventTypes.label,
  serverOnly: eventTypes.serverOnly,
  createdAt: eventTypes.createdAt,
} as const;

/**
 * Un type tel qu'il est rendu : la ligne sans `projectId`.
 *
 * L'appelant l'a déjà — il est dans l'URL de la route — et le republier
 * inviterait un écran à s'en resservir plutôt qu'à le tenir de son contexte.
 * Même posture qu'`EventStore`, dont les projections sont listées une à une
 * pour qu'une colonne ajoutée demain ne sorte pas par simple inertie.
 */
export type ProjectEventType = Omit<EventType, 'projectId'>;

/** Ce qu'une route peut changer sur un type. Ni `name`, ni `projectId`. */
export interface EventTypePatch {
  label?: string | null;
  serverOnly?: boolean;
}

/**
 * Le registre des types d'un projet : son vocabulaire.
 *
 * ## Il inscrit, il ne filtre pas
 *
 * `register` est appelé à chaque ingestion et ne refuse jamais rien. Un type
 * inconnu entre dans la table et l'événement est écrit — voir le commentaire de
 * `event_types` pour le raisonnement complet, qui tient en une phrase : une
 * allowlist bloquante ne protège de rien que la clé ne protège déjà, et un 4xx
 * sur l'ingestion est de la donnée perdue.
 *
 * ## Il ne sait toujours pas ce qu'un type *signifie*
 *
 * Comme `EventStore`, ce service manipule des noms de types sans en connaître
 * aucun. Il n'en compare aucun à un littéral et n'indexe aucun comportement par
 * l'un d'eux — c'est ce que vérifie `architecture.spec.ts`, et c'est ce qui lui
 * permet de vivre dans le socle plutôt que dans `features/`.
 */
@Injectable()
export class EventTypeRegistry {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * Inscrit un type s'il ne l'est pas déjà.
   *
   * Prend la transaction de l'ingestion : l'inscription et l'écriture de
   * l'événement réussissent ou échouent ensemble. Un type inscrit pour un
   * événement qui n'a pas été écrit laisserait une entrée de vocabulaire qui ne
   * correspond à rien.
   *
   * `ON CONFLICT DO NOTHING` sur l'index unique `(project_id, name)` : le cas
   * courant — le type existe déjà — ne lit rien avant d'écrire et ne peut pas
   * perdre une course contre une ingestion concurrente.
   *
   * Le coût est un `INSERT` de plus par événement. Un cache mémoire des types
   * connus l'effacerait presque entièrement ; il n'est pas là parce que rien ne
   * l'a encore réclamé, et l'ajouter plus tard ne casse rien.
   */
  async register(
    tx: DrizzleTransaction,
    projectId: string,
    name: string,
  ): Promise<void> {
    await tx
      .insert(eventTypes)
      .values({ projectId, name })
      .onConflictDoNothing({
        target: [eventTypes.projectId, eventTypes.name],
      });
  }

  /** Le vocabulaire du projet, par ordre alphabétique de nom technique. */
  list(projectId: string): Promise<ProjectEventType[]> {
    return this.db
      .select(PROJECTION)
      .from(eventTypes)
      .where(eq(eventTypes.projectId, projectId))
      .orderBy(asc(eventTypes.name));
  }

  /**
   * Change le libellé, le drapeau `serverOnly`, ou les deux.
   *
   * `name` n'est pas modifiable, et ce n'est pas une omission : il est écrit sur
   * chaque ligne d'`events` et désigné par les filtres. Le renommer
   * orphelinerait tout l'historique du projet d'un coup. Le libellé existe
   * précisément pour que le besoin « je veux l'appeler autrement » ait une
   * réponse qui ne casse rien.
   *
   * Poser `serverOnly` est **rétroactif à la lecture** : les événements de ce
   * type déjà écrits depuis un navigateur cessent d'être rendus, sans être
   * détruits. Le retirer les fait revenir.
   */
  async update(
    projectId: string,
    id: string,
    patch: EventTypePatch,
  ): Promise<ProjectEventType> {
    const [updated] = await this.db
      .update(eventTypes)
      .set(patch)
      .where(and(eq(eventTypes.id, id), eq(eventTypes.projectId, projectId)))
      .returning(PROJECTION);

    if (!updated) {
      throw new NotFoundException("Ce type d'événement n'existe pas.");
    }

    return updated;
  }
}
