import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../auth/auth.decorators';
import { DRIZZLE, type DrizzleDatabase } from '../database/database.module';
import { memberships, projects } from '../database/schema';

/** Clé de métadonnée lue par `ProjectMemberGuard`. */
const REQUIRED_ROLES = 'project:roles';

/**
 * Restreint une route aux membres portant l'un de ces rôles.
 *
 * Sans ce décorateur, `ProjectMemberGuard` se contente de vérifier
 * l'appartenance — être membre suffit. C'est le cas de la lecture des
 * analytics, où distinguer les rôles n'aurait pas de sens.
 *
 * Il sert là où l'action engage le projet au-delà de sa consultation : créer ou
 * révoquer une clé d'ingestion, par exemple, qui coupe ou ouvre la collecte
 * pour tout le monde.
 */
export const ProjectRoles = (...roles: string[]) =>
  SetMetadata(REQUIRED_ROLES, roles);

/**
 * N'autorise l'accès à `:projectId` que si l'appelant est membre de
 * l'organisation propriétaire.
 *
 * C'est **la** règle d'accès du hub, et elle tient en une jointure : le projet
 * porte son organisation, l'organisation porte ses membres.
 *
 * ## 404 et jamais 403
 *
 * Un projet qui n'existe pas et un projet auquel on n'a pas droit rendent la
 * même réponse. Les distinguer transformerait la route en oracle : un attaquant
 * tirant des UUID au hasard apprendrait lesquels correspondent à de vrais
 * projets, ce qui est exactement le renseignement qu'on lui refuse.
 *
 * ## Il tourne après `AuthGuard`, et pas à sa place
 *
 * Nest exécute les guards globaux avant ceux du contrôleur : `request.auth` est
 * donc déjà rempli, et l'absence de session a déjà produit un 401. Ce guard-ci
 * ne répond qu'à la question suivante — « et ce projet-là, il est à vous ? ».
 *
 * ## 403 quand le rôle ne suffit pas, et là on distingue
 *
 * Une fois l'appartenance établie, l'appelant sait déjà que le projet existe :
 * lui rendre 404 parce qu'il est `member` et non `admin` ne cacherait plus rien
 * et le laisserait croire à une erreur d'URL. Le secret ne porte que sur
 * l'existence, pas sur le niveau de droit.
 *
 * ## Pourquoi l'identifiant est validé ici
 *
 * Les guards tournent **avant** les pipes : un `:projectId` malformé
 * atteindrait la base et Postgres lèverait une erreur de cast, rendue en 500.
 * On le valide donc sur place, et un identifiant qui n'est pas un UUID reçoit
 * le même 404 que le reste — il ne désigne aucun projet, c'est tout ce qu'il y
 * a à en dire.
 */
@Injectable()
export class ProjectMemberGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDatabase,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { params: Record<string, string> }>();

    const projectId = z.uuid().safeParse(request.params.projectId);
    const userId = request.auth?.user.id;

    // `userId` est garanti par `AuthGuard` sur une route non publique. On ne
    // s'appuie pas dessus pour autant : si ce guard était un jour posé sur une
    // route ouverte, refuser est le bon défaut.
    if (!projectId.success || !userId) {
      throw new NotFoundException("Ce projet n'existe pas.");
    }

    const [accessible] = await this.db
      .select({ id: projects.id, role: memberships.role })
      .from(projects)
      .innerJoin(
        memberships,
        eq(memberships.organizationId, projects.organizationId),
      )
      .where(
        and(eq(projects.id, projectId.data), eq(memberships.userId, userId)),
      )
      .limit(1);

    if (!accessible) {
      throw new NotFoundException("Ce projet n'existe pas.");
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_ROLES,
      [context.getHandler(), context.getClass()],
    );

    if (required?.length && !required.includes(accessible.role)) {
      throw new ForbiddenException(
        `Action réservée aux rôles : ${required.join(', ')}.`,
      );
    }

    return true;
  }
}
