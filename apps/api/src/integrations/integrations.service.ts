import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DRIZZLE, type DrizzleDatabase } from '../database/database.module';
import {
  integrations,
  type Integration,
  type IntegrationProvider,
} from '../database/schema';
import type { ConnectedAccount } from './stripe-connect.service';

/**
 * Les connexions aux sources externes d'un projet.
 *
 * Le seul accès à la table `integrations`, sur le modèle d'`EventStore` : une
 * connexion est une clé d'accès à la comptabilité d'un client, et savoir depuis
 * quel endroit elle peut être créée ou lue doit rester une question à réponse
 * courte.
 *
 * Le service ne connaît aucun fournisseur en particulier — il range et retrouve.
 * Ce que Stripe exige de spécifique vit dans `StripeConnectService`.
 */
@Injectable()
export class IntegrationsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * Enregistre la connexion, ou remplace celle qui existait.
   *
   * `onConflictDoUpdate` plutôt qu'un test préalable : rebrancher un compte est
   * un geste normal — on change de compte Stripe, on repasse de test à
   * production — et le faire échouer obligerait à débrancher d'abord, pour un
   * résultat identique en deux fois plus d'étapes.
   *
   * Le remplacement est **silencieux mais visible** : `connectedAt` est réécrit,
   * donc l'interface montre la date du nouveau branchement.
   */
  async connect(
    projectId: string,
    provider: IntegrationProvider,
    account: ConnectedAccount,
  ): Promise<Integration> {
    const values = {
      projectId,
      provider,
      externalAccountId: account.accountId,
      scope: account.scope,
      livemode: account.livemode,
      connectedAt: new Date(),
    };

    const [row] = await this.db
      .insert(integrations)
      .values(values)
      .onConflictDoUpdate({
        target: [integrations.projectId, integrations.provider],
        set: values,
      })
      .returning();

    return row;
  }

  find(
    projectId: string,
    provider: IntegrationProvider,
  ): Promise<Integration | undefined> {
    return this.db.query.integrations.findFirst({
      where: and(
        eq(integrations.projectId, projectId),
        eq(integrations.provider, provider),
      ),
    });
  }

  /** Retrouve le projet d'un compte externe — le chemin qu'empruntent les webhooks. */
  findByAccount(
    provider: IntegrationProvider,
    externalAccountId: string,
  ): Promise<Integration | undefined> {
    return this.db.query.integrations.findFirst({
      where: and(
        eq(integrations.provider, provider),
        eq(integrations.externalAccountId, externalAccountId),
      ),
    });
  }

  async disconnect(
    projectId: string,
    provider: IntegrationProvider,
  ): Promise<void> {
    await this.db
      .delete(integrations)
      .where(
        and(
          eq(integrations.projectId, projectId),
          eq(integrations.provider, provider),
        ),
      );
  }
}
