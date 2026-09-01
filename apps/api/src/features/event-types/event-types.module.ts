import { Module } from '@nestjs/common';

import { EventTypesModule } from '../../event-types/event-types.module';
import { ProjectsModule } from '../../projects/projects.module';
import { EventTypesController } from './event-types.controller';

/**
 * Le vocabulaire d'un projet, exposé en HTTP.
 *
 * Aucun service à lui : `EventTypeRegistry` fait déjà exactement ce que les
 * deux routes demandent, et une couche par-dessus n'aurait rien à décider. Ses
 * voisins de `features/` en ont un parce qu'ils *interprètent* — replier des
 * sessions, classer des provenances. Ici il n'y a rien à interpréter.
 *
 * `ProjectsModule` fournit `ProjectMemberGuard`.
 *
 * ## Le suffixe, comme chez le voisin
 *
 * `EventTypesModule` existe déjà dans le socle et n'est pas monté dans
 * `AppModule` : il est l'accès à la table. Celui-ci monte une route et un guard.
 * Même partage qu'entre `EventsModule` et `EventsFeatureModule`.
 */
@Module({
  imports: [EventTypesModule, ProjectsModule],
  controllers: [EventTypesController],
})
export class EventTypesFeatureModule {}
