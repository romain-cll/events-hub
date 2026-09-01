import {
  organizationsSchema,
  type Organization,
} from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { apiJson, write } from './api';

export type { Organization };

/**
 * Les organisations dont le visiteur est membre.
 *
 * Elle sert à une seule chose aujourd'hui : savoir où déposer un projet.
 * `POST /v1/projects` exige un `organizationId` explicite, et un compte neuf
 * n'avait aucun moyen de le connaître — pas de projet, donc pas d'organisation
 * visible, donc pas de création possible. C'est l'impasse que cette liste ferme.
 *
 * ## Elle ne passe pas par `authClient`
 *
 * Le plugin organisation sert bien `/v1/auth/organization/list`, mais côté
 * client il ne l'expose que par un atome nanostores — un singleton de module,
 * que le serveur Start partagerait entre deux visiteurs simultanés (voir
 * `auth-client.ts`). L'appel direct, lui, part en `POST` sur une route en `GET`
 * et répond 404. Notre API sert donc sa propre lecture, décrite dans le contrat
 * comme le reste.
 */
export function organizationsQuery() {
  return queryOptions({
    queryKey: ['organizations'],
    queryFn: () => apiJson('/v1/organizations', organizationsSchema),
  });
}

/**
 * Les écritures, elles, restent chez Better Auth.
 *
 * `organizations.controller.ts` n'expose qu'un `GET`, et le dit : créer,
 * renommer et supprimer une organisation touchent aux rôles, aux invitations
 * et à l'organisation active, que le plugin tient déjà. Une seconde voie
 * d'écriture ferait deux vérités sur la même table.
 *
 * La lecture, elle, est bien à nous — d'où ce fichier à cheval sur les deux :
 * une seule famille pour l'appelant, deux origines assumées.
 *
 * Comme dans `members.ts`, la réponse n'est pas validée : l'écran réinvalide
 * `['organizations']` et relit la liste, qui est le chemin déjà décrit par le
 * contrat. Ce qu'on préserve ici est le message de refus.
 */
const discard = { parse: (): void => undefined };

/**
 * Crée une organisation. Celui qui la crée en est `owner` (`creatorRole`).
 *
 * Le `slug` n'est pas demandé : le plugin l'exige, on le dérive du nom côté
 * serveur avec un suffixe aléatoire, et il n'apparaît dans aucune URL. Le faire
 * saisir ici exposerait une seconde façon de désigner une organisation, qu'il
 * faudrait alors sécuriser aussi.
 */
export function createOrganization(name: string): Promise<void> {
  return write('/v1/auth/organization/create', discard, {
    name,
    slug: slugFor(name),
  });
}

/**
 * Un slug, dérivé du nom.
 *
 * Le plugin l'exige et le veut unique. Le serveur en fabrique déjà un pour les
 * organisations personnelles (`slugify` dans `auth.ts`) mais son endpoint de
 * création, lui, réclame le champ. Le suffixe aléatoire évite d'avoir à boucler
 * sur les collisions — deux « Acme » ne se percutent pas.
 *
 * ⚠️ Le duplicata est assumé et borné : cette copie sert le seul cas où c'est le
 * client qui crée. La règle qui compte — le slug ne va dans aucune URL — est
 * tenue par les routes, qui désignent les projets par leur id.
 */
function slugFor(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

  return `${base || 'org'}-${Math.random().toString(16).slice(2, 8)}`;
}

/** Renomme une organisation. Réservé à `organization:update` — owner et admin. */
export function renameOrganization(payload: {
  organizationId: string;
  name: string;
}): Promise<void> {
  return write('/v1/auth/organization/update', discard, {
    organizationId: payload.organizationId,
    data: { name: payload.name },
  });
}

/**
 * Supprime une organisation. Réservé à l'`owner`.
 *
 * ⚠️ Échoue tant qu'elle possède des projets : `projects.organizationId` est en
 * `onDelete: 'restrict'`, et le plugin n'en sait rien — il tentera la
 * suppression et Postgres refusera. L'écran le dit **avant**, en désactivant le
 * bouton, plutôt que de laisser découvrir une erreur de contrainte.
 */
export function deleteOrganization(organizationId: string): Promise<void> {
  return write('/v1/auth/organization/delete', discard, { organizationId });
}
