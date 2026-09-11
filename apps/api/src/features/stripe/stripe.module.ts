import { Module } from '@nestjs/common';

import { CohortsService } from './cohorts.service';
import { MovementsService } from './movements.service';
import { CoreModule } from '../../core/core.module';
import { EventsModule } from '../../events/events.module';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { ProjectsModule } from '../../projects/projects.module';
import { RevenueController } from './revenue.controller';
import { RevenueService } from './revenue.service';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { SubscriptionStore } from './subscription-store.service';

/**
 * Le revenu, en tant que source d'événements comme une autre.
 *
 * Il n'importe que le socle et la connexion. Le socle n'importe rien de lui : le
 * retirer d'`AppModule` ferait disparaître la route de webhook sans que
 * l'ingestion navigateur en souffre.
 *
 * Pas de suffixe `Feature` : il n'existe pas de `StripeModule` dans le socle avec
 * lequel le confondre, contrairement à `EventsFeatureModule`.
 *
 * Deux contrôleurs, et la frontière passe entre eux : l'un **reçoit** des
 * webhooks signés, l'autre **rend** du revenu à un membre authentifié. Ils
 * partagent un module parce qu'ils partagent une interprétation — celle de ce
 * qu'un paiement veut dire — et rien d'autre.
 */
@Module({
  imports: [CoreModule, EventsModule, IntegrationsModule, ProjectsModule],
  controllers: [StripeController, RevenueController],
  providers: [
    StripeService,
    RevenueService,
    CohortsService,
    MovementsService,
    SubscriptionStore,
  ],
})
export class StripeModule {}
