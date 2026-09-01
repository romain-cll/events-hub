import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { FaviconsModule } from './favicons/favicons.module';
import { AnalyticsModule } from './features/analytics/analytics.module';
import { EventTypesFeatureModule } from './features/event-types/event-types.module';
import { EventsFeatureModule } from './features/events/events.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ProjectsModule } from './projects/projects.module';
import { SdkModule } from './sdk/sdk.module';

/**
 * La racine de composition : l'infrastructure, l'ingestion, puis les modules
 * métier.
 *
 * Seuls les modules *de tête* figurent ici. `CoreModule`, `EventsModule`,
 * `PrivacyModule`, `SessionsModule` et `ProjectsModule` sont tirés par ceux qui
 * les importent — les lister à nouveau ne dirait rien de plus et donnerait à
 * croire qu'ils sont montés à part.
 *
 * Ajouter un module métier se lit donc ici en une ligne, et ne demande de
 * toucher à rien d'autre.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    IngestionModule,
    SdkModule,
    FaviconsModule,
    OrganizationsModule,
    ProjectsModule,
    AnalyticsModule,
    EventsFeatureModule,
    EventTypesFeatureModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
