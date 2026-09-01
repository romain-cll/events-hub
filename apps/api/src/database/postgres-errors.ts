import { DatabaseError } from 'pg';

/** Violation de clé étrangère — `foreign_key_violation` dans la table des
 * codes SQLSTATE de Postgres. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Retrouve l'erreur `pg` d'origine derrière l'emballage de Drizzle.
 *
 * Depuis la 0.44, `drizzle-orm` encapsule toute erreur de requête dans un
 * `DrizzleQueryError` et range l'erreur Postgres dans `cause`. Tester
 * `error instanceof DatabaseError` directement sur ce qui remonte d'un
 * `.insert()` renverrait donc toujours `false`.
 */
function toDatabaseError(error: unknown): DatabaseError | undefined {
  if (error instanceof DatabaseError) {
    return error;
  }

  if (error instanceof Error && error.cause instanceof DatabaseError) {
    return error.cause;
  }

  return undefined;
}

/**
 * Vrai si l'écriture a été refusée parce qu'elle référence une ligne
 * inexistante. Permet de traduire la contrainte en réponse HTTP parlante au
 * lieu de laisser fuiter un 500.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return toDatabaseError(error)?.code === FOREIGN_KEY_VIOLATION;
}
