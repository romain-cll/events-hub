import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProjectMemberGuard } from '../../projects/project-member.guard';
import {
  revenueCampaignsSchema,
  type RevenueCampaignsDto,
} from './dto/revenue-query.dto';
import { RevenueService, type CampaignRevenuePage } from './revenue.service';

/**
 * `GET /v1/projects/:projectId/revenue/…` — la lecture du revenu.
 *
 * Séparée de `StripeController`, qui reçoit les webhooks : l'un est `@Public()`
 * et authentifié par une signature, l'autre est réservé aux membres de
 * l'organisation. Deux publics, deux façons de prouver qui on est, donc deux
 * contrôleurs — les mélanger aurait mis un `@Public()` à portée de copier-coller
 * d'une route de lecture.
 *
 * Le chemin dit `revenue` et non `stripe` : le hub promet de croiser le revenu,
 * pas d'exposer un fournisseur. Le jour où un second encaisseur arrivera, c'est
 * la source des événements qui changera, pas l'URL.
 */
@UseGuards(ProjectMemberGuard)
@Controller({ path: 'projects/:projectId/revenue', version: '1' })
export class RevenueController {
  constructor(private readonly revenue: RevenueService) {}

  /**
   * Le revenu par campagne d'acquisition, sur une fenêtre.
   *
   * `projectId` est validé comme UUID avant d'atteindre la base : un identifiant
   * malformé produit un 400 explicite plutôt qu'une erreur de cast Postgres
   * remontée en 500.
   */
  @Get('campaigns')
  campaigns(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(revenueCampaignsSchema))
    query: RevenueCampaignsDto,
  ): Promise<CampaignRevenuePage> {
    return this.revenue.campaigns(projectId, query);
  }
}
