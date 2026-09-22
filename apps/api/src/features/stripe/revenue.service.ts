import { Injectable } from '@nestjs/common';

import {
  EventStore,
  type EntryAxis,
  type EntryRanking,
  type EntryTotals,
  type SeriesStep,
} from '../../events/event-store.service';
import {
  classifyReferrer,
  NATURE_LABELS,
  type Source,
  type TrafficNature,
} from '../analytics/entry-source';
import {
  REVENUE_TYPES,
  SETTLED_CURRENCY_KEY,
  SETTLED_KEY,
} from './event-mapping';
import type {
  AttributionAxis,
  RevenueAttributionDto,
  RevenueSeriesDto,
} from './dto/revenue-query.dto';

/**
 * Ce qu'une valeur d'axe a rapporté sur la fenêtre.
 *
 * Les montants sont ceux du **règlement**, recopiés de Stripe : en centimes,
 * dans la devise du compte connecté, avec le taux que Stripe a appliqué pour se
 * régler. On n'a ni choisi de taux ni refait d'arrondi — sans quoi un client
 * verrait ici un total différent de son tableau de bord et conclurait que c'est
 * le nôtre qui ment, avec raison puisqu'il n'a aucun moyen de trancher.
 *
 * Une devise `null` avec des `payments` non nuls n'est pas un groupe vide :
 * c'est l'aveu qu'autant de paiements existent et que cette lecture ne sait pas
 * les convertir. Voir `SETTLED_KEY`.
 */
export interface RevenueRow {
  /** Le libellé de la ligne, tel qu'on l'affiche. */
  label: string;
  /** La devise ISO telle que Stripe la donne, ou `null`. */
  currency: string | null;
  /** Somme des montants, en centimes, dans cette devise-là seulement. */
  amount: number;
  /** Nombre de paiements comptés. */
  payments: number;
  /** Visiteurs distincts derrière ces paiements. */
  visitors: number;
}

/** La campagne garde ses trois champs : « source seule » n'en désigne pas une. */
export interface CampaignRevenue extends RevenueRow {
  campaign: {
    source: string | null;
    medium: string | null;
    name: string | null;
  };
}

/**
 * Une **nature** de trafic — la famille, pas le site.
 *
 * La question posée est « quelle famille me rapporte », à quoi `Search` répond
 * et `google.fr` ne répond pas. Les hôtes ont leur propre axe.
 */
export interface NatureRevenue extends RevenueRow {
  nature: TrafficNature;
}

/** Un hôte classé — le même classement, un cran plus bas. */
export interface ReferrerRevenue extends RevenueRow {
  source: Source;
}

/** Un total sans valeur sur l'axe : même forme, moins ce qu'on ne sait pas. */
export type UnsourcedRevenue = Omit<RevenueRow, 'label'>;

/**
 * `GET /v1/projects/:projectId/revenue/attribution`.
 *
 * ## Une route, quatre répartitions
 *
 * La carte Acquisition montre les mêmes paiements rangés de quatre façons —
 * campagne, provenance, page d'entrée, pays. Quatre routes auraient demandé
 * quatre allers-retours pour une seule carte, et rien ne garantirait que leurs
 * totaux s'accordent : un paiement arrivé entre deux appels suffirait à les
 * faire diverger.
 *
 * ## Ce qui est additionné, et pourquoi la somme est juste
 *
 * **Une facture, une ligne.** Les cinq types de `REVENUE_TYPES` ne se recouvrent
 * pas — c'est tout l'objet de l'affinage fait à l'ingestion. Il n'y a donc pas
 * de `kind` à choisir : l'analyse fine du revenu appartient à Stripe, ce qu'on
 * rend ici est « d'où vient l'argent ».
 *
 * ## Trois ensembles, et les deux derniers ne sont pas des restes
 *
 * `rows` classe. `direct` porte les paiements de visiteurs **connus** qui n'ont
 * rien sur cet axe. `unattributed` porte ceux qu'aucun parcours ne réclame —
 * consentement refusé, identifiant jamais posé, client antérieur à
 * l'installation.
 *
 * Les séparer est le point de la réponse : annoncer « 12 k€ venus de Google »
 * sans dire que 30 k€ ne sont rattachés à rien fait lire une part comme un
 * total.
 */
export interface RevenueBreakdown<Row> {
  rows: Row[];
  /** Visiteurs connus, sans valeur sur cet axe. */
  direct: UnsourcedRevenue[];
  /** Paiements qu'aucune visite ne réclame. */
  unattributed: UnsourcedRevenue[];
}

