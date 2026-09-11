/**
 * L'opposition du visiteur, et les deux voies par lesquelles elle arrive.
 *
 * ## Pourquoi il en faut une, alors qu'on ne demande rien
 *
 * Le mode par défaut n'inscrit rien sur le terminal et ne lit rien : il sort du
 * champ qui impose un consentement préalable. Mais il traite quand même une
 * donnée personnelle — une clé dérivée reste un pseudonyme — et il le fait au
 * titre de l'intérêt légitime. Ce fondement-là s'achète : il oblige à offrir un
 * moyen **simple et accessible** de s'y opposer, sans avoir à se justifier.
 *
 * Il n'y en avait aucun. C'est ce que ce fichier corrige.
 *
 * ## Deux voies, et elles ne se remplacent pas
 *
 * **`Sec-GPC`** est un en-tête que le navigateur envoie de lui-même quand son
 * porteur a exprimé un refus global. Il ne demande aucune action au site, ne
 * coûte rien à personne, et il est déjà opposable dans plusieurs juridictions.
 * Son défaut est qu'il dépend du navigateur : la plupart ne l'envoient pas.
 *
 * **Le cookie** couvre le reste — un visiteur qui clique le lien d'opposition
 * de la politique de confidentialité du site. Il faut alors s'en souvenir, donc
 * écrire sur le terminal.
 *
 * ## Écrire pour mémoriser un refus n'appelle pas de consentement
 *
 * C'est le cas d'école du « strictement nécessaire » : exiger un consentement
 * pour enregistrer une opposition reviendrait à demander l'autorisation
 * d'obéir. La CNIL nomme d'ailleurs explicitement le cookie de refus parmi les
 * traceurs exemptés.
 *
 * Le cookie ne porte donc **aucun identifiant** — la valeur est un `1`. Un
 * opt-out qui distinguerait les gens serait le traceur qu'on vient d'éteindre.
 */
const NAME = '__Host-eh_optout';

/**
 * Les mêmes attributs que le cookie de visiteur, et pour les mêmes raisons :
 * servi depuis le domaine du hub, c'est un cookie tiers, donc `Partitioned` ou
 * il est refusé. Voir `visitor-cookie.ts`.
 */
const ATTRIBUTES = 'Path=/; Secure; SameSite=None; Partitioned';

/**
 * 13 mois, comme le cookie de visiteur.
 *
 * Le plafond s'applique aussi à un refus : rien ne permet de présumer qu'une
 * décision d'il y a deux ans vaut encore. À l'échéance le visiteur retombe dans
 * le régime par défaut, où il pourra s'opposer de nouveau.
 *
 * Il est en revanche **rafraîchi** à chaque événement, contrairement à celui du
 * visiteur, et l'asymétrie est voulue : prolonger un refus ne dessert personne,
 * alors que prolonger une identité contourne la limite qui la borne.
 */
const MAX_AGE_SECONDS = 395 * 24 * 60 * 60;

/** Ce que l'opposition dicte pour cet événement. */
export interface OptOutDecision {
  /**
   * Faut-il écarter l'événement sans rien écrire ?
   *
   * Vrai dans deux cas qu'il ne faut pas confondre : le visiteur est opposé, ou
   * cet événement-ci **porte une décision** — s'opposer comme s'y soustraire.
   * Un porteur n'est pas une mesure : l'écrire inscrirait son type au
   * vocabulaire du projet et ferait apparaître dans les analyses un événement
   * que personne n'a émis pour être compté.
   */
  refused: boolean;
  /** L'en-tête `Set-Cookie` à poser, quand il y a lieu d'en poser un. */
  setCookie?: string;
}

/**
 * Tranche si cet événement doit être écarté, et ce qu'il faut répondre.
 *
 * ## Le signal explicite l'emporte sur tout
 *
 * `optOut === true` pose le cookie ; `false` l'efface. Entre les deux, un
 * visiteur qui n'a rien dit de nouveau : son cookie, s'il en a un, continue de
 * valoir — son existence *est* la trace d'une opposition antérieure. C'est la
 * même logique à trois états que le consentement, et confondre l'absence avec
 * une révocation ressusciterait tous les opposants au premier événement.
 *
 * ## `Sec-GPC` écarte mais n'écrit rien
 *
 * Parce qu'il n'y a rien à mémoriser : le navigateur le renverra à chaque
 * requête. Poser un cookie pour retenir ce qu'on nous redira de toute façon
 * serait écrire sur le terminal sans raison — l'exemption couvre le nécessaire,
 * pas le superflu.
 *
 * Conséquence à connaître : un visiteur qui désactive `Sec-GPC` reprend
 * immédiatement le régime par défaut, et c'est cohérent — il vient de retirer
 * le signal qui portait son refus.
 */
export function decideOptOut(
  cookieHeader: string | undefined,
  globalPrivacyControl: string | undefined,
  optOut: boolean | undefined,
): OptOutDecision {
  if (optOut === true) {
    return {
      refused: true,
      setCookie: `${NAME}=1; ${ATTRIBUTES}; Max-Age=${MAX_AGE_SECONDS}`,
    };
  }

  if (optOut === false) {
    // Écarté aussi, et pour l'autre raison : le traitement reprend dès
    // l'événement suivant, mais celui-ci ne porte qu'une décision.
    if (!hasOptedOut(cookieHeader)) return { refused: true };

    return { refused: true, setCookie: `${NAME}=; ${ATTRIBUTES}; Max-Age=0` };
  }

  return {
    refused: hasOptedOut(cookieHeader) || honoursGpc(globalPrivacyControl),
  };
}

/**
 * `Sec-GPC: 1`, et rien d'autre.
 *
 * La spécification ne définit que cette valeur : un en-tête absent, vide ou
 * portant `0` ne dit pas « je refuse », il ne dit rien. Traiter toute présence
 * comme un refus écarterait du trafic sur un en-tête mal formé.
 */
function honoursGpc(header: string | undefined): boolean {
  return header?.trim() === '1';
}

/**
 * Lit le cookie d'opposition.
 *
 * La valeur n'est pas contrôlée, contrairement à l'identifiant de visiteur :
 * ici la seule question est « ce cookie est-il là ». Il n'y a pas d'espace
 * d'identifiants à protéger du bruit, et un visiteur qui bricole la valeur pour
 * se faire écarter obtient exactement ce qu'il demandait.
 */
function hasOptedOut(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;

  return cookieHeader
    .split(';')
    .some((pair) => pair.slice(0, pair.indexOf('=')).trim() === NAME);
}
