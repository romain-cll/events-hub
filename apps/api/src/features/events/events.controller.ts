import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProjectMemberGuard } from '../../projects/project-member.guard';
import { eventsQuerySchema, type EventsQueryDto } from './dto/events-query.dto';
import { EventsService, type EventsPage } from './events.service';

/**
 * `GET /v1/projects/:projectId/events` — le journal brut.
 *
 * ## Une route, et une seule
 *
 * Pas de `/events/types` à côté : les types présents dans la fenêtre partent
 * dans l'enveloppe de cette réponse-ci. Deux routes auraient voulu dire deux
 * appels, donc deux périmètres qui peuvent diverger — un type qui apparaît dans
 * le menu et nulle part dans la page, ou l'inverse, selon l'ordre d'arrivée.
 *
 * Pas de `/events/:id` non plus. Le panneau de détail de l'écran affiche une
 * ligne **déjà présente** dans la réponse ; il n'a rien à aller rechercher, et
 * publier un identifiant d'événement en ferait une référence durable que le
 * Core ne promet pas.
 *
 * ## Ce qu'elle a de particulier face à ses voisines analytiques
 *
 * Elles répondent à des questions et savent donc ce qu'est une vue de page.
 * Celle-ci ne répond à rien : elle rend des événements du plus récent au plus
 * ancien, avec leurs deux sacs `jsonb` intacts. C'est la seule route du projet
 * où un type que personne n'a prévu — celui qu'un client émettrait pour son
 * propre métier — apparaît sans qu'aucune ligne de code ne le connaisse.
 *
 * Réservée aux membres de l'organisation propriétaire, comme tout ce qui lit un
 * projet : pas de session → 401, session sans appartenance → 404, indiscernable
 * d'un projet inexistant.
 */
@UseGuards(ProjectMemberGuard)
@Controller({ path: 'projects/:projectId/events', version: '1' })
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Query(new ZodValidationPipe(eventsQuerySchema)) query: EventsQueryDto,
  ): Promise<EventsPage> {
    return this.events.list({ projectId, ...query });
  }
}
