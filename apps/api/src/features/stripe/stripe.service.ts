import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';

import { CoreService } from '../../core/core.service';
import { DRIZZLE, type DrizzleDatabase } from '../../database/database.module';
import { stripeWebhookEvents } from '../../database/schema';
import { IntegrationsService } from '../../integrations/integrations.service';
import { StripeConnectService } from '../../integrations/stripe-connect.service';
import {
  customerIdOf,
  occurredAtOf,
  propertiesOf,
  typeOf,
} from './event-mapping';

/** La clé que le site du client pose dans la metadata de ses objets Stripe. */
const VISITOR_METADATA_KEY = 'eh_visitor_id';

/**
 * Transformer les webhooks Stripe en événements du hub.
 *
 * ## Ce que ce module a le droit de faire, et le socle non
 *
 * Il **interprète**. Il sait que `invoice.paid` avec `subscription_cycle` est un
 * renouvellement, que `amount_paid` est du revenu, que `eh_visitor_id` désigne un
 * visiteur. C'est exactement le travail d'un module de `features/`, et c'est ce
 * qui n'a pas sa place dans `core/`.
 *
 * Ce qu'il ne fait pas : hacher l'identifiant du visiteur. Il transmet la valeur
 * brute au socle, qui en dérive la clé. La corrélation reste ainsi calculée à un
 * seul endroit, et ce module ne tient jamais de clé visiteur.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDatabase,
    private readonly connect: StripeConnectService,
    private readonly integrations: IntegrationsService,
    private readonly core: CoreService,
  ) {}

  /**
   * Traite un webhook, de la signature à l'écriture.
   *
   * Rend toujours sans lever quand l'événement n'est pas exploitable — un compte
   * inconnu, un événement déjà vu. Stripe considère toute réponse non-2xx comme
   * un échec et **rejoue**, indéfiniment : répondre 4xx à ce qu'on a délibérément
   * ignoré fabriquerait une file de rejeux qui ne se viderait jamais.
   *
   * Une signature invalide, elle, lève : ce n'est pas Stripe qui appelle.
   */
  async handle(payload: Buffer, signature: string): Promise<void> {
    const event = this.connect.verifyWebhook(payload, signature);

    // Sur un endpoint Connect, `account` porte le compte connecté d'où vient
    // l'événement. Absent, c'est un événement de **notre** propre compte, qui
    // n'appartient au projet de personne.
    if (!event.account) return;

    if (event.type === 'account.application.deauthorized') {
      await this.forget(event.account);

      return;
    }

    const integration = await this.integrations.findByAccount(
      'stripe',
      event.account,
    );

    if (!integration) {
      // Un compte débranché continue d'émettre quelque temps. Le dire au
      // journal, et s'arrêter là.
      this.logger.warn(
        `Webhook Stripe ignoré : le compte ${event.account} n'est branché sur aucun projet.`,
      );

      return;
    }

    if (!(await this.claim(event.id))) return;

    try {
      await this.ingest(integration.projectId, event);
    } catch (error) {
      // Le registre est écrit avant l'ingestion pour que deux livraisons
      // concurrentes ne puissent pas gagner toutes les deux. En cas d'échec il
      // faut le relâcher, sinon le rejeu de Stripe — le seul filet qui reste —
      // serait pris pour un doublon et l'événement perdu en silence.
      await this.release(event.id);

      throw error;
    }
  }

  /**
   * Réserve l'identifiant de l'événement, ou dit qu'il était déjà pris.
   *
   * `onConflictDoNothing` + `returning` : c'est Postgres qui arbitre, donc deux
   * livraisons simultanées du même événement ne peuvent pas passer toutes les
   * deux — il n'y a ni verrou applicatif ni fenêtre entre le test et l'écriture.
   */
  private async claim(eventId: string): Promise<boolean> {
    const claimed = await this.db
      .insert(stripeWebhookEvents)
      .values({ eventId })
      .onConflictDoNothing()
      .returning({ eventId: stripeWebhookEvents.eventId });

    return claimed.length > 0;
  }

  private async release(eventId: string): Promise<void> {
    await this.db
      .delete(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.eventId, eventId));
  }

  private async ingest(projectId: string, event: Stripe.Event): Promise<void> {
    await this.core.ingest({
      projectId,
      type: typeOf(event),
      occurredAt: occurredAtOf(event),
      // `attributes` appartient au SDK navigateur — le contexte de page, l'écran,
      // la langue. Un événement qui n'est jamais passé par un navigateur n'en a
      // aucun, et lui en inventer ferait mentir la moitié des lectures.
      attributes: {},
      properties: propertiesOf(event),
      // La source vient du chemin d'entrée, jamais du contenu : ce webhook
      // arrive de serveur à serveur, donc il n'a pas de visite.
      source: 'server',
      visitorId: await this.visitorId(event),
    });
  }

  /**
   * L'identifiant du visiteur derrière ce paiement.
   *
   * Deux endroits, dans cet ordre. La metadata de **l'objet** d'abord : le site
   * l'y pose au moment du checkout, quand le navigateur est encore là. Celle du
   * **client** ensuite, et c'est elle qui porte la LTV — un renouvellement
   * d'abonnement est facturé des mois plus tard, sans navigateur nulle part, et
   * seule la metadata du Customer survit à ce délai.
   *
   * Le second cas coûte un appel à Stripe. C'est le prix d'un renouvellement
   * attribuable, et il ne se paie que quand le premier chemin n'a rien donné.
   *
   * Rien nulle part : le paiement est écrit sans visiteur. Il compte dans le
   * revenu, il n'est simplement rattaché à aucun parcours — ce qui est le cas
   * normal d'un client qui n'a pas consenti.
   */
  private async visitorId(event: Stripe.Event): Promise<string | undefined> {
    const object = event.data.object;

    if ('metadata' in object && object.metadata?.[VISITOR_METADATA_KEY]) {
      return object.metadata[VISITOR_METADATA_KEY];
    }

    const customerId = customerIdOf(object);

    if (!customerId || !event.account) return undefined;

    try {
      // Le compte connecté voyage dans les **options** (3e argument), pas dans
      // les paramètres de la requête : c'est l'en-tête `Stripe-Account`, pas un
      // champ du corps.
      const customer = await this.connect.api.customers.retrieve(
        customerId,
        {},
        { stripeAccount: event.account },
      );

      return customer.deleted
        ? undefined
        : customer.metadata[VISITOR_METADATA_KEY];
    } catch (error) {
      // Un client supprimé, une permission retirée : le paiement reste du
      // revenu, il perd seulement son attribution. Refuser l'événement entier
      // serait pire que de l'écrire incomplet.
      this.logger.warn(
        `Metadata client Stripe illisible pour ${customerId} : ${String(error)}`,
      );

      return undefined;
    }
  }

  /** Un client nous a débranchés depuis son tableau de bord Stripe. */
  private async forget(accountId: string): Promise<void> {
    const integration = await this.integrations.findByAccount(
      'stripe',
      accountId,
    );

    if (!integration) return;

    await this.integrations.disconnect(integration.projectId, 'stripe');
    this.logger.log(
      `Compte Stripe ${accountId} débranché depuis Stripe : connexion retirée du projet ${integration.projectId}.`,
    );
  }
}
