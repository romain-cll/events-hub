import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';

import type { DrizzleDatabase } from '../src/database/database.module';
import {
  memberships,
  organizations,
  projectKeys,
  projects,
  type Project,
} from '../src/database/schema';

/**
 * Ce que les tests e2e ont en commun.
 *
 * Ce fichier est né avec les organisations : `projects.organizationId` étant
 * `notNull`, les treize créations de projet réparties dans les suites ne
 * pouvaient plus se contenter d'un nom. Plutôt que d'ajouter le même champ
 * treize fois, on nomme ici ce que chaque suite refaisait déjà à sa façon.
 */

/**
 * L'organisation d'accueil des projets de test, créée une fois par suite.
 *
 * Une seule pour tout le fichier : les tests d'ingestion et d'analytics ne
 * parlent pas d'organisations, ils ont juste besoin que leurs projets aient un
 * propriétaire. Leur en fabriquer une chacun ne les isolerait pas davantage —
 * le cloisonnement qu'ils vérifient est celui **par projet** — et laisserait
 * des dizaines d'organisations vides derrière.
 */
let sharedOrganizationId: string | null = null;

export async function organizationId(db: DrizzleDatabase): Promise<string> {
  if (sharedOrganizationId) return sharedOrganizationId;

  const [organization] = await db
    .insert(organizations)
    .values({
      name: 'organisation e2e',
      slug: `e2e-${randomBytes(6).toString('hex')}`,
    })
    .returning({ id: organizations.id });

  sharedOrganizationId = organization.id;

  return sharedOrganizationId;
}

/**
 * L'origine déclarée sur les clés de test.
 *
 * Depuis les clés d'ingestion, `POST /v1/events` refuse toute requête sans
 * en-tête `Origin`, et n'accepte que les origines déclarées sur la clé. Les
 * suites doivent donc poser celle-ci sur chaque envoi.
 */
export const TEST_ORIGIN = 'http://localhost:3002';

/** Ce qui distingue cette exécution de la précédente. */
const RUN = randomBytes(4).toString('hex');

/**
 * Rend un identifiant propre à cette exécution.
 *
 * Réservé aux identifiants que **Postgres arbitre globalement** — aujourd'hui
 * `stripe_webhook_events.event_id`, clé primaire non cloisonnée par projet. Le
 * service y réserve en `onConflictDoNothing` : un identifiant déjà présent est
 * lu comme « déjà rejoué », et **rien n'est écrit**. C'est le comportement qu'on
 * veut en production, et un piège en test.
 *
 * Avec des identifiants en dur, il suffisait qu'un run s'arrête au mauvais
 * moment — Ctrl-C, worker tué, échec dans un `beforeAll` — pour laisser la ligne
 * derrière lui. Tous les runs suivants échouaient alors **de façon déterministe
 * et définitive**, sur une assertion qui constate un événement manquant sans
 * rien dire de la raison. Le nettoyage de fin de suite ne protège de rien : il
 * ne s'exécute pas quand la suite meurt, et c'est précisément le cas qui empoisonne.
 *
 * L'unicité par exécution rend le résidu inoffensif. Les nettoyages restent —
 * ils empêchent la table de croître, ils n'ont jamais empêché ça.
 */
export function perRun(id: string): string {
  return `${id}_${RUN}`;
}

/** Un projet de test, avec les deux clés qui permettent d'y écrire. */
export interface TestProject extends Project {
  /** Clé publique `eh_pk_` : chemin navigateur, `Origin` vérifiée. */
  apiKey: string;
  /**
   * Clé serveur `eh_sk_` : chemin serveur, pas d'`Origin`, pas de session.
   *
   * La valeur en clair n'existe qu'ici — la base n'en garde que le hash, comme
   * en production. C'est aussi ce qui fait que le hachage est réellement
   * éprouvé : si `resolve` cherchait la mauvaise colonne, aucun test ne
   * passerait.
   */
  secretKey: string;
}

/**
 * Crée un projet rattaché à l'organisation de test.
 *
 * Remplace les `db.insert(projects).values({ name })` que faisaient les suites :
 * le rattachement est désormais obligatoire, et le faire ici évite qu'une suite
 * l'oublie ou invente sa propre organisation.
 */
