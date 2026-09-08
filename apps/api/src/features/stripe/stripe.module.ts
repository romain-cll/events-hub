import { Module } from '@nestjs/common';

import { CoreModule } from '../../core/core.module';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';

/**
 * Le revenu, en tant que source d'événements comme une autre.
 *
 * Il n'importe que le socle et la connexion. Le socle n'importe rien de lui : le
 * retirer d'`AppModule` ferait disparaître la route de webhook sans que
 * l'ingestion navigateur en souffre.
 *
 * Pas de suffixe `Feature` : il n'existe pas de `StripeModule` dans le socle avec
 * lequel le confondre, contrairement à `EventsFeatureModule`.
 */
@Module({
  imports: [CoreModule, IntegrationsModule],
  controllers: [StripeController],
  providers: [StripeService],
})
export class StripeModule {}
