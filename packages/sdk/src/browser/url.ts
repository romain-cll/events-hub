/**
 * Identité d'une page pour l'anti-doublon de `page_view`.
 *
 * `pathname + search` et rien d'autre. Le hash est délibérément ignoré : il
 * sert aussi bien de route (`#/pricing`) que d'ancre dans la page (`#faq`), et
 * tant que cette ambiguïté n'est pas tranchée, compter un `page_view` par ancre
 * cliquée gonflerait les chiffres sans que personne ne comprenne pourquoi.
 *
 * `search` est en revanche gardé : `?page=2` et `?page=3` sont deux pages.
 */
export function pageKey(
  location: Pick<Location, 'pathname' | 'search'> = window.location,
): string {
  return `${location.pathname}${location.search}`;
}

/**
 * La page précédente **du même site**, quand on peut l'établir — sinon `null`.
 *
 * C'est la moitié MPA de `navigation.from`. Sur un site classique, chaque
 * navigation interne recharge le document : il n'y a ni `pushState` à observer
 * ni page précédente en mémoire, et la seule trace de l'enchaînement est
 * `document.referrer`. Rendue sous la même forme que `pageKey()` — chemin +
 * query, sans origine — pour qu'une SPA et un MPA produisent exactement la même
 * valeur pour le même parcours.
 *
 * Un referrer d'une autre origine rend `null` : c'est une *source*, pas une page
 * précédente. Il reste intégralement dans `page.referrer`, qui ne perd rien.
 *
 * L'origine, pas le « site » : protocole, hôte et port. Un sous-domaine compte
 * donc comme externe. C'est la seule frontière que le navigateur définit sans
 * ambiguïté — décider que `blog.exemple.com` et `exemple.com` sont « le même
 * site » demande une liste de suffixes publics, et se tromperait sur les sites
 * qui hébergent réellement des clients différents par sous-domaine.
 */
export function internalReferrer(): string | null {
  if (!document.referrer) return null;

  const referrer = resolveUrl(document.referrer);
  if (!referrer || referrer.origin !== window.location.origin) return null;

  return pageKey(referrer);
}

/**
 * Lit une URL **absolue**, ou rend `null` si ce n'en est pas une.
 *
 * Les deux appelants en fournissent une par construction : la propriété DOM
 * `anchor.href` est toujours absolue (c'est le navigateur qui l'a résolue), et
 * `document.referrer` aussi. Aucune base n'est donc passée à `new URL` — et
 * c'est délibéré. Avec une base, une chaîne qui n'est pas une URL du tout
 * (`"pas une URL"`) serait résolue *relativement* à la page courante et
 * ressortirait en `https://site.test/pas%20une%20URL` : une valeur de même
 * origine, parfaitement plausible, entièrement fausse. Mieux vaut `null`.
 *
 * `new URL` lève sur ce qu'on ne peut pas lire : on préfère ne pas classer
 * plutôt que faire tomber un gestionnaire d'événement — et avec lui la page
 * hôte.
 */
export function resolveUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Le lien quitte-t-il l'origine courante ?
 *
 * Restreint à `http(s)` sciemment. `mailto:`, `tel:` et `javascript:` n'ont pas
 * d'origine au sens du navigateur (`url.origin` y vaut la chaîne `"null"`) et
 * ne provoquent pas de navigation : les compter comme sorties ferait apparaître
 * des « destinations » qui ne sont pas des sites.
 */
export function isOutbound(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  return url.origin !== window.location.origin;
}
