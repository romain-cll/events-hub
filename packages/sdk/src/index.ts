/**
 * Client d'ingestion pour `POST /v1/events`.
 *
 * Deux usages, un seul chemin de sortie :
 *
 * - `track()` pour les événements métier, que seul le site connaît ;
 * - `start()` pour les collecteurs automatiques, qui transforment les signaux
 *   natifs du navigateur en `page_view`, `click`, `submit`, `outbound_click` et
 *   `page_leave`.
 *
 * Le SDK reste sans file d'attente, sans batching et sans retry : un événement,
 * une requête. La session, l'identification et le suivi d'erreurs n'existent
 * pas non plus ici — il s'agit d'abord de vérifier qu'on sait produire un flux
 * d'événements propre.
 *
 * ## Frontière entre `attributes` et `properties`
 *
 * `attributes` appartient au SDK. Ce sont les clés pointées et namespacées
 * (`page.*`, `browser.*`, `screen.*`) qu'il lit lui-même dans le navigateur,
 * et elles sont les **mêmes quel que soit l'événement**. L'appelant n'y écrit
 * pas : c'est ce qui permet de garantir en aval que `page.path` veut dire la
 * même chose sur tous les sites instrumentés, et donc de construire des
 * requêtes analytiques dessus. Le jour où on ajoute une clé, tous les clients
 * en bénéficient sans toucher à leur code.
 *
 * `properties` décrit **cet événement-là**. Pour un `track()` manuel, c'est le
 * métier — `plan`, `cartValue`, `articleId` — que le SDK ne peut pas deviner et
 * sur lequel il ne fait aucune hypothèse ; il le transmet tel quel. Pour un
 * événement collecté, c'est le collecteur qui le remplit (`navigation.type`,
 * `element.tag`, `leave.reason`), puisque c'est lui l'appelant.
 *
 * Cette séparation est la raison pour laquelle le deuxième argument de
 * `track()` alimente `properties` et non `attributes` : rien de ce que passe un
 * site ne doit pouvoir se faire passer pour du contexte collecté.
 */
import { collectAttributes } from './browser/attributes.ts';
import { trackClicks } from './tracking/click.ts';
import { trackOutboundClicks } from './tracking/outbound-click.ts';
import { trackPageLeave } from './tracking/page-leave.ts';
import { trackPageViews } from './tracking/page-view.ts';
import { trackSubmits } from './tracking/submit.ts';
import {
  beaconEvent,
  postEvent,
  type EventEnvelope,
} from './transport/send.ts';
import type { Emit, EventProperties, Teardown } from './types.ts';

export type { EventAttributes, EventProperties, Teardown } from './types.ts';
export type { NavigationType } from './browser/history.ts';
export type { LeaveReason } from './tracking/page-leave.ts';

export interface AnalyticsOptions {
  /**
   * Clé d'ingestion publique du projet, de la forme `eh_pk_…`.
   *
   * Elle est **publique par construction** : ce fichier tourne dans le
   * navigateur de vos visiteurs, donc elle est lisible dans le bundle. Ce n'est
   * pas une fuite, c'est son statut — elle identifie un projet, elle n'ouvre
   * aucun accès en lecture. Les origines autorisées à s'en servir se déclarent
   * côté hub, dans les réglages du projet.
   */
  apiKey: string;
  /** URL complète de la route d'ingestion, ex. `http://localhost:3001/v1/events`. */
  endpoint: string;
  /**
   * Appelé quand l'envoi d'un événement **collecté** échoue.
   *
   * Par défaut, rien : un endpoint injoignable ne doit pas remplir la console
   * d'un site qui n'y peut rien, à chaque clic. Le brancher pendant le
   * développement rend le SDK débogable sans avoir à le modifier.
   *
   * Ne concerne pas `track()`, dont la promesse rejette et appartient à
   * l'appelant.
   */
  onError?: (error: unknown) => void;
}

/**
 * Quels collecteurs démarrer. Tous par défaut.
 *
 * Chaque clé porte le nom de l'événement produit — désactiver `pageLeave`
 * revient exactement à ne plus recevoir de `page_leave`, sans avoir à savoir
 * quels signaux du navigateur le fabriquent.
 */
