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
 * ## Le consentement, transporté et jamais demandé
 *
 * Le SDK ne montre aucun bandeau et n'en montrera jamais : le responsable de
 * traitement est le site client, pas le hub. Ce qu'il fait, c'est **relayer**
 * la décision que la plateforme de consentement du site a déjà prise, via
 * `setConsent()`. Un site qui n'appelle rien reste parfaitement fonctionnel,
 * dans le mode qui ne dépose rien sur le terminal.
 *
 * Quand le consentement est accordé, le hub rend l'identifiant durable du
 * visiteur avec chaque réponse, et le SDK en dépose une copie lisible sur le
 * domaine du site — voir `browser/visitor-mirror.ts`. C'est cette copie que le
 * backend du site joint à ses paiements ; c'est elle qui permettra de dire quel
 * revenu vient de quelle visite.
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
import { collectCampaign } from './browser/campaign.ts';
import { mirrorVisitorId } from './browser/visitor-mirror.ts';
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
  /** URL complète de la route d'ingestion, ex. `http://localhost:3003/v1/events`. */
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
  /**
   * Le consentement du visiteur, s'il est déjà connu à la construction.
   *
   * Rarement le cas — une plateforme de consentement répond après le démarrage
   * de la page. D'où `setConsent()`, qui est la voie normale ; cette option
   * n'est là que pour un site qui aurait déjà la réponse sous la main, et pour
   * éviter de devoir appeler une méthode juste après le constructeur.
   */
  consent?: boolean;
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
  /**
   * `undefined` tant que rien n'a été déclaré, et c'est un troisième état, pas
   * un `false` en attente : le hub honore alors un identifiant déjà posé au
   * lieu de l'effacer. Confondre les deux ferait perdre son identité à tout
   * visiteur d'un site qui ne câble pas le signal.
   */
  private consent: boolean | undefined;
  /** Le dernier identifiant rendu par le hub. Jamais forgé ici. */
  private visitorId: string | undefined;
  /**
   * La visite en cours, telle que le hub l'a découpée. Jamais forgée ici non
   * plus, et **jamais recopiée dans un cookie** : c'est ce qui lui permet
   * d'exister sans consentement. Voir `getSessionId()`.
   */
  private sessionId: string | undefined;
  /**
   * A-t-on déjà répercuté une réponse depuis le chargement de la page ?
   *
   * Sans ce drapeau, la première réponse *sans* identifiant serait confondue
   * avec l'état initial et n'effacerait rien — laissant survivre une copie
   * posée lors d'une visite précédente, alors que le consentement a été retiré
   * entre-temps.
   */
  private mirrored = false;
  /**
   * L'opposition, portée par le prochain événement puis oubliée.
   *
   * Remise à `undefined` une fois partie : la répéter à chaque événement ne
   * changerait rien côté hub, où c'est le cookie qui fait foi. C'est ce qui
   * distingue ce champ de `consent`, dont le site réaffirme la valeur aussi
   * longtemps qu'elle vaut.
   */
  private optingOut: boolean | undefined;
  /**
   * De quoi arrêter ce que `start()` a démarré, sans que l'appelant ait à nous
   * rendre le `Teardown` qu'il a peut-être jeté. Un site qui s'oppose ne doit
   * pas continuer d'émettre parce qu'il a oublié de le garder.
   */
  private stopCollectors: Teardown = () => undefined;

  constructor({ apiKey, endpoint, onError, consent }: AnalyticsOptions) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.onError = onError ?? (() => undefined);
    this.consent = consent;
  }

  /**
   * Rapporte la décision de la plateforme de consentement du site.
   *
   * À appeler à chaque fois qu'elle change, dans les deux sens : accorder pose
   * un identifiant durable côté hub, retirer l'efface. Rien n'est envoyé à cet
   * instant — la décision voyage avec le prochain événement, ce qui évite une
   * requête dont le seul contenu serait un booléen.
   *
   * Il n'y a donc rien à nettoyer et rien à attendre : le retrait prend effet
   * au premier événement qui suit, et si aucun ne suit, il n'y avait rien à
   * rattacher.
   */
  setConsent(granted: boolean): void {
    this.consent = granted;
  }

  /**
   * Enregistre l'opposition du visiteur au traitement, tout entier.
   *
   * ## Ce n'est pas `setConsent(false)`
   *
   * Le consentement ne porte que sur l'identifiant durable : le refuser laisse
   * la mesure d'audience se faire, sans rien déposer sur le terminal. S'opposer
   * l'arrête. Les deux répondent à deux questions différentes, et un site qui a
   * un bandeau a besoin des deux — l'un pour son bandeau, l'autre pour le lien
   * d'opposition de sa politique de confidentialité.
   *
   * ## Ce que ça fait, et dans quel ordre
   *
   * Les collecteurs démarrés sont arrêtés immédiatement, et un dernier
   * événement part porter la décision — c'est lui qui la fait enregistrer côté
   * hub, et il est écarté à l'arrivée sans rien écrire. Sans cet envoi, le
   * refus ne vivrait que dans cet onglet et serait oublié au rechargement.
   *
   * `optIn()` fait le chemin inverse. Il ne redémarre **pas** les collecteurs :
   * ce n'est pas à nous de décider qu'un site veut recommencer à mesurer, et
   * `start()` est là pour ça.
   */
  optOut(): void {
    this.stopCollectors();
    this.declareOptOut(true);
  }

  /** Retire une opposition. Ne redémarre rien — voir `optOut()`. */
  optIn(): void {
    this.declareOptOut(false);
  }

  /**
   * Le dernier identifiant durable rendu par le hub, s'il y en a un.
   *
   * Pour les sites qui construisent leur paiement en JS. Ceux qui le
   * construisent côté serveur n'en ont pas besoin : ils lisent la copie déposée
   * dans leurs propres cookies, et c'est le chemin recommandé — il ne dépend
   * d'aucun ordre d'exécution.
   *
   * Synchrone, donc `undefined` tant qu'aucune réponse n'est revenue. Le rendre
   * asynchrone déplacerait l'attente dans le code du site pour ne rien y
   * gagner : un paiement arrive toujours après une navigation.
   */
  getVisitorId(): string | undefined {
    return this.visitorId;
  }

  /**
   * La visite en cours, à joindre au paiement quand il n'y a pas de
   * consentement.
   *
   * ## Ce qu'elle permet, et ce qu'elle ne permet pas
   *
   * Elle rattache un paiement à la visite qui l'a produit, donc à la source
   * d'où cette visite venait. Un achat conclu pendant la navigation est
   * attribué ; un achat conclu trois jours plus tard s'attribue à la visite de
   * ce jour-là, dont le referrer est le plus souvent vide — le trafic direct
   * est donc sur-crédité, et le canal d'acquisition sous-crédité. Un
   * renouvellement d'abonnement, lui, n'a aucune visite derrière lui et reste
   * hors d'atteinte.
   *
   * Tout cela, `getVisitorId()` le résout — au prix d'un consentement. Préférez
   * l'identifiant durable quand il existe, celui-ci quand il n'existe pas.
   *
   * ## Pourquoi il n'y a pas de cookie miroir
   *
   * Parce que ce serait renoncer à ce qui la rend intéressante. Le miroir de
   * `visitorId` existe parce que sa source est un cookie de notre domaine, que
   * le site ne peut pas lire ; ici il n'y a pas de source à recopier, et poser
   * un cookie ferait rentrer par la fenêtre le consentement qu'on évite.
   *
   * Le site transmet donc cette valeur lui-même à son backend, au moment où il
   * construit son paiement. C'est du travail pour lui, et c'est le prix.
   *
   * Synchrone, donc `undefined` tant qu'aucune réponse n'est revenue.
   */
  getSessionId(): string | undefined {
    return this.sessionId;
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
    const body = await postEvent(
      this.endpoint,
      this.envelope(type, properties),
    );

    this.receive(body);

    return body;
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

      postEvent(this.endpoint, envelope)
        .then((body) => {
          this.receive(body);
        })
        .catch(this.onError);
    };

    const teardowns: Teardown[] = [];

    // Retenu ici pour qu'`optOut()` puisse tout arrêter sans que l'appelant ait
    // à nous rendre le `Teardown` qu'on lui a donné.
    this.stopCollectors = () => {
      for (const stop of teardowns) stop();
      teardowns.length = 0;
    };

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
  /**
   * Répercute ce que le hub vient de dire de ce visiteur.
   *
   * Le SDK n'invente jamais d'identifiant : il n'y a ici que de la recopie. La
   * réponse fait autorité dans les deux sens — elle en porte un, on l'écrit ;
   * elle n'en porte plus, on efface.
   *
   * L'écriture est conditionnée au changement pour ne pas toucher
   * `document.cookie` à chaque événement, ce qui n'apporterait rien : la copie
   * porte déjà sa propre durée de vie.
   *
   * La lecture est défensive parce que le transport rend `unknown` : un corps
   * vide (une origine refusée répond 204) ou une forme inattendue ne doit pas
   * faire échouer un envoi qui, lui, a réussi.
   */
  /**
   * Envoie la décision, puis l'oublie.
   *
   * Par `beacon` plutôt que par `fetch` : `optOut()` est souvent appelé depuis
   * un gestionnaire de clic qui navigue dans la foulée, et une requête ordinaire
   * serait annulée au déchargement — le refus serait perdu au moment précis où
   * il compte. Rien n'est attendu en retour : la réponse est un 204 vide.
   */
  private declareOptOut(refused: boolean): void {
    this.optingOut = refused;

    if (typeof window === 'undefined') return;

    beaconEvent(this.endpoint, this.envelope('opt_out', {}));
    this.optingOut = undefined;

    // Le miroir sur le domaine du site n'a plus de raison d'être : il ne sert
    // qu'à joindre un identifiant à un paiement, et il n'y a plus d'identifiant.
    if (refused) {
      this.visitorId = undefined;
      mirrorVisitorId(undefined);
    }
  }

  private receive(body: unknown): void {
    // Avant la garde de recopie, et pas après : elle ne parle que du cookie
    // miroir. Un visiteur sans consentement n'a jamais d'identifiant durable,
    // donc la garde est vraie à chaque événement — y ranger la session
    // reviendrait à ne l'enregistrer que pour les visiteurs consentants, c'est
    // à dire exactement ceux qui n'en ont pas besoin.
    this.sessionId = readString(body, 'sessionId');

    const visitorId = readString(body, 'visitorId');

    if (this.mirrored && visitorId === this.visitorId) return;

    this.mirrored = true;
    this.visitorId = visitorId;
    mirrorVisitorId(visitorId);
  }

  private envelope(type: string, properties: EventProperties): EventEnvelope {
    const campaign = collectCampaign();

    return {
      apiKey: this.apiKey,
      type,
      occurredAt: new Date().toISOString(),
      attributes: collectAttributes(),
      properties,
      // Étalé plutôt que posé à `undefined` : le schéma du hub refuse les clés
      // inconnues, et une clé présente à `undefined` disparaît certes de la
      // sérialisation, mais laisse le type mentir sur ce qui part.
      ...(this.consent === undefined ? {} : { consent: this.consent }),
      ...(this.optingOut === undefined ? {} : { optOut: this.optingOut }),
      // Relue à **chaque** événement, comme les attributs : après une navigation
      // interne l'URL a changé, et c'est celle du moment qui compte. Le hub, lui,
      // n'en retient que celle de l'ouverture de session — décider quand figer
      // est son travail, pas le nôtre.
      ...(campaign ? { campaign } : {}),
    };
  }
}

/**
 * Lit une chaîne dans un corps de réponse.
 *
 * Défensive parce que le transport rend `unknown` : un corps vide (une origine
 * refusée répond 204) ou une forme inattendue ne doit pas faire échouer un envoi
 * qui, lui, a réussi. Une clé absente et une clé d'un autre type mènent au même
 * endroit, et c'est voulu — il n'y a rien à distinguer entre les deux.
 */
function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null || !(key in body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === 'string' ? value : undefined;
}
