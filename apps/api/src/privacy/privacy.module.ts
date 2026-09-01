import { Module } from '@nestjs/common';

import { VisitorKeyService } from './visitor-key.service';

/**
 * Tout ce qui transforme une donnée identifiante en donnée exploitable sans
 * la conserver. Isolé dans son propre module parce que c'est la promesse
 * produit : ce qui entre ici ne doit pas en ressortir.
 */
@Module({
  providers: [VisitorKeyService],
  exports: [VisitorKeyService],
})
export class PrivacyModule {}
