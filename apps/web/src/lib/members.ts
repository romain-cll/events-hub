import {
  invitationDetailSchema,
  invitationsSchema,
  membersPageSchema,
  type Invitation,
  type InvitationDetail,
  type Member,
  type OrganizationRole,
} from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { apiJson, write } from './api';

export type { Invitation, InvitationDetail, Member, OrganizationRole };

/**
 * Les membres d'une organisation et ses invitations.
 *
 * ## Ces routes sont celles du plugin, appelées à la main
 *
 * Elles vivent sous `/v1/auth/organization/*` et non sous une route à nous.
 * C'est délibéré : le plugin tient les transitions d'état des invitations, leur
 * péremption, la réponse uniforme qui empêche d'énumérer les adresses ayant un
 * compte, et le contrôle de rôle. Les doubler ferait deux vérités sur les mêmes
 * tables — le raisonnement est écrit en entier dans le contrat, côté
 * `members.ts`.
 *
 * ## Mais pas via `authClient`
 *
 * Le client du plugin n'expose ces lectures que par des atomes nanostores —
 * des singletons de module, que le serveur Start partagerait entre deux
 * visiteurs simultanés. `auth-client.ts` l'interdit pour cette raison, et la
 * règle vaut ici aussi. On parle donc à ces routes comme à n'importe quelle
 * autre : `apiFetch`, un schéma, et la validation à la lecture.
 *
 * ## `organizationId` est toujours passé
 *
 * Le plugin l'accepte en option et retombe sinon sur l'organisation « active »
 * portée par la session. On ne s'en sert pas : la cible d'écriture serait alors
 * invisible dans la requête comme dans les logs, et deux onglets ouverts sur
 * deux organisations se marcheraient dessus. C'est la même règle que pour
 * `createProject`.
 */

/** Les membres d'une organisation, avec leur utilisateur joint. */
export function membersQuery(organizationId: string) {
  return queryOptions({
    queryKey: ['organizations', organizationId, 'members'],
    queryFn: async () => {
      const page = await apiJson(
        `/v1/auth/organization/list-members?organizationId=${organizationId}`,
        membersPageSchema,
      );

      // L'enveloppe `{ members, total }` sert la pagination du plugin, dont on
      // ne se sert pas : une organisation tient dans un écran. La retirer ici
      // évite que chaque appelant redise `.members`.
      return page.members;
    },
  });
}

/**
 * Les invitations d'une organisation — toutes, pas seulement celles en attente.
 *
 * Le plugin rend l'historique complet, `accepted` et `canceled` compris. Filtrer
 * ici plutôt que dans l'écran serait plus court d'une ligne et ferait perdre le
 * seul endroit d'où l'on pourrait un jour montrer « qui a refusé ».
 */
export function invitationsQuery(organizationId: string) {
  return queryOptions({
    queryKey: ['organizations', organizationId, 'invitations'],
    queryFn: () =>
      apiJson(
        `/v1/auth/organization/list-invitations?organizationId=${organizationId}`,
        invitationsSchema,
      ),
  });
}

/**
 * Une invitation lue depuis son lien.
 *
 * ## Le lien seul n'autorise rien
 *
 * Cette route exige une session **dont l'adresse est celle de l'invitation** :
 * sans session elle rend 401, sous un autre compte elle rend 403. Connaître
 * l'identifiant ne suffit donc pas, et c'est ce qui rend l'écran « mauvais
 * compte » nécessaire plutôt que décoratif.
 *
 * `retry: false` : les deux refus ci-dessus sont des réponses, pas des pannes.
 * Les rejouer trois fois retarderait l'affichage de l'état exact que la personne
 * doit lire.
 *
 * Le schéma est `invitationDetailSchema` et non celui de la liste : cette route
 * joint le nom de l'organisation, que l'écran affiche et que l'invité — pas
 * encore membre — n'a aucun autre moyen d'apprendre.
 */
