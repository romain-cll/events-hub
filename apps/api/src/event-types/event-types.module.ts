import { Module } from '@nestjs/common';

import { EventTypeRegistry } from './event-type-registry.service';

/**
 * L'accès à la table `event_types`, et rien d'autre.
 *
 * Même posture qu'`EventsModule` : un seul provider, aucun controller, et pas
 * de montage dans `AppModule`. `CoreModule` s'en sert pour inscrire à
 * l'ingestion, `EventTypesFeatureModule` pour lire et éditer depuis le
 * dashboard.
 *
 * `DatabaseModule` est `@Global()` : rien à importer pour obtenir DRIZZLE.
 */
@Module({
  providers: [EventTypeRegistry],
  exports: [EventTypeRegistry],
})
export class EventTypesModule {}
