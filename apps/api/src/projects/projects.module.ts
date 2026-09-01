import { Module } from '@nestjs/common';

import { ProjectIngestionController } from './project-ingestion.controller';
import { ProjectKeysController } from './project-keys.controller';
import { ProjectKeysService } from './project-keys.service';
import { ProjectMemberGuard } from './project-member.guard';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * Les projets, et la règle d'accès qui va avec.
 *
 * `ProjectMemberGuard` est exporté parce qu'il s'applique ailleurs — sur
 * `AnalyticsController`, et sur tout module qui servira une route en
 * `:projectId`. C'est volontairement le même guard partout : deux
 * implémentations de « ce projet est-il à vous » finiraient par diverger.
 */
@Module({
  controllers: [
    ProjectsController,
    ProjectKeysController,
    ProjectIngestionController,
  ],
  providers: [ProjectsService, ProjectKeysService, ProjectMemberGuard],
  exports: [ProjectsService, ProjectKeysService, ProjectMemberGuard],
})
export class ProjectsModule {}
