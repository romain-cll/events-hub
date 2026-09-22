import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type {
  Integration,
  IntegrationProvider,
} from '../database/schema';
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

/**
 * Ce qu'on rend d'une connexion : de quoi l'afficher, rien de plus.
 *
 * Ni `id`, ni `projectId` — le premier ne sert à personne, le second est déjà
 * dans l'URL. Aucun secret non plus, et il n'y en a pas : Connect ne rend pas
 * de jeton à conserver.
 */
export interface PublicIntegration {
  provider: IntegrationProvider;
  externalAccountId: string;
  scope: string;
  livemode: boolean;
  connectedAt: Date;
}

/** La projection, en un seul endroit : deux routes la rendent. */
const publicOf = (row: Integration): PublicIntegration => ({
  provider: row.provider,
  externalAccountId: row.externalAccountId,
  scope: row.scope,
  livemode: row.livemode,
  connectedAt: row.connectedAt,
});

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
  /**
   * Ce qui est branché sur ce projet.
   *
   * Ouvert à **tout membre**, contrairement aux trois autres : savoir d'où vient
   * le revenu affiché fait partie de la lecture ordinaire. Le brancher et le
   * débrancher, non — c'est du même ordre que les clés d'ingestion.
   */
  @Get()
  async list(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): Promise<PublicIntegration[]> {
    const stripe = await this.integrations.find(projectId, 'stripe');

    return stripe ? [publicOf(stripe)] : [];
  }

  @Post('stripe/authorize')
  @ProjectRoles('owner', 'admin')
  authorize(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): { url: string } {
    return { url: this.stripeConnect.authorizeUrl(projectId) };
  }

  @Post('stripe/callback')
  @ProjectRoles('owner', 'admin')
  async callback(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Body(new ZodValidationPipe(callbackSchema))
    { code, state }: z.infer<typeof callbackSchema>,
  ): Promise<PublicIntegration> {
    const account = await this.stripeConnect.exchange(projectId, code, state);

    return publicOf(await this.integrations.connect(projectId, 'stripe', account));
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
  @ProjectRoles('owner', 'admin')
  async disconnect(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
  ): Promise<PublicIntegration> {
    const existing = await this.integrations.find(projectId, 'stripe');

    if (!existing) {
      throw new NotFoundException('Aucune connexion Stripe sur ce projet.');
    }

    await this.integrations.disconnect(projectId, 'stripe');
    await this.stripeConnect.deauthorize(existing.externalAccountId);

    // La connexion retirée, et pas un 204 : c'est la convention des écritures de
    // cette API — une suppression rend ce qu'elle a supprimé, pour que le client
    // sache sur quoi il a agi sans relire.
    return publicOf(existing);
  }
}
