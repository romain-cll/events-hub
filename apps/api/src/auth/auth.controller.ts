import { Controller, Get } from '@nestjs/common';

import type { AuthContext } from './auth';
import { Session } from './auth.decorators';

/**
 * `GET /v1/me` — qui suis-je.
 *
 * ## Pourquoi ce n'est pas sous `/v1/auth`
 *
 * Parce que `/v1/auth/*` n'appartient pas au routeur Nest : Better Auth y est
 * monté en middleware Express, en amont (voir `app.setup.ts`). Un contrôleur
 * déclaré sous ce préfixe ne serait jamais atteint — la requête serait absorbée
 * avant. `/v1/me` est hors de son territoire, donc routé normalement.
 *
 * ## Ce qu'elle apporte
 *
 * Elle donne à la suite de tests une cible pour vérifier que le guard refuse
 * réellement — un guard qu'aucun test ne voit refuser n'est pas une protection,
 * c'est une intention.
 *
 * Elle a été écrite comme point d'entrée du dashboard ; ce n'en est plus un.
 * Le front lit `GET /v1/auth/get-session`, qui rend en plus la session et son
 * `activeOrganizationId`, et passe par le client Better Auth plutôt que par une
 * seconde forme de « qui suis-je » qu'il faudrait garder d'accord avec la
 * première. La route reste pour ce qu'elle prouve, pas pour ce qu'elle sert.
 *
 * Pas de `@Public()` ici : le guard global s'applique, donc un appel sans
 * cookie valide reçoit un 401 sans que ce fichier ait à le dire.
 */
@Controller({ path: 'me', version: '1' })
export class AuthController {
  @Get()
  me(@Session() session: AuthContext) {
    // Le guard a déjà rejeté l'absence de session : `session` est non nul ici.
    // On rend l'utilisateur seul — la session elle-même porte un jeton, et il
    // n'a aucune raison de redescendre chez le client qui l'a déjà en cookie.
    return session?.user ?? null;
  }
}
