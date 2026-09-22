import type { Campaign } from '../browser/campaign.ts';
import type { EventAttributes, EventProperties } from '../types.ts';

/** L'événement tel qu'il part sur le fil, dans la forme qu'attend le hub. */
export interface EventEnvelope {
  /**
   * La clé publique du projet — elle a remplacé `projectId`.
   *
   * Le hub ne laisse plus le client désigner sa cible : la clé la désigne pour
   * lui, ce qui empêche d'écrire dans le projet d'autrui en devinant un UUID.
   */
  apiKey: string;
  type: string;
  occurredAt: string;
  attributes: EventAttributes;
  properties: EventProperties;
  /**
   * Le consentement du visiteur au dépôt d'un identifiant durable.
   *
   * Absent tant que le site n'a rien déclaré, et l'absence n'est pas un refus :
   * le hub continue d'honorer un identifiant déjà posé. C'est ce qui permet à
   * un site sans plateforme de consentement de ne rien câbler du tout.
   */
  consent?: boolean;
  /**
   * L'opposition du visiteur au traitement, quand il vient de l'exprimer.
   *
   * Ne voyage que sur l'événement qui la porte : côté hub c'est un cookie qui
   * fait foi ensuite, donc la répéter n'apprendrait rien.
   */
  optOut?: boolean;
  /**
   * Les paramètres de campagne lus dans l'URL, s'il y en a.
   *
   * Champ de premier niveau, jamais une clé d'`attributes` : les deux sacs sont
   * opaques pour le hub, et il ne peut pas y chercher ce qu'il doit exploiter.
   * Même statut que `consent`.
   *
   * Absent la plupart du temps : la plupart des visites n'arrivent par aucune
   * campagne, et la plupart des sites n'en posent jamais.
   */
  campaign?: Campaign;
}

/**
 * Sans quoi rien du mode consenti ne fonctionne.
 *
 * Le défaut de `fetch` est `same-origin`, et le hub est par construction sur
 * une autre origine que le site instrumenté : le navigateur n'enverrait aucun
 * cookie, et surtout n'enregistrerait pas celui que la réponse pose. Le mode
 * sans consentement, lui, n'en a pas besoin — c'est le seul endroit du SDK où
 * cette ligne se voit.
 *
 * `sendBeacon`, en repli plus bas, envoie déjà les credentials sans qu'on le
 * lui demande. Il ne peut pas lire la réponse, ce qui est sans importance : le
 * `Set-Cookie` est appliqué par le navigateur, pas par nous.
 */
const CREDENTIALS = 'include' as const;

/**
 * POST classique, pour tout ce qui est émis pendant que la page vit.
 *
 * Rend le corps renvoyé par le hub (l'événement persisté, id compris). En cas
 * de réponse non-2xx, lève une `Error` qui porte le statut *et* le corps : les
 * 400 du hub détaillent les champs fautifs, les jeter rendrait l'erreur
 * inexploitable.
 */
export async function postEvent(
  endpoint: string,
  envelope: EventEnvelope,
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
    credentials: CREDENTIALS,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[analytics] ${envelope.type} refusé : ${response.status} ${response.statusText} — ${body}`,
    );
  }

  return response.json();
}

/**
 * Envoi « la page part » : `fetch` + `keepalive`, `sendBeacon` en repli.
 *
 * Un `fetch` ordinaire lancé depuis `pagehide` est annulé avec le document — on
 * perdrait exactement l'événement qu'on cherche à capturer. `keepalive` lève
 * cette annulation : le navigateur mène la requête à terme après la mort de la
 * page, et rend la main immédiatement, ce qui permet aussi de ne pas retarder
 * la navigation sortante d'une seule milliseconde.
 *
 * ## Pourquoi pas `sendBeacon` en premier
 *
 * C'est l'outil canonique pour ça, et il ne marche pas ici. Le hub parse du
 * `application/json`, qui n'est pas un Content-Type « simple » au sens du CORS :
 * la requête est donc précédée d'un preflight `OPTIONS`. Or `sendBeacon` ne
 * garde pas cette paire en vie au déchargement — mesuré sur Chrome contre l'API
 * locale, le preflight part, le POST jamais. `keepalive`, lui, couvre le
 * preflight *et* la requête.
 *
 * Les deux contournements classiques coûtent plus cher qu'ils ne rapportent :
 * poster en `text/plain` (safelisted, sans preflight) obligerait le Core à
 * accepter un Content-Type qui ment sur son contenu, et servir l'ingestion sur
 * la même origine que chaque site client n'est pas une option.
 *
 * `sendBeacon` reste donc en repli, pour les navigateurs sans `keepalive` : sur
 * un endpoint de même origine il n'y a pas de preflight, et il fait le travail.
 *
 * Rien n'est rendu et rien n'est levé : à ce stade la page n'existe plus, il
 * n'y a plus personne pour lire un résultat ou rattraper une erreur.
 */
export function beaconEvent(endpoint: string, envelope: EventEnvelope): void {
  const body = JSON.stringify(envelope);

  if (supportsKeepalive()) {
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: CREDENTIALS,
    }).catch(() => {
      // Sans page pour l'afficher ni appelant pour la rattraper, l'erreur n'a
      // nulle part où aller. On l'avale plutôt que de laisser un rejet non géré.
    });

    return;
  }

  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(
      endpoint,
      new Blob([body], { type: 'application/json' }),
    );
  }
}

/**
 * `keepalive` est-il supporté ?
 *
 * Test sur le prototype plutôt que sur une requête construite : pas d'URL à
 * fournir, donc pas de cas d'échec parasite. `fetch` ignore silencieusement une
 * option qu'il ne connaît pas — sans ce test, un vieux navigateur enverrait un
 * `fetch` ordinaire qui mourrait avec la page, sans rien signaler.
 */
function supportsKeepalive(): boolean {
  return typeof Request !== 'undefined' && 'keepalive' in Request.prototype;
}
