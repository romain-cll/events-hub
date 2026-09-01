import { Module } from '@nestjs/common';

import { CoreModule } from '../core/core.module';
import { ProjectsModule } from '../projects/projects.module';
import { IngestionController } from './ingestion.controller';

/**
 * L'adaptateur HTTP du socle d'ingestion : `POST /v1/events`.
 *
 * Il ne porte aucune logique — valider la forme du payload et appeler
 * `CoreService.ingest()`. La séparation d'avec `CoreModule` est ce qui permet
 * d'ajouter demain un second point d'entrée (ingestion par lot, consommation
 * d'une file) sans rouvrir le socle.
 */
@Module({
  imports: [CoreModule, ProjectsModule],
  controllers: [IngestionController],
})
export class IngestionModule {}
