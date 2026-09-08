/**
 * La copie du visitorId sur le domaine du site, à l'usage de son backend.
 *
 * ## Pourquoi une copie
 *
 * L'identifiant durable vit dans un cookie posé par le hub, sur le domaine du
 * hub, partitionné. Ni le JS ni le backend du site ne peuvent le lire — c'est
 * une autre origine, et c'est exactement ce qui lui permet de tenir 400 jours
 * là où un cookie posé en JS serait ramené à sept par Safari.
 *
 * Mais le site en a besoin : c'est lui qui doit joindre cet identifiant à son
 * paiement pour qu'on sache, plus tard, quelle visite l'a produit. D'où cette
 * copie, lisible par son backend dans `req.cookies` comme n'importe quel cookie
 * à lui.
 *
 * ## Ce que la copie n'est pas
 *
 * Ce n'est **pas** une mémoire, c'est un coursier. Elle ne fait jamais autorité :
 * le SDK n'y lit rien, il ne fait qu'y écrire ce que le hub vient de lui dire.
 * Safari peut donc l'effacer au bout de sept jours sans que rien ne soit perdu —
 * la source, elle, n'a pas bougé, et la visite suivante réécrit la copie.
 *
 * C'est tout l'intérêt d'avoir deux cookies plutôt qu'un : celui qui dure n'a
 * pas besoin d'être lisible, et celui qui est lisible n'a pas besoin de durer.
 *
 * ## Les attributs
 *
 * - `SameSite=Lax` et non `None` : cette copie ne sert qu'aux requêtes du site
 *   vers son propre backend, jamais en intersite.
 * - Pas de `Domain` : elle reste sur l'hôte exact, pas sur les sous-domaines.
 * - `Secure` seulement en HTTPS — un site servi en clair pendant son
 *   développement verrait sinon le cookie refusé sans rien dire.
 * - Pas de `HttpOnly`, et ça n'a rien d'un oubli : c'est ce script qui l'écrit.
 *   Un script tiers de la page peut donc la lire, comme chez tous les analytics
 *   navigateur. La valeur est opaque, elle ne donne accès à rien, et elle
 *   n'entre dans aucune lecture de revenu — c'est la metadata du paiement qui
 *   fait foi, et elle est posée côté serveur.
 */
const NAME = 'eh_visitor_id';

/** 400 jours, comme la source — sans effet sur Safari, correct ailleurs. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Écrit la copie, ou l'efface quand il n'y a plus d'identifiant.
 *
 * L'effacement n'est pas une symétrie de confort. Sans lui, une copie posée
 * avant un retrait de consentement survivrait jusqu'à 400 jours et continuerait
 * de partir dans les paiements du site — on attribuerait du revenu à un visiteur
 * qui a précisément demandé à ne plus l'être.
 *
 * Inerte hors navigateur : le SDK doit pouvoir être instancié sous rendu
 * serveur sans rien casser, comme `start()` l'est déjà.
 */
export function mirrorVisitorId(visitorId: string | undefined): void {
  if (typeof document === 'undefined') return;

  const attributes = `Path=/; SameSite=Lax${isSecure() ? '; Secure' : ''}`;

  document.cookie = visitorId
    ? `${NAME}=${visitorId}; ${attributes}; Max-Age=${MAX_AGE_SECONDS}`
    : `${NAME}=; ${attributes}; Max-Age=0`;
}

function isSecure(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}
