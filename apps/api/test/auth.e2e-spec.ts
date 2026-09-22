import type { INestApplication } from '@nestjs/common';
import { eq, like } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions, users } from '../src/database/schema';
import {
  TEST_ORIGIN,
  cleanupFixtures,
  createProject,
  trackSignUp,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * Le cycle de vie d'un compte, de bout en bout : HTTP réel, Nest réel,
 * Postgres réel, Better Auth réel.
 *
 * Ce qu'on vérifie ici n'est **pas** que Better Auth fonctionne — ce n'est pas
 * notre code et ses propres tests s'en chargent. C'est que **notre câblage**
 * tient : que le handler est monté au bon endroit et avant le parsing du corps,
 * que le `basePath` répond bien sous `/v1`, que le cookie fait l'aller-retour,
 * et surtout que le guard global refuse quand il doit refuser.
 *
 * Les deux derniers tests sont les plus importants du fichier : ce sont des
 * non-régressions. Un guard global est exactement le genre de chose qui protège
 * ce qu'il ne fallait pas.
 */

/** Extrait les cookies d'une réponse pour les rejouer sur la suivante. */
function cookiesOf(response: request.Response): string[] {
  const header = response.headers['set-cookie'];

  if (!header) return [];

  return Array.isArray(header) ? header : [header];
}

interface UserResponse {
  id: string;
  email: string;
  name: string;
}

describe('authentification (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;

  // Une adresse par exécution : les tests écrivent réellement, et `users.email`
  // est unique. Deux exécutions successives se marcheraient dessus.
  const email = `romain+${Date.now()}@example.test`;
  const password = 'un-mot-de-passe-assez-long';
  const name = 'Romain';

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  describe('inscription et session', () => {
    let sessionCookies: string[] = [];

    it('inscrit un utilisateur et pose un cookie de session', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/sign-up/email')
        .send({ email, password, name })
        .expect(200);

      sessionCookies = cookiesOf(response);
      await trackSignUp(
        app,
        (response.body as { user: { id: string } }).user.id,
      );

      expect(sessionCookies.length).toBeGreaterThan(0);
      expect(sessionCookies.join(';')).toContain('session_token');
    });

    it('reconnaît la session sur une route protégée', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/me')
        .set('Cookie', sessionCookies)
        .expect(200);

      const user = response.body as UserResponse;

      expect(user.email).toBe(email);
      expect(user.name).toBe(name);
    });

    it('ne renvoie jamais le mot de passe', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/me')
        .set('Cookie', sessionCookies)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(password);
      expect(response.body).not.toHaveProperty('password');
    });

    it('déconnecte, et la session cesse d’être valide', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/sign-out')
        .set('Cookie', sessionCookies)
        .expect(200);

      await request(app.getHttpServer())
        .get('/v1/me')
        .set('Cookie', sessionCookies)
        .expect(401);
    });

    it('reconnecte avec le même mot de passe', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/sign-in/email')
        .send({ email, password })
        .expect(200);

      expect(cookiesOf(response).length).toBeGreaterThan(0);
    });

    it('refuse un mauvais mot de passe', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/sign-in/email')
        .send({ email, password: 'ce-n-est-pas-le-bon' })
        .expect(401);
    });
  });

  /**
   * Le nom sert à dériver l'organisation personnelle — sans lui, l'inscription
   * fabrique une organisation nommée `'s org`.
   *
   * Better Auth déclare `name: z.string()`, donc la chaîne vide passe **sa**
   * validation : la règle est à nous, elle vit dans un hook `before` de
   * `auth.ts`. Le formulaire du dashboard l'applique aussi, mais ces cas-ci
   * postent directement — c'est tout l'intérêt de les éprouver ici.
   */
  describe('le nom est obligatoire à l’inscription', () => {
    const refuse = (candidat: unknown) =>
      request(app.getHttpServer())
        .post('/v1/auth/sign-up/email')
        .send({
          email: `sans-nom-${randomBytes(6).toString('hex')}@example.test`,
          password,
          name: candidat,
        })
        .expect(400);

    it.each([
      ['une chaîne vide', ''],
      ['des espaces seulement', '   '],
      ['une tabulation', '\t'],
    ])('refuse %s', async (_cas, candidat) => {
      const response = await refuse(candidat);

      expect(JSON.stringify(response.body)).toContain('nom');
    });

    it('rogne le nom au lieu de l’enregistrer tel quel', async () => {
      // Sinon `"  Espacé  "` passerait la vérification et donnerait une
      // organisation nommée `"  Espacé  's org"`.
      const espace = `espace-${randomBytes(6).toString('hex')}@example.test`;

      const inscrit = await request(app.getHttpServer())
        .post('/v1/auth/sign-up/email')
        .send({ email: espace, password, name: '  Espacé  ' })
        .expect(200);

      await trackSignUp(
        app,
        (inscrit.body as { user: { id: string } }).user.id,
      );

      const [cree] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.email, espace));

      expect(cree.name).toBe('Espacé');
    });

    it('n’a créé aucun compte au passage', async () => {
      // Un refus qui laisserait une ligne derrière lui serait pire que le
      // problème d'origine.
      const orphelins = await db
        .select({ id: users.id })
        .from(users)
        .where(like(users.email, 'sans-nom-%@example.test'));

      expect(orphelins).toHaveLength(0);
    });
  });

  describe('le guard global refuse par défaut', () => {
    it('rend 401 sur une route protégée sans cookie', async () => {
      await request(app.getHttpServer()).get('/v1/me').expect(401);
    });

    it('rend 401 avec un cookie de session inventé', async () => {
      await request(app.getHttpServer())
        .get('/v1/me')
        .set('Cookie', ['better-auth.session_token=nimportequoi'])
        .expect(401);
    });
  });

  describe('non-régression : le guard n’a pas fermé ce qui doit rester ouvert', () => {
    it('laisse passer l’ingestion sans aucune session', async () => {
      const project = await createProject(db, { name: 'projet e2e auth' });

      try {
        await request(app.getHttpServer())
          .post('/v1/events')
          .set('Origin', TEST_ORIGIN)
          .send({
            apiKey: project.apiKey,
            type: 'auth_e2e_smoke',
            occurredAt: new Date().toISOString(),
          })
          .expect(201);
      } finally {
        // Les FK sont en `restrict` : il faut défaire dans l'ordre inverse de
        // l'écriture — l'événement, puis la session qu'il a fait naître, puis
        // le projet.
        await db.delete(events).where(eq(events.projectId, project.id));
        await db.delete(sessions).where(eq(sessions.projectId, project.id));
        await db.delete(projects).where(eq(projects.id, project.id));
      }
    });

    it('laisse passer la racine sans session', async () => {
      await request(app.getHttpServer()).get('/').expect(200);
    });
  });

  describe('suppression de compte', () => {
    it('supprime l’utilisateur et sa ligne en base', async () => {
      const signIn = await request(app.getHttpServer())
        .post('/v1/auth/sign-in/email')
        .send({ email, password })
        .expect(200);

      await request(app.getHttpServer())
        .post('/v1/auth/delete-user')
        .set('Cookie', cookiesOf(signIn))
        .send({ password })
        .expect(200);

      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));

      expect(rows).toEqual([]);
    });
  });
});
