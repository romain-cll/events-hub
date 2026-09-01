import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';

import type { AuthContext } from './auth';

/** Clé de métadonnée lue par `AuthGuard`. */
export const IS_PUBLIC = 'auth:public';

/**
 * Ouvre une route — ou un contrôleur entier — à qui n'est pas connecté.
 *
 * Le guard est global et refuse par défaut : c'est donc **ce décorateur** qui
 * fait la liste des routes publiques, et rien d'autre. Ajouter une route sans y
 * penser la rend protégée, ce qui est le bon sens de l'oubli.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Requête enrichie par `AuthGuard`.
 *
 * `auth` vaut `null` sur une route publique atteinte sans cookie — d'où le type
 * qui inclut `null` plutôt qu'un optionnel : sur une route protégée le guard a
 * déjà rejeté, mais le compilateur ne le sait pas, et prétendre le contraire
 * ferait sauter la vérification là où elle sert.
 */
export interface AuthenticatedRequest {
  auth: AuthContext;
}

/** La session complète (`{ session, user }`), telle que Better Auth la rend. */
export const Session = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);

/** Le seul utilisateur connecté, quand c'est tout ce que le handler veut. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth?.user ??
    null,
);
