/**
 * De ce que quelqu'un tape à ce que l'API attend : une origine, au sens strict.
 *
 * ## Pourquoi une normalisation, et pas juste une validation
 *
 * L'API compare l'en-tête `Origin` d'un événement **à l'identique** avec ce
 * qu'on a enregistré, et refuse à l'écriture toute valeur qui n'est pas
 * exactement une origine — `https://acme.com/blog` est rejeté, pas tronqué. Sans
 * normalisation ici, quelqu'un qui colle l'URL de son site depuis sa barre
 * d'adresse — avec le chemin, la query, la barre finale — reçoit un 400 qui a
 * l'air d'un caprice.
 *
 * Le refus silencieux qui suivrait est pire encore : une origine mal déclarée ne
 * casse rien, elle fait juste que **rien n'arrive jamais**, sans message, sans
 * erreur, avec pour seule trace une ligne dans les journaux du serveur.
 *
 * ## Le port et le schéma ne sont pas décoratifs
 *
 * `https://acme.com` et `https://acme.com:8443` sont deux origines différentes,
 * et un site en `http://` n'enverra jamais `https://`. D'où le repli sur `http`
 * — et seulement — pour `localhost` et la boucle locale : c'est là que les gens
 * développent, aucun de ces serveurs n'est en TLS, et deviner `https` leur
 * donnerait une clé qui ne collecte rien sur leur propre machine.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i;

/** Ce que rend `parseOrigins` : la liste normalisée, ou la valeur fautive. */
export type ParsedOrigins =
  | { origins: string[]; invalid?: undefined }
  | { origins?: undefined; invalid: string };

/**
 * Découpe une saisie libre en origines normalisées, ou nomme la première fautive.
 *
 * Le séparateur est la virgule ou le retour à la ligne : un seul champ suffit
 * pour déclarer à la fois le site en production et le `localhost` sur lequel on
 * teste l'installation — ce sont deux origines distinctes, et n'en accepter
 * qu'une transformerait la première vérification en échec inexplicable.
 *
 * Les doublons sont écartés en silence : deux fois la même origine n'est pas une
 * faute, juste une saisie deux fois.
 */
export function parseOrigins(input: string): ParsedOrigins {
  const entries = input
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);

  const origins: string[] = [];

  for (const entry of entries) {
    const withScheme = /^https?:\/\//i.test(entry)
      ? entry
      : `${LOOPBACK.test(entry) ? 'http' : 'https'}://${entry}`;

    let parsed: URL;

    try {
      parsed = new URL(withScheme);
    } catch {
      return { invalid: entry };
    }

    // `URL` accepte des choses qui ne sont pas des sites — `https://` seul rend
    // un hôte vide, et l'API refuserait l'origine `https://` qui en sortirait.
    if (!parsed.hostname) return { invalid: entry };

    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }

  return { origins };
}
