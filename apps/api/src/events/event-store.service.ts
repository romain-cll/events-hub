import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { alias } from 'drizzle-orm/pg-core';

import {
  DRIZZLE,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from '../database/database.module';
import {
  eventTypes,
  events,
  sessions,
  type Event,
  type EventSource,
  type NewEvent,
} from '../database/schema';
import { retentionCutoff } from '../retention/cutoff';

/**
 * Combien de valeurs distinctes `topValues` rend par défaut.
 *
 * Un défaut existe parce que la cardinalité d'une clé JSON n'est bornée par
 * rien : une clé qui porte une URL complète peut avoir autant de valeurs
 * distinctes qu'il y a d'événements. Rendre tout par défaut ferait d'un appel
 * distrait une requête qui ramène des dizaines de milliers de lignes. Un
 * appelant qui veut plus le demande — la troncature est documentée, jamais
 * silencieuse.
 */
const DEFAULT_TOP_LIMIT = 10;

/**
 * La taille d'un alias de visiteur, en octets tirés au hasard.
 *
 * Neuf octets donnent douze caractères en base64url — 72 bits, sans padding.
 * Le dimensionnement ne vise pas la résistance à une attaque : l'alias ne
 * protège rien par sa longueur, il ne dit rien de son visiteur, et il ne vaut
 * que le temps d'une réponse. Il vise l'**unicité dans une lecture**, avec une
 * marge qui rend la collision non pas improbable mais hors de question — il
 * faudrait de l'ordre de deux milliards de visiteurs distincts dans une seule
 * fenêtre pour l'atteindre une fois sur deux.
 *
 * Ce qui compte, et qui n'est pas la longueur : le tirage est **refait à chaque
 * appel**. Un compteur (`v1`, `v2`, `v3`) ou un `dense_rank()` SQL suffiraient à
 * l'unicité et seraient stables d'une lecture à l'autre — deux réponses
 * deviendraient joignables, et l'alias ne vaudrait pas mieux que la clé qu'il
 * remplace.
 */
const ALIAS_BYTES = 9;

/**
 * Ce sur quoi un module veut compter.
 *
 * `types` est le seul point où un module dit ce qui l'intéresse. Le Core ne
 * connaît la signification d'aucun type : il sait filtrer une colonne, c'est
 * tout. Omettre `types`, c'est prendre tous les événements du projet — le bon
 * périmètre pour parler d'audience.
 */
export interface EventScope {
  projectId: string;
  /** Borne incluse. */
  from: Date;
  /** Borne exclue. */
  to: Date;
  /**
   * Restreint à ces types d'événement. Absent : tous les types.
   *
   * Une **liste**, et pas un type unique, depuis que le journal se lit avec un
   * filtre à cocher : « les clics et les sorties » est une question aussi
   * légitime que « les vues de page », et l'exprimer avec un champ singulier
   * aurait demandé deux requêtes puis une fusion côté appelant.
   *
   * Un tableau **vide** ne veut pas dire « tous » : il ne sélectionne rien, et
   * `inArray` le traduit fidèlement. C'est la lecture littérale, et c'est la
   * seule qui ne surprenne pas — le contraire ferait d'un filtre qui n'a rien
   * gardé un filtre qui rend tout.
   */
  types?: string[];
}

/**
 * Où lire une valeur : l'une des deux colonnes jsonb de l'événement, et une
 * clé dedans.
 *
 * `source` est un ensemble fermé de deux valeurs, résolu en référence de
 * colonne — jamais en SQL construit par concaténation. `key`, elle, est libre
 * et vient de l'appelant : elle part donc en **paramètre lié**, au même titre
 * qu'une valeur de `where`. C'est ce qui fait qu'une clé biscornue rend une
 * liste vide au lieu d'exécuter quoi que ce soit.
 *
 * Le Core ne sait pas ce que la clé désigne, et il n'a pas à le savoir : il
 * groupe une colonne. Que `attributes` porte des chemins de page ou que
 * `properties` porte des noms d'erreur ne change pas une ligne d'ici.
 */
export interface ValueSelector {
  source: 'attributes' | 'properties';
  /** La clé JSON à grouper, telle que l'émetteur l'a écrite. */
  key: string;
  /** Nombre de valeurs rendues. Défaut : 10. */
  limit?: number;
}

/**
 * Les colonnes de `sessions` sur lesquelles un classement peut porter.
 *
 * **Un ensemble fermé, et c'est la propriété de sécurité du mécanisme.** Le
 * grain vient d'un paramètre de requête ; le résoudre ici en référence de
 * colonne, par un objet dont les clés sont connues à la compilation, garantit
 * qu'aucune chaîne d'appelant n'atteint jamais le SQL. Même posture que
 * `ValueSelector.source`, qui choisit entre deux colonnes jsonb.
 *
 * Ajouter une entrée ici est un geste délibéré, dans un diff : c'est ce qui
 * empêche un `column` « générique » de devenir une porte ouverte sur toute la
 * table — la clé visiteur y vit.
 */
export const SESSION_COLUMNS = {
  countryCode: sessions.countryCode,
  region: sessions.region,
  city: sessions.city,
  browser: sessions.browser,
  os: sessions.os,
  deviceType: sessions.deviceType,
} as const;

export type SessionColumn = keyof typeof SESSION_COLUMNS;

/** Une ligne de classement par attribut de session. */
export interface SessionValueCount {
  /**
   * La seconde colonne qui départage, quand l'appelant en demande une.
   *
   * Elle existe pour la géographie : sans elle, deux villes homonymes dans deux
   * pays fusionneraient en une ligne, et le planisphère n'aurait rien sur quoi
   * se joindre. Un classement par navigateur n'a rien à départager — l'appelant
   * n'en demande pas, et le champ vaut `null`.
   *
   * Le nom est neutre exprès : c'est le socle, et rien ici ne sait ce qu'est un
   * pays.
   */
  qualifier: string | null;
  /** La valeur du grain demandé. */
  value: string;
  visitors: number;
  sessions: number;
}

/**
 * Un classement géographique **et sa couverture**.
 *
 * Les deux voyagent ensemble parce qu'un classement sans le nombre de ceux
 * qu'il n'a pas su placer se lit comme s'il couvrait tout le trafic. Ce ne
 * serait pas une imprécision, ce serait faux : une base GeoIP ne connaît pas
 * toutes les plages, et une IP privée n'a pas de pays.
 */
export interface SessionValueRanking {
  rows: SessionValueCount[];
  /** Visiteurs distincts dont la valeur du grain est inconnue. */
  unresolved: number;
}

/** Sur quelle colonne de session porte le classement, et jusqu'où. */
export interface SessionValueSelector {
  column: SessionColumn;
  /**
   * La colonne qui départage les homonymes, quand il y en a.
   *
   * Absente, le classement ne groupe que sur `column` et `qualifier` vaut
   * `null`. C'est le cas par défaut : la plupart des grains n'ont rien à
   * départager, et rendre un champ qui ne veut rien dire obligerait chaque
   * lecture à l'expliquer.
   */
  qualifier?: SessionColumn;
  /** Nombre de lignes rendues. Défaut : 10. */
  limit?: number;
}

/**
 * Une valeur et son poids.
 *
 * `events` et `visitors` répondent à deux questions différentes — « combien de
 * fois » et « par combien de monde » — et les deux sont rendues ensemble parce
 * qu'un appelant qui n'aurait que la première referait une requête par ligne
 * pour obtenir la seconde.
 *
 * `visitors` ne s'additionne pas d'une valeur à l'autre : quelqu'un qui a
 * touché trois valeurs compte dans les trois lignes. La somme des `visitors`
 * d'un classement dépasse donc `countVisitors()` sur le même périmètre, et ce
 * n'est pas une incohérence.
 */
export interface ValueCount {
  /** Toujours du texte : `->>` rend la forme textuelle quel que soit le type JSON. */
  value: string;
  events: number;
  visitors: number;
}

/**
 * Un événement rendu tel quel, sans agrégation.
 *
 * C'est une ligne de la table amputée de ce qui ne regarde pas l'appelant :
 * `projectId` est déjà le sien — il l'a passé dans le périmètre — et `id` n'a
 * de rôle qu'ici, comme départage d'un `occurred_at` à égalité. Le publier
 * inviterait un module à s'en resservir comme d'une référence stable, alors
 * que rien dans le Core ne promet qu'un événement reste lisible par son
 * identifiant.
 *
 * Les deux sacs `jsonb` sortent **entiers**. Le Core ne sait pas quelle clé
 * intéresse l'appelant ; lui en laisser choisir une reviendrait à lui demander
 * ce qu'il cherche, donc à commencer à le savoir.
 */
/**
 * La campagne d'une session, telle que la lecture la rend.
 *
 * Le socle ne sait pas ce qu'une campagne *signifie* — il rend trois libellés
 * qu'il a lui-même normalisés et figés, et c'est tout ce qu'il en dit.
 */
export interface SessionCampaign {
  source: string | null;
  medium: string | null;
  name: string | null;
}

/**
 * Où lire un montant, et dans quelle devise il est libellé.
 *
 * Deux clés plutôt qu'une, et la seconde n'est pas un ornement : sans devise, un
 * total additionne des euros et des yens en silence. Le Core ne convertit rien —
 * il **sépare**, ce qui est la seule chose qu'une base de données puisse faire
 * honnêtement sans taux de change ni date de taux.
 *
 * Comme pour `ValueSelector`, le Core ne sait pas ce que ces clés désignent : il
 * additionne ce qu'il trouve à l'endroit qu'on lui nomme, dans l'unité où
 * l'émetteur l'a écrit.
 */
export interface AmountSelector {
  source: 'attributes' | 'properties';
  /** La clé du montant. Seules les valeurs entières sont additionnées. */
  amount: string;
  /** La clé de la devise. Elle sépare les totaux, elle ne les convertit pas. */
  currency: string;
  /** Nombre de lignes classées. Défaut : 10. */
  limit?: number;
}

/**
 * Le pas d'une série temporelle.
 *
 * Ensemble **fermé**, et c'est la propriété de sécurité : la valeur vient d'une
 * URL et finit dans un `date_trunc`, qui prend son unité en texte. La résoudre
 * ici, par un objet dont les clés sont connues à la compilation, garantit
 * qu'aucune chaîne d'appelant n'atteint le SQL.
 */
export const SERIES_STEPS = ['day', 'week', 'month'] as const;

export type SeriesStep = (typeof SERIES_STEPS)[number];

/** Un point de la série : un pas, une devise, un total. */
export interface AmountPoint {
  /** Le début du pas, en UTC. Une borne, pas un libellé. */
  start: Date;
  /** La devise telle que l'émetteur l'a écrite, ou `null`. */
  currency: string | null;
  /** Somme des montants entiers du pas, dans leur unité d'origine. */
  amount: number;
  /** Nombre d'événements du pas, montant ou pas. */
  events: number;
}

/**
 * Sur quel axe ranger les paiements — et où cet axe se lit.
 *
 * ## Deux natures, une seule jointure de plus
 *
 * Certains axes sont des **colonnes de la première visite** : la campagne y a
 * été rangée à l'ouverture, le pays aussi. D'autres vivent dans le **sac du
 * premier événement** de cette visite — le referrer et le chemin d'entrée n'ont
 * jamais eu de colonne, et n'en auront pas : les recopier créerait une seconde
 * vérité là où la donnée existe déjà.
 *
 * ## Le Core ne nomme rien
 *
 * `column` est un ensemble **fermé à la compilation**, comme `SESSION_COLUMNS` :
 * aucune chaîne d'appelant n'atteint le SQL. `key`, elle, est libre et part en
 * paramètre lié — le Core ignore ce qu'elle désigne, exactement comme dans
 * `topValues`. C'est ce qui lui permet de grouper un referrer sans savoir ce
 * qu'est un referrer.
 */
export type EntrySessionColumn =
  | 'campaign'
  | 'country'
  | 'browser'
  | 'os'
  | 'device';

export type EntryAxis =
  | { on: 'session'; column: EntrySessionColumn }
  | { on: 'entry'; source: 'attributes' | 'properties'; key: string }
  /**
   * Les deux à la fois, groupés ensemble — et **rien de décidé ici**.
   *
   * Une colonne seule ne suffit pas quand la question porte sur ce que les deux
   * disent *ensemble* : deux visites arrivées du même endroit peuvent n'avoir
   * pas la même origine, et seule la colonne le dit. Les lire en deux passes ne
   * rendrait pas le couple — deux classements séparés ne se recroisent pas.
   *
   * Le Core rend donc les deux valeurs côte à côte, dans les deux premiers
   * emplacements, et **ne tranche pas** laquelle l'emporte : il ne sait pas ce
   * qu'elles désignent. C'est l'appelant, dans `features/`, qui a le droit de
   * le savoir.
   *
   * La campagne y tient en **une** valeur — sa source — là où l'axe `session`
   * lui en donne trois. Savoir qu'il y en avait une suffit à cette question ;
   * qui veut le triplet a son propre axe.
   */
  | {
      on: 'both';
      column: EntrySessionColumn;
      source: 'attributes' | 'properties';
      key: string;
    };

export interface EntrySelector extends AmountSelector {
  axis: EntryAxis;
}

/** Ce qu'un groupe de paiements pèse, et ce qui l'a amené. */
export interface EntryTotals {
  /**
   * Les libellés de l'axe, bruts, dans l'ordre où le Core les a groupés.
   *
   * Un seul pour la plupart des axes ; **trois** pour la campagne, qui est un
   * triplet et dont « source seule » ne désigne rien. Tous nuls veut dire « pas
   * de valeur sur cet axe », jamais « valeur vide ».
   */
  values: (string | null)[];
  /**
   * A-t-on retrouvé une première visite pour ce visiteur ?
   *
   * `false` veut dire qu'aucun parcours ne porte ce paiement — pas de
   * consentement, pas d'identifiant, ou un client antérieur à l'installation.
   * `true` avec des valeurs nulles est tout autre chose : on connaît la visite,
   * elle n'a simplement rien sur cet axe. Confondre les deux ferait passer un
   * trou de mesure pour du trafic direct.
   */
  known: boolean;
  /** La devise telle que l'émetteur l'a écrite, ou `null` s'il n'en donne pas. */
  currency: string | null;
  /** Somme des montants entiers trouvés, dans leur unité d'origine. */
  amount: number;
  /** Nombre d'événements du groupe, montant ou pas. */
  events: number;
  /** Visiteurs distincts derrière ces événements. */
  visitors: number;
}

/**
 * Le classement, et ce qu'il ne montre pas.
 *
 * `others` n'est pas un reste décoratif : c'est la part de revenu qu'aucune
 * valeur de cet axe ne revendique, et elle doit rester visible à côté du
 * classement. L'annoncer séparément est ce qui empêche de lire « 12 k€ venus de
 * Google » comme « 12 k€ sur 12 k€ ».
 */
export interface EntryRanking {
  /** Les valeurs de l'axe, du plus gros total au plus petit, coupées à `limit`. */
  rows: EntryTotals[];
  /** Tout ce qui n'a pas de valeur sur cet axe, jamais coupé. */
  others: EntryTotals[];
}

/**
 * La **première visite** d'un visiteur, telle que la lecture la rend.
 *
 * Ce qu'une cohorte demande, et rien de plus : quand il est arrivé, et par où.
 * Le reste de son parcours ne la regarde pas — c'est un axe d'acquisition, pas
 * un profil.
 */
export interface EntryVisit {
  /** Le début de sa toute première session, sans borne de fenêtre. */
  startedAt: Date;
  campaign: SessionCampaign | null;
  /** Le pays de cette première visite, `null` si la base GeoIP n'a rien dit. */
  countryCode: string | null;
}

/**
 * Aplatit les trois emplacements en une liste.
 *
 * Le Core ne recompose rien : il rend les libellés dans l'ordre où il les a
 * groupés, et c'est à l'appelant — qui a choisi l'axe — de savoir si le
 * deuxième et le troisième veulent dire quelque chose.
 */
function toTotals(row: {
  first: string | null;
  second: string | null;
  third: string | null;
  known: boolean;
  currency: string | null;
  amount: number;
  events: number;
  visitors: number;
}): EntryTotals {
  const { first, second, third, ...totals } = row;

  return { ...totals, values: [first, second, third] };
}

export interface EventRow {
  /**
   * La session à laquelle l'événement appartient.
   *
   * Attribuée à l'ingestion et persistée : c'est la source de vérité unique du
   * découpage, et aucun module ne la recalcule. Deux événements du même
   * visiteur la partagent tant que moins de trente minutes les séparent.
   *
   * Jamais `null` ici, et c'est une propriété de la lecture qui la produit :
   * `events()` joint `sessions` en interne, donc un événement sans visiteur n'y
   * apparaît pas. C'est le comportement voulu — cette lecture sert à replier des
   * sessions. La page brute, elle, les montre : voir `EventEntry`.
   */
  sessionId: string;
  /**
   * La campagne qui a amené la visite, quand il y en a une.
   *
   * Identique sur tous les événements d'une même session — elle est figée à son
   * ouverture — donc le premier vu fait foi, comme pour `sessionStartedAt`.
   *
   * `null` est le cas courant : la plupart des visites n'arrivent par aucune
   * campagne, et la plupart des sites n'en posent jamais.
   */
  campaign: SessionCampaign | null;
  /**
   * L'instant du **premier événement de la session**, tel que la table le porte.
   *
   * Pas « le premier de la fenêtre » : la colonne, donc le vrai début, même
   * quand il est antérieur à `from`. C'est toute la raison de la rendre.
   *
   * Sans elle, une session commencée à 09:00 et lue sur `[09:30, 10:00)` serait
   * indiscernable d'une session réellement ouverte à 09:30 — l'appelant verrait
   * un premier événement à 09:30 dans les deux cas. La comparer à sa propre
   * borne basse lui dit laquelle des deux il regarde.
   *
   * Elle est identique sur toutes les lignes d'une même session : c'est une
   * colonne jointe, pas un calcul. Le Core ne dit pas ce qu'il faut en conclure.
   */
  sessionStartedAt: Date;
  /**
   * Le visiteur, sous une forme qui ne vaut **que dans cette lecture**.
   *
   * ## Ce qu'il permet, et c'est tout ce qu'il permet
   *
   * Reconnaître que deux lignes viennent du même visiteur, à l'intérieur d'un
   * seul appel. C'est ce qui rend un compte de visiteurs distincts calculable
   * en aval, à n'importe quel grain, sans que le Core ait à choisir un pas, un
   * fuseau ou un calendrier — la décision qu'il a rendue à l'affichage à
   * l'étape 33, et qu'il ne reprend pas ici.
   *
   * ## Pourquoi ce n'est pas `visitorKey`
   *
   * La clé est un HMAC stable toute la journée UTC. La rendre donnerait à
   * l'aval — puis au navigateur, au cache HTTP, à un HAR partagé — un
   * identifiant pseudonyme durable, joignable entre deux réponses et entre deux
   * fenêtres. L'alias est **retiré à chaque appel** : deux lectures de la même
   * fenêtre ne rendent pas les mêmes valeurs, donc rien ne se recolle d'une
   * réponse à l'autre.
   *
   * C'est ce qui garde vraie la phrase du module Analytics : la clé visiteur ne
   * lui parvient pas. Il reçoit un alias dont il ignore ce qu'il aliase.
   */
  visitorAlias: string;
  type: string;
  /**
   * D'où l'événement est entré : `browser` ou `server`.
   *
   * Rendue parce qu'elle est la seule chose qui distingue à l'œil un événement
   * sans visiteur d'un événement dont la session n'aurait pas été résolue. Le
   * Core n'en tire aucune conclusion — il rend la colonne.
   */
  source: EventSource;
  occurredAt: Date;
  attributes: Record<string, unknown>;
  properties: Record<string, unknown>;
}

/**
 * Un événement d'une lecture **paginée** : `EventRow` sans l'alias.
 *
 * L'absence est le seul écart, et c'est une conséquence de la pagination, pas
 * une économie. Un alias est tiré à chaque appel ; sur une lecture qui se fait
 * en plusieurs appels, le même visiteur en porterait un différent par page. Il
 * ne servirait donc à rien et tromperait quiconque met deux pages bout à bout.
 *
 * `sessionId` reste, et suffit à ce qu'un journal paginé demande : reconnaître
 * un fil d'une page à l'autre. Il est persisté, donc stable, là où l'alias ne
 * l'est jamais.
 */
/*
 * `campaign` en est retiré aussi : le journal brut montre des événements, pas
 * des visites. La campagne est un attribut de la session, et une ligne de
 * journal en porte déjà l'identifiant pour qui veut la suivre.
 */
export type EventEntry = Omit<
  EventRow,
  'visitorAlias' | 'sessionId' | 'sessionStartedAt' | 'campaign'
> & {
  /**
   * `null` quand l'événement n'a **pas de visiteur** — un deploy, un webhook de
   * paiement, une sonde d'uptime.
   *
   * Ce n'est pas une valeur manquante : il n'y a rien à rattacher, et il n'y
   * aura jamais rien. C'est la différence de fond entre cette lecture et
   * `events()` : celle-ci est le journal brut, elle montre tout ce qui est
   * entré, y compris ce qui n'a pas de fil.
   */
  sessionId: string | null;
  /** `null` exactement quand `sessionId` l'est : pas de session, pas de début. */
  sessionStartedAt: Date | null;
};

/** Ce qu'on demande à `page()` : une taille, et où reprendre. */
export interface EventPageRequest {
  /** Nombre de lignes rendues au plus. Entier positif, sans défaut. */
  limit: number;
  /**
   * Le jeton rendu par l'appel précédent. Absent : on part du début de la
   * fenêtre.
   */
  after?: string;
}

/** Ce que `page()` rend : la tranche, et de quoi demander la suite. */
export interface EventPageResult {
  events: EventEntry[];
  /** `null` quand il n'y a rien après — la fin, pas une erreur. */
  nextCursor: string | null;
}

/**
 * La position d'un événement dans l'ordre total, sous forme transportable.
 *
 * Un couple `(occurred_at, id)`, encodé en base64url. L'encodage n'est pas une
 * protection : il ne chiffre rien et n'est pas signé. Il dit une chose, aux
 * appelants comme au prochain lecteur de ce fichier — **cette valeur n'est pas
 * à lire**. Une position en clair invite à la fabriquer à la main, puis à
 * dépendre de sa forme, et la forme cesse alors d'appartenir à ce fichier.
 *
 * Le séparateur est sûr : un instant ISO n'a pas de `|`, un uuid non plus.
 */
function encodeCursor({
  occurredAt,
  id,
}: {
  occurredAt: Date;
  id: string;
}): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString('base64url');
}

