import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ProjectMemberGuard } from './project-member.guard';
import { ProjectsService, type ProjectIngestion } from './projects.service';

/**
 * `GET /v1/projects/:projectId/ingestion` — « est-ce que ça arrive ? ».
 *
 * ## Pourquoi un contrôleur à part
 *
 * `ProjectsController` porte `/v1/projects` et n'a **pas** de
 * `ProjectMemberGuard`, faute de `:projectId` à vérifier — c'est écrit chez lui,
 * et c'est vrai. Glisser cette route-ci à côté demanderait un guard posé à la
 * méthode, donc une exception à une règle que le fichier affirme par ailleurs :
 * le prochain à lire le contrôleur croirait la classe entière ouverte.
 *
 * Ici la protection est déclarée au niveau de la classe, comme pour les clés :
 * toute route ajoutée dessous est cloisonnée sans que personne ait à y penser.
 *
 * ## Ce qu'elle sert, et à qui
 *
 * L'écran d'installation, qui l'interroge en boucle pendant que le développeur
 * colle le snippet chez lui. C'est la seule route de l'API conçue pour être
 * appelée toutes les trois secondes — d'où un booléen et rien de plus, résolu
 * par une existence plutôt que par un compte (voir `ingestionStatus`).
 *
 * Lire est ouvert à tous les membres, sans distinction de rôle : savoir si la
 * collecte a démarré n'engage rien, et un `member` qui installe le SDK sur son
 * poste doit pouvoir le constater.
 */
@UseGuards(ProjectMemberGuard)
@Controller({ path: 'projects/:projectId/ingestion', version: '1' })
export class ProjectIngestionController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  status(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): Promise<ProjectIngestion> {
    return this.projects.ingestionStatus(projectId);
  }
}
