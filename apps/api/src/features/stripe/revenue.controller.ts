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
import { CohortsService, type CohortsPage } from './cohorts.service';
import {
  revenueAttributionSchema,
  revenueCohortsSchema,
  revenueMovementsSchema,
  revenueSeriesSchema,
  type RevenueAttributionDto,
  type RevenueCohortsDto,
  type RevenueMovementsDto,
  type RevenueSeriesDto,
} from './dto/revenue-query.dto';
import { MovementsService, type MovementsPage } from './movements.service';
import {
  RevenueService,
  type RevenueAttributionPage,
  type RevenueSeriesPage,
} from './revenue.service';
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
    private readonly cohortsReading: CohortsService,
    private readonly movementsReading: MovementsService,
    private readonly stripe: StripeService,
  ) {}

  /**
   * D'où vient le revenu, rangé de quatre façons à la fois.
   *
   * Une seule route plutôt que quatre : la carte Acquisition les affiche
   * ensemble, et quatre appels laisseraient leurs totaux diverger dès qu'un
   * paiement arrive entre deux.
   *
   * `projectId` est validé comme UUID avant d'atteindre la base : un identifiant
   * malformé produit un 400 explicite plutôt qu'une erreur de cast Postgres
   * remontée en 500.
   */
  @Get('attribution')
  attribution(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(revenueAttributionSchema))
    query: RevenueAttributionDto,
  ): Promise<RevenueAttributionPage> {
    return this.revenue.attribution(projectId, query);
  }

  /**
   * `GET /v1/projects/:projectId/revenue/series` — le revenu dans le temps.
   *
   * Une route pour un calcul, et pas un repli côté client : une somme d'argent
   * recalculée dans chaque page finit par diverger d'une page à l'autre. Son
   * total égale celui d'`/attribution` sur la même fenêtre, par construction.
   */
  @Get('series')
  series(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(revenueSeriesSchema))
    query: RevenueSeriesDto,
  ): Promise<RevenueSeriesPage> {
    return this.revenue.series(projectId, query);
  }

  /**
   * `GET /v1/projects/:projectId/revenue/cohorts` — qui reste, et depuis quand.
   *
   * La fenêtre borne les **mois d'acquisition**, pas les paiements observés :
   * une cohorte de mars suivie six mois regarde jusqu'en septembre, quelle que
   * soit la borne haute demandée.
   */
  @Get('cohorts')
  cohorts(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(revenueCohortsSchema))
    query: RevenueCohortsDto,
  ): Promise<CohortsPage> {
    return this.cohortsReading.cohorts(projectId, query);
  }

  /**
   * `GET /v1/projects/:projectId/revenue/movements` — qui entre, qui sort.
   *
   * Trois nombres bruts par mois, et aucun taux : le churn se divise de
   * plusieurs façons défendables, et en figer une ici priverait les autres de
   * leurs termes.
   */
  @Get('movements')
  movements(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(revenueMovementsSchema))
    query: RevenueMovementsDto,
  ): Promise<MovementsPage> {
    return this.movementsReading.movements(projectId, query);
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
