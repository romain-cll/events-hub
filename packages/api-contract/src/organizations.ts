import { z } from 'zod';

/**
 * Les organisations, vues depuis le membre qui demande.
 *
 * ## Pourquoi cette route existe alors que Better Auth en sert une
 *
 * Le plugin organisation expose `/v1/auth/organization/list`, et le dashboard
 * pourrait l'appeler. Il ne le fait pas, pour deux raisons qui se cumulent :
 *
 * - **côté client**, le plugin ne rend cette liste que par un atome nanostores
 *   (`useListOrganizations`), qui est un singleton de module — exactement ce que
 *   `auth-client.ts` interdit, parce que le serveur Start le partagerait entre
 *   deux visiteurs simultanés. L'appel direct, lui, part en `POST` alors que la
 *   route est en `GET` : il répond 404 ;
 * - **côté contrat**, la forme rendue par le plugin est inférée de sa
 *   configuration. La décrire ici en ferait une deuxième source de vérité, ce
 *   que `index.ts` refuse explicitement pour tout `/v1/auth/*`.
 *
 * Notre route rend donc ce dont le dashboard a besoin, décrit une seule fois, au
 * même endroit que le reste.
 *
 * ## `role` est le vôtre, pas celui de l'organisation
 *
 * La ressource n'est pas « les organisations » mais « vos appartenances » :
 * `GET /v1/organizations` n'a pas de sens sans un demandeur, et il n'existe
 * aucune façon d'en lire une dont on ne soit pas membre. Le rôle vient de la
 * même jointure, il ne coûte rien, et c'est lui qui dira demain quels écrans
 * d'administration proposer.
 */
export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Le rôle du demandeur dans cette organisation — `owner`, `admin`, `member`. */
  role: z.string(),
  /** Sérialisé depuis un `Date` — ISO 8601 avec décalage. */
  createdAt: z.iso.datetime({ offset: true }),
});

export type Organization = z.infer<typeof organizationSchema>;

export const organizationsSchema = z.array(organizationSchema);
