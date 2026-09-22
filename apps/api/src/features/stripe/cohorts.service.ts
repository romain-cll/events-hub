import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { CoreService } from '../../core/core.service';
import { DRIZZLE, type DrizzleDatabase } from '../../database/database.module';
import { stripeCustomers, stripeSubscriptions } from '../../database/schema';
import {
  cohortsOf,
  type Cohort,
  type CohortCustomer,
  type SubscriptionSpan,
} from './cohorts';
import type { RevenueCohortsDto } from './dto/revenue-query.dto';

/**
 * `GET /v1/projects/:projectId/revenue/cohorts` — qui reste, et depuis quand.
 *
 * ## Trois lectures, et une seule d'entre elles traverse le socle
 *
 * Les clients et leurs abonnements sont **nos** tables : ce module les lit
 * directement. La première visite, elle, vit dans `sessions`, dont la clé de
 * visiteur ne sort pas du Core — d'où `CoreService.firstVisits`, à qui on donne
 * les identifiants bruts que le site nous a confiés et qui rend des dates.
 *
 * C'est la même frontière que pour l'attribution : ce module sait ce qu'un
 * paiement veut dire, il ne sait pas — et ne peut pas fabriquer — ce qu'est une
 * identité.
 *
 * ## Qui compte comme client
 *
 * L'union de deux ensembles : ceux dont on connaît l'identité (`stripe_
 * customers`, donc ceux qui ont un jour porté un identifiant de visiteur) et
 * ceux qui ont un abonnement. Ni l'un ni l'autre seul ne suffit — le premier
 * rate les abonnés antérieurs à l'installation, le second rate les paiements
 * ponctuels.
 */
export interface CohortsPage {
  /** Borne incluse : le premier mois de cohorte rendu. */
  from: Date;
  /** Borne incluse : le dernier. */
  to: Date;
  /** Nombre de mois suivis après l'acquisition. */
  depth: number;
  cohorts: Cohort[];
  /**
   * Clients sans première visite connue — antérieurs à l'installation, ou sans
   * consentement. Ils ne sont dans aucune cohorte, et le taire ferait passer
   * une matrice partielle pour une matrice complète.
   */
  unmeasured: number;
}

@Injectable()
export class CohortsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDatabase,
    private readonly core: CoreService,
  ) {}

  async cohorts(
    projectId: string,
    { from, to, depth }: RevenueCohortsDto,
  ): Promise<CohortsPage> {
    const [known, spans] = await Promise.all([
      this.db
        .select({
          customerId: stripeCustomers.customerId,
          visitorId: stripeCustomers.visitorId,
        })
        .from(stripeCustomers)
        .where(eq(stripeCustomers.projectId, projectId)),
      this.db
        .select({
          customerId: stripeSubscriptions.customerId,
          startDate: stripeSubscriptions.startDate,
          endedAt: stripeSubscriptions.endedAt,
        })
        .from(stripeSubscriptions)
        .where(eq(stripeSubscriptions.projectId, projectId)),
    ]);

    const visits = await this.core.firstVisits(
      projectId,
      known.map((row) => row.visitorId),
    );

    const byCustomer = new Map<string, SubscriptionSpan[]>();

    for (const { customerId, startDate, endedAt } of spans) {
      const lot = byCustomer.get(customerId);

      if (lot) lot.push({ startDate, endedAt });
      else byCustomer.set(customerId, [{ startDate, endedAt }]);
    }

    const visitorOf = new Map(
      known.map((row) => [row.customerId, row.visitorId]),
    );

    // L'union des deux ensembles, prise sur les identifiants de client : un même
    // client peut être dans les deux, et le compter deux fois gonflerait sa
    // cohorte.
    const customers: CohortCustomer[] = [
      ...new Set([...visitorOf.keys(), ...byCustomer.keys()]),
    ].map((customerId) => {
      const visitorId = visitorOf.get(customerId);
      const visit = visitorId ? visits.get(visitorId) : undefined;

      return {
        firstVisit: visit?.startedAt ?? null,
        subscriptions: byCustomer.get(customerId) ?? [],
      };
    });

    // `now` est passé plutôt que lu par le calcul : c'est lui qui décide des
    // cellules qui n'ont pas encore eu lieu, et une fonction qui lirait
    // l'horloge ne s'éprouverait pas.
    const reading = cohortsOf(customers, { from, to, depth, now: new Date() });

    return { from, to, depth, ...reading };
  }
}
