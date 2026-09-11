import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProjectMemberGuard } from '../../projects/project-member.guard';
import {
  revenueCampaignsSchema,
  type RevenueCampaignsDto,
} from './dto/revenue-query.dto';
import { RevenueService, type CampaignRevenuePage } from './revenue.service';
import { StripeService, type SyncReport } from './stripe.service';

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
  constructor(
    private readonly revenue: RevenueService,
    private readonly stripe: StripeService,
  ) {}

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

  /**
   * `POST /v1/projects/:projectId/revenue/sync` — rattraper ce que le
   * branchement n'a pas vu passer.
   *
   * ## Pourquoi une route, et pas un appel dans le callback OAuth
   *
   * Parce que `integrations.controller.ts` appartient au socle, et que le socle
   * n'importe rien de `features/`. C'est la même frontière que partout ailleurs,
   * et elle a ici un effet heureux : la même route sert de bouton
   * « resynchroniser », que le client peut actionner le jour où il pose enfin
   * ses identifiants de visiteur sur ses clients Stripe.
   *
   * ## `POST`, et il est long
   *
   * Il écrit, donc `POST`. Et il parcourt trois listes paginées chez Stripe :
   * sur un compte chargé, la réponse se fait attendre. C'est assumé pour un
   * geste explicite et rare — le rendre asynchrone demanderait une file, donc
   * un état à suivre, pour une opération entièrement **idempotente** qu'il
   * suffit de relancer.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): Promise<SyncReport> {
    return this.stripe.resync(projectId);
  }
}
