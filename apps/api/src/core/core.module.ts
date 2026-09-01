import { Module } from '@nestjs/common';

import { EventTypesModule } from '../event-types/event-types.module';
import { EventsModule } from '../events/events.module';
import { GeoIpModule } from '../geoip/geoip.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CoreService } from './core.service';

/**
 * Le socle d'ingestion, assemblé.
 *
 * Il importe ses cinq collaborateurs et n'expose qu'`CoreService` : c'est la
 * seule façon d'écrire un événement dans le hub. Aucun controller ici — brancher
 * l'ingestion sur HTTP est le travail d'`IngestionModule`, et l'y laisser rend
 * possible un second point d'entrée (lot, file) sans toucher à ce fichier.
 *
 * `DatabaseModule` est `@Global()` : rien à importer pour obtenir DRIZZLE.
 */
@Module({
  imports: [
    PrivacyModule,
    GeoIpModule,
    SessionsModule,
    EventTypesModule,
    EventsModule,
  ],
  providers: [CoreService],
  exports: [CoreService],
})
export class CoreModule {}
