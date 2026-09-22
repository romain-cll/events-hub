import { randomUUID } from 'node:crypto';

/**
 * Le cookie qui porte l'identité durable d'un visiteur consentant, et lui seul.
 *
 * ## Pourquoi il vit dans l'adaptateur HTTP
 *
 * Un cookie est une notion HTTP, au même titre qu'`Origin`. Le socle reçoit un
 * identifiant opaque et n'a jamais à savoir qu'il a voyagé dans un en-tête —
 * c'est la même frontière que celle posée dans `IngestionController`, et c'est
 * elle qui permettra à une autre source d'en présenter un autrement.
 *
 * ## Pourquoi `Partitioned`
 *
 * Le hub est servi depuis son propre domaine : côté visiteur, ce cookie est un
 * cookie **tiers**. Sans cet attribut il n'est pas raboté, il est *bloqué* —
 * Safari et Firefox les refusent tous par défaut. `Partitioned` le double-clé
 * par le site de premier niveau, donc il n'existe que sur le site où il a été
 * posé.
 *
 * Ce n'est pas une concession, c'est exactement la sémantique voulue : on
 * cherche une identité stable **à l'intérieur d'un projet**, jamais un suivi
 * d'un site client à l'autre. Le cloisonnement que le navigateur impose est
 * celui que `VisitorKeyService` impose déjà de son côté.
 *
 * Les deux autres pistes ont été écartées : un sous-domaine du client en CNAME
 * est justement le cas que Safari punit — il y voit du *CNAME cloaking* et
 * ramène le cookie à sept jours — et un reverse proxy sur l'origine du client
 * marche mais se paie en installation chez chacun d'eux. Il reste la porte de
 * sortie si le domaine du hub venait à être classé traqueur.
 *
 * ## Les attributs, un par un
 *
 * - `__Host-` : le préfixe interdit `Domain` et impose `Path=/` et `Secure`.
 *   Un sous-domaine ne peut donc pas écraser le cookie du hub.
 * - `SameSite=None` : la requête est intersite par construction, sans quoi le
 *   cookie ne partirait jamais.
 * - `Secure` : imposé par les deux précédents. Les navigateurs traitent
 *   `localhost` comme une origine sûre, le développement local n'en souffre pas.
 * - `Max-Age` de 13 mois, **posé une seule fois**. Voir juste en dessous : la
 *   durée et le refus de la prolonger sont la même décision.
 */
const NAME = '__Host-eh_vid';

/**
 * 13 mois, en secondes.
 *
 * ## Pourquoi 13 et pas les 400 jours que les navigateurs tolèrent
 *
 * Parce que le plafond technique n'est pas le plafond réglementaire. Chrome et
 * Firefox tronquent à 400 jours ; la CNIL, elle, recommande 13 mois pour un
 * traceur, consenti ou non. Viser le premier revenait à laisser la limite être
 * fixée par ce que le navigateur laisse passer, ce qui n'est pas un critère.
 *
 * ## Et surtout : il n'est plus réécrit
 *
 * Il l'était à **chaque** événement, ce qui en faisait une fenêtre glissante.
 * Un cookie « 13 mois » rechargé tous les jours ne dure pas 13 mois, il dure
 * pour toujours — la durée nominale ne décrit alors plus rien. C'est
 * précisément ce que la recommandation écarte : pas de prolongation automatique
 * à chaque visite.
 *
 * D'où la règle, dans `decideVisitorCookie` : on n'émet un `Set-Cookie` qu'à la
 * **pose**. Un cookie déjà présenté est honoré sans être touché, donc il expire
 * 13 mois après le jour où le visiteur a accepté, quoi qu'il fasse ensuite.
 *
 * ## Ce que ça coûte, et ce n'est pas rien
 *
 * L'identité durable tombe à 13 mois pile. Un abonné plus ancien cesse d'être
 * rattaché à sa visite d'acquisition : sa valeur vie se remet à courir sur une
 * identité neuve, et l'attribution de son revenu d'origine est perdue. Aucun
 * mécanisme ne la rattrape — c'est le prix, et il est assumé.
 *
 * Ce n'est pas à nous de le réduire : redemander le consentement avant
 * l'échéance appartient à la plateforme de consentement du site, qui est le
 * responsable de traitement. Nous, on constate la réponse.
 */
const MAX_AGE_SECONDS = 395 * 24 * 60 * 60;

const ATTRIBUTES = 'Path=/; Secure; SameSite=None; Partitioned';