export async function createProject(
  db: DrizzleDatabase,
  values: { name: string },
): Promise<TestProject> {
  const [project] = await db
    .insert(projects)
    .values({ ...values, organizationId: await organizationId(db) })
    .returning();

  // Une clé vient avec, parce qu'un projet sans clé ne peut rien recevoir : le
  // `projectId` ne circule plus dans le corps des requêtes d'ingestion.
  const [key] = await db
    .insert(projectKeys)
    .values({
      projectId: project.id,
      value: `eh_pk_${randomBytes(16).toString('hex')}`,
      allowedOrigins: [TEST_ORIGIN],
      name: 'clé e2e',
    })
    .returning({ value: projectKeys.value });

  // La clé serveur, rangée hachée comme en production. `allowedOrigins` est
  // vide : elle n'en a pas, et lui en donner une laisserait croire qu'elle est
  // vérifiée quelque part.
  const secretKey = `eh_sk_${randomBytes(16).toString('hex')}`;

  await db.insert(projectKeys).values({
    projectId: project.id,
    value: createHash('sha256').update(secretKey).digest('hex'),
    isSecret: true,
    allowedOrigins: [],
    name: 'clé serveur e2e',
  });

  return { ...project, apiKey: key.value, secretKey };
}

/** Les cookies d'une réponse, prêts à être rejoués sur la suivante. */
/**
 * La réponse est-elle conforme à ce que le contrat promet ?
 *
 * ## Le pendant exécutable de `src/contract.spec.ts`
 *
 * Ce dernier compare des **types**, donc des formes. Il ne peut rien dire de la
 * sérialisation réelle : qu'un `Date` sorte bien en ISO 8601, qu'un `null`
 * traverse sans devenir `undefined`, qu'une colonne Drizzle ne remonte pas sous
 * un autre nom. Ici on parse la vraie réponse d'une vraie requête sur une vraie
 * base — c'est la seule vérification qui voie le JSON tel que le dashboard le
 * recevra.
 *
 * Les deux sont nécessaires : l'un est instantané et attrape les renommages,
 * l'autre est lent et attrape ce que les types ne peuvent pas voir.
 *
 * ## Pourquoi `test/` peut importer le contrat en valeur
 *
 * `src/` ne le peut pas — `architecture.spec.ts` l'interdit, parce qu'un import
 * de valeur ferait entrer le paquet dans le programme émis et déplacerait toute
 * la sortie du build. `test/` est exclu de `tsconfig.build.json`, donc n'a
 * jamais ce problème : ces fichiers ne sont pas compilés vers `dist`.
 *
 * L'échec nomme le champ fautif plutôt que de rendre « false » : quand un
 * contrat casse, ce qu'on veut lire c'est *lequel*.
 */
export function expectMatchesContract<T>(
  body: unknown,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new Error(
      `La réponse ne respecte pas le contrat :\n${z.prettifyError(parsed.error)}`,
    );
  }

  return parsed.data;
}

export function cookiesOf(response: request.Response): string[] {
  const header = response.headers['set-cookie'];

  if (!header) return [];

  return Array.isArray(header) ? header : [header];
}

export interface SignedUpUser {
  cookies: string[];
  id: string;
  email: string;
}

/**
 * Inscrit un compte et rend de quoi le faire agir.
 *
 * L'adresse est unique par appel : `users.email` l'est en base, et deux tests
 * qui partageraient une adresse se marcheraient dessus d'une exécution à
 * l'autre.
 *
 * Rappel utile pour qui écrit un test : l'inscription crée **aussi** une
 * organisation personnelle dont ce compte est `owner` (voir le hook dans
 * `src/auth/auth.ts`). Un utilisateur fraîchement inscrit n'est donc jamais
 * sans organisation.
 */
export async function signUp(
  app: INestApplication<App>,
  name = 'Testeur',
): Promise<SignedUpUser> {
  const email = `e2e+${randomBytes(8).toString('hex')}@example.test`;

  const response = await request(app.getHttpServer())
    .post('/v1/auth/sign-up/email')
    .send({ email, password: 'un-mot-de-passe-assez-long', name })
    .expect(200);

  const body = response.body as { user: { id: string } };

  return { cookies: cookiesOf(response), id: body.user.id, email };
}

/** Les organisations d'un compte, telles que Better Auth les rend. */
export async function listOrganizations(
  app: INestApplication<App>,
  cookies: string[],
): Promise<Array<{ id: string; name: string; slug: string }>> {
  const response = await request(app.getHttpServer())
    .get('/v1/auth/organization/list')
    .set('Cookie', cookies)
    .expect(200);

  return response.body as Array<{ id: string; name: string; slug: string }>;
}

export { memberships, organizations };

/**
 * Rattache un utilisateur à une organisation.
 *
 * Sert aux suites qui lisent des analytics : depuis `ProjectMemberGuard`, un
 * projet n'est lisible que par les membres de son organisation. Sans ce
 * rattachement, une suite qui crée son projet avec `createProject` obtiendrait
 * un 404 parfaitement légitime.
 */
export async function joinOrganization(
  db: DrizzleDatabase,
  organization: string,
  userId: string,
  role = 'owner',
): Promise<void> {
  await db
    .insert(memberships)
    .values({ organizationId: organization, userId, role });
}
