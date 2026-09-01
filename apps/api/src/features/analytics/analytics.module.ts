import { Module } from '@nestjs/common';

import { EventsModule } from '../../events/events.module';
import { ProjectsModule } from '../../projects/projects.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Premier module consommateur de l'Event Store.
 *
 * Il n'importe que du Core, et le Core n'importe rien de lui : la dépendance ne
 * va que dans un sens. Le retirer de `AppModule` ferait disparaître la route
 * `/analytics` sans que l'ingestion en souffre — c'est la vérification la plus
 * simple que la frontière tient.
 */
@Module({
  imports: [EventsModule, ProjectsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
