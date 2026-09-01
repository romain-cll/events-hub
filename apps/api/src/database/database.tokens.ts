import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import type * as schema from './schema';

/** Instance Drizzle typée par le schéma, à injecter dans les services. */
export const DRIZZLE = Symbol('DRIZZLE');

/** Pool `pg` sous-jacent — utile pour le SQL brut et fermé au shutdown. */
export const PG_POOL = Symbol('PG_POOL');

export type DrizzleDatabase = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * Le handle passé au callback de `db.transaction()`.
 *
 * Il porte la même API que `DrizzleDatabase` mais exécute dans la transaction en
 * cours. Le nommer sert de contrat : un service qui le prend en paramètre
 * *exige* d'être appelé dans une transaction, et ne peut pas être branché sur le
 * pool par distraction.
 */
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleDatabase['transaction']>[0]
>[0];
