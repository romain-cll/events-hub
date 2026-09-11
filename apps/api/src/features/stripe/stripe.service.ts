import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import type Stripe from 'stripe';

import { CoreService } from '../../core/core.service';
import { DRIZZLE, type DrizzleDatabase } from '../../database/database.module';
import { stripeCustomers, stripeWebhookEvents } from '../../database/schema';
import { IntegrationsService } from '../../integrations/integrations.service';
import { StripeConnectService } from '../../integrations/stripe-connect.service';
import {
  customerLinkOf,
  customerOf,
  replayOf,
  occurredAtOf,
  propertiesOf,
  sessionIdOf,
  typeOf,
  visitorIdOf,
  VISITOR_METADATA_KEY,
} from './event-mapping';
import { projectionOf, rowsOf } from './subscription-projection';
import { SubscriptionStore } from './subscription-store.service';

/** Une paire client ↔ visiteur, telle qu'un site l'affirme. */
interface CustomerLink {
  customerId: string;
  visitorId: string;
}

/**
 * Ce qu'une resynchronisation a fait, en quatre nombres.
 *
 * Rendu à l'appelant plutôt que journalisé seul : un bouton
 * « resynchroniser » qui ne dit rien laisse croire qu'il n'a rien fait. Et
 * `skipped` n'est pas un échec — c'est le compte des factures déjà rejouées,
 * donc la preuve que l'opération est idempotente.
 */
export interface SyncReport {
  /** Paires client ↔ visiteur **nouvelles**, chacune ayant déclenché un rattrapage. */
  customers: number;
  /** Abonnements dont l'état a été écrit. */
  subscriptions: number;
  /** Factures historiques rejouées, une par facture. */
  invoices: number;
  /** Factures déjà rejouées, laissées telles quelles. */
  skipped: number;
}

