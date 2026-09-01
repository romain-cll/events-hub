import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  EventTypeRegistry,
  type ProjectEventType,
} from '../../event-types/event-type-registry.service';
import { ProjectMemberGuard } from '../../projects/project-member.guard';
import {
  updateEventTypeSchema,
  type UpdateEventTypeDto,
} from './dto/update-event-type.dto';

/**
 * `/v1/projects/:projectId/event-types` — le vocabulaire d'un projet.
 *
 * ## Deux verbes, et l'absence du troisième
 *
 * Pas de `POST`. Un type naît de l'**ingestion**, à sa première apparition :
 * c'est ce qui permet à un client d'inventer son propre type métier sans rien
 * déclarer chez nous d'abord, et c'est la promesse même du hub. En ouvrir la
 * création à la main donnerait deux chemins vers la même ligne, dont un qui
 * pourrait décrire un type que rien n'émettra jamais.
 *
 * Pas de `DELETE` non plus. Supprimer une entrée ne supprimerait pas les
 * événements qui la portent — ils reviendraient à la prochaine ingestion, sans
 * le libellé ni le drapeau qu'on venait d'effacer. Ce serait une suppression qui
 * n'en est pas une.
 *
 * ## Ce module ne connaît toujours aucun type
 *
 * Il est dans `features/`, donc il en aurait le droit ; il ne s'en sert pas. Il
 * liste et édite des lignes dont il ne lit jamais le `name`. C'est ce qui le
 * rend valable pour les types que personne n'a prévus, qui sont sa raison
 * d'être.
 *
 * Réservé aux membres de l'organisation propriétaire, comme tout ce qui touche
 * à un projet.
 */
@UseGuards(ProjectMemberGuard)
@Controller({ path: 'projects/:projectId/event-types', version: '1' })
export class EventTypesController {
  constructor(private readonly registry: EventTypeRegistry) {}

  @Get()
  list(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): Promise<ProjectEventType[]> {
    return this.registry.list(projectId);
  }

  /**
   * Change le libellé, le drapeau `serverOnly`, ou les deux.
   *
   * Poser `serverOnly` a un effet **rétroactif et réversible** : les événements
   * de ce type déjà écrits depuis un navigateur cessent d'être rendus par toutes
   * les lectures, sans être détruits. Le retirer les fait revenir. C'est ce qui
   * ferme la fenêtre qu'un contrôle à l'écriture laisserait ouverte — le drapeau
   * ne peut être posé qu'après qu'un type existe, donc après qu'il a pu être
   * forgé.
   */
  @Patch(':eventTypeId')
  update(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('eventTypeId', new ZodValidationPipe(z.uuid())) eventTypeId: string,
    @Body(new ZodValidationPipe(updateEventTypeSchema))
    patch: UpdateEventTypeDto,
  ): Promise<ProjectEventType> {
    return this.registry.update(projectId, eventTypeId, patch);
  }
}
