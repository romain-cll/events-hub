import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';

import type { Auth } from './auth';
import { IS_PUBLIC, type AuthenticatedRequest } from './auth.decorators';
import { AUTH } from './auth.tokens';

/**
 * Le guard global : il refuse par défaut.
 *
 * ## Ce qu'il ne fait pas
 *
 * Aucune cryptographie, aucune lecture de cookie, aucune comparaison de jeton.
 * Une seule ligne compte — `auth.api.getSession()` — et tout ce qui est
 * sensible (signature du cookie, validité et expiration du jeton, hachage)
 * reste chez Better Auth. Ce fichier est du **câblage Nest**, pas de la
 * sécurité : c'est ce qui rend acceptable de l'avoir écrit à la main plutôt que
 * de prendre une intégration tierce dont on n'utiliserait qu'un tiers.
 *
 * ## L'ordre des vérifications
 *
 * La session est résolue **avant** le test de `@Public()`, et non après. C'est
 * délibéré : une route publique veut souvent savoir *si* quelqu'un est connecté
 * sans l'exiger — un `@Session()` sur une route publique doit donc être rempli
 * quand le cookie est là. Le coût est un appel de plus sur les routes
 * anonymes ; le bénéfice est qu'il n'existe pas deux façons d'obtenir une
 * session selon la route.
 *
 * ## Le défaut
 *
 * `throw` quand il n'y a pas de session, et les seuls `return true` en amont
 * exigent une métadonnée explicite. Une route ajoutée demain sans y penser est
 * protégée. Si `getSession()` lève, la promesse rejette et la requête est
 * refusée — il n'existe pas de chemin où une erreur ouvre l'accès.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { headers: IncomingHttpHeaders }>();

    request.auth = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) return true;

    if (!request.auth) {
      throw new UnauthorizedException('Authentification requise.');
    }

    return true;
  }
}
