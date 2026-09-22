import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { Public } from '../../auth/auth.decorators';
import { StripeService } from './stripe.service';

/**
 * La porte d'entrée des webhooks Stripe.
 *
 * `@Public()` comme l'ingestion, et pour la même raison : l'appelant n'a pas de
 * session chez nous. Ce qui l'authentifie n'est pas un cookie mais la
 * **signature** du corps, vérifiée avant toute lecture.
 *
 * ## 200 sur presque tout, et ce n'est pas de la complaisance
 *
 * Stripe rejoue tout ce qui ne répond pas 2xx, indéfiniment. Répondre 4xx à un
 * événement qu'on a délibérément ignoré — compte inconnu, doublon — fabriquerait
 * une file de rejeux qui ne se viderait jamais. Le service ne lève donc que sur
 * une signature invalide, seul cas où l'appelant n'est pas Stripe.
 *
 * ## Le corps est un `Buffer`, et il doit l'être
 *
 * La signature porte sur les octets reçus : re-sérialiser du JSON parsé ne
 * redonne pas les mêmes. `app.setup.ts` monte donc `express.raw` sur ce chemin,
 * **avant** le `express.json()` global. Sans ça, tout webhook serait refusé.
 */
@Public()
@Controller({ path: 'webhooks/stripe', version: '1' })
export class StripeController {
  constructor(private readonly stripe: StripeService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: Request,
    @Headers('stripe-signature') signature?: string,
  ): Promise<void> {
    if (!signature || !Buffer.isBuffer(request.body)) {
      throw new BadRequestException('Webhook Stripe malformé.');
    }

    await this.stripe.handle(request.body, signature);
  }
}