/**
 * Transformer les webhooks Stripe en événements du hub.
 *
 * ## Ce que ce module a le droit de faire, et le socle non
 *
 * Il **interprète**. Il sait qu'une facture payée sur renouvellement n'est pas un
 * nouveau client, que `amount_paid` est du revenu, que `eh_visitor_id` désigne un
 * visiteur. C'est le travail d'un module de `features/`, et c'est ce qui n'a pas
 * sa place dans `core/`.
 *
 * Ce qu'il ne fait pas : dériver une clé visiteur. Il transmet l'identifiant brut
 * au socle, qui en décide. C'est pour ça qu'il peut rattacher du revenu à un
 * parcours sans jamais nommer — ni pouvoir fabriquer — une identité.
 *
 * ## Pourquoi la paire est retenue plutôt que redemandée
 *
 * La première version interrogeait Stripe à chaque événement pour lire la
 * metadata du client. Éprouvée sur un vrai abonnement, elle attribuait **deux
 * événements sur douze** : un site pose l'identifiant sur son client *après* le
 * checkout, or les webhooks du paiement arrivent avant. On lisait un client
 * encore vide, deux secondes trop tôt, et c'est le paiement — le seul qui
 * compte — qui repartait muet.
 *
 * Retenir la paire renverse le problème. L'ordre d'arrivée n'a plus d'importance,
 * et ce qui a été écrit avant se rattrape après.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDatabase,
    private readonly connect: StripeConnectService,
    private readonly integrations: IntegrationsService,
    private readonly core: CoreService,
    private readonly subscriptions: SubscriptionStore,
  ) {}

  /**
   * Traite un webhook, de la signature à l'écriture.
   *
   * Rend sans lever quand l'événement n'est pas exploitable — un compte inconnu,
   * un événement déjà vu. Stripe considère toute réponse non-2xx comme un échec
   * et **rejoue**, indéfiniment : répondre 4xx à ce qu'on a délibérément ignoré
   * fabriquerait une file de rejeux qui ne se viderait jamais.
   *
   * Une signature invalide, elle, lève : ce n'est pas Stripe qui appelle.
   *
   * L'ordre des quatre temps n'est pas indifférent. On **apprend** avant
   * d'écrire, pour que l'événement en cours profite de ce qu'il vient
   * d'apprendre ; on **rattrape** après, une fois qu'il est écrit lui aussi.
   */
  async handle(payload: Buffer, signature: string): Promise<void> {
    const event = this.connect.verifyWebhook(payload, signature);

    // Sur un endpoint Connect, `account` porte le compte connecté d'où vient
    // l'événement. Absent, c'est un événement de **notre** propre compte, qui
    // n'appartient au projet de personne.
    if (!event.account) {
      this.logger.debug(
        `Webhook Stripe ${event.type} ignoré : événement du compte plateforme, sans compte connecté.`,
      );

      return;
    }

    if (event.type === 'account.application.deauthorized') {
      await this.forget(event.account);

      return;
    }

    const integration = await this.integrations.findByAccount(
      'stripe',
      event.account,
    );

    if (!integration) {
      // Un compte débranché continue d'émettre quelque temps.
      this.logger.warn(
        `Webhook Stripe ignoré : le compte ${event.account} n'est branché sur aucun projet.`,
      );

      return;
    }

    const { projectId } = integration;
    const customerId = customerOf(event.data.object);

    if (!(await this.claim(event.id, projectId, customerId))) return;

    let learned: CustomerLink | undefined;
    let written: { id: string };

    // ## Avant l'écriture : un échec doit relâcher la réservation
    //
    // Le registre est écrit avant l'ingestion pour que deux livraisons
    // concurrentes ne puissent pas gagner toutes les deux. Tant que rien n'est
    // écrit, un échec doit le relâcher — sinon le rejeu de Stripe, seul filet
    // qui reste, serait pris pour un doublon et l'événement perdu en silence.
    try {
      learned = await this.learn(projectId, event);

      const visitorId = await this.visitorId(projectId, event, customerId);

      written = await this.core.ingest({
        projectId,
        type: typeOf(event),
        occurredAt: occurredAtOf(event),
        // `attributes` appartient au SDK navigateur — contexte de page, écran,
        // langue. Un événement qui n'est jamais passé par un navigateur n'en a
        // aucun, et lui en inventer ferait mentir la moitié des lectures.
        attributes: {},
        properties: propertiesOf(event),
        // La source vient du chemin d'entrée, jamais du contenu : ce webhook
        // arrive de serveur à serveur.
        source: 'server',
        visitorId,
        // Le repli, et seulement le repli : une visite ne vaut que pour l'achat
        // conclu pendant qu'elle durait. La chercher alors qu'on tient déjà une
        // identité durable ne rattacherait rien de plus et laisserait deux
        // rattachements concurrents sur la même ligne.
        sessionId: visitorId ? undefined : sessionIdOf(event.data.object),
      });
    } catch (error) {
      await this.release(event.id);

      throw error;
    }

    // ## Après l'écriture : plus rien ne doit lever
    //
    // L'événement existe désormais. Relâcher la réservation ici ferait rejouer
    // Stripe, et le rejeu **écrirait le paiement une seconde fois** — le revenu
    // du jour double, la donnée reste plausible, et rien ne le signale. C'est la
    // pire panne que ce module puisse produire.
    //
    // Ce qui suit est donc réparable et non critique : sans le lien, cet
    // événement échappe au rattrapage rétroactif de son client ; sans le
    // rattrapage, les événements déjà écrits attendent la prochaine occasion. Un
    // journal, et on continue.
    try {
      await this.link(event.id, written.id);

      // La projection est là et pas ailleurs pour la même raison que le reste de
      // ce bloc : elle est **réparable**. Une projection ratée se rattrape à la
      // prochaine mise à jour de l'abonnement, ou au rattrapage manuel ; un
      // paiement écrit deux fois, non.
      await this.project(projectId, event);

      if (learned) await this.backfill(projectId, learned);
    } catch (error) {
      this.logger.error(
        `Webhook Stripe ${event.id} écrit, mais son rattachement a échoué : ${String(error)}. L'événement est en base ; l'attribution de ce client reste à rattraper.`,
      );
    }
  }

  /**
   * Rattrape ce que le branchement n'a pas vu passer.
   *
   * ## Pourquoi c'est indispensable, et pas un confort
   *
   * Brancher un compte n'importe rien du passé : un client abonné depuis deux
   * ans n'a produit aucun événement chez nous, et aucune lecture de cohorte ou
   * de rétention ne tient sans lui. Le flux seul ne peut pas répondre — il ne
   * contient rien d'antérieur à la connexion, par construction.
   *
   * ## Trois passes, et leur ordre compte
   *
   * **Les clients d'abord.** On y lit les paires client ↔ visiteur déjà posées
   * dans la metadata, y compris sur des clients antérieurs à l'installation. Les
   * apprendre en premier, c'est permettre aux deux passes suivantes d'attribuer
   * au moment où elles écrivent, au lieu de laisser du revenu muet derrière
   * elles. Chaque paire nouvelle déclenche l'attribution rétroactive de ce qui
   * est déjà en base.
   *
   * **Les abonnements ensuite**, pour l'état courant. Rejouable à volonté :
   * l'upsert est idempotent, et le garde-fou d'ordre protège de tout.
   *
   * **Les factures enfin**, pour l'histoire, bornées à ce qui précède la
   * connexion. Au-delà, les webhooks ont déjà écrit, et rejouer ferait
   * doublon — la réservation l'en empêcherait, mais s'en remettre à elle
   * reviendrait à écrire une règle dans un mécanisme de secours.
   *
   * ## Ce que ça ne réparera pas
   *
   * Un client dont la metadata n'a jamais été posée **restera non attribué**. Le
   * rejeu écrit son revenu, il ne lui invente pas une origine. La seule
   * réparation passe par le chemin déjà construit : le site pose l'identifiant,
   * et la prochaine resynchronisation — ou le prochain webhook — le retient.
   *
   * Et le rejeu n'a pas la fidélité du direct : un checkout vivant produit
   * quatre événements Stripe, le rejeu n'en produit qu'un par facture. C'est
   * voulu, et `stripe.replayed` le dit sur chaque ligne.
   */
  async resync(projectId: string): Promise<SyncReport> {
    const integration = await this.integrations.find(projectId, 'stripe');

    if (!integration) {
      throw new NotFoundException(
        'Aucun compte Stripe n’est branché sur ce projet.',
      );
    }

    const account = integration.externalAccountId;

    const customers = await this.relearn(projectId, account);
    const subscriptions = await this.resyncSubscriptions(projectId, account);
    const invoices = await this.replayInvoices(
      projectId,
      account,
      integration.connectedAt,
    );

    this.logger.log(
      `Resynchronisation Stripe du projet ${projectId} : ${String(customers)} paire(s) apprise(s), ${String(subscriptions)} abonnement(s), ${String(invoices.invoices)} facture(s) rejouée(s).`,
    );

    return { customers, subscriptions, ...invoices };
  }

  /**
   * Relit les paires client ↔ visiteur posées chez Stripe.
   *
   * C'est la passe qui répare l'historique : un site qui pose `eh_visitor_id`
   * sur ses clients après coup rend d'un seul coup attribuable tout ce qu'ils
   * ont produit. Sans elle, il faudrait attendre qu'un webhook mentionne chaque
   * client, donc qu'il repaie.
   */
  private async relearn(projectId: string, account: string): Promise<number> {
    let learned = 0;

    await this.connect.api.customers
      .list({ limit: 100 }, { stripeAccount: account })
      .autoPagingEach(async (customer) => {
        const visitorId = visitorIdOf(customer);

        if (!visitorId) return;

        const link = await this.remember(projectId, {
          customerId: customer.id,
          visitorId,
        });

        if (!link) return;

        learned += 1;
        await this.backfill(projectId, link);
      });

    return learned;
  }

  /**
   * Relit l'état de tous les abonnements, actifs comme résiliés.
   *
   * `status: 'all'` et pas `active` : un abonnement résilié est exactement ce
   * qu'une lecture de churn cherche, et il ne reviendra jamais par le flux.
   *
   * Une seule date d'observation pour toute la passe — celle du début. Deux
   * abonnements lus à deux secondes d'écart décrivent le même instant logique,
   * et leur donner deux dates ferait dépendre le départage d'un ordre de
   * pagination.
   */
  private async resyncSubscriptions(
    projectId: string,
    account: string,
  ): Promise<number> {
    const observedAt = new Date();
    let applied = 0;

    await this.connect.api.subscriptions
      .list({ status: 'all', limit: 100 }, { stripeAccount: account })
      .autoPagingEach(async (subscription) => {
        const complete = await this.withAllItems(subscription, account);
        const projection = rowsOf(complete, observedAt);

        if (!projection) return;

        if (await this.subscriptions.save(projectId, projection)) applied += 1;
      });

    return applied;
  }

  /**
   * Complète les lignes d'un abonnement que la liste a tronquées.
   *
   * Une réponse de liste ne rend que **dix** items, et rien ne le signale sinon
   * ce `has_more`. Un abonnement à douze produits serait donc rangé amputé de
   * deux, avec un total plausible et faux — exactement la panne que la seconde
   * table existe pour éviter.
   */
  private async withAllItems(
    subscription: Stripe.Subscription,
    account: string,
  ): Promise<Stripe.Subscription> {
    if (!subscription.items.has_more) return subscription;

    const data: Stripe.SubscriptionItem[] = [];

    await this.connect.api.subscriptionItems
      .list(
        { subscription: subscription.id, limit: 100 },
        { stripeAccount: account },
      )
      .autoPagingEach((item) => {
        data.push(item);
      });

    return {
      ...subscription,
      items: { ...subscription.items, data, has_more: false },
    };
  }

  /**
   * Rejoue les factures payées **antérieures** à la connexion.
   *
   * La borne n'est pas une optimisation : au-delà, les webhooks ont déjà écrit
   * ces paiements, et les rejouer doublerait le revenu. La réservation
   * l'empêcherait — un `in_…` déjà pris ne repasse pas — mais compter sur elle
   * reviendrait à loger une règle métier dans un mécanisme de secours.
   *
   * La réservation est prise sous l'**identifiant de la facture**, faute
   * d'`evt_…` : une facture historique n'a jamais eu d'événement. Les deux
   * espaces de noms ne se croisent pas, `in_…` et `evt_…` étant distincts par
   * construction.
   */
  private async replayInvoices(
    projectId: string,
    account: string,
    before: Date,
  ): Promise<{ invoices: number; skipped: number }> {
    let invoices = 0;
    let skipped = 0;

    await this.connect.api.invoices
      .list(
        {
          status: 'paid',
          created: { lt: Math.floor(before.getTime() / 1000) },
          limit: 100,
        },
        { stripeAccount: account },
      )
      .autoPagingEach(async (invoice) => {
        const replay = replayOf(invoice);

        if (!replay || !invoice.id) return;

        const customerId = customerOf(invoice);

        // Déjà rejouée lors d'une resynchronisation précédente : c'est le cas
        // normal du bouton « resynchroniser », pas une anomalie.
        if (!(await this.claim(invoice.id, projectId, customerId))) {
          skipped += 1;

          return;
        }

        try {
          const visitorId =
            visitorIdOf(invoice) ??
            (customerId
              ? await this.knownVisitorId(projectId, customerId)
              : undefined);

          const written = await this.core.ingest({
            projectId,
            type: replay.type,
            occurredAt: replay.occurredAt,
            attributes: {},
            properties: replay.properties,
            source: 'server',
            visitorId,
          });

          await this.link(invoice.id, written.id);
          invoices += 1;
        } catch (error) {
          // Même règle que pour un webhook : tant que rien n'est écrit, la
          // réservation doit être relâchée, sinon la facture serait perdue et
          // comptée comme traitée.
          await this.release(invoice.id);

          throw error;
        }
      });

    return { invoices, skipped };
  }

  /**
   * Réserve l'identifiant de l'événement, ou dit qu'il était déjà pris.
   *
   * `onConflictDoNothing` + `returning` : c'est Postgres qui arbitre, donc deux
   * livraisons simultanées du même événement ne peuvent pas passer toutes les
   * deux — il n'y a ni verrou applicatif ni fenêtre entre le test et l'écriture.
   *
   * Le projet et le client sont posés dès maintenant : ils se lisent dans la
   * charge utile, et c'est ce couple qui rendra les événements de ce client
   * retrouvables le jour où on apprendra qui il est.
   */
  private async claim(
    eventId: string,
    projectId: string,
    customerId: string | undefined,
  ): Promise<boolean> {
    const claimed = await this.db
      .insert(stripeWebhookEvents)
      .values({ eventId, projectId, customerId })
      .onConflictDoNothing()
      .returning({ eventId: stripeWebhookEvents.eventId });

    return claimed.length > 0;
  }

  /** L'événement écrit, noté sur sa réservation — l'autre moitié de l'index. */
  private async link(eventId: string, writtenEventId: string): Promise<void> {
    await this.db
      .update(stripeWebhookEvents)
      .set({ writtenEventId })
      .where(eq(stripeWebhookEvents.eventId, eventId));
  }

  private async release(eventId: string): Promise<void> {
    await this.db
      .delete(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.eventId, eventId));
  }

  /**
   * Range l'état courant de l'abonnement que cet événement décrit.
   *
   * L'écriture elle-même vit dans `SubscriptionStore`, partagée avec le
   * rattrapage d'historique : deux chemins qui écriraient chacun de leur côté
   * finiraient par diverger sur le garde-fou d'ordre, et l'écart ne se verrait
   * que dans les chiffres.
   */
  private async project(projectId: string, event: Stripe.Event): Promise<void> {
    const projection = projectionOf(event);

    if (!projection) return;

    await this.subscriptions.save(projectId, projection);
  }

  /**
   * Retient la paire que cet événement affirme, si elle est nouvelle.
   *
   * Rend la paire **seulement quand elle change** : c'est ce qui évite de
   * relancer un rattrapage à chaque événement d'un client déjà connu, sans rien
   * coûter en justesse — l'attribution est de toute façon idempotente.
   *
   * Réapprendre une paire différente la remplace. Un client peut avoir été
   * réattribué à un autre visiteur, et la dernière affirmation du site fait foi ;
   * les événements déjà rattachés, eux, ne bougent pas.
   */
  private async learn(
    projectId: string,
    event: Stripe.Event,
  ): Promise<CustomerLink | undefined> {
    const link = customerLinkOf(event);

    if (!link) return undefined;

    return await this.remember(projectId, link);
  }

  /**
   * Retient une paire, et ne rend rien si elle était déjà celle-là.
   *
   * Séparée de `learn` pour le rattrapage, qui lit les paires dans les clients
   * de Stripe plutôt que dans un événement. Les deux chemins doivent écrire
   * pareil — et surtout décider pareil de ce qui est « nouveau », puisque c'est
   * ce qui déclenche l'attribution rétroactive.
   */
  private async remember(
    projectId: string,
    link: CustomerLink,
  ): Promise<CustomerLink | undefined> {
    const known = await this.knownVisitorId(projectId, link.customerId);

    if (known === link.visitorId) return undefined;

    await this.db
      .insert(stripeCustomers)
      .values({ projectId, ...link })
      .onConflictDoUpdate({
        target: [stripeCustomers.projectId, stripeCustomers.customerId],
        set: { visitorId: link.visitorId, learnedAt: new Date() },
      });

    return link;
  }

  /**
   * Rattache au visiteur tout ce que ce client a déjà produit.
   *
   * C'est ce qui répare la course : les événements d'un paiement arrivent avant
   * que le site n'ait posé l'identifiant sur le client, et repartaient donc
   * muets. Ils sont désormais rattrapés dès que la paire s'apprend, quelques
   * secondes ou plusieurs mois après.
   *
   * Le socle n'écrase rien : ce qui portait déjà une identité la garde.
   */
  private async backfill(
    projectId: string,
    { customerId, visitorId }: CustomerLink,
  ): Promise<void> {
    const rows = await this.db
      .select({ id: stripeWebhookEvents.writtenEventId })
      .from(stripeWebhookEvents)
      .where(
        and(
          eq(stripeWebhookEvents.projectId, projectId),
          eq(stripeWebhookEvents.customerId, customerId),
          isNotNull(stripeWebhookEvents.writtenEventId),
        ),
      );

    const attributed = await this.core.attribute(
      projectId,
      rows.map((row) => row.id).filter((id): id is string => id !== null),
      visitorId,
    );

    if (attributed > 0) {
      this.logger.log(
        `Client Stripe ${customerId} rattaché à un visiteur : ${String(attributed)} événement(s) déjà écrit(s) attribué(s).`,
      );
    }
  }

  /**
   * L'identifiant du visiteur derrière cet événement.
   *
   * Trois sources, de la plus directe à la plus coûteuse.
   *
   * **La metadata de l'objet** d'abord : c'est ce que le site vient de dire, sur
   * cet objet-là, et ça ne coûte aucune requête.
   *
   * **La paire retenue** ensuite. C'est elle qui porte la LTV : un renouvellement
   * d'abonnement est facturé des mois plus tard, sans navigateur nulle part et
   * sans metadata propre — seul le lien appris sur le client survit à ce délai.
   *
   * **Stripe enfin**, et seulement pour un client dont on n'a jamais vu passer
   * l'identité autrement. Ce chemin était le seul, et c'est ce qui rendait
   * l'attribution dépendante de l'ordre d'arrivée des webhooks.
   *
   * Rien nulle part : l'événement est écrit sans visiteur. Il compte dans le
   * revenu, il n'est simplement rattaché à aucun parcours — le cas normal d'un
   * client qui n'a pas consenti, et un état qui reste réparable plus tard.
   */
  private async visitorId(
    projectId: string,
    event: Stripe.Event,
    customerId: string | undefined,
  ): Promise<string | undefined> {
    const declared = visitorIdOf(event.data.object);

    if (declared) return declared;
    if (!customerId) return undefined;

    const known = await this.knownVisitorId(projectId, customerId);

    if (known) return known;

    return await this.askStripe(event, customerId);
  }

  private async knownVisitorId(
    projectId: string,
    customerId: string,
  ): Promise<string | undefined> {
    const row = await this.db.query.stripeCustomers.findFirst({
      where: and(
        eq(stripeCustomers.projectId, projectId),
        eq(stripeCustomers.customerId, customerId),
      ),
    });

    return row?.visitorId;
  }

  /** Le dernier recours : demander à Stripe la metadata de ce client. */
  private async askStripe(
    event: Stripe.Event,
    customerId: string,
  ): Promise<string | undefined> {
    if (!event.account) return undefined;

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