export interface CollectorOptions {
  pageView?: boolean;
  pageLeave?: boolean;
  click?: boolean;
  submit?: boolean;
  outboundClick?: boolean;
}

export class Analytics {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly onError: (error: unknown) => void;

  constructor({ apiKey, endpoint, onError }: AnalyticsOptions) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.onError = onError ?? (() => undefined);
  }

  /**
   * Envoie un événement et rend le corps renvoyé par le hub (l'événement
   * persisté, id compris).
   *
   * `analytics.track('checkout_completed', { plan: 'pro' })` : le contexte
   * navigateur est collecté ici, `properties` ne sert qu'à ce que le SDK ne
   * peut pas savoir.
   *
   * La promesse rejette si le hub refuse — c'est voulu, l'appelant d'un
   * événement métier a de quoi réagir. Les événements collectés, eux, passent
   * par `onError`.
   */
  async track(
    type: string,
    properties: EventProperties = {},
  ): Promise<unknown> {
    return postEvent(this.endpoint, this.envelope(type, properties));
  }

  /**
   * Démarre les collecteurs automatiques et rend de quoi les débrancher.
   *
   * Le démarrage est explicite plutôt que fait dans le constructeur : brancher
   * des écouteurs globaux et poster un `page_view` en construisant un objet
   * rendrait le SDK impossible à instancier sous rendu serveur et pénible à
   * tester. `new Analytics(...)` ne fait rien d'observable ; `start()` fait
   * tout.
   *
   * L'ordre de branchement est le contrat d'ordre des événements : `page_view`
   * initial d'abord, puis `click` avant `outbound_click` — les écouteurs d'un
   * même nœud sont appelés dans leur ordre d'enregistrement.
   *
   * Hors navigateur, ne fait rien et rend un débranchement vide : appeler
   * `start()` dans un composant rendu des deux côtés doit être sans effet, pas
   * une erreur.
   */
  start(collectors: CollectorOptions = {}): Teardown {
    if (typeof window === 'undefined') return () => undefined;

    const {
      pageView = true,
      pageLeave = true,
      click = true,
      submit = true,
      outboundClick = true,
    } = collectors;

    const emit: Emit = (type, properties = {}, { beacon = false } = {}) => {
      const envelope = this.envelope(type, properties);

      if (beacon) {
        beaconEvent(this.endpoint, envelope);
        return;
      }

      postEvent(this.endpoint, envelope).catch(this.onError);
    };

    const teardowns: Teardown[] = [];

    if (pageView) teardowns.push(trackPageViews(emit));

    // Créé avant les collecteurs de clic : c'est `outboundClick` qui déclenche
    // le départ, et il a besoin du même compteur de déduplication que les
    // signaux `pagehide` / `visibilitychange`.
    const leaveTracker = pageLeave ? trackPageLeave(emit) : null;
    if (leaveTracker) teardowns.push(leaveTracker.stop);

    if (click) teardowns.push(trackClicks(emit));
    if (submit) teardowns.push(trackSubmits(emit));
    if (outboundClick) {
      teardowns.push(
        trackOutboundClicks(emit, () => leaveTracker?.leave('outbound_click')),
      );
    }

    return () => {
      // À l'envers du branchement : les monkey-patchs de l'History API se
      // dépilent dans l'ordre inverse de leur pose.
      for (const teardown of teardowns.reverse()) teardown();
    };
  }

  /**
   * Construit le corps envoyé au hub.
   *
   * Il est assemblé ici, jamais fusionné avec ce que passe l'appelant : le
   * schéma du hub est strict et refuse les clés inconnues, donc une faute de
   * frappe côté appelant ferait échouer l'ingestion au lieu d'être ignorée.
   *
   * `occurredAt` est daté au moment de l'appel : c'est l'instant que le client
   * observe. `toISOString()` produit exactement la forme ISO 8601 UTC que le
   * schéma attend.
   */
  private envelope(type: string, properties: EventProperties): EventEnvelope {
    return {
      apiKey: this.apiKey,
      type,
      occurredAt: new Date().toISOString(),
      attributes: collectAttributes(),
      properties,
    };
  }
}
