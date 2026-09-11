/**
 * La campagne d'une visite, normalisée, ou rien.
 *
 * `null` sur chaque champ plutôt qu'une chaîne vide : une chaîne vide n'est pas
 * une information, et obligerait chaque lecture en aval à distinguer deux cas
 * qui n'en font qu'un.
 */
export interface Campaign {
  source: string | null;
  medium: string | null;
  name: string | null;
}

/** Ce que le fil apporte, tel quel — casse et espaces compris. */
export interface RawCampaign {
  source?: string;
  medium?: string;
  name?: string;
}

/**
 * Au-delà, ce n'est plus un nom de campagne.
 *
 * Tronquer plutôt que refuser : la valeur reste exploitable, et jeter la ligne
 * ferait perdre la visite entière pour un libellé aberrant. La colonne est
 * indexée, et une query n'est bornée par rien.
 */
const MAX = 200;

/**
 * Normalise ce que le SDK a lu dans l'URL, une fois pour tous les clients.
 *
 * ## Pourquoi ici et pas dans le SDK
 *
 * Parce que c'est une règle qui doit valoir pour tout le monde en même temps. Si
 * chaque version du SDK normalisait à sa façon, deux visiteurs d'un même site
 * produiraient deux campagnes distinctes selon la date du bundle qu'ils ont
 * chargé — et rien ne le signalerait, sinon un classement qui se dédouble.
 *
 * C'est aussi ce qui justifie une colonne plutôt qu'un sac : la règle de
 * rangement ne dit pas « client-fourni donc jsonb » — `type` et `occurredAt`
 * sont fournis par le client et sont des colonnes. Elle dit qu'on ne laisse pas
 * un client écrire une valeur **que le serveur est censé garantir**. Ici le
 * serveur garantit la normalisation, le moment où elle est figée, et la
 * joignabilité de ce qui en sort.
 *
 * ## Les minuscules, et ce qu'elles coûtent
 *
 * Les plateformes publicitaires et les humains mélangent les casses : sans cette
 * ligne, `Newsletter`, `newsletter` et `NEWSLETTER` font trois campagnes dans un
 * classement, et rien ne dit que c'est la même. Le prix est un libellé en
 * minuscules à l'affichage, assumé — c'est déjà la posture retenue pour les
 * hôtes référents.
 */
export function normalizeCampaign(
  raw: RawCampaign | undefined,
): Campaign | null {
  if (!raw) return null;

  const campaign: Campaign = {
    source: clean(raw.source),
    medium: clean(raw.medium),
    name: clean(raw.name),
  };

  // Les trois vides valent « pas de campagne » : écrire trois `NULL` en base
  // plutôt qu'une ligne qui prétend en porter une.
  return campaign.source ?? campaign.medium ?? campaign.name
    ? campaign
    : null;
}

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;

  const normalized = value.trim().toLowerCase().slice(0, MAX);

  return normalized || null;
}