/** Le couple d'origine, ou `null` si ce jeton n'en est pas un. */
function decodeCursor(token: string): { occurredAt: Date; id: string } | null {
  const [instant, id, ...rest] = Buffer.from(token, 'base64url')
    .toString()
    .split('|');

  if (instant === undefined || id === undefined || rest.length > 0) return null;

  const occurredAt = new Date(instant);

  return Number.isNaN(occurredAt.getTime()) ? null : { occurredAt, id };
}

/**
 * Reconnaît un jeton produit ici, sans dire ce qu'il contient.
 *
 * Exporté pour que la validation d'entrée d'un module puisse refuser un
 * `?after=` bricolé par un **400** plutôt que de le laisser filer jusqu'à une
 * exception. C'est le seul point où la forme du curseur franchit ce fichier, et
 * elle le franchit sous forme de réponse par oui ou non.
 */
export function isEventCursor(token: string): boolean {
  return decodeCursor(token) !== null;
}

/**
 * « Strictement plus ancien que cette position », dans l'ordre de `page()`.
 *
 * Le sens suit celui de la lecture : `page()` rend du plus récent au plus
 * ancien, donc « la suite » est ce qui précède dans le temps. Un prédicat qui
 * regarderait dans l'autre sens que le `orderBy` rendrait des pages qui se
 * recouvrent, ou sauterait tout le journal d'un coup.
 *
 * Les deux termes sont nécessaires et le second est le moins évident : deux
 * événements peuvent partager la milliseconde, et un `<` sur le seul instant
 * les sauterait tous les deux ou les rendrait deux fois. C'est l'`id` qui
 * départage, exactement comme dans le `orderBy`.
 */