/**
 * La valeur relue vient du navigateur du visiteur, donc de nulle part :
 * n'importe qui peut y mettre n'importe quoi. Contraindre la forme empêche du
 * bruit d'entrer dans l'espace des identifiants — ce n'est pas une frontière de
 * sécurité, et il n'y en a pas besoin ici : choisir sa propre identité de
 * visiteur n'affecte que soi, exactement comme effacer ses cookies.
 */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Ce que le cookie dicte pour cet événement, et ce qu'il faut lui répondre. */
export interface VisitorCookieDecision {
  visitorId?: string;
  visitorIdJustGranted?: boolean;
  retiredVisitorId?: string;
  /** L'en-tête `Set-Cookie` à poser, quand il y a lieu d'en poser un. */
  setCookie?: string;
}

/**
 * L'en-tête qui retire l'identité durable, pour les appelants qui doivent
 * l'effacer sans passer par une décision de consentement.
 *
 * Il n'y en a qu'un aujourd'hui : l'opposition. Un visiteur qui s'oppose au
 * traitement ne doit pas conserver l'identifiant qui le rendait suivable —
 * l'écarter des écritures tout en lui laissant son cookie serait un demi-geste.
 */
export function clearVisitorCookie(): string {
  return `${NAME}=; ${ATTRIBUTES}; Max-Age=0`;
}

/**
 * Traduit l'en-tête `Cookie` et le signal de consentement en une décision.
 *
 * ## Le signal est à trois états, et l'absence n'est pas un refus
 *
 * - **accordé** : on pose l'identifiant, ou on rafraîchit celui qui est là ;
 * - **retiré** : on efface le cookie, et l'identité repasse au réseau dès cet
 *   événement-ci — pas au suivant ;
 * - **absent** : le client n'a pas de plateforme de consentement, ou n'a rien à
 *   dire de nouveau. On n'écrit rien, mais on continue d'honorer le cookie
 *   présent : son existence *est* la trace d'un consentement antérieur.
 *
 * Confondre le troisième avec le deuxième effacerait l'identité de tous les
 * visiteurs à la première requête d'un client qui ne câble pas le signal.
 *
 * ## Pourquoi le cookie est l'unique état
 *
 * Il n'y a ni réglage par projet, ni table de consentement. C'est le client
 * éditeur qui est responsable de traitement, pas nous : la preuve du
 * consentement lui incombe, et la dupliquer ici nous ferait conserver de la
 * donnée que personne ne nous demande. La révocation cesse alors d'être un
 * chemin de code — on supprime le cookie, et le mode dérivé reprend seul.
 */
export function decideVisitorCookie(
  cookieHeader: string | undefined,
  consent: boolean | undefined,
): VisitorCookieDecision {
  const presented = readVisitorId(cookieHeader);

  if (consent === true) {
    // Déjà posé : on l'honore et on n'y touche pas. Répondre un `Set-Cookie`
    // ici rechargerait l'échéance à chaque événement, et les 13 mois ne
    // voudraient plus rien dire — voir `MAX_AGE_SECONDS`.
    if (presented !== undefined) return { visitorId: presented };

    const visitorId = randomUUID();

    return {
      visitorId,
      // Un identifiant qu'on vient de forger n'a pas de passé : c'est cet
      // événement-là, et lui seul, qui fait la bascule.
      visitorIdJustGranted: true,
      setCookie: `${NAME}=${visitorId}; ${ATTRIBUTES}; Max-Age=${MAX_AGE_SECONDS}`,
    };
  }

  if (consent === false) {
    // Rien à retirer, rien à dire : ne pas répondre un `Set-Cookie` d'effacement
    // à qui n'en a jamais eu évite d'annoncer un cookie à chaque événement de
    // l'immense majorité des visiteurs.
    if (presented === undefined) return {};

    return {
      retiredVisitorId: presented,
      setCookie: `${NAME}=; ${ATTRIBUTES}; Max-Age=0`,
    };
  }

  return { visitorId: presented };
}

/**
 * Lit un cookie nommé dans l'en-tête brut.
 *
 * Écrit à la main plutôt qu'avec `cookie-parser` : ce dernier est un middleware,
 * il tournerait donc sur toutes les routes de l'API pour un unique lecteur, sur
 * une seule d'entre elles.
 */
function readVisitorId(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;

  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;

    if (pair.slice(0, separator).trim() !== NAME) continue;

    const value = pair.slice(separator + 1).trim();

    return UUID_V4.test(value) ? value : undefined;
  }

  return undefined;
}
