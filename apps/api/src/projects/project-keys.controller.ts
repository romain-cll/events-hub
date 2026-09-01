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

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  createProjectKeySchema,
  updateProjectKeySchema,
  type CreateProjectKeyDto,
  type UpdateProjectKeyDto,
} from './dto/project-key.dto';
import {
  ProjectKeysService,
  type ListedProjectKey,
} from './project-keys.service';
import { ProjectMemberGuard, ProjectRoles } from './project-member.guard';

/**
 * `/v1/projects/:projectId/keys` — les clés d'ingestion d'un projet.
 *
 * `ProjectMemberGuard` s'applique à tout le contrôleur : il faut appartenir à
 * l'organisation propriétaire, sans quoi le projet est réputé inexistant.
 *
 * ## Lire est ouvert aux membres, écrire ne l'est pas
 *
 * Un `member` peut voir les clés — elles sont publiques par nature, elles sont
 * dans le bundle de chaque page du site. Les **créer** et les **révoquer** est
 * réservé à `owner` et `admin`, parce que révoquer coupe la collecte pour tout
 * le monde d'un coup et que créer ouvre une nouvelle porte d'écriture.
 *
 * C'est le premier endroit où la colonne `role` de `memberships` autorise
 * quelque chose au lieu de simplement le décrire.
 */
@UseGuards(ProjectMemberGuard)
@Controller({ path: 'projects/:projectId/keys', version: '1' })
export class ProjectKeysController {
  constructor(private readonly keys: ProjectKeysService) {}

  @Get()
  list(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): Promise<ListedProjectKey[]> {
    return this.keys.list(projectId);
  }

  @Post()
  @ProjectRoles('owner', 'admin')
  create(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Body(new ZodValidationPipe(createProjectKeySchema))
    payload: CreateProjectKeyDto,
  ): Promise<ListedProjectKey> {
    return this.keys.create(projectId, payload);
  }

  @Patch(':keyId')
  @ProjectRoles('owner', 'admin')
  update(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('keyId', new ZodValidationPipe(z.uuid())) keyId: string,
    @Body(new ZodValidationPipe(updateProjectKeySchema))
    payload: UpdateProjectKeyDto,
  ): Promise<ListedProjectKey> {
    return this.keys.update(projectId, keyId, payload);
  }

  /**
   * Révoque — et ne supprime pas. La ligne reste, `revokedAt` est posé.
   *
   * Rien n'étant mis en cache à l'ingestion, la coupure est immédiate.
   */
  @Delete(':keyId')
  @ProjectRoles('owner', 'admin')
  revoke(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('keyId', new ZodValidationPipe(z.uuid())) keyId: string,
  ): Promise<ListedProjectKey> {
    return this.keys.revoke(projectId, keyId);
  }
}