function isOlder({ occurredAt, id }: { occurredAt: Date; id: string }): SQL {
  return or(
    lt(events.occurredAt, occurredAt),
    and(eq(events.occurredAt, occurredAt), lt(events.id, id)),
  ) as SQL;
}

/**
 * Ce que l'Event Store rend d'une ligne qu'il vient d'écrire.
 *
 * ## `visitorKey` est hors de ce type, et le restera
 *
 * C'est une infrastructure serveur, pas une donnée du site appelant. La rendre
 * donnerait à n'importe quelle page un identifiant stable pour son visiteur —
 * exactement ce qu'on prend soin de ne concéder que sous consentement, et sous
 * une autre forme.
 *
 * ## `sessionId` est hors de ce type pour une autre raison, bien plus faible
 *
 * Parce que `insert` ne le relit pas de Postgres : l'appelant vient de le lui
 * passer, le redemander serait payer une colonne qu'on tient déjà. Ce n'est pas
 * une règle de confidentialité, et il ne faut pas lire l'exclusion des deux
 * colonnes comme un seul argument — elles ne sont pas de la même nature.
 *
 * La session **est** rendue au site, une ligne plus haut dans la chaîne :
 * `CoreService.ingest` la recompose depuis la valeur qu'il détient. Voir
 * `IngestedEvent` là-bas pour ce qui l'autorise — une visite n'est pas un
 * visiteur.
 *
 * ## Les colonnes sont listées une à une
 *
 * `insert` ne rend pas la ligne entière : ce type décrit ce que cette liste
 * contient, et les deux doivent rester d'accord. C'est pour ça qu'une colonne
 * ajoutée au schéma ne s'expose pas toute seule.
 */
export type PublicEvent = Omit<Event, 'sessionId' | 'visitorKey'>;

/**
 * L'Event Store : le seul accès à la table `events`, en lecture comme en
 * écriture.
 *
 * L'écriture (`insert`) sert le chemin d'ingestion ; les lectures servent les
 * modules métier. C'est la frontière entre le socle et ce qui le consomme. Le Core garantit
 * deux choses, et depuis l'étape 33 il n'en garantit plus que deux : le
 * cloisonnement par projet, et la fenêtre semi-ouverte `[from, to)`. Ce que
 * *signifie* un type d'événement ne le regarde pas ; c'est au module de le
 * savoir.
 *
 * Le découpage en journées UTC vivait ici, et il en est parti. Choisir un pas,
 * un fuseau et un calendrier sont des décisions d'affichage : elles appartiennent
 * à qui affiche. Le Core rend des instants ; les regrouper est le travail de
 * l'autre bout de la chaîne.
 *
 * Les méthodes sont volontairement unitaires plutôt qu'un `summarize()`
 * qui rendrait tout d'un coup. Un module veut souvent croiser deux périmètres
 * différents — les vues d'un type, l'audience tous types confondus — et une
 * méthode « fourre-tout » l'obligerait à jeter la moitié du résultat, ou à
 * faire remonter sa sémantique dans le Core. Le coût est réel : quatre
 * requêtes là où une passe unique en aurait suffi. Elles partent en parallèle,
 * et l'appelant reste libre de n'en demander qu'une.
 */
