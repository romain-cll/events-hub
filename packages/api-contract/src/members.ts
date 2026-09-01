import { z } from 'zod';

/**
 * Les membres d'une organisation et ses invitations en attente.
 *
 * ## Ces formes-là ne viennent pas de nos contrôleurs
 *
 * Elles décrivent `GET /v1/auth/organization/list-members` et
 * `.../list-invitations`, servies par le plugin `organization` de Better Auth.
 * C'est une exception à la règle posée dans `index.ts` — « pas `/v1/auth/*` » —
 * et elle ne tient que parce qu'on la rattache : `contract.spec.ts` compare ces
 * schémas aux types que le plugin **infère** de sa propre configuration
 * (`Awaited<ReturnType<Auth['api']['listMembers']>>`).
 *
 * C'est ce lien qui fait la différence entre décrire et recopier. Sans lui, une
 * montée de version du plugin changerait la forme sur le fil pendant que ce
 * fichier continuerait d'affirmer l'ancienne — exactement la dérive que ce
 * paquet existe pour fermer, en pire, puisqu'elle aurait l'air vérifiée. Avec
 * lui, elle casse `pnpm check-types`.
 *
 * ## Pourquoi passer par le plugin plutôt que par nos propres routes
 *
 * Parce que ce n'est pas qu'une lecture. Inviter, changer un rôle, retirer
 * quelqu'un : le plugin tient les transitions d'état des invitations, leur
 * péremption, la réponse uniforme qui empêche d'énumérer les adresses ayant un
 * compte, et le contrôle de rôle (`invitation:create`, `member:update`,
 * `member:delete`). Doubler ça par des routes maison ferait deux vérités sur
 * les mêmes tables — c'est le raisonnement déjà tenu dans
 * `organizations.controller.ts`, appliqué au reste de la famille.
 */

/**
 * Les trois rôles, en énumération et non en chaîne libre.
 *
 * C'est ce que le plugin **infère** de notre configuration : aucun rôle
 * personnalisé n'y est déclaré, donc son type est exactement cette union, et
 * l'assertion de `contract.spec.ts` refuse `z.string()`. Le jour où
 * `auth.ts` déclarera des rôles supplémentaires, l'union s'élargira là-bas et
 * cassera ici — ce qui est le comportement voulu.
 *
 * ⚠️ `organizationSchema.role`, lui, reste une chaîne : il vient de notre
 * propre jointure sur la colonne `text` de `memberships`, pas du plugin. Les
 * deux décrivent la même donnée par deux chemins qui ne garantissent pas la
 * même chose.
 */
export const organizationRoleSchema = z.enum(['owner', 'admin', 'member']);

export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const memberSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  userId: z.uuid(),
  role: organizationRoleSchema,
  /** Sérialisé depuis un `Date` — ISO 8601 avec décalage. */
  createdAt: z.iso.datetime({ offset: true }),
  /**
   * L'utilisateur, joint côté serveur.
   *
   * Le plugin le rattache lui-même (`adapter.listMembers`) : sans lui la liste
   * ne porterait que des `userId`, et l'écran devrait recouper une seconde
   * requête pour afficher un nom.
   */
  user: z.object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    /**
     * `null` quand il n'y a pas d'avatar — et pas absent.
     *
     * Le plugin déclare pourtant ce champ `string | undefined`. Sa requête le
     * lit dans `users.image`, colonne nullable : c'est `null` qui remonte, et
     * `null` traverse `JSON.stringify` intact. Le type ment, la réponse dit
     * vrai, et c'est la réponse que ce paquet décrit — l'écart est nommé dans
     * `contract.spec.ts`, qui assertit tout le reste.
     */
    image: z.string().nullable(),
  }),
});

export type Member = z.infer<typeof memberSchema>;

/**
 * `GET /v1/auth/organization/list-members` — la liste **et** son total.
 *
 * L'enveloppe vient du plugin, qui pagine (`limit`/`offset`). Nous ne paginons
 * pas : une organisation tient dans un écran, et `total` n'est là que parce
 * qu'il est rendu.
 */
export const membersPageSchema = z.object({
  members: z.array(memberSchema),
  total: z.number(),
});

export type MembersPage = z.infer<typeof membersPageSchema>;

/**
 * Une invitation, telle que `list-invitations` la rend.
 *
 * `status` énumère les quatre états que le plugin connaît. Les transitions lui
 * appartiennent — c'est la raison même de passer par lui — mais leur *liste*
 * est fixe et inférée, donc l'assertion la réclame telle quelle.
 *
 * `expiresAt` est ce qui borne l'invitation : le lien n'authentifie pas à lui
 * seul — `accept-invitation` exige une session dont l'adresse correspond — mais
 * il périme, et c'est cette date que l'écran affiche.
 */
export const invitationSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  email: z.string(),
  role: organizationRoleSchema,
  status: z.enum(['pending', 'accepted', 'rejected', 'canceled']),
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  inviterId: z.uuid(),
});

export type Invitation = z.infer<typeof invitationSchema>;

export const invitationsSchema = z.array(invitationSchema);

/**
 * Une invitation lue depuis son lien — la même, plus de quoi l'afficher.
 *
 * `get-invitation` joint trois champs que la liste n'a pas : le nom de
 * l'organisation, son slug, et l'adresse de qui a invité. C'est ce qui permet à
 * l'écran d'invitation de dire « Join Acme Corp » plutôt que « join this
 * organization » — l'invité n'est encore membre de rien, il n'a aucune autre
 * requête par laquelle apprendre ce nom.
 *
 * Un schéma **exporté à part**, même s'il dérive du précédent : les deux routes
 * ne rendent pas la même chose, et `contract.spec.ts` les assertit séparément
 * contre deux types du plugin. Les fondre en un seul — en rendant les trois
 * champs facultatifs, par exemple — ferait passer l'une pour l'autre et
 * laisserait l'écran lire un nom absent sans que rien ne le signale.
 */
export const invitationDetailSchema = invitationSchema.extend({
  organizationName: z.string(),
  organizationSlug: z.string(),
  inviterEmail: z.string(),
});

export type InvitationDetail = z.infer<typeof invitationDetailSchema>;
