import { Module } from '@nestjs/common';

import { SessionAssigner } from './session-assigner.service';

/**
 * La sessionisation, offerte au chemin d'ingestion.
 *
 * Elle vit dans le Core et non dans un module d'analyse : le découpage en
 * sessions est une **propriété des données persistées**, pas une interprétation.
 * Tous les modules parlent des mêmes sessions parce qu'aucun ne les fabrique.
 */
@Module({
  providers: [SessionAssigner],
  exports: [SessionAssigner],
})
export class SessionsModule {}
