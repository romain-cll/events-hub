import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';

import { DRIZZLE, type DrizzleDatabase } from '../../database/database.module';
import {
  stripeSubscriptionItems,
  stripeSubscriptionRevisions,
  stripeSubscriptions,
} from '../../database/schema';
import { monthlyAmountOf, type Priced } from './monthly-amount';
import type { Projection } from './subscription-projection';

/**
 * L'écriture de l'état d'abonnement, en un seul endroit.
 *
 * Deux chemins y mènent — le webhook et le rattrapage d'historique — et ils
 * doivent écrire **exactement** pareil. Séparés, le second aurait fini par
 * oublier le garde-fou d'ordre ou le remplacement des items, et l'écart n'aurait
 * été visible que dans les chiffres.
 */
@Injectable()
export class SubscriptionStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * Range un abonnement et ses lignes, si l'observation est la plus récente.
   *
   * ## Le garde-fou d'ordre
   *
   * Stripe ne garantit pas l'ordre de livraison de ses webhooks, et
   * `Subscription` ne porte aucun numéro de version. Un `.updated` livré après
   * un `.deleted` ressusciterait un abonnement résilié — la ligne redeviendrait
   * `active`, et rien ne le signalerait.
   *
   * `setWhere` ferme ça : l'upsert ne s'applique que si l'observation est plus
   * récente que celle déjà en base. Une observation périmée ne rend aucune
   * ligne, donc les items ne sont pas remplacés non plus — c'est ce qui rend le
   * `returning` significatif plutôt que décoratif.
   *
   * ## Les items sont remplacés, pas fusionnés
   *
   * Un client qui retire un produit fait **disparaître** une ligne. Une fusion
   * la laisserait en place avec son montant, le total de l'abonnement resterait
   * celui d'avant, et rien n'échouerait. Suppression puis réécriture dans la
   * même transaction est la seule forme qui ne puisse pas mentir.
   *
   * Rend `true` quand l'observation a été appliquée — ce que le rattrapage
   * compte pour dire ce qu'il a fait.
   */
  async save(
    projectId: string,
    { subscription, items }: Projection,
  ): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      // L'état d'avant, lu avant de l'écraser. C'est la seule fenêtre où il
      // existe encore : l'upsert juste en dessous le remplace, et Postgres ne
      // rend pas l'ancienne ligne d'un `ON CONFLICT`.
      const [existing] = await tx
        .select({ id: stripeSubscriptions.id, status: stripeSubscriptions.status })
        .from(stripeSubscriptions)
        .where(
          and(
            eq(stripeSubscriptions.projectId, projectId),
            eq(stripeSubscriptions.stripeId, subscription.stripeId),
          ),
        );

      const previous = existing
        ? await tx
            .select({
              unitAmount: stripeSubscriptionItems.unitAmount,
              quantity: stripeSubscriptionItems.quantity,
              interval: stripeSubscriptionItems.interval,
              intervalCount: stripeSubscriptionItems.intervalCount,
            })
            .from(stripeSubscriptionItems)
            .where(eq(stripeSubscriptionItems.subscriptionId, existing.id))
        : [];

      const [row] = await tx
        .insert(stripeSubscriptions)
        .values({ projectId, ...subscription })
        .onConflictDoUpdate({
          target: [stripeSubscriptions.projectId, stripeSubscriptions.stripeId],
          set: { ...subscription, projectedAt: new Date() },
          setWhere: lt(stripeSubscriptions.observedAt, subscription.observedAt),
        })
        .returning({ id: stripeSubscriptions.id });

      // Observation périmée : la ligne en base décrit un état postérieur, on la
      // laisse tranquille. Aucune révision non plus — ce qu'on lit n'est pas la
      // dernière vérité connue, et l'écrire fabriquerait un aller-retour dans la
      // série.
      if (!row) return false;

      await this.record(tx, projectId, row.id, { subscription, items }, {
        status: existing?.status ?? null,
        items: previous,
      });

      await tx
        .delete(stripeSubscriptionItems)
        .where(eq(stripeSubscriptionItems.subscriptionId, row.id));

      if (items.length === 0) return true;

      await tx
        .insert(stripeSubscriptionItems)
        .values(items.map((item) => ({ subscriptionId: row.id, ...item })));

      return true;
    });
  }

  /**
   * Note le changement de montant, s'il y en a un.
   *
   * ## Pourquoi seulement s'il y en a un
   *
   * Parce que la plupart des webhooks d'abonnement ne bougent pas le MRR : un
   * renouvellement, une carte mise à jour, une facture payée passent tous par
   * ici. Leur donner une ligne noierait les vraies variations sous du bruit, et
   * une série qui compte des non-événements ne se lit pas.
   *
   * ## Pourquoi `null` n'est pas zéro
   *
   * Aucune ligne précédente veut dire que l'abonnement vient d'exister — c'est
   * une entrée dans la série. Un abonnement qui existait à zéro est autre chose,
   * et les confondre ferait passer chaque création pour une reprise.
   *
   * La devise vient de l'abonnement et pas des items : ils portent la même, et
   * c'est celle-là qui sépare les séries.
   */
  private async record(
    tx: Parameters<Parameters<DrizzleDatabase['transaction']>[0]>[0],
    projectId: string,
    subscriptionId: string,
    { subscription, items }: Projection,
    previous: { status: string | null; items: Priced[] },
  ): Promise<void> {
    const before =
      previous.status === null ? null : monthlyAmountOf(previous.items);
    const after = monthlyAmountOf(items);

    // Le statut compte autant que le montant : une résiliation ne change
    // souvent **rien** aux prix — Stripe renvoie les mêmes items, avec
    // `canceled` — et s'en tenir au montant la rendrait invisible, alors que
    // c'est le mouvement qui pèse le plus lourd dans un waterfall.
    if (before === after && previous.status === subscription.status) return;

    await tx.insert(stripeSubscriptionRevisions).values({
      projectId,
      subscriptionId,
      observedAt: subscription.observedAt,
      currency: subscription.currency,
      monthlyBefore: before,
      monthlyAfter: after,
      status: subscription.status,
    });
  }
}
