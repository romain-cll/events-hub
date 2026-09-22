import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { StripeConnectService } from './stripe-connect.service';

/**
 * Brancher une source externe sur un projet.
 *
 * Monté dans `AppModule` parce qu'il porte des routes. `ProjectsModule` est
 * importé pour `ProjectMemberGuard` — c'est lui qui répond « ce projet est-il à
 * vous », et le redemander ici en dupliquerait la réponse.
 *
 * Exporte `IntegrationsService` : les modules métier qui reçoivent des webhooks
 * ont besoin de retrouver le projet d'un compte connecté, sans pouvoir toucher
 * à la table eux-mêmes.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, StripeConnectService],
  exports: [IntegrationsService, StripeConnectService],
})
export class IntegrationsModule {}