export function invitationQuery(invitationId: string) {
  return queryOptions({
    queryKey: ['invitations', invitationId],
    retry: false,
    queryFn: () =>
      apiJson(
        `/v1/auth/organization/get-invitation?id=${invitationId}`,
        invitationDetailSchema,
      ),
  });
}

/**
 * Les écritures, et ce qu'elles ne rendent pas.
 *
 * Aucune ne valide sa réponse contre un schéma, à rebours du reste de ce
 * dossier. Ce n'est pas un relâchement, c'est ce que le plugin impose : ses
 * retours de mutation ne partagent aucune forme — `invite-member` rend
 * l'invitation nue, `accept-invitation` un `{ invitation, member }`,
 * `remove-member` un `{ member }`, `update-member-role` le membre nu, et le
 * membre rendu là n'a pas la jointure `user` que porte celui de la liste.
 *
 * Décrire ces cinq formes dans le contrat leur donnerait une garantie qu'on ne
 * peut pas tenir : `contract.spec.ts` n'assertit que ce que le plugin type
 * proprement, et ces retours-là ne le sont pas tous. Les écrans, eux, n'en ont
 * pas besoin — chacun réinvalide sa liste après l'écriture, et c'est cette
 * relecture qui est validée. Ce qui compte ici est donc le **refus**, préservé
 * mot pour mot par `write`.
 *
 * `Promise<void>` le dit dans la signature : il n'y a rien à lire en retour.
 */

/** Ce que rend une écriture dont on ne lit pas la réponse. */
const discard = { parse: (): void => undefined };

/**
 * Invite une adresse dans une organisation.
 *
 * L'adresse n'a pas besoin d'avoir un compte — c'est même le cas le plus
 * fréquent, et la raison pour laquelle `invitations` est clé sur l'email plutôt
 * que sur un `userId`.
 *
 * `resend: true` rejoue une invitation déjà envoyée au lieu d'en créer une
 * seconde pour la même adresse : c'est ce que fait le bouton « Resend » d'une
 * invitation expirée.
 */
export function inviteMember(payload: {
  organizationId: string;
  email: string;
  role: OrganizationRole;
  resend?: boolean;
}): Promise<void> {
  return write('/v1/auth/organization/invite-member', discard, payload);
}

/** Annule une invitation. Elle passe à `canceled` ; la ligne reste. */
export function cancelInvitation(invitationId: string): Promise<void> {
  return write('/v1/auth/organization/cancel-invitation', discard, {
    invitationId,
  });
}

/** Accepte une invitation, ce qui crée l'appartenance. */
export function acceptInvitation(invitationId: string): Promise<void> {
  return write('/v1/auth/organization/accept-invitation', discard, {
    invitationId,
  });
}

/** Refuse une invitation. Celui qui l'a envoyée n'en est pas averti. */
export function rejectInvitation(invitationId: string): Promise<void> {
  return write('/v1/auth/organization/reject-invitation', discard, {
    invitationId,
  });
}

/**
 * Change le rôle d'un membre.
 *
 * Le plugin répond 403 si l'appelant n'a pas `member:update` — c'est-à-dire
 * s'il est lui-même `member`. L'écran ne dessine pas ce contrôle dans ce cas ;
 * le refus est ce qui rend cette absence autre chose qu'une politesse.
 */
export function updateMemberRole(payload: {
  organizationId: string;
  memberId: string;
  role: OrganizationRole;
}): Promise<void> {
  return write('/v1/auth/organization/update-member-role', discard, payload);
}

/** Retire un membre. Le champ accepte un identifiant ou une adresse. */
export function removeMember(payload: {
  organizationId: string;
  memberIdOrEmail: string;
}): Promise<void> {
  return write('/v1/auth/organization/remove-member', discard, payload);
}

/**
 * Quitte une organisation de son propre chef.
 *
 * Distinct d'un `removeMember` sur soi-même : le plugin refuse au dernier
 * `owner` de partir, et c'est cette route-ci qui porte la règle. L'écran affiche
 * son message tel quel.
 */
export function leaveOrganization(organizationId: string): Promise<void> {
  return write('/v1/auth/organization/leave', discard, { organizationId });
}