export interface RevenueAttributionPage {
  /** Borne incluse. */
  from: Date;
  /** Borne exclue. */
  to: Date;
  /**
   * Les types d'événement réellement additionnés.
   *
   * Rendus parce qu'ils sont la définition du chiffre. Un paiement déclenche
   * plusieurs événements Stripe porteurs du même montant ; savoir lesquels ont
   * été retenus est la seule façon de réconcilier ce total avec Stripe.
   */
  eventTypes: string[];
  /**
   * Les répartitions demandées, et **elles seules**.
   *
   * Une clé absente veut dire « pas demandée », jamais « calculée et vide ».
   * Les rendre toutes ferait payer sept agrégations SQL à qui en affiche
   * quatre, et laisserait croire qu'un axe vide a été mesuré.
   */
  campaign?: RevenueBreakdown<CampaignRevenue>;
  source?: RevenueBreakdown<NatureRevenue>;
  referrer?: RevenueBreakdown<ReferrerRevenue>;
  landing?: RevenueBreakdown<RevenueRow>;
  country?: RevenueBreakdown<RevenueRow>;
  browser?: RevenueBreakdown<RevenueRow>;
  os?: RevenueBreakdown<RevenueRow>;
  device?: RevenueBreakdown<RevenueRow>;
}

/** Un point de la série : un pas, une devise, ce qui a été encaissé. */
export interface RevenuePoint {
  /**
   * Le début du pas, en **UTC**.
   *
   * Une borne, pas un libellé : le fuseau d'affichage est une décision de
   * lecteur, et l'appliquer ici ferait dépendre le contenu d'un point du pays
   * de qui regarde.
   */
  start: Date;
  /** La devise ISO telle que Stripe la donne, ou `null`. */
  currency: string | null;
  /** Somme des montants du pas, **en centimes**, dans cette devise seulement. */
  amount: number;
  /** Nombre de paiements comptés dans le pas. */
  payments: number;
}

/**
 * `GET /v1/projects/:projectId/revenue/series` — le revenu dans le temps.
 *
 * Le total de `points` égale celui d'`/attribution` sur la même fenêtre, devise
 * par devise : les deux lisent les mêmes types. C'est ce qui permet d'afficher
 * un graphique et un tableau côte à côte sans qu'ils se contredisent.
 */
export interface RevenueSeriesPage {
  /** Borne incluse. */
  from: Date;
  /** Borne exclue. */
  to: Date;
  /** Le pas demandé, en écho — le lecteur en a besoin pour dessiner son axe. */
  step: SeriesStep;
  /** Les types additionnés, comme pour l'attribution. */
  eventTypes: string[];
  /**
   * Un point par pas **et par devise**, du plus ancien au plus récent.
   *
   * ⚠️ Les pas sans paiement sont **absents**, pas à zéro : un `group by` ne
   * fabrique pas les lignes qu'il n'a pas. Compléter l'axe appartient au
   * lecteur.
   */
  points: RevenuePoint[];
}

/**
 * Où le SDK range le referrer et le chemin d'entrée.
 *
 * Nommées ici, dans un module métier, parce que le socle n'a pas le droit de les
 * nommer : il groupe la clé qu'on lui passe sans savoir ce qu'elle désigne.
 * C'est le même mécanisme que pour le montant d'un paiement.
 */
const REFERRER_KEY = 'page.referrer';
const PATH_KEY = 'page.path';

/**
 * Le plafond interne, plus haut que ce qui est affiché.
 *
 * Le repli des provenances se fait **après** le groupement SQL : `google.fr` et
 * `google.com` sont deux lignes pour Postgres et une seule pour le lecteur.
 * Couper à dix avant de replier ferait disparaître la moitié d'un moteur au
 * profit d'un referrer isolé.
 */
const SCAN_LIMIT = 250;

@Injectable()
export class RevenueService {
  constructor(private readonly events: EventStore) {}

