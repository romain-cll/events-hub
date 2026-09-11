import { Injectable } from '@nestjs/common';

import {
  EventStore,
  type EntryCampaignTotals,
} from '../../events/event-store.service';
import {
  AMOUNT_KEY,
  CURRENCY_KEY,
  TYPE_BY_REVENUE_KIND,
} from './event-mapping';
import type { RevenueCampaignsDto, RevenueKind } from './dto/revenue-query.dto';

/**
 * Ce qu'une campagne a rapporté sur la fenêtre.
 *
 * Les montants sont rendus **tels que Stripe les écrit** — en centimes, dans la
 * devise de la transaction. Ni conversion, ni arrondi, ni mélange de devises :
 * un client qui verrait ici un total différent de son tableau de bord Stripe
 * conclurait que c'est le nôtre qui ment, et il aurait raison de le conclure
 * puisqu'il n'a aucun moyen de trancher.
 */
export interface CampaignRevenue {
  /** Les trois UTM de la **première** visite du visiteur, normalisés. */
  campaign: {
    source: string | null;
    medium: string | null;
    name: string | null;
  };
  /** La devise ISO telle que Stripe la donne, ou `null` si l'objet n'en porte pas. */
  currency: string | null;
  /** Somme des montants, en centimes, dans cette devise-là seulement. */
  amount: number;
  /** Nombre d'événements comptés — un par paiement du type visé. */
  payments: number;
  /** Visiteurs distincts derrière ces paiements. */
  visitors: number;
}

/** Un total sans campagne : même forme, moins ce qu'on ne sait pas. */
export interface UnsourcedRevenue {
  currency: string | null;
  amount: number;
  payments: number;
  visitors: number;
}

/**
 * `GET /v1/projects/:projectId/revenue/campaigns`.
 *
 * ## Trois ensembles, et les deux derniers ne sont pas des restes
 *
 * `campaigns` est le classement. `direct` porte les paiements de visiteurs
 * **qu'on connaît** et qui ne sont venus par aucune campagne. `unattributed`
 * porte ceux qu'aucun parcours ne réclame — pas de consentement, pas
 * d'identifiant posé, ou un client antérieur à l'installation.
 *
 * Les séparer est le point de la réponse. Annoncer « 12 k€ venus de Google »
 * sans dire que 30 k€ ne sont rattachés à rien laisserait lire une part comme un
 * total. C'est la même exigence que pour le MRR : un chiffre dont on ne peut pas
 * expliquer l'origine coûte plus cher qu'un chiffre faux.
 *
 * ## `kind`, et pourquoi il n'y a pas de « revenu total »
 *
 * Un paiement produit plusieurs événements Stripe qui portent tous le même
 * montant. Le classement vise donc un type, et un seul — `eventType` le nomme
 * dans la réponse, pour que le chiffre affiché ne soit jamais d'origine
 * devinable.
 */
export interface CampaignRevenuePage {
  /** Borne incluse. */
  from: Date;
  /** Borne exclue. */
  to: Date;
  /** La question posée, telle que l'appelant l'a formulée. */
  kind: RevenueKind;
  /**
   * Le type d'événement réellement additionné.
   *
   * Rendu parce qu'il est la définition du chiffre. Sans lui, « revenu par
   * campagne » recouvrirait quatre agrégats différents selon `kind`, et rien à
   * l'écran ne dirait lequel.
   */
  eventType: string;
  campaigns: CampaignRevenue[];
  direct: UnsourcedRevenue[];
  unattributed: UnsourcedRevenue[];
}

/**
 * La lecture du revenu croisé à l'acquisition.
 *
 * Le module interprète — il sait quel type d'événement est du revenu, et que
 * `payment.amount` en porte le montant. Le Core, lui, ne fait que joindre un
 * paiement à la première visite de son visiteur : c'est lui qui tient la clé, et
 * ce module n'a pas le droit de la nommer.
 */
@Injectable()
export class RevenueService {
  constructor(private readonly events: EventStore) {}

  async campaigns(
    projectId: string,
    { from, to, kind, limit }: RevenueCampaignsDto,
  ): Promise<CampaignRevenuePage> {
    const eventType = TYPE_BY_REVENUE_KIND[kind];

    const { rows, others } = await this.events.entryCampaigns(
      { projectId, from, to, types: [eventType] },
      {
        source: 'properties',
        amount: AMOUNT_KEY,
        currency: CURRENCY_KEY,
        limit,
      },
    );

    return {
      from,
      to,
      kind,
      eventType,
      // `flatMap` plutôt qu'un `as` : le Core garantit déjà que ces lignes ont
      // une campagne, mais c'est une garantie de requête, pas de type. Une
      // ligne sans campagne qui arriverait ici serait écartée, pas affichée
      // sous une campagne vide.
      campaigns: rows.flatMap((row) =>
        row.campaign ? [{ ...strip(row), campaign: row.campaign }] : [],
      ),
      direct: others.filter((row) => row.known).map(strip),
      unattributed: others.filter((row) => !row.known).map(strip),
    };
  }
}

/** Le total seul : ce que le Core rend, moins ce qui a servi à le ranger. */
function strip({
  currency,
  amount,
  events,
  visitors,
}: EntryCampaignTotals): UnsourcedRevenue {
  return { currency, amount, payments: events, visitors };
}
