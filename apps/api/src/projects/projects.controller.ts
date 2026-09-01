import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import type { AuthContext } from '../auth/auth';
import { Session } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  createProjectSchema,
  type CreateProjectDto,
} from './dto/create-project.dto';
import {
  updateProjectSchema,
  type UpdateProjectDto,
} from './dto/update-project.dto';
import { ProjectMemberGuard, ProjectRoles } from './project-member.guard';
import { ProjectsService, type ProjectRow } from './projects.service';

/**
 * La collection des projets, et chaque projet pris isolément.
 *
 * Pas de `@Public()` : le guard global s'applique, donc un appel sans session
 * reçoit un 401 sans que ce fichier ait à le dire.
 *
 * ## Deux régimes d'accès dans le même contrôleur
 *
 * `ProjectMemberGuard` est posé **par méthode**, pas sur la classe, et c'est le
 * seul choix qui marche : il lit `request.params.projectId`, que `GET /` et
 * `POST /` n'ont pas — au niveau classe il leur rendrait 404 à toutes deux.
 *
 * Sur la collection, le cloisonnement est donc fait par le service, qui filtre
 * par appartenance à partir de l'utilisateur de la session. Sur un projet
 * nommé, il est fait par le guard. Ce sont deux mécanismes parce que ce sont
 * deux questions : « lesquels sont à vous » et « celui-ci est-il à vous ».
 *
 * L'identifiant de l'utilisateur vient de la session, **jamais du corps de la
 * requête** : le laisser entrer par le payload permettrait de créer un projet
 * au nom de quelqu'un d'autre.
 *
 * ## Pourquoi renommer et supprimer exigent un rôle, et pas lire
 *
 * Lire les analytics est le geste ordinaire d'un membre. Renommer change ce que
 * tout le monde voit dans son sélecteur ; supprimer efface les événements de
 * l'organisation entière. `@ProjectRoles('owner', 'admin')` — les mêmes que
 * pour les clés, qui coupent la collecte pour tous.
 */
@Controller({ path: 'projects', version: '1' })
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Session() session: AuthContext): Promise<ProjectRow[]> {
    return this.projects.listForUser(session!.user.id);
  }

  @Post()
  create(
    @Session() session: AuthContext,
    @Body(new ZodValidationPipe(createProjectSchema)) payload: CreateProjectDto,
  ): Promise<ProjectRow> {
    return this.projects.createForUser(session!.user.id, payload);
  }

  @Patch(':projectId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles('owner', 'admin')
  rename(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) payload: UpdateProjectDto,
  ): Promise<ProjectRow> {
    return this.projects.rename(projectId, payload);
  }

  /**
   * Supprime — et cette fois c'est bien une suppression, pas une révocation.
   *
   * Les clés se révoquent (`revokedAt` posé, ligne conservée) parce que leur
   * historique se lit. Un projet supprimé n'a pas d'historique à lire : ce qu'il
   * portait part avec lui, dans l'ordre décrit par `ProjectsService.remove`.
   *
   * Le projet est rendu tel qu'il était juste avant : c'est la seule occasion de
   * le nommer dans une confirmation, et l'écran n'a plus rien à relire ensuite.
   */
  @Delete(':projectId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles('owner', 'admin')
  remove(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): Promise<ProjectRow> {
    return this.projects.remove(projectId);
  }
}