  async attribution(
    projectId: string,
    { from, to, axes, limit }: RevenueAttributionDto,
  ): Promise<RevenueAttributionPage> {
    const scope = { projectId, from, to, types: [...REVENUE_TYPES] };
    // Le **règlement**, pas le montant facturé. C'est ce qui met les euros et
    // les dollars sur la même ligne sans qu'on ait choisi de taux : la
    // conversion est celle de Stripe, recopiée. Voir `SETTLED_KEY`.
    const money = {
      source: 'properties' as const,
      amount: SETTLED_KEY,
      currency: SETTLED_CURRENCY_KEY,
    };

    // Où chaque axe se lit. Les deux premiers vivent dans le sac du premier
    // événement de la visite ; les autres sont des colonnes posées à son
    // ouverture. Le Core ne sait pas ce que `page.referrer` désigne — il groupe
    // la clé qu'on lui nomme.
    const where: Record<AttributionAxis, EntryAxis> = {
      campaign: { on: 'session', column: 'campaign' },
      // La nature demande les **deux** : le referrer dit d'où vient le clic, la
      // campagne dit si on l'a acheté, et seule la seconde distingue du trafic
      // Google Ads d'un résultat organique. Le Core rend le couple, c'est ici
      // qu'on tranche — lui ne sait pas ce que ces deux valeurs désignent.
      source: {
        on: 'both',
        column: 'campaign',
        source: 'attributes',
        key: REFERRER_KEY,
      },
      referrer: { on: 'entry', source: 'attributes', key: REFERRER_KEY },
      landing: { on: 'entry', source: 'attributes', key: PATH_KEY },
      country: { on: 'session', column: 'country' },
      browser: { on: 'session', column: 'browser' },
      os: { on: 'session', column: 'os' },
      device: { on: 'session', column: 'device' },
    };

    // Une passe par axe demandé, en parallèle : elles lisent la même fenêtre et
    // ne peuvent donc pas se contredire.
    const rankings = await Promise.all(
      axes.map((axis) =>
        this.events.entryDimension(scope, {
          ...money,
          axis: where[axis],
          limit: SCAN_LIMIT,
        }),
      ),
    );

    const page: RevenueAttributionPage = {
      from,
      to,
      eventTypes: [...REVENUE_TYPES],
    };

    axes.forEach((axis, index) => {
      const ranking = rankings[index];

      if (axis === 'campaign') {
        page.campaign = this.breakdown(ranking, limit, (row) => {
          const [source, medium, name] = row.values;

          return {
            ...strip(row),
            label: [source, medium, name].filter(Boolean).join(' / '),
            campaign: { source, medium, name },
          };
        });

        return;
      }

      if (axis === 'source') {
        page.source = this.natures(ranking, limit);

        return;
      }

      if (axis === 'referrer') {
        page.referrer = this.hosts(ranking, limit);

        return;
      }

      page[axis] = this.breakdown(ranking, limit, (row) => ({
        ...strip(row),
        label: row.values[0] ?? '',
      }));
    });

    return page;
  }

  /**
   * Le revenu encaissé, découpé dans le temps.
   *
   * ## Le même total que l'attribution, par construction
   *
   * Les deux lectures visent les **mêmes cinq types**, sur la même fenêtre :
   * leurs totaux coïncident donc devise par devise, et c'est la propriété qui
   * justifie d'avoir centralisé le calcul ici plutôt que de le refaire dans
   * chaque page. Un e2e la vérifie — c'est le seul test qui prouve qu'on n'a
   * pas créé d'écart.
   *
   * ## Les pas vides ne sont pas comblés
   *
   * Un jour sans paiement ne rend aucun point. Compléter l'axe appartient au
   * lecteur : il le fait déjà pour le trafic, et il est le seul à savoir quelles
   * bornes il affiche.
   */
  async series(
    projectId: string,
    { from, to, step }: RevenueSeriesDto,
  ): Promise<RevenueSeriesPage> {
    const points = await this.events.amountSeries(
      { projectId, from, to, types: [...REVENUE_TYPES] },
      {
        source: 'properties',
        // La même clé que l'attribution, et c'est la condition de la propriété
        // annoncée juste au-dessus : deux lectures qui ne sommeraient pas la
        // même colonne rendraient deux totaux, et le graphique contredirait le
        // tableau sous lui.
        amount: SETTLED_KEY,
        currency: SETTLED_CURRENCY_KEY,
        step,
      },
    );

    return {
      from,
      to,
      step,
      eventTypes: [...REVENUE_TYPES],
      points: points.map(({ start, currency, amount, events }) => ({
        start,
        currency,
        amount,
        payments: events,
      })),
    };
  }

