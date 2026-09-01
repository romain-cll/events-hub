import { Injectable } from '@nestjs/common';

import { EventStore, type EventEntry } from '../../events/event-store.service';
import type { EventsQueryDto } from './dto/events-query.dto';

/**
 * Combien d'événements une page porte.
 *
 * Décidé ici, pas exposé dans l'API publique — même posture que le classement
 * des pages du module voisin. C'est ce module qui répond à « montre-moi le
 * journal », et vingt lignes est sa réponse : de quoi lire une visite entière
 * d'un coup d'œil sans faire défiler.
 *
 * Un `?limit=` ouvert serait une borne haute à défendre et à documenter, pour
 * une demande que personne n'a formulée. Le jour où elle vient, c'est un
 * paramètre ajouté délibérément, avec son plafond.
 */
const PAGE_SIZE = 20;

/**
 * Ce que `GET /v1/projects/:projectId/events` promet.
 *
 * Le seul module du projet qui ne sait pas ce qu'est un type d'événement — et
 * qui ne doit pas l'apprendre.
 */
export interface EventsPage {
  /** Borne incluse. */
  from: Date;
  /** Borne exclue. */
  to: Date;
  /**
   * Les types présents dans la fenêtre, filtre non appliqué.
   *
   * Voir `EventStore.distinctTypes`, dont la signature rend l'erreur
   * impossible : ils décrivent la fenêtre, jamais la sélection.
   */
  types: string[];
  events: EventEntry[];
  /** `null` sur la dernière page. */
  nextCursor: string | null;
}

/**
 * Le journal brut, page par page.
 *
 * ## Ce que ce module fait, et c'est tout
 *
 * Deux lectures, mises dans une enveloppe. Aucun repliage, aucun classement,
 * aucun total, aucune provenance classée — rien de ce que fait le module
 * Analytics. C'est un module métier par son emplacement et par sa route, pas
 * par ce qu'il sait : il est le seul de `features/` à n'interpréter aucun type.
 *
 * ## Pourquoi il n'est pas dans `events/`
 *
 * `EventsModule` se décrit comme « l'accès à la table `events`, et rien
 * d'autre », et il n'est pas monté dans `AppModule` : le socle n'a pas de
 * contrôleur, et lui en donner un pour cette route l'aurait rendu joignable
 * par HTTP pour la première fois. La route est donc ici, voisine d'Analytics,
 * derrière le même guard.
 *
 * La contrepartie est réelle et assumée : `architecture.spec.ts` ne scanne pas
 * `features/`, donc rien dans la *forme* n'empêche ce fichier d'apprendre un
 * jour ce qu'est un `page_view`. C'est le **comportement** qui le tient —
 * `events-route.e2e-spec.ts` ingère un type inventé et exige de le retrouver
 * dans la page comme dans les facettes.
 *
 * ## Les deux requêtes ne sont pas redondantes
 *
 * La page dit ce que la fenêtre contient **sous le filtre**, les facettes
 * disent ce qu'elle contient **sans lui**. Les tirer de la même requête
 * demanderait de lire toute la fenêtre pour en dédoublonner la colonne `type`,
 * ce que la pagination existe précisément pour éviter.
 */
@Injectable()
export class EventsService {
  constructor(private readonly events: EventStore) {}

  async list({
    projectId,
    from,
    to,
    types,
    after,
  }: EventsQueryDto & { projectId: string }): Promise<EventsPage> {
    const window = { projectId, from, to };

    const [page, present] = await Promise.all([
      this.events.page({ ...window, types }, { limit: PAGE_SIZE, after }),
      this.events.distinctTypes(window),
    ]);

    return { from, to, types: present, ...page };
  }
}
