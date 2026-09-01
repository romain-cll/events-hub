import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { organization } from 'better-auth/plugins/organization';
import { randomBytes } from 'node:crypto';

import type { DrizzleDatabase } from '../database/database.module';
import * as schema from '../database/schema';
import { memberships, organizations } from '../database/schema';

const logger = new Logger('Auth');

/**
 * Fabrique un slug d'organisation.
 *
 * Le plugin exige `slug` unique ; nous n'en voulions pas. On le dérive donc du
 * nom, suffixé de six caractères aléatoires — assez pour que deux « Acme » ne
 * se percutent pas, sans avoir à boucler sur les collisions.
 *
 * Ce slug **n'apparaît dans aucune URL** : les routes désignent les projets par
 * leur id, et l'accès se vérifie contre l'appartenance. Il n'a pas à être joli,
 * seulement unique.
 */
function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

  return `${base || 'org'}-${randomBytes(3).toString('hex')}`;
}

/**
 * L'instance Better Auth, construite à partir des dépendances Nest.
 *
 * C'est une **factory** et non un singleton de module : l'instance a besoin de
 * la connexion Drizzle et de la configuration, toutes deux fournies par le
 * conteneur. Un singleton construit à l'import ouvrirait un second pool
 * Postgres à côté de celui que `DatabaseModule` gère déjà — et échapperait à
 * `onApplicationShutdown`.
 *
 * ## Ce que cette configuration décide
 *
 * `basePath: '/v1/auth'` plutôt que le `/api/auth` par défaut : le reste de
 * l'API est versionné sous `/v1`, et une famille de routes qui échapperait à
 * cette convention obligerait à se souvenir d'une exception.
 *
 * `generateId: 'uuid'` aligne les identifiants d'auth sur ceux du reste du
 * schéma. Par défaut Better Auth génère des chaînes base62 : elles
 * fonctionneraient, mais on aurait deux formes d'identifiant dans la même base
 * et des colonnes `text` là où tout le reste est `uuid`.
 *
 * Les `modelName` mappent les tables sur notre convention (pluriel, et
 * `auth_sessions` pour ne pas confondre avec les sessions visiteur). Ils
 * servent à la fois de clé dans l'objet `schema` et de nom de table.
 *
 * ## Les emails ne partent pas
 *
 * `sendResetPassword` et `sendVerificationEmail` journalisent le lien. C'est
 * assumé pour ce chantier : aucun fournisseur d'email n'est branché, et les
 * invitations d'organisation — qui en auront réellement besoin — viendront
 * avec. `requireEmailVerification: false` en découle mécaniquement : exiger une
 * vérification qu'aucun email ne transporte rendrait l'inscription impossible.
 */
