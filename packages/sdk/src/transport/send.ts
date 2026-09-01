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
}

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
