import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ProjectMemberGuard, ProjectRoles } from '../projects/project-member.guard';
import { IntegrationsService } from './integrations.service';
import { StripeConnectService } from './stripe-connect.service';

/**
 * Le corps du retour OAuth, tel que le dashboard le relaie.
 *
 * `strictObject` comme partout : Stripe ajoute parfois des paramètres à l'URL de
 * retour, et les laisser passer en silence donnerait à croire qu'ils sont lus.
 */
const callbackSchema = z.strictObject({
  code: z.string().min(1),
  state: z.string().min(1),
});

/** Ce qu'on rend d'une connexion : de quoi l'afficher, rien de plus. */
interface PublicIntegration {
  provider: string;
  externalAccountId: string;
  livemode: boolean;
  connectedAt: Date;
}

/**
 * Brancher et débrancher une source de paiement.
 *
 * ## Pourquoi `owner` et `admin` seulement
 *
 * Brancher un compte Stripe fait entrer la comptabilité d'une entreprise dans le
 * hub, et la débrancher arrête l'attribution du revenu pour tout le monde. C'est
 * du même ordre que les clés d'ingestion, qui coupent la collecte — pas du même
 * ordre que lire un graphique.
 *
 * ## Le retour d'OAuth passe par le dashboard, pas par ici
 *
 * Stripe renvoie le navigateur sur le front, qui relaie `code` et `state` à
 * cette route par son appel authentifié ordinaire. Faire atterrir Stripe
 * directement sur l'API demanderait d'y traiter une navigation de premier
 * niveau porteuse d'une session de dashboard, puis de rediriger derrière — deux
 * problèmes de cookies pour aucun gain.
 */
@Controller({ path: 'projects/:projectId/integrations', version: '1' })
@UseGuards(ProjectMemberGuard)
@ProjectRoles('owner', 'admin')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly stripeConnect: StripeConnectService,
  ) {}

  /**
   * Rend l'URL vers laquelle envoyer le membre.
   *
   * `POST` et non `GET` alors que rien n'est écrit : l'URL porte un `state`
   * signé à durée de vie courte, donc chaque appel produit une valeur
   * différente. La rendre sur un `GET` inviterait à la mettre en cache, et un
   * lien mis en cache expire sans prévenir.
   */
  @Post('stripe/authorize')
  authorize(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): { url: string } {
    return { url: this.stripeConnect.authorizeUrl(projectId) };
  }

  @Post('stripe/callback')
  async callback(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Body(new ZodValidationPipe(callbackSchema))
    { code, state }: z.infer<typeof callbackSchema>,
  ): Promise<PublicIntegration> {
    const account = await this.stripeConnect.exchange(projectId, code, state);
    const row = await this.integrations.connect(projectId, 'stripe', account);

    return {
      provider: row.provider,
      externalAccountId: row.externalAccountId,
      livemode: row.livemode,
      connectedAt: row.connectedAt,
    };
  }

  /**
   * Débranche, chez nous **puis** chez Stripe.
   *
   * Dans cet ordre, et l'ordre est le sujet : ce que l'utilisateur a demandé,
   * c'est que le hub cesse de lire sa comptabilité. Cette promesse-là est tenue
   * dès la suppression locale. La révocation côté Stripe est un nettoyage — son
   * échec est journalisé, il n'annule rien.
   */
  @Delete('stripe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): Promise<void> {
    const existing = await this.integrations.find(projectId, 'stripe');

    if (!existing) {
      throw new NotFoundException('Aucune connexion Stripe sur ce projet.');
    }

    await this.integrations.disconnect(projectId, 'stripe');
    await this.stripeConnect.deauthorize(existing.externalAccountId);
  }
}
