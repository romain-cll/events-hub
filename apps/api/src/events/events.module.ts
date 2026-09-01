import { Module } from '@nestjs/common';

import { EventStore } from './event-store.service';

/**
 * L'accès à la table `events`, et rien d'autre.
 *
 * `EventStore` est le seul provider parce qu'il est le seul point d'accès :
 * `CoreModule` s'en sert pour écrire, les modules métier pour lire. Rien ici ne
 * connaît la signification d'un type d'événement — ajouter un module ne demande
 * donc pas de toucher à ce fichier.
 *
 * `DatabaseModule` est `@Global()` : rien à importer pour obtenir DRIZZLE.
 */
@Module({
  providers: [EventStore],
  exports: [EventStore],
})
export class EventsModule {}