  /**
   * Coupe le classement à ce que l'appelant demande, et range le reste.
   *
   * `flatMap` plutôt qu'un `as` sur `rows` : le Core garantit déjà que ces
   * lignes ont une valeur, mais c'est une garantie de requête, pas de type.
   */
  private breakdown<Row>(
    ranking: EntryRanking,
    limit: number,
    shape: (row: EntryTotals) => Row,
  ): RevenueBreakdown<Row> {
    return {
      rows: ranking.rows.slice(0, limit).map(shape),
      direct: ranking.others.filter((row) => row.known).map(strip),
      unattributed: ranking.others.filter((row) => !row.known).map(strip),
    };
  }

  /**
   * Replie les referrers bruts en **natures**, la campagne l'emportant.
   *
   * Le socle rend un couple : la source de campagne de la visite, et son
   * referrer. Savoir que `google.fr` est un moteur et `t.co` un réseau est une
   * **interprétation**, déjà écrite une fois dans
   * `features/analytics/entry-source.ts` — la réécrire ici créerait une seconde
   * vérité, et les deux divergeraient au premier moteur ajouté.
   *
   * L'ordre, lui, se décide ici et nulle part ailleurs : une campagne présente
   * gagne, quelle que soit la nature du referrer. Une visite Google Ads arrive
   * de `google.com` comme une visite organique, et les fondre ferait lire « la
   * recherche m'apporte X » en y comptant du trafic acheté.
   */
  private natures(
    ranking: EntryRanking,
    limit: number,
  ): RevenueBreakdown<NatureRevenue> {
    return this.merged(ranking, limit, (row) => {
      const [campaign, referrer] = row.values;

      // L'URL de la page n'est pas passée, et c'est un écart connu : sans elle,
      // un referrer de notre propre site serait rangé en `other` plutôt qu'en
      // `internal`. Sur la **première** page de la **première** visite, le cas
      // est rare par construction — et la remonter obligerait à grouper sur
      // l'URL entière, ce qui ferait exploser le nombre de lignes pour une
      // information dont on ne garderait que l'hôte.
      const nature: TrafficNature =
        campaign === null ? classifyReferrer(referrer, null).kind : 'campaign';

      return { key: nature, label: NATURE_LABELS[nature], extra: { nature } };
    });
  }

  /** Le même classement un cran plus bas : un hôte par ligne, sa nature avec. */
  private hosts(
    ranking: EntryRanking,
    limit: number,
  ): RevenueBreakdown<ReferrerRevenue> {
    return this.merged(ranking, limit, (row) => {
      const source = classifyReferrer(row.values[0], null);

      return {
        key: String(source.name),
        label: source.label,
        extra: { source },
      };
    });
  }

  /**
   * Regroupe des lignes du Core sous une clé que l'appelant invente.
   *
   * Extrait parce que les deux replis ne diffèrent **que** par cette clé, et
   * qu'un second exemplaire du regroupement aurait divergé sur un détail —
   * l'un dédupliquant par devise et l'autre non, par exemple — sans que rien ne
   * le signale.
   *
   * La devise reste dans la clé même si elle est désormais presque toujours la
   * même : c'est ce qui empêche un jour de mélanger le règlement connu et
   * l'inconnu dans une seule ligne.
   */
  private merged<Extra>(
    ranking: EntryRanking,
    limit: number,
    classify: (row: EntryTotals) => {
      key: string;
      label: string;
      extra: Extra;
    },
  ): RevenueBreakdown<RevenueRow & Extra> {
    const merged = new Map<string, RevenueRow & Extra>();

    for (const row of ranking.rows) {
      const { key, label, extra } = classify(row);
      const at = `${key}|${String(row.currency)}`;
      const seen = merged.get(at);

      if (seen) {
        seen.amount += row.amount;
        seen.payments += row.events;
        // Les visiteurs ne s'additionnent pas sans risque — quelqu'un peut
        // avoir été vu derrière deux referrers du même moteur — mais le Core ne
        // rend pas de quoi les dédupliquer ici. Le compte est donc un majorant,
        // et c'est dit dans le contrat.
        seen.visitors += row.visitors;
      } else {
        merged.set(at, { ...strip(row), label, ...extra });
      }
    }

    return {
      rows: [...merged.values()]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, limit),
      direct: ranking.others.filter((row) => row.known).map(strip),
      unattributed: ranking.others.filter((row) => !row.known).map(strip),
    };
  }
}

/** Le total seul : ce que le Core rend, moins ce qui a servi à le ranger. */
function strip({
  currency,
  amount,
  events,
  visitors,
}: EntryTotals): UnsourcedRevenue {
  return { currency, amount, payments: events, visitors };
}