@Injectable()
export class EventStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * Écrit un événement **dans la transaction de l'appelant**, et rend la ligne
   * telle que Postgres l'a écrite : `id` généré en base, `attributes` et
   * `properties` par défaut appliqués.
   *
   * La transaction est un paramètre plutôt qu'une affaire interne, comme pour
   * `SessionAssigner.assign`. Ce n'est pas de la souplesse : l'attribution de
   * session prend un verrou consultatif qui ne tient que jusqu'au `COMMIT`, et
   * insérer hors de cette transaction rouvrirait la course que le verrou
   * empêche. Le point de commit appartient donc à l'orchestrateur — ici, on ne
   * fait qu'écrire là où il le dit.
   *
   * On rend la ligne relue plutôt que les valeurs d'entrée pour que la réponse
   * décrive l'état réel de la base, pas ce qu'on croit y avoir mis. Colonnes
   * listées une à une plutôt qu'un `.returning()` nu : la session n'est même
   * pas relue depuis Postgres, et une colonne ajoutée demain ne se retrouvera
   * pas exposée par simple inertie.
   */
  async insert(tx: DrizzleTransaction, values: NewEvent): Promise<PublicEvent> {
    const [event] = await tx.insert(events).values(values).returning({
      id: events.id,
      projectId: events.projectId,
      type: events.type,
      source: events.source,
      occurredAt: events.occurredAt,
      attributes: events.attributes,
      properties: events.properties,
    });

    return event;
  }

  /**
   * Rattache des événements déjà écrits à un visiteur.
   *
   * ## Pourquoi une écriture après coup existe
   *
   * Une source de paiement n'annonce pas toujours son visiteur au moment où elle
   * annonce le paiement. Le lien se découvre parfois quelques secondes plus tard,
   * parfois des mois — un client qui existait avant l'installation, un abonnement
   * dont l'identité n'a été posée qu'après le premier encaissement. Sans cette
   * écriture, ce revenu-là resterait à jamais hors de portée alors qu'on finit par
   * savoir d'où il vient.
   *
   * ## Elle n'écrase jamais
   *
   * `isNull` dans la condition, et c'est le cœur de la méthode : une identité
   * **affirmée à l'ingestion** l'emporte sur une identité **déduite après coup**.
   * L'inverse laisserait une déduction tardive et faillible réécrire ce qu'une
   * source avait dit d'elle-même — et le ferait en silence, sur des lignes que
   * personne ne relit.
   *
   * Elle est donc idempotente : la rejouer ne déplace rien.
   *
   * ## Elle ne ré-identifie jamais ce que la purge a anonymisé
   *
   * C'est la borne de rétention, et sans elle le lot de purge ne servirait à
   * rien. Un événement anonymisé a **exactement la forme** que cette méthode
   * cherche — une ligne écrite, sans clé visiteur. La première paire client
   * apprise après coup ré-identifierait donc un paiement de vingt-six mois, et
   * la purge et le rattrapage rétroactif se contrediraient en silence, chacun
   * défaisant le travail de l'autre à son rythme.
   *
   * La condition vit **ici** plutôt que chez l'appelant pour la raison qui fait
   * vivre `where()` dans ce fichier : une règle posée dans un module de
   * `features/` sera oubliée par le suivant. Celle-ci vaut pour tout appelant,
   * présent et futur, et c'est le seul endroit d'où elle peut le garantir.
   *
   * Le seuil est un fragment SQL, donc évalué par Postgres à chaque appel, sur
   * la même horloge que les lignes qu'il compare — voir `retentionCutoff`.
   *
   * ## Ce qu'elle ne prend pas
   *
   * Ni période, ni projet, ni type : des **ids**, que l'appelant a obtenus
   * autrement. C'est ce qui permet à un module métier de s'en servir sans jamais
   * nommer la clé qu'elle écrit, ni décider ce qu'est une identité.
   */
  async attribute(eventIds: string[], visitorKey: string): Promise<number> {
    if (eventIds.length === 0) return 0;

    const attributed = await this.db
      .update(events)
      .set({ visitorKey })
      .where(
        and(
          inArray(events.id, eventIds),
          isNull(events.visitorKey),
          gte(events.occurredAt, retentionCutoff()),
        ),
      )
      .returning({ id: events.id });

    return attributed.length;
  }

  /** Nombre d'événements dans le périmètre. */
  async countEvents(scope: EventScope): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(events)
      .where(this.where(scope));

    return row.count;
  }

  /**
   * Nombre de clés visiteur distinctes dans le périmètre.
   *
   * ## Ce n'est pas un nombre de personnes
   *
   * La clé **tourne chaque nuit UTC** (voir `VisitorKeyService`) : le même
   * visiteur en porte une nouvelle chaque jour. Sur une fenêtre de plusieurs
   * jours, ce compte dénombre donc des couples *(personne, journée)*, et
   * quelqu'un revenu trois jours y vaut trois.
   *
   * C'est le prix de l'anonymat par rotation, et il se paie ici plutôt qu'en
   * conservant de quoi suivre les gens. Autant l'écrire : le nom de la méthode
   * ne le dira jamais, et un lecteur qui l'ignore additionnera des fenêtres en
   * croyant compter des visiteurs.
   *
   * ## Où il s'additionne, et où il gonfle
   *
   * Exactement à la frontière de rotation. Deux fenêtres qui se coupent sur un
   * minuit UTC s'additionnent — les clés des deux côtés sont distinctes par
   * construction. Deux fenêtres qui découpent une même journée ne s'additionnent
   * pas : quelqu'un présent le matin et le soir y porte la même clé et compte
   * deux fois.
   */
  async countVisitors(scope: EventScope): Promise<number> {
    const [row] = await this.db
      .select({ count: countDistinct(sessions.visitorKey) })
      .from(events)
      .innerJoin(sessions, eq(events.sessionId, sessions.id))
      .where(this.where(scope));

    return row.count;
  }

  /**
   * Nombre de sessions distinctes ayant au moins un événement dans le périmètre.
   *
   * **La même population que celle qu'`events()` rend une fois repliée.** C'est
   * la seule propriété qui compte ici : deux lectures qui prétendraient toutes
   * deux compter « les sessions » avec deux périmètres différents finiraient par
   * s'afficher côte à côte, et rien ne dirait laquelle a raison. Le résumé et le
   * détail répondent donc au même `where`.
   *
   * Un agrégat, pas une lecture de lignes : c'est ce qui permet à un résumé de
   * donner ce nombre sans faire remonter le journal entier. Aucune jointure —
   * `session_id` est porté par l'événement lui-même.
   *
   * Ne s'additionne pas entre deux fenêtres adjacentes : une session à cheval
   * sur la borne compte des deux côtés.
   */
  async countSessions(scope: EventScope): Promise<number> {
    const [row] = await this.db
      .select({ count: countDistinct(events.sessionId) })
      .from(events)
      .where(this.where(scope));

    return row.count;
  }

  /**
   * Les sessions du périmètre, réparties selon qu'elles portent **une** ou
   * **plusieurs** occurrences d'un type, et closes depuis assez longtemps.
   *
   * ## Ce que le Core sait, et ce qu'il ne sait pas
   *
   * Il sait grouper des événements par session, en compter d'un type donné, et
   * écarter les sessions encore susceptibles d'en recevoir. Il ne sait pas de
   * quel type il s'agit, ni comment s'appelle une session qui n'en porte
   * qu'un : `AnalyticsService` nomme les deux, comme c'est lui qui décide
   * qu'une vue de page mérite un compteur. La frontière est éprouvée par
   * `architecture.spec.ts`, qui refuse jusqu'à la mention d'un type ici.
   *
   * ## Pourquoi le type n'est pas dans le périmètre
   *
   * Parce que la requête en a besoin des **deux** côtés à la fois, et pas du
   * même. Le comptage porte sur un seul type ; le test de fin porte sur
   * **tous** — un clic arrivé après la dernière vue prolonge la session, et
   * l'ignorer déclarerait close une session qui ne l'est pas. Un `scope.type`
   * filtrerait les deux ensemble.
   *
   * C'est le même croisement que `summarize()` résout avec deux périmètres.
   * Ici il n'y a qu'une requête, donc le type voyage à côté du périmètre plutôt
   * que dedans. `scope.type` doit être **absent** ; le passer quand même
   * restreindrait la population de sessions sans qu'aucun nom ne le dise.
   *
   * ## `settledBefore` est un instant, pas une durée
   *
   * La règle « plus rien ne peut rejoindre cette session » appartient à
   * l'ingestion (`SESSION_GAP_MS`), et le Core n'a pas à la connaître : il
   * reçoit l'instant déjà calculé. Une session dont le dernier événement tombe
   * après cet instant sort du compte — elle n'est ni `single` ni `several`,
   * parce qu'on ne sait pas encore ce qu'elle sera.
   *
   * ## Les sessions sans aucune occurrence ne sont nulle part
   *
   * Aucun filtre ne les écarte : elles tombent d'elles-mêmes hors des deux
   * `filter`, l'un exigeant `= 1` et l'autre `> 1`. Écrire un `where` de plus
   * pour les exclure dirait qu'il se passe quelque chose là où il ne se passe
   * rien.
   *
   * ## Les sessions ouvertes avant la fenêtre, si
   *
   * Celles-là demandent un filtre, parce que rien ne les distingue autrement.
   * `where(scope)` coupe les **événements** à `from` : une session commencée à
   * 23 h 50 et lue sur la journée suivante arrive ici amputée de ses vues
   * d'avant minuit. Quatre vues plus une, ça devient une — soit un rebond, et
   * au dénominateur par-dessus le marché.
   *
   * D'où la jointure sur `sessions` : on ne compte que celles dont on a vu le
   * début. C'est la symétrique exacte de `settledBefore`, qui écarte en haut
   * les sessions dont on n'a pas vu la fin — dans les deux cas le serveur
   * refuse de se prononcer sur ce qu'il n'a pas regardé, plutôt que de trancher
   * sur un morceau.
   *
   * Longtemps ce filtre n'a rien changé : la clé visiteur tournant à minuit
   * UTC, aucune session ne pouvait traverser une borne de journée. Le tampon de
   * trente minutes (`CoreService.previousKey`) a rendu le cas possible, et donc
   * la règle nécessaire.
   *
   * ⚠️ Le filtre s'arrête ici. `countSessions`, `countEvents` et
   * `countVisitors` comptent délibérément **ce qui s'est passé dans la
   * fenêtre**, session tronquée comprise : c'est ce qui fait que
   * `summary.sessions` vaut la longueur de `GET /analytics/sessions`, invariant
   * éprouvé en e2e.
   *
   * Aucune ligne ne remonte, quel que soit le volume de la fenêtre : c'est ce
   * qui garde `GET /analytics` bon marché.
   */
  async countSessionsBySingleEvent(
    scope: EventScope,
    { type, settledBefore }: { type: string; settledBefore: Date },
  ): Promise<{ single: number; several: number }> {
    // Une sous-requête pour la même raison que dans `topValues` : le
    // groupement porte alors sur une colonne ordinaire, au lieu de dépendre de
    // la façon dont Drizzle qualifie une expression selon la clause.
    const perSession = this.db
      .select({
        sessionId: events.sessionId,
        occurrences:
          sql<number>`count(*) filter (where ${events.type} = ${type})`
            .mapWith(Number)
            .as('occurrences'),
        // Sur **tous** les types : c'est le dernier signe de vie de la session,
        // pas sa dernière occurrence du type compté.
        lastSeen: sql<Date>`max(${events.occurredAt})`.as('last_seen'),
      })
      .from(events)
      .innerJoin(sessions, eq(events.sessionId, sessions.id))
      .where(and(this.where(scope), gte(sessions.startedAt, scope.from)))
      .groupBy(events.sessionId)
      .as('per_session');

    const [row] = await this.db
      .select({
        single:
          sql<number>`count(*) filter (where ${perSession.occurrences} = 1)`.mapWith(
            Number,
          ),
        several:
          sql<number>`count(*) filter (where ${perSession.occurrences} > 1)`.mapWith(
            Number,
          ),
      })
      .from(perSession)
      .where(sql`${perSession.lastSeen} < ${settledBefore}`);

    return row;
  }

  /**
   * Les valeurs les plus fréquentes d'une clé JSON, dans le périmètre.
   *
   * C'est la primitive qui manquait pour répondre à « quelles valeurs, et dans
   * quelles proportions » — question que les compteurs ne pouvaient pas poser,
   * puisqu'ils ne savent que dénombrer un périmètre déjà connu.
   *
   * Générique par construction : l'appelant nomme une colonne et une clé, le
   * Core groupe. Un module qui compte des pages et un module qui compte des
   * noms d'erreur appellent la même méthode, et l'ajout du second ne demande
   * pas d'y toucher.
   *
   * ## Ce qui est écarté
   *
   * Les événements où la clé est absente **ou vaut `null` en JSON** ne sont pas
   * comptés : ils n'ont pas de valeur à porter, et une ligne « vide » en tête
   * de classement n'apprendrait rien. Les deux cas sont indistinguables ici,
   * comme ils le sont pour l'émetteur qui omet ses clés vides. L'appelant qui
   * veut connaître la couverture compare la somme des `events` à
   * `countEvents()` sur le même périmètre.
   *
   * ## L'ordre est total
   *
   * `events` décroissant, puis la valeur croissante. Le second critère n'est
   * pas cosmétique : à égalité de compte, Postgres est libre de rendre les
   * lignes dans n'importe quel ordre, et c'est la coupe du `limit` qui
   * deviendrait alors non déterministe — deux appels identiques ne rendraient
   * pas le même top 10.
   */
  async topValues(
    scope: EventScope,
    { source, key, limit = DEFAULT_TOP_LIMIT }: ValueSelector,
  ): Promise<ValueCount[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      // Sans ce garde, un `limit` négatif remonterait sous forme d'erreur
      // Postgres, à des couches de là et sans dire qui l'a passé.
      throw new RangeError(
        `[EventStore] limit doit être un entier positif, reçu ${String(limit)}.`,
      );
    }

    // `source` choisit une colonne parmi deux connues à l'avance ; `key` est
    // interpolée par Drizzle en paramètre lié. Le `::text` lève l'ambiguïté de
    // `->>`, qui existe aussi en variante « index de tableau ».
    const column =
      source === 'attributes' ? events.attributes : events.properties;

    // L'extraction est isolée dans une sous-requête pour qu'elle ne soit écrite
    // qu'une fois. Répéter l'expression dans le `select`, le `group by` et le
    // `order by` paraît plus direct et ne marche pas : Drizzle rend la même
    // référence de colonne tantôt qualifiée (`"events"."attributes"`) tantôt
    // nue (`"attributes"`) selon la clause, et Postgres y voit alors deux
    // expressions distinctes — « column must appear in the GROUP BY clause ».
    // Ici le groupement porte sur une colonne ordinaire de la sous-requête, ce
    // qui ne dépend plus d'aucune subtilité de rendu.
    const extracted = this.db
      .select({
        value: sql<string>`${column} ->> ${key}::text`.as('value'),
        visitorKey: sessions.visitorKey,
      })
      .from(events)
      .innerJoin(sessions, eq(events.sessionId, sessions.id))
      .where(this.where(scope))
      .as('extracted');

    const count = sql<number>`count(*)`.mapWith(Number);

    return this.db
      .select({
        value: extracted.value,
        events: count,
        visitors: countDistinct(extracted.visitorKey),
      })
      .from(extracted)
      .where(isNotNull(extracted.value))
      .groupBy(extracted.value)
      .orderBy(desc(count), asc(extracted.value))
      .limit(limit);
  }

  /**
   * Le classement d'une colonne de `sessions`, et sa couverture.
   *
   * Le jumeau de `topValues` pour les colonnes de la session plutôt que pour
   * une clé JSON de l'événement. Il existe séparément parce que ce qu'on compte
   * n'est pas la même chose : `topValues` pèse des **événements** (« combien de
   * fois cette page a été vue »), celui-ci pèse des **visiteurs et des
   * sessions** (« combien de monde depuis ce pays »). Fusionner les deux
   * demanderait un paramètre disant lequel des deux poids on veut, c'est-à-dire
   * de remonter la question dans le Core.
   *
   * ## Ce que `visitors` ne fait pas
   *
   * Il ne s'additionne pas. Quelqu'un dont deux sessions résolvent vers deux
   * pays — VPN, déplacement, un mobile qui change de réseau — compte dans les
   * deux lignes. La somme de la colonne dépasse donc `countVisitors()` sur le
   * même périmètre, et **une part sur ce total ne fait pas 100 %**. C'est au
   * lecteur de ne pas présenter ça comme une décomposition, exactement comme
   * pour `topPages`.
   *
   * ## Le pays voyage toujours
   *
   * Même au grain ville : sans lui, « Paris » du Texas et « Paris » d'Île-de-
   * France seraient une seule ligne. Le regroupement porte donc sur le couple,
   * et au grain pays les deux colonnes sont la même — le `group by` est alors
   * un doublon inoffensif plutôt qu'une seconde requête.
   *
   * ## `unresolved` n'est pas le complément du classement
   *
   * C'est le nombre de visiteurs dont la valeur **du grain demandé** est
   * inconnue : sans pays au grain pays, sans ville au grain ville. Il change
   * donc avec le grain, et ce n'est pas une incohérence — une session peut
   * avoir un pays sans avoir de ville.
   */
  async topSessionValues(
    scope: EventScope,
    { column, qualifier, limit = DEFAULT_TOP_LIMIT }: SessionValueSelector,
  ): Promise<SessionValueRanking> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(
        `[EventStore] limit doit être un entier positif, reçu ${String(limit)}.`,
      );
    }

    // Résolution par un objet gelé dont les clés sont connues à la compilation.
    // Aucune chaîne d'appelant n'entre dans le SQL — voir `SESSION_COLUMNS`.
    const value = SESSION_COLUMNS[column];

    // Même sous-requête que `topValues`, et pour la même raison : le groupement
    // porte ensuite sur des colonnes ordinaires, au lieu de dépendre de la façon
    // dont Drizzle qualifie une référence selon la clause.
    // Un `null` constant quand personne ne demande de départage : le groupement
    // porte alors sur une seule valeur, ce qui ne change rien au résultat et
    // évite une seconde requête presque identique.
    const secondary = qualifier
      ? sql<string | null>`${SESSION_COLUMNS[qualifier]}`
      : sql<string | null>`null`;

    const extracted = this.db
      .select({
        qualifier: secondary.as('qualifier'),
        value: sql<string | null>`${value}`.as('value'),
        visitorKey: sessions.visitorKey,
        sessionId: events.sessionId,
      })
      .from(events)
      .innerJoin(sessions, eq(events.sessionId, sessions.id))
      .where(this.where(scope))
      .as('extracted');

    const visitors = countDistinct(extracted.visitorKey);

    const [rows, [missing]] = await Promise.all([
      this.db
        .select({
          qualifier: extracted.qualifier,
          value: sql<string>`${extracted.value}`,
          visitors,
          sessions: countDistinct(extracted.sessionId),
        })
        .from(extracted)
        .where(isNotNull(extracted.value))
        .groupBy(extracted.qualifier, extracted.value)
        // Le second critère départage à égalité : sans lui, la coupe du `limit`
        // serait non déterministe et deux appels identiques ne rendraient pas
        // le même classement.
        .orderBy(desc(visitors), asc(extracted.value))
        // En SQL, pas en JavaScript : c'est ce qui fait qu'une fenêtre de trente
        // jours sur un site mondial ne ramène pas dix mille villes pour en
        // afficher dix.
        .limit(limit),
      this.db
        .select({ count: visitors })
        .from(extracted)
        .where(isNull(extracted.value)),
    ]);

    return { rows, unresolved: missing.count };
  }

  /**
   * Ce que chaque paiement doit à la **première visite** de son visiteur.
   *
   * ## Pourquoi le Core, et pas un module
   *
   * Parce que la jointure porte sur la clé visiteur, et qu'aucun module n'a le
   * droit de la nommer. C'est la même frontière que partout ailleurs : un module
   * dit « ces types-là, cette fenêtre-là, ce montant-là », le Core sait seul par
   * quelle colonne on relie un paiement à un parcours.
   *
   * ## La première visite est **lue**, jamais figée
   *
   * On aurait pu recopier la campagne sur l'événement de paiement au moment de
   * l'écrire. Ç'aurait été faux : `CoreService.attribute` rattache des paiements
   * **rétroactivement**, des mois après, quand un site pose enfin l'identifiant
   * sur ses clients. « La première visite de ce visiteur » devient donc
   * légitimement connaissable après coup, et une valeur gelée serait restée
   * vide pour toujours.
   *
   * Le `left join lateral` prend la session la plus ancienne du visiteur —
   * `sessions_project_visitor_idx` le sert — sans borne de fenêtre : la fenêtre
   * choisit les *paiements* comptés, pas l'ancienneté de l'acquisition qu'on
   * leur reconnaît.
   *
   * ## Ce que le Core additionne, et ce qu'il ignore
   *
   * Une clé fournie par l'appelant, dont il ne sait rien : ni l'unité, ni ce
   * qu'elle mesure. Seules les valeurs **entières** entrent dans la somme — un
   * `::numeric` sur une chaîne quelconque ferait échouer la requête entière, et
   * un total qui tombe est pire qu'un total incomplet.
   *
   * La devise **sépare** les totaux, elle ne les convertit pas. Additionner deux
   * devises demanderait un taux de change, donc une date de taux, donc une
   * décision qui n'appartient pas à une base de données.
   *
   * ## Deux ensembles, et le `limit` ne porte que sur le premier
   *
   * `rows` est un classement, donc coupé. `others` ne l'est pas : il porte ce
   * qui n'a pas de campagne — visiteur connu venu sans, ou paiement rattaché à
   * personne — et c'est précisément ce qu'un classement tronqué ferait
   * disparaître. Une part d'attribution qu'on ne peut pas voir est une part
   * d'attribution qu'on croit nulle.
   */
  async entryDimension(
    scope: EventScope,
    { axis, source, amount, currency, limit = DEFAULT_TOP_LIMIT }: EntrySelector,
  ): Promise<EntryRanking> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(
        `[EventStore] limit doit être un entier positif, reçu ${String(limit)}.`,
      );
    }

    const bag = source === 'attributes' ? events.attributes : events.properties;
    const nothing = sql<string | null>`null`;

    // La plus ancienne visite du visiteur, quelle que soit sa date. `marker`
    // n'est là que pour distinguer « aucune visite » de « une visite sans
    // valeur » : sans lui, les deux rendraient des colonnes nulles.
    const entry = this.db
      .select({
        id: sessions.id,
        campaignSource: sessions.campaignSource,
        campaignMedium: sessions.campaignMedium,
        campaignName: sessions.campaignName,
        country: sessions.countryCode,
        browser: sessions.browser,
        os: sessions.os,
        device: sessions.deviceType,
        marker: sql<number>`1`.as('marker'),
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, events.projectId),
          eq(sessions.visitorKey, events.visitorKey),
        ),
      )
      .orderBy(asc(sessions.startedAt), asc(sessions.id))
      .limit(1)
      .as('entry');

    // Le premier événement de cette première visite, et lui seul. C'est là que
    // vivent le referrer et le chemin d'entrée — dans un sac que le Core ne sait
    // pas lire, mais qu'il sait grouper à la clé qu'on lui nomme. Rien n'est
    // recopié nulle part : on lit la donnée là où elle est déjà.
    //
    // `events` est joint à lui-même, d'où l'alias. L'ordre est le même que
    // partout ailleurs — instant, puis `id` pour départager — et
    // `events_session_occurred_idx` le sert.
    const entryEvent = alias(events, 'entry_event');
    // Le sac de l'axe, qui n'est **pas** celui du montant : le referrer vit dans
    // les attributs du navigateur, le montant dans les propriétés d'un serveur.
    // Les confondre rendrait des colonnes vides sans rien faire échouer.
    const entryBag =
      axis.on !== 'session' && axis.source === 'properties'
        ? entryEvent.properties
        : entryEvent.attributes;
    const firstEvent = this.db
      .select({
        value: sql<string | null>`${entryBag} ->> ${
          axis.on === 'session' ? '' : axis.key
        }::text`.as('value'),
      })
      .from(entryEvent)
      .where(eq(entryEvent.sessionId, entry.id))
      .orderBy(asc(entryEvent.occurredAt), asc(entryEvent.id))
      .limit(1)
      .as('first_event');

    // Trois emplacements, toujours : la forme du `select` est figée à la
    // compilation, et la campagne est le seul axe qui en occupe plus d'un. Les
    // autres laissent deux `null` constants, que Postgres groupe sans frais.
    // Les colonnes de la première visite sur lesquelles un classement peut
    // porter, résolues par un objet dont les clés sont connues à la
    // compilation : aucune chaîne d'appelant n'atteint le SQL. Même propriété
    // que `SESSION_COLUMNS`. La campagne n'y est pas — elle occupe trois
    // emplacements et se traite à part.
    const fromEntry = {
      country: entry.country,
      browser: entry.browser,
      os: entry.os,
      device: entry.device,
      // La campagne réduite à **une** valeur, pour la variante à deux
      // emplacements où le second est déjà pris. Sa source suffit à savoir
      // qu'il y en avait une ; l'axe `session` rend le triplet entier.
      campaign: entry.campaignSource,
    } as const;

    const slots =
      axis.on === 'entry'
        ? [sql<string | null>`${firstEvent.value}`, nothing, nothing]
        : axis.on === 'both'
          ? [
              sql<string | null>`${fromEntry[axis.column]}`,
              sql<string | null>`${firstEvent.value}`,
              nothing,
            ]
          : axis.column === 'campaign'
            ? [
                sql<string | null>`${entry.campaignSource}`,
                sql<string | null>`${entry.campaignMedium}`,
                sql<string | null>`${entry.campaignName}`,
              ]
            : [
                sql<string | null>`${fromEntry[axis.column]}`,
                nothing,
                nothing,
              ];

    // Même raison que dans `topValues` : l'extraction est isolée pour que le
    // groupement porte sur des colonnes ordinaires, et non sur des expressions
    // que Drizzle qualifie différemment selon la clause.
    const selection = {
      first: slots[0].as('first'),
      second: slots[1].as('second'),
      third: slots[2].as('third'),
      known: sql<boolean>`${entry.marker} is not null`.as('known'),
      currency: sql<string | null>`${bag} ->> ${currency}::text`.as('currency'),
      amount: sql<
        string | null
      >`case when ${bag} ->> ${amount}::text ~ '^-?[0-9]+$' then (${bag} ->> ${amount}::text)::bigint end`.as(
        'amount',
      ),
      visitorKey: events.visitorKey,
    };

    // La seconde jointure n'est posée que si l'axe la demande : un `lateral`
    // par ligne d'événement se paie, et un axe qui ne lit que des colonnes de
    // la visite n'en a aucun besoin.
    const joined = this.db
      .select(selection)
      .from(events)
      .leftJoinLateral(entry, sql`true`);

    const extracted = (
      axis.on === 'session' ? joined : joined.leftJoinLateral(firstEvent, sql`true`)
    )
      .where(this.where(scope))
      .as('extracted');

    // `coalesce` parce qu'une somme sans aucune valeur rend `null` : un groupe
    // dont aucun événement ne porte de montant existe, et il vaut zéro.
    const total = sql<number>`coalesce(sum(${extracted.amount}), 0)`.mapWith(
      Number,
    );
    const payments = sql<number>`count(*)`.mapWith(Number);

    const columns = {
      first: extracted.first,
      second: extracted.second,
      third: extracted.third,
      known: extracted.known,
      currency: extracted.currency,
      amount: total,
      events: payments,
      visitors: countDistinct(extracted.visitorKey),
    };

    const grouped = [
      extracted.first,
      extracted.second,
      extracted.third,
      extracted.known,
      extracted.currency,
    ];

    const named = or(
      isNotNull(extracted.first),
      isNotNull(extracted.second),
      isNotNull(extracted.third),
    );

    // Écrit en positif plutôt qu'en `not(named)` : les deux requêtes se
    // relisent alors côte à côte, et leur complémentarité se vérifie à l'œil.
    const unnamed = and(
      isNull(extracted.first),
      isNull(extracted.second),
      isNull(extracted.third),
    );

    const [ranked, rest] = await Promise.all([
      this.db
        .select(columns)
        .from(extracted)
        .where(named)
        .groupBy(...grouped)
        // Le second critère départage à égalité : sans lui, la coupe du `limit`
        // serait non déterministe, comme pour les autres classements.
        .orderBy(desc(total), asc(extracted.first))
        .limit(limit),
      this.db
        .select(columns)
        .from(extracted)
        .where(unnamed)
        .groupBy(...grouped)
        .orderBy(desc(total)),
    ]);

    return { rows: ranked.map(toTotals), others: rest.map(toTotals) };
  }

  /**
   * La première visite de chacun de ces visiteurs, quand on en a une.
   *
   * ## Pourquoi le Core, encore
   *
   * Parce que la table `sessions` porte la clé, et qu'aucun module n'a le droit
   * de la nommer. L'appelant arrive avec des clés qu'il n'a pas fabriquées — le
   * Core les a dérivées pour lui — et repart avec des dates et des libellés.
   *
   * ## Sans fenêtre, délibérément
   *
   * Une cohorte d'acquisition demande **quand quelqu'un est arrivé**, pas s'il
   * est arrivé pendant la période qu'on regarde. Borner ici ferait entrer dans
   * la cohorte de mars un visiteur de janvier, au motif que la lecture commence
   * en mars — et la rétention mesurée serait celle d'une population qui n'existe
   * pas.
   *
   * ## Ce que `distinct on` garantit
   *
   * Une ligne par visiteur, la plus ancienne, départagée par `id` quand deux
   * sessions partagent l'instant. C'est le même ordre total que partout
   * ailleurs : deux appels rendent la même première visite.
   *
   * Les visiteurs sans aucune visite ne sont **pas** dans la carte rendue.
   * L'absence est une réponse — un client qui n'a jamais été vu par le
   * navigateur n'a pas de cohorte, et lui en inventer une fausserait toutes
   * celles qui l'entourent.
   */
  async entryVisits(
    projectId: string,
    visitorKeys: string[],
  ): Promise<Map<string, EntryVisit>> {
    if (visitorKeys.length === 0) return new Map();

    const rows = await this.db
      .selectDistinctOn([sessions.visitorKey], {
        visitorKey: sessions.visitorKey,
        startedAt: sessions.startedAt,
        countryCode: sessions.countryCode,
        campaignSource: sessions.campaignSource,
        campaignMedium: sessions.campaignMedium,
        campaignName: sessions.campaignName,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, projectId),
          inArray(sessions.visitorKey, visitorKeys),
          // Un robot n'a pas de cohorte. Le filtre des lectures d'événements ne
          // s'applique pas ici — on ne lit pas `events` — donc il est réécrit.
          eq(sessions.isBot, false),
        ),
      )
      .orderBy(
        asc(sessions.visitorKey),
        asc(sessions.startedAt),
        asc(sessions.id),
      );

    return new Map(
      rows.map((row) => [
        row.visitorKey,
        {
          startedAt: row.startedAt,
          countryCode: row.countryCode,
          campaign:
            row.campaignSource ?? row.campaignMedium ?? row.campaignName
              ? {
                  source: row.campaignSource,
                  medium: row.campaignMedium,
                  name: row.campaignName,
                }
              : null,
        },
      ]),
    );
  }

  /**
   * Tous les événements du périmètre, dans un ordre total.
   *
   * C'est la primitive la plus brute du Core : aucune agrégation, aucune
   * sélection, aucun regroupement. Elle rend le journal tel qu'il a été écrit,
   * et c'est exactement ce qu'un module doit recevoir quand le sens n'est porté
   * par aucune ligne prise séparément, mais par leur **succession**. Un agrégat
   * a perdu l'ordre en même temps qu'il a perdu les lignes, et aucun compte ne
   * rend une suite.
   *
   * Le Core ne sait pas ce que cette suite raconte, et c'est la condition pour
   * qu'elle serve à plusieurs modules à la fois : celui qui y lira un parcours,
   * celui qui y lira un entonnoir et celui qui y cherchera une anomalie
   * appellent la même méthode. Elle ne changera pas quand ils arriveront.
   *
   * ## L'ordre est total, et c'est tout ce qui est promis
   *
   * `occurred_at` croissant, puis `id` croissant. Le second critère n'est pas
   * décoratif : `occurred_at` est borné à la milliseconde et deux événements
   * peuvent y tomber ensemble — deux onglets ouverts d'un coup, ou une salve
   * envoyée pendant que la page se décharge. Sans lui, Postgres serait libre de
   * les rendre dans n'importe quel ordre, et un module qui lit une suite verrait
   * son interprétation changer d'un appel à l'autre sans que rien n'ait changé.
   *
   * `id` départage arbitrairement ; ce qu'on lui demande, c'est d'être stable.
   * Il ne sort donc pas avec la ligne : il a un rôle *ici*, et le publier
   * inviterait un module à s'en servir de référence durable — chose que le Core
   * ne promet nulle part.
   *
   * ## L'ordre est global, pas par session
   *
   * Les lignes de toutes les sessions sont entrelacées dans une seule
   * chronologie. Un module qui veut la suite d'une session groupe par
   * `sessionId` lui-même, et l'ordre relatif à l'intérieur de chaque groupe est
   * préservé — regrouper une liste déjà triée ne la détrie pas.
   *
   * Grouper ici serait déjà supposer que c'est *par session* que la suite a un
   * sens. C'est vrai d'une visite, faux d'un entonnoir observé sur une
   * population. Le Core ne tranche pas.
   *
   * ## `sessionId` est lu, pas calculé
   *
   * Il sort tel qu'il a été écrit à l'ingestion. Le Core ne redécoupe rien à la
   * lecture : deux appels, à deux moments, avec deux fenêtres différentes,
   * rendent les mêmes sessions. C'est ce qui permet à plusieurs modules de
   * parler des mêmes objets sans se coordonner.
   *
   * ## `visitorAlias` est l'exact inverse
   *
   * Il est **calculé, et pas deux fois pareil**. C'est la seule valeur de cette
   * lecture qui change d'un appel à l'autre sans que la donnée ait bougé, et
   * c'est sa raison d'être : il rend un visiteur reconnaissable *dans la
   * réponse*, et nulle part ailleurs. Un appelant qui le persisterait pour
   * recouper deux lectures ne recouperait rien — il n'y a rien à recouper, par
   * construction.
   *
   * C'est ce qui permet de compter des visiteurs distincts en aval, à n'importe
   * quel grain, sans que la clé sorte et sans que le Core reprenne le
   * découpage qu'il a rendu à l'affichage.
   *
   * ## `sessionStartedAt` déborde la fenêtre, et c'est voulu
   *
   * C'est la seule valeur rendue ici qui puisse être **antérieure à `from`**.
   * Elle n'est pas une entorse au cadrage : la fenêtre décide de quelles
   * *lignes* sortent, pas de ce qu'une ligne dit d'elle-même. Une session qui a
   * commencé avant, l'a commencé avant, et le taire obligerait chaque lecture à
   * confondre un début réel avec un bord de fenêtre.
   *
   * ## Ce qu'elle ne borne pas
   *
   * Rien : une fenêtre large sur un projet bavard rend autant de lignes que la
   * fenêtre en contient. C'est le sens de « journal brut », et la fenêtre est le
   * seul garde-fou — c'est à l'appelant de la choisir à sa mesure. Les
   * compteurs sont là pour la jauger avant de lire (`countEvents`,
   * `countSessions`).
   */
  async events(scope: EventScope): Promise<EventRow[]> {
    const rows = await this.db
      .select({
        sessionId: events.sessionId,
        sessionStartedAt: sessions.startedAt,
        campaignSource: sessions.campaignSource,
        campaignMedium: sessions.campaignMedium,
        campaignName: sessions.campaignName,
        visitorKey: sessions.visitorKey,
        type: events.type,
        source: events.source,
        occurredAt: events.occurredAt,
        attributes: events.attributes,
        properties: events.properties,
      })
      .from(events)
      // La jointure **filtre**, et c'est voulu : depuis que `session_id` est
      // nullable, elle écarte les événements sans visiteur — deploys, paiements,
      // sondes. Cette lecture sert à replier des sessions, un événement qui n'en
      // a pas n'y a rien à faire, et l'écarter ici évite à chaque appelant d'y
      // penser. Elle fait aussi descendre `started_at` et la clé visiteur.
      .innerJoin(sessions, eq(events.sessionId, sessions.id))
      .where(this.where(scope))
      // `id` ordonne sans figurer dans la projection : il classe, il ne sort
      // pas.
      .orderBy(asc(events.occurredAt), asc(events.id));

    // La table de correspondance ne survit pas à l'appel : elle est locale, et
    // les clés partent avec elle au retour. C'est le seul endroit de la lecture
    // où `visitor_key` existe en mémoire.
    const aliases = new Map<string, string>();

    return rows.map(
      ({
        visitorKey,
        sessionId,
        campaignSource,
        campaignMedium,
        campaignName,
        ...row
      }) => {
        let alias = aliases.get(visitorKey);

        if (alias === undefined) {
          alias = randomBytes(ALIAS_BYTES).toString('base64url');
          aliases.set(visitorKey, alias);
        }

        // Regroupées en objet plutôt qu'en trois champs plats : une campagne est
        // un triplet, et « source seule » n'en désigne pas une. Les trois
        // colonnes à `null` valent « pas de campagne », pas « campagne aux
        // champs vides » — la distinction disparaîtrait à plat.
        const campaign =
          campaignSource ?? campaignMedium ?? campaignName
            ? {
                source: campaignSource,
                medium: campaignMedium,
                name: campaignName,
              }
            : null;

        // `sessionId` est déballé puis remis : Drizzle le type `string | null`
        // parce que la colonne l'est, alors que la jointure interne juste
        // au-dessus garantit qu'il ne l'est pas ici. Le rétablir explicitement
        // dit où vit cette garantie, au lieu de la faire passer pour une
        // inattention.
        return {
          ...row,
          sessionId: sessionId as string,
          campaign,
          visitorAlias: alias,
        };
      },
    );
  }

  /**
   * Une tranche du journal, et de quoi demander la suivante.
   *
   * ## Pourquoi une méthode de plus, et pas un paramètre sur `events()`
   *
   * Les deux lectures ne rendent pas la même chose. `events()` rend **toute**
   * la fenêtre avec un alias de visiteur, parce que son appelant la replie en
   * sessions et a besoin de reconnaître un visiteur d'une ligne à l'autre.
   * Celle-ci rend vingt lignes **sans alias** : sur une lecture paginée, un
   * jeton tiré à chaque appel serait différent d'une page à l'autre, donc
   * mensonger pour qui les met bout à bout. Un paramètre commun aurait fait une
   * méthode dont le retour change de nature selon un argument.
   *
   * Elles ne lisent pas non plus dans le même sens. `events()` va du plus
   * ancien au plus récent, parce que replier un journal en sessions suppose de
   * le parcourir dans l'ordre où il s'est écrit. Celle-ci va du plus **récent**
   * au plus ancien : un journal se consulte par ce qui vient d'arriver, et
   * commencer par le plus vieux obligerait à parcourir toute la fenêtre pour
   * voir la dernière minute.
   *
   * Ce qu'elles partagent est ce qui compte, et c'est partagé pour de vrai :
   * `where()` et le couple `(occurred_at, id)` qui donne un ordre total.
   *
   * ## Le curseur, et pourquoi ce n'est pas un `offset`
   *
   * `offset` compte des lignes depuis le début, donc il dépend de ce qui est
   * arrivé entre-temps : un événement ingéré pendant la lecture décale tout ce
   * qui suit, et la page 2 ressaute une ligne déjà vue ou en saute une jamais
   * vue. Le curseur désigne une **position**, pas un rang : la suite est
   * toujours « ce qui précède cet événement-là », quoi qu'il soit arrivé.
   *
   * Le décalage est ici plus qu'une gêne : en lecture décroissante, tout
   * événement ingéré pendant le parcours s'insère **en tête**, donc un `offset`
   * ferait réapparaître en page 2 des lignes déjà lues en page 1. Le curseur y
   * est insensible.
   *
   * Il est **opaque** au reste du monde, et l'`id` qu'il contient ne devient
   * pas pour autant un champ de ligne : il traverse la réponse plié dans un
   * jeton, jamais publié comme référence.
   *
   * ## Une ligne de plus que demandé
   *
   * La requête tire `limit + 1`. C'est ce qui distingue « la page est pleine »
   * de « il reste quelque chose après », sans compter la fenêtre — un
   * `count(*)` à chaque page coûterait exactement ce que la pagination existe
   * pour éviter. La ligne en trop est lue, jamais rendue.
   */
  async page(
    scope: EventScope,
    { limit, after }: EventPageRequest,
  ): Promise<EventPageResult> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(
        `[EventStore] limit doit être un entier positif, reçu ${String(limit)}.`,
      );
    }

    const cursor = after === undefined ? null : decodeCursor(after);

    if (after !== undefined && cursor === null) {
      // Un curseur illisible est une erreur d'appelant, pas une page vide : la
      // rendre vide ferait passer un jeton corrompu pour une fin de journal.
      throw new RangeError(`[EventStore] curseur illisible : « ${after} ».`);
    }

    const rows = await this.db
      .select({
        id: events.id,
        sessionId: events.sessionId,
        sessionStartedAt: sessions.startedAt,
        type: events.type,
        source: events.source,
        occurredAt: events.occurredAt,
        attributes: events.attributes,
        properties: events.properties,
      })
      .from(events)
      // `leftJoin`, et c'est la seule lecture de ce fichier qui en fasse un.
      // Le journal brut est la route générique sur le vocabulaire : un
      // événement sans visiteur — un deploy, un paiement — doit y apparaître.
      // Une jointure interne le ferait disparaître en silence, ce qui est le
      // contraire de ce que « journal brut » promet. Les autres méthodes
      // comptent des visiteurs ou replient des sessions : là, l'exclusion est
      // le comportement correct, et leur `innerJoin` reste.
      .leftJoin(sessions, eq(events.sessionId, sessions.id))
      .where(and(this.where(scope), cursor ? isOlder(cursor) : undefined))
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      // La projection est réécrite champ par champ plutôt que privée de son
      // `id` par un reste : ce qui sort est alors *visible* à l'endroit où ça
      // sort. Un `...reste` laisserait passer en silence toute colonne ajoutée
      // un jour au `select` ci-dessus — c'est exactement comme ça qu'une clé
      // finit par descendre jusqu'au navigateur.
      events: page.map((row) => ({
        sessionId: row.sessionId,
        sessionStartedAt: row.sessionStartedAt,
        type: row.type,
        source: row.source,
        occurredAt: row.occurredAt,
        attributes: row.attributes,
        properties: row.properties,
      })),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /**
   * Les types d'événement présents dans la fenêtre, par ordre alphabétique.
   *
   * ## Le périmètre ne peut pas porter de types, et c'est le sujet
   *
   * `Omit<EventScope, 'types'>` n'est pas une commodité de typage : c'est
   * l'invariant. Ces valeurs servent à **construire** un filtre, donc les
   * calculer à travers ce filtre ferait rétrécir la liste à mesure qu'on s'en
   * sert — on décoche un type, il disparaît du menu, et on ne peut plus le
   * recocher. Prendre un périmètre qui n'a pas de `types` rend l'erreur
   * impossible plutôt que de compter sur l'appelant pour ne pas la faire.
   *
   * Le Core ne sait toujours pas ce qu'un type signifie : il rend une colonne
   * dédoublonnée. C'est l'appelant qui en fait un menu.
   */
  async distinctTypes(scope: Omit<EventScope, 'types'>): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ type: events.type })
      .from(events)
      .where(this.where(scope))
      .orderBy(asc(events.type));

    return rows.map(({ type }) => type);
  }

  /**
   * `[from, to)` : la borne haute est exclue. C'est ce qui permet d'enchaîner
   * deux fenêtres consécutives — lundi puis mardi — sans compter deux fois un
   * événement tombé exactement à minuit, et de sommer les jours d'un mois pour
   * retrouver le total du mois.
   */
  private where(scope: EventScope): SQL | undefined {
    return and(...this.scoped(scope), this.excludesBots());
  }

  /**
   * Le périmètre sans le filtre des robots — extrait parce qu'une lecture,
   * **une seule**, doit pouvoir regarder de l'autre côté.
   *
   * Elle n'existe pas pour rendre le filtre optionnel : il n'y a pas de drapeau
   * `includeBots` sur `EventScope`, et il ne faut pas en ajouter. Un
   * interrupteur invite à être basculé ; une méthode nommée se lit dans un diff.
   */
  private scoped(scope: EventScope): (SQL | undefined)[] {
    return [
      eq(events.projectId, scope.projectId),
      gte(events.occurredAt, scope.from),
      lt(events.occurredAt, scope.to),
      scope.types ? inArray(events.type, scope.types) : undefined,
      this.honoursServerOnly(),
    ];
  }

  /**
   * Écarte ce qu'une session de robot a produit.
   *
   * ## Pourquoi ici, et pas dans les lectures
   *
   * Exactement l'argument de `honoursServerOnly` : les neuf lectures passent par
   * `where`, et la table n'est lue que d'ici. Poser la règle dans chaque module
   * demanderait à chacun de s'en souvenir, et le premier qui l'oublierait
   * publierait des robots parmi ses visiteurs sans que rien ne le signale.
   *
   * ## Ce que ça ne jette pas
   *
   * Un `NOT EXISTS` est vrai quand il n'y a rien à trouver : un événement **sans
   * session** — un déploiement, un paiement, une sonde — passe donc sans qu'on
   * ait à l'écrire. C'est la même propriété que celle dont `sessionId` nullable
   * bénéficie déjà partout ailleurs.
   *
   * ## Ce que ça ne doit pas faire : se taire
   *
   * Un chiffre retiré en silence est un chiffre que personne ne sait manquant.
   * `countBotSessions` existe pour le publier, et le résumé le rend — sans quoi
   * ce filtre serait indistinguable d'une baisse de trafic.
   */
  private excludesBots(): SQL | undefined {
    return not(
      exists(
        this.db
          .select({ one: sql`1` })
          .from(sessions)
          .where(and(eq(sessions.id, events.sessionId), eq(sessions.isBot, true))),
      ),
    );
  }

  /**
   * Ce que le filtre a retiré : le nombre de sessions de robots de la fenêtre.
   *
   * La seule lecture de ce fichier qui regarde délibérément de l'autre côté de
   * `where`. Elle ne rend pas les événements, seulement leur compte de
   * sessions : ce qu'on veut savoir d'un robot tient dans un nombre, et le
   * reste n'intéresse personne.
   */
  async countBotSessions(scope: EventScope): Promise<number> {
    const [row] = await this.db
      .select({ sessions: countDistinct(events.sessionId) })
      .from(events)
      .innerJoin(sessions, eq(events.sessionId, sessions.id))
      .where(and(...this.scoped(scope), eq(sessions.isBot, true)));

    return row.sessions;
  }

  /**
   * Un montant, découpé dans le temps.
   *
   * ## Le pas est choisi par l'appelant, pas la fenêtre
   *
   * C'est le seul endroit du Core qui accepte une granularité temporelle, et
   * c'est assumé. L'analytics a rendu son découpage au lecteur à l'étape 33 —
   * il reçoit des sessions datées et les regroupe comme il l'entend — mais une
   * somme n'est pas un compte de valeurs distinctes : la redescendre entière
   * ferait remonter tous les paiements de la fenêtre pour en additionner les
   * montants dans un navigateur, et deux pages qui referaient ce calcul
   * finiraient par diverger.
   *
   * Le Core ne sait toujours pas ce qu'il additionne. Comme dans `topValues`,
   * il lit la clé qu'on lui nomme, à l'endroit qu'on lui nomme.
   *
   * ## `date_trunc`, et le fuseau
   *
   * En **UTC**, comme le reste de la chaîne. Le fuseau d'affichage est une
   * décision de lecteur, et l'appliquer ici ferait dépendre le contenu d'un
   * point du pays de qui regarde.
   *
   * ## Les pas vides n'existent pas
   *
   * Un jour sans paiement ne rend aucune ligne : un `group by` ne fabrique pas
   * de lignes absentes. C'est au lecteur de compléter son axe — il sait déjà le
   * faire pour le trafic, et il est le seul à connaître les bornes qu'il
   * affiche.
   */
  async amountSeries(
    scope: EventScope,
    { source, amount, currency, step }: AmountSelector & { step: SeriesStep },
  ): Promise<AmountPoint[]> {
    const bag = source === 'attributes' ? events.attributes : events.properties;

    // Résolution par un objet gelé dont les clés sont connues à la compilation :
    // `date_trunc` prend son unité en texte, et c'est exactement le genre
    // d'endroit où une chaîne d'appelant ne doit pas arriver.
    const unit = { day: sql`'day'`, week: sql`'week'`, month: sql`'month'` }[
      step
    ];

    // Même isolation que dans `topValues` : le groupement porte sur des colonnes
    // ordinaires de la sous-requête, et non sur des expressions que Drizzle
    // qualifie différemment selon la clause.
    const extracted = this.db
      .select({
        start: sql<Date>`date_trunc(${unit}, ${events.occurredAt} at time zone 'UTC') at time zone 'UTC'`.as(
          'start',
        ),
        currency: sql<string | null>`${bag} ->> ${currency}::text`.as(
          'currency',
        ),
        amount: sql<
          string | null
        >`case when ${bag} ->> ${amount}::text ~ '^-?[0-9]+$' then (${bag} ->> ${amount}::text)::bigint end`.as(
          'amount',
        ),
      })
      .from(events)
      .where(this.where(scope))
      .as('extracted');

    // `coalesce` parce qu'une somme sans aucune valeur rend `null` : un pas dont
    // aucun événement ne porte de montant existe, et il vaut zéro.
    const total = sql<number>`coalesce(sum(${extracted.amount}), 0)`.mapWith(
      Number,
    );

    return await this.db
      .select({
        // `mapWith` emprunte le convertisseur de la colonne d'origine : sans
        // lui, Drizzle rend la chaîne brute de Postgres, que le contrat rejette
        // — un `sql` n'hérite d'aucun type, c'est à l'appelant de le dire.
        start: sql<Date>`${extracted.start}`.mapWith(events.occurredAt),
        currency: extracted.currency,
        amount: total,
        events: sql<number>`count(*)`.mapWith(Number),
      })
      .from(extracted)
      .groupBy(extracted.start, extracted.currency)
      // Chronologique, puis la devise pour départager : sans le second critère,
      // deux appels identiques rendraient les devises dans un ordre différent.
      .orderBy(asc(extracted.start), asc(extracted.currency));
  }

  /**
   * Ce que les visiteurs ont répondu au sujet du cookie de croisement.
   *
   * ## Deux nombres, et leur somme ne fait pas `sessions`
   *
   * Le reste — la majorité, sur un site qui ne demande rien — n'a pas été
   * interrogé. Le mode par défaut de la mesure ne pose aucune question, donc
   * une visite sans réponse n'est ni un refus ni un trou : c'est le cas
   * ordinaire. Rendre un pourcentage ici obligerait à choisir son dénominateur,
   * et ce choix appartient au lecteur.
   *
   * ## `where` et non `scoped`
   *
   * Les robots restent **exclus**, comme partout ailleurs. `countBotSessions`
   * est la seule lecture de ce fichier à regarder de l'autre côté du filtre, et
   * elle le dit dans son nom.
   *
   * Les deux comptes partent ensemble : ils lisent la même jointure, et deux
   * requêtes pourraient se contredire si un événement arrivait entre les deux.
   */
  async countConsent(
    scope: EventScope,
  ): Promise<{ granted: number; declined: number }> {
    const [row] = await this.db
      .select({
        granted: sql<number>`count(distinct ${events.sessionId}) filter (where ${sessions.consent})`.mapWith(
          Number,
        ),
        declined: sql<number>`count(distinct ${events.sessionId}) filter (where not ${sessions.consent})`.mapWith(
          Number,
        ),
      })
      .from(events)
      .innerJoin(sessions, eq(events.sessionId, sessions.id))
      .where(this.where(scope));

    return row;
  }

  /**
   * Écarte les événements qu'un type `serverOnly` n'aurait pas dû voir arriver
   * d'un navigateur.
   *
   * ## Pourquoi à la lecture, et pas à l'écriture
   *
   * Un contrôle à l'ingestion arriverait toujours trop tard. Le drapeau est posé
   * *après* qu'un type existe — c'est l'ingestion qui l'inscrit — donc il suffit
   * de forger le type depuis un navigateur pendant la fenêtre où le drapeau
   * n'est pas encore là pour que la donnée fausse reste acquise à jamais.
   * Aucune vérification à l'écriture ne referme cette fenêtre.
   *
   * Ici l'ordre ne joue plus : poser le drapeau fait disparaître ces lignes
   * rétroactivement, le retirer les fait revenir, et rien n'est détruit sur un
   * changement de réglage. Les lignes forgées restent en base — elles ont
   * consommé du quota, c'est le prix assumé.
   *
   * ## Pourquoi ici, dans `where`
   *
   * Parce que **les neuf lectures de ce fichier y passent**, et qu'aucune autre
   * n'existe : la table `events` n'est lue que d'ici. Poser la règle dans chaque
   * module de `features/` demanderait à chacun de s'en souvenir, et le premier
   * qui l'oublierait publierait la donnée forgée sans que rien ne le signale.
   * Un seul point d'accroche, donc une seule chose à ne pas casser.
   *
   * La condition ne nomme aucun type et n'en compare aucun à un littéral : elle
   * corrèle deux colonnes. C'est ce qui lui permet de vivre dans le socle.
   */
  private honoursServerOnly(): SQL | undefined {
    return or(
      // Un événement réellement émis par un serveur est toujours légitime, quel
      // que soit le réglage de son type.
      eq(events.source, 'server'),
      not(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(eventTypes)
            .where(
              and(
                eq(eventTypes.projectId, events.projectId),
                eq(eventTypes.name, events.type),
                eq(eventTypes.serverOnly, true),
              ),
            ),
        ),
      ),
    );
  }
}
