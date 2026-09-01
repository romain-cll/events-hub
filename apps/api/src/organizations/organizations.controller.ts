import { Controller, Get } from '@nestjs/common';

import type { AuthContext } from '../auth/auth';
import { Session } from '../auth/auth.decorators';
import {
  OrganizationsService,
  type OrganizationRow,
} from './organizations.service';

/**
 * `GET /v1/organizations` — vos organisations, et rien d'autre.
 *
 * Pas de `@Public()` : le guard global s'applique, un appel sans session reçoit
 * un 401 sans que ce fichier ait à le dire. Pas de `ProjectMemberGuard` non
 * plus, faute de `:projectId` — le cloisonnement est fait par le service, qui
 * part de l'utilisateur de la session et ne peut rien rendre d'autre.
 *
 * ## À quoi elle sert aujourd'hui
 *
 * À une seule chose : créer un projet. `POST /v1/projects` exige un
 * `organizationId` explicite — la cible d'écriture ne doit pas être implicite —
 * et le dashboard n'avait aucun moyen de le connaître tant qu'il n'avait pas
 * déjà un projet. C'était l'impasse exacte d'un compte neuf : une liste vide, un
 * bouton « créer », et rien à mettre dans le champ obligatoire.
 *
 * ## Il n'y a pas de `POST` ici
 *
 * Créer une organisation reste l'affaire de Better Auth : c'est lui qui tient
 * les rôles, les invitations et l'organisation active. Une seconde voie
 * d'écriture ferait deux vérités sur la même table. Seule la lecture est reprise
 * ici, parce que celle du plugin n'est pas atteignable proprement depuis le
 * dashboard — le pourquoi est dans `organizationSchema`, côté contrat.
 */
@Controller({ path: 'organizations', version: '1' })
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  list(@Session() session: AuthContext): Promise<OrganizationRow[]> {
    return this.organizations.listForUser(session!.user.id);
  }
}
