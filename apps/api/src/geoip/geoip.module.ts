import { Module } from '@nestjs/common';

import { GeoIpService } from './geoip.service';

/**
 * La résolution d'une IP en libellés géographiques.
 *
 * Un module à part de `PrivacyModule` : celui-là garantit qu'une donnée
 * identifiante ne ressort pas, celui-ci **dérive** une donnée qu'on stocke.
 * Voir l'en-tête de `GeoIpService` pour la frontière exacte.
 */
@Module({
  providers: [GeoIpService],
  exports: [GeoIpService],
})
export class GeoIpModule {}
