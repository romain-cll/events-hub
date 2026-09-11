import { Inject, Injectable } from '@nestjs/common';
import { eq, lt } from 'drizzle-orm';

import { DRIZZLE, type DrizzleDatabase } from '../../database/database.module';
import {
  stripeSubscriptionItems,
  stripeSubscriptions,
} from '../../database/schema';
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
      // laisse tranquille.
      if (!row) return false;

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
}
