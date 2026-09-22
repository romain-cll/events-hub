/**
 * Les paramètres de campagne présents dans l'URL, s'il y en a.
 *
 * ## Pourquoi le SDK les extrait, plutôt que le serveur
 *
 * Parce que le serveur n'a pas le droit de les chercher. Les deux sacs
 * `attributes` et `properties` lui sont opaques — c'est un invariant testé — et
 * `page.url`, où les UTM vivent, en fait partie. Y lire quoi que ce soit
 * reviendrait à leur supposer une forme, et le premier module qui le ferait
 * ouvrirait la porte au suivant.
 *
 * Le précédent est `consent` : une valeur que le client fournit et que le
 * serveur exploite voyage en **champ de premier niveau**, déclaré par le
 * serveur, jamais comme une clé glissée dans un sac.
 *
 * ## Ce qui n'est pas fait ici, et qui l'est côté serveur
 *
 * Aucune normalisation : ni casse, ni espaces, ni longueur. `Newsletter` et
 * `newsletter` partent tels quels. C'est volontaire — si chaque version du SDK
 * normalisait à sa façon, deux visiteurs du même site produiraient deux
 * campagnes différentes selon la date de leur bundle, et rien ne le signalerait.
 * Une règle qui doit valoir pour tous les clients vit là où il n'y en a qu'une.
 *
 * ## Ce qu'on ne prend pas
 *
 * `utm_term` et `utm_content` répondent à « quelle création », pas à « quelle
 * campagne rapporte ». Ils restent dans `page.url`, entiers, et pourront être
 * promus le jour où la question existe.
 *
 * `gclid` et `fbclid` non plus : ils identifient un **clic**, pas une campagne.
 * En tirer une source reviendrait à fabriquer un fait — la même erreur que
 * transformer une absence de referrer en « accès direct ».
 */
export interface Campaign {
  source?: string;
  medium?: string;
  name?: string;
}

export function collectCampaign(): Campaign | undefined {
  // Même garde que `collectAttributes` : un `track()` peut partir d'un rendu
  // serveur, où `window` n'existe pas.
  if (typeof window === 'undefined') return undefined;

  const params = new URLSearchParams(window.location.search);

  const campaign: Campaign = {
    source: params.get('utm_source') ?? undefined,
    medium: params.get('utm_medium') ?? undefined,
    // `name` et pas `campaign` : `campaign.campaign` ne se lit pas.
    name: params.get('utm_campaign') ?? undefined,
  };

  // Rien à dire vaut mieux qu'un objet vide : le serveur distingue « pas de
  // campagne » de « campagne aux champs vides », et un objet toujours présent
  // effacerait cette distinction dès le fil.
  return campaign.source ?? campaign.medium ?? campaign.name
    ? campaign
    : undefined;
}
