import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';

import { DRIZZLE, type DrizzleDatabase } from '../database/database.module';
import { memberships, organizations } from '../database/schema';

/** Une organisation, avec le rôle qu'y tient le demandeur. */
export interface OrganizationRow {
  id: string;
  name: string;
  role: string;
  createdAt: Date;
}

/**
 * Les organisations, vues depuis l'utilisateur connecté.
 *
 * Même forme que `ProjectsService`, et pour la même raison : toutes les méthodes
 * prennent un `userId` et partent de `memberships`. Il n'existe pas ici de
 * lecture « toutes les organisations » qu'un appelant distrait pourrait
 * emprunter — le cloisonnement est la forme du service, pas une politesse rendue
 * par chaque route.
 *
 * `slug` n'est pas rendu, à dessein : il existe parce que Better Auth l'exige,
 * il n'apparaît dans aucune URL, et le publier laisserait croire qu'il désigne
 * quelque chose (voir `schema/organizations.ts`).
 */
@Injectable()
export class OrganizationsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /** Les organisations dont l'appelant est membre, par ordre alphabétique. */
  listForUser(userId: string): Promise<OrganizationRow[]> {
    return this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        role: memberships.role,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .innerJoin(memberships, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(organizations.name));
  }
}
