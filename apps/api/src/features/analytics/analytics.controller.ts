import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  analyticsLocationsSchema,
  analyticsTechnologySchema,
  analyticsWindowSchema,
  type AnalyticsLocationsDto,
  type AnalyticsTechnologyDto,
  type AnalyticsWindowDto,
} from './dto/analytics-query.dto';
import {
  AnalyticsService,
  type AnalyticsSummary,
  type LocationsPage,
  type TechnologyPage,
  type SessionsPage,
} from './analytics.service';
import { ProjectMemberGuard } from '../../projects/project-member.guard';

/**
 * `GET /v1/projects/:projectId/analytics`.
 *
 * La ressource est rattachée au projet dans l'URL : toute lecture est cloisonnée
 * par projet, et il n'existe pas de route qui agrège plusieurs projets à la
 * fois. C'est la même frontière que celle appliquée à la clé visiteur.
 *
 * ## Deux routes, deux natures — pas deux vues de la même chose
 *
 * Il y en a eu trois jusqu'à l'étape 33. `/sources` rendait la répartition des
 * sessions par provenance, `/sessions` rendait leurs totaux : deux lectures du
 * même journal, repliées par la même fonction, dont deux compteurs étaient
 * numériquement identiques. Une seule reste, et elle rend les lignes.
 *
 * Ce qui sépare les deux routes qui restent n'est pas une vue, c'est un **coût
 * et une capacité** :
 *
 * - `/analytics` ne rend que des agrégats calculés par Postgres. Il répond sans
 *   faire remonter une ligne, donc il reste bon marché quel que soit le volume.
 *   C'est là son intérêt, `uniqueVisitors` compris : le lecteur sait refaire ce
 *   compte depuis les alias de la route voisine, mais il lui en coûte le
 *   journal entier ;
 * - `/analytics/sessions` rend le journal replié. C'est la donnée source, datée,
 *   que le lecteur regroupe comme il l'entend — et depuis qu'une ligne porte un
 *   alias de visiteur, le regroupement peut compter des visiteurs distincts, ce
 *   qui n'était pas le cas.
 *
 * Le premier est la jauge du second : son `sessions` dit exactement combien de
 * lignes le second rendra.
 *
 * `/analytics/locations` s'est ajoutée depuis, et elle relève de la première
 * nature : des agrégats, calculés par Postgres, sans qu'une ligne remonte. Elle
 * existe malgré tout séparément parce que le grain géographique se choisit —
 * pays, région, ville — et qu'un résumé ne choisit rien. **Une seule route pour
 * les trois grains**, cependant : c'est un paramètre qui change le classement,
 * pas le chemin.
 *
 * ## Aucune n'accepte de granularité temporelle
 *
 * `analyticsWindowSchema` est en `strictObject`, donc `?interval=day` est un
 * 400 sur les deux. Le paramètre a existé et il a été retiré avec la série qu'il
 * produisait : choisir un pas, un fuseau et un calendrier sont des décisions
 * d'affichage, et elles appartiennent à qui affiche. Accepter le paramètre en
 * l'ignorant laisserait croire à un découpage qui n'a pas eu lieu — sur une API
 * de lecture, c'est un chiffre faux que rien ne signale.
 */
/**
 * Réservée aux membres de l'organisation propriétaire du projet.
 *
 * Cette route a porté un `@Public()` pendant tout le temps où l'authentification
 * existait sans les organisations : exiger une session sans pouvoir vérifier
 * une appartenance aurait laissé n'importe quel compte lire n'importe quel
 * projet, ce qui déplace un trou sans le fermer.
 *
 * `ProjectMemberGuard` est ce qui le ferme. Il tourne après le guard global :
 * pas de session → 401 ; session sans appartenance → 404, indiscernable d'un
 * projet inexistant.
 */
@UseGuards(ProjectMemberGuard)
@Controller({ path: 'projects/:projectId/analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * `projectId` est validé comme UUID avant d'atteindre la base : un
   * identifiant malformé produit un 400 explicite plutôt qu'une erreur de cast
   * Postgres remontée en 500.
   */
  @Get()
  summarize(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(analyticsWindowSchema))
    window: AnalyticsWindowDto,
  ): Promise<AnalyticsSummary> {
    return this.analytics.summarize(projectId, window);
  }

  /**
   * `GET /v1/projects/:projectId/analytics/sessions`.
   *
   * La chaîne complète, et elle ne fait rien d'autre que la brancher :
   *
   *     events() → sessionsOf() → sourceOf() → lignes
   *
   * Aucun seuil n'est appliqué ici, aucune session n'est recalculée, aucune clé
   * visiteur n'est lue, aucune durée n'est refaite, et aucun total n'est fait.
   * Ce que la route ajoute au module, c'est **une forme de sortie** — voir
   * `SessionRow`, qui dit ce qu'elle porte et ce qu'elle écarte.
   */
  @Get('sessions')
  sessions(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(analyticsWindowSchema))
    window: AnalyticsWindowDto,
  ): Promise<SessionsPage> {
    return this.analytics.sessions(projectId, window);
  }

  /**
   * `GET /v1/projects/:projectId/analytics/locations`.
   *
   * **La seule route géographique, et il n'y en aura pas d'autre.** Les trois
   * onglets de la carte Locations et le planisphère tapent tous ici : c'est
   * `?grain=country|region|city` qui change le classement, pas le chemin. Une
   * route par grain aurait rendu trois fois la même requête sous trois noms.
   *
   * Le grain et la borne du classement sont validés par
   * `analyticsLocationsSchema` — enum fermé, `limit` borné, `strictObject` —
   * avant d'atteindre le service. La protection, elle, vient du
   * `@UseGuards(ProjectMemberGuard)` du contrôleur : rien à recâbler ici, et
   * c'est le but d'un guard posé sur la classe.
   */
  @Get('locations')
  locations(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(analyticsLocationsSchema))
    query: AnalyticsLocationsDto,
  ): Promise<LocationsPage> {
    return this.analytics.locations(projectId, query);
  }

  /**
   * `GET /v1/projects/:projectId/analytics/technology`.
   *
   * Jumelle de `locations` : une route, trois grains. Trois routes rendraient la
   * même requête sous trois noms, et il faudrait les garder d'accord.
   */
  @Get('technology')
  technology(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(analyticsTechnologySchema))
    query: AnalyticsTechnologyDto,
  ): Promise<TechnologyPage> {
    return this.analytics.technology(projectId, query);
  }
}
