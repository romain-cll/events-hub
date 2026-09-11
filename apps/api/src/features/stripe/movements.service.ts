import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DRIZZLE, type DrizzleDatabase } from '../../database/database.module';
import { stripeSubscriptions } from '../../database/schema';
import type { RevenueMovementsDto } from './dto/revenue-query.dto';
import { movementsOf, type Movement } from './movements';

/**
 * `GET /v1/projects/:projectId/revenue/movements` — les entrées et les sorties.
 *
 * ## Pourquoi elle ne traverse pas le socle
 *
 * Parce qu'elle ne parle pas de visiteurs. Le churn se lit dans les dates des
 * abonnements, qui sont nos tables : aucune clé à dériver, aucune frontière à
 * franchir. C'est la différence avec les cohortes, qui ont besoin de la première
 * visite et passent donc par le Core.
 *
 * Croiser le churn avec la **source** d'acquisition demandera ce passage, et
 * c'est une lecture de plus — pas une colonne de plus ici.
 */
export interface MovementsPage {
  /** Borne incluse : le premier mois rendu. */
  from: Date;
  /** Borne incluse : le dernier mois **clos** rendu. */
  to: Date;
  movements: Movement[];
}

@Injectable()
export class MovementsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  async movements(
    projectId: string,
    { from, to }: RevenueMovementsDto,
  ): Promise<MovementsPage> {
    const spans = await this.db
      .select({
        startDate: stripeSubscriptions.startDate,
        endedAt: stripeSubscriptions.endedAt,
      })
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.projectId, projectId));

    return {
      from,
      to,
      movements: movementsOf(spans, { from, to, now: new Date() }),
    };
  }
}
