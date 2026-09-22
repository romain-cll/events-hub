import { Module } from '@nestjs/common';

import { UserAgentService } from './user-agent.service';

/**
 * La dérivation d'un User-Agent en libellés d'audience.
 *
 * Un module à part de `PrivacyModule`, pour la même raison que `GeoIpModule` :
 * celui-là garantit qu'une donnée identifiante ne ressort pas, celui-ci **dérive**
 * une donnée qu'on stocke. Voir l'en-tête de `UserAgentService`.
 */
@Module({
  providers: [UserAgentService],
  exports: [UserAgentService],
})
export class UserAgentModule {}