export function createAuth(db: DrizzleDatabase, config: ConfigService) {
  const webUrl = config.get<string>('WEB_URL') ?? 'http://localhost:3000';
  const apiUrl = config.get<string>('API_URL') ?? 'http://localhost:3001';

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    baseURL: apiUrl,
    basePath: '/v1/auth',
    secret: config.getOrThrow<string>('BETTER_AUTH_SECRET'),
    trustedOrigins: [webUrl],
    advanced: { database: { generateId: 'uuid' } },
    /**
     * Un nom vide n'entre pas.
     *
     * Better Auth déclare `name: z.string()` — sans `.min(1)` — donc la chaîne
     * vide passe sa validation. Or l'inscription en dérive une organisation
     * (`databaseHooks.user.create.after` plus bas) : un nom vide produit une
     * organisation nommée `'s org`, et un slug réduit à six caractères
     * aléatoires. Le compte est créé, l'organisation est absurde, et plus rien
     * ne le signale ensuite.
     *
     * Le formulaire du dashboard l'interdit déjà, mais ça ne protège rien : un
     * appel direct ne passe pas par lui. La règle doit vivre ici.
     *
     * ## Pourquoi ici et pas dans `databaseHooks.user.create.before`
     *
     * Parce que c'est de la **validation d'entrée**, et qu'elle appartient à la
     * frontière d'entrée : on rend un 400 clair à qui poste le formulaire.
     * Placée dans le hook base de données, elle couvrirait aussi les créations
     * par fournisseur OAuth — et refuser une inscription GitHub parce que le
     * profil distant n'a pas de nom serait hostile, alors que le bon geste y
     * serait de retomber sur autre chose.
     *
     * ⚠️ Le corollaire : le jour où OAuth arrivera, la dérivation du nom
     * d'organisation redeviendra fragile et il faudra lui donner un repli. Ce
     * hook-ci ne couvre que `/sign-up/email`.
     *
     * Le nom est **rogné au passage**. Sans ça `"  Romain  "` passerait la
     * vérification et donnerait `"  Romain  's org"`.
     */
    hooks: {
      // `Promise.resolve` plutôt qu'`async` : Better Auth attend une promesse,
      // mais rien ici n'attend quoi que ce soit — un `async` sans `await`
      // prétendrait le contraire. Même choix que pour les envois d'emails.
      before: createAuthMiddleware((ctx) => {
        if (ctx.path !== '/sign-up/email') return Promise.resolve();

        const body = ctx.body as { name?: unknown } | undefined;
        const name = typeof body?.name === 'string' ? body.name.trim() : '';

        if (!name) {
          return Promise.reject(
            new APIError('BAD_REQUEST', {
              message:
                'Renseignez un nom : il sert à nommer votre organisation.',
              code: 'NAME_REQUIRED',
            }),
          );
        }

        // Ce que rend un hook `before` sous la clé `context` est fusionné dans
        // le contexte de l'endpoint : c'est le nom rogné qui sera enregistré.
        return Promise.resolve({ context: { body: { ...body, name } } });
      }),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      // Better Auth attend une `Promise<void>` — un vrai envoi en est une. On
      // la rend explicitement plutôt que par `async` : journaliser n'attend
      // rien, et un `async` sans `await` prétendrait le contraire.
      sendResetPassword: ({ user, url }) => {
        logger.log(`Réinitialisation de mot de passe — ${user.email} : ${url}`);

        return Promise.resolve();
      },
    },
    emailVerification: {
      sendVerificationEmail: ({ user, url }) => {
        logger.log(`Vérification d'adresse — ${user.email} : ${url}`);

        return Promise.resolve();
      },
    },
    user: {
      modelName: 'users',
      deleteUser: { enabled: true },
    },
    account: { modelName: 'accounts' },
    session: { modelName: 'authSessions' },
    verification: { modelName: 'verifications' },
    plugins: [
      organization({
        // Le créateur d'une organisation en est propriétaire. Les rôles sont
        // persistés (voir `schema/memberships.ts`) mais aucune route ne les
        // distingue encore : à ce stade ils décrivent, ils n'autorisent pas.
        creatorRole: 'owner',
        schema: {
          organization: { modelName: 'organizations' },
          member: { modelName: 'memberships' },
          invitation: { modelName: 'invitations' },
        },
        // Même stub que les autres envois : aucun fournisseur d'email n'est
        // branché, et le flux complet se teste en e2e sans service tiers.
        sendInvitationEmail: ({ email, id, organization: org }) => {
          logger.log(
            `Invitation à « ${org.name} » — ${email} : ${apiUrl}/accept-invitation/${id}`,
          );

          return Promise.resolve();
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          /**
           * Chaque compte naît avec une organisation.
           *
           * Sans ça il existerait un état « utilisateur sans organisation »,
           * dans lequel aucun projet ne peut être créé — puisqu'un projet doit
           * appartenir à une org — et où le dashboard n'aurait rien à montrer.
           * Le supprimer à la racine coûte moins cher que de le gérer partout.
           *
           * L'écriture est faite en Drizzle et non via
           * `auth.api.createOrganization` : cette API attend une session, et à
           * cet instant du parcours d'inscription elle n'existe pas encore.
           *
           * ⚠️ Cette création n'est **pas** dans la transaction qui crée
           * l'utilisateur. Si elle échouait, le compte existerait sans
           * organisation. Le cas est couvert par un test e2e ; le rendre
           * atomique demanderait d'entrer dans la transaction de Better Auth,
           * ce qui n'est pas exposé.
           */
          after: async (user) => {
            const [org] = await db
              .insert(organizations)
              .values({
                name: `${user.name}'s org`,
                slug: slugify(user.name),
              })
              .returning({ id: organizations.id });

            await db.insert(memberships).values({
              organizationId: org.id,
              userId: user.id,
              role: 'owner',
            });
          },
        },
      },
    },
  });
}

/** L'instance telle que le reste de l'application la voit. */
export type Auth = ReturnType<typeof createAuth>;

/** Ce que `auth.api.getSession()` rend : la session et son utilisateur. */
export type AuthContext = Awaited<ReturnType<Auth['api']['getSession']>>;
