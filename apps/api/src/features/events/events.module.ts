import { Module } from '@nestjs/common';

import { EventsModule } from '../../events/events.module';
import { ProjectsModule } from '../../projects/projects.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * Le journal brut, exposé en HTTP.
 *
 * Second consommateur de l'Event Store, et le premier qui n'en tire aucune
 * conclusion : il rend des événements, pas des réponses. Comme son voisin
 * Analytics, il n'importe que du Core, et le Core n'importe rien de lui.
 *
 * ## Le suffixe n'est pas décoratif
 *
 * `EventsModule` existe déjà, dans le socle, et c'est l'accès à la table. Les
 * deux noms se ressemblent parce que les deux parlent d'événements ; ils ne
 * font pas la même chose. Celui-ci monte une route et un guard, celui-là ne
 * monte rien — il n'est même pas dans `AppModule`. Le suffixe évite qu'un
 * import machinal les échange.
 */
@Module({
  imports: [EventsModule, ProjectsModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsFeatureModule {}
