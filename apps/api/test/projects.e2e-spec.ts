import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions, users } from '../src/database/schema';
import { projectSchema, projectsSchema } from '@events-hub/api-contract';

import { expectMatchesContract, signUp, TEST_ORIGIN } from './fixtures';

/**
 * Le cloisonnement par organisation, éprouvé par les routes.
 *
 * C'est le fichier qui vérifie ce que tout le chantier « organisations » avait
 * pour but de rendre possible : **un projet n'est lisible que par les membres
 * de l'organisation qui le possède**. Jusqu'ici `/v1/projects/:id/analytics`
 * portait un `@Public()` et répondait à quiconque connaissait l'UUID.
 *
 * Le test qui compte est « ne montre rien à un compte étranger » : les autres
 * décrivent le fonctionnement nominal, celui-là décrit ce qu'on empêche.
 */

const FENETRE = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-02T00:00:00.000Z',
};

interface ProjectJson {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
}

interface OrganizationJson {
  id: string;
}

describe('projets et cloisonnement (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  const createdUsers: string[] = [];
  const createdProjects: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    db = app.get<DrizzleDatabase>(DRIZZLE);
  });

  afterAll(async () => {
    for (const id of createdProjects) {
      await db.delete(events).where(eq(events.projectId, id));
      await db.delete(sessions).where(eq(sessions.projectId, id));
      await db.delete(projects).where(eq(projects.id, id));
    }
    for (const id of createdUsers) {
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  const register = async (name?: string) => {
    const user = await signUp(app, name);
    createdUsers.push(user.id);

    const [organization] = (
      await request(app.getHttpServer())
        .get('/v1/auth/organization/list')
        .set('Cookie', user.cookies)
        .expect(200)
    ).body as OrganizationJson[];

    return { ...user, organizationId: organization.id };
  };

  const createProjectVia = async (
    cookies: string[],
    organizationId: string,
    name = 'projet e2e',
  ) => {
    const response = await request(app.getHttpServer())
      .post('/v1/projects')
      .set('Cookie', cookies)
      .send({ organizationId, name })
      .expect(201);

    expectMatchesContract(response.body, projectSchema);

    const project = response.body as ProjectJson;
    createdProjects.push(project.id);

    return project;
  };

  describe('création et listing', () => {
    it('crée un projet dans son organisation personnelle et le liste', async () => {
      const user = await register('Createur');
      const project = await createProjectVia(user.cookies, user.organizationId);

      expect(project.organizationId).toBe(user.organizationId);

      const list = await request(app.getHttpServer())
        .get('/v1/projects')
        .set('Cookie', user.cookies)
        .expect(200);

      expectMatchesContract(list.body, projectsSchema);

      expect((list.body as ProjectJson[]).map((p) => p.id)).toEqual([
        project.id,
      ]);
    });

    it('ne liste que les projets de ses propres organisations', async () => {
      const proprietaire = await register('Proprio');
      const etranger = await register('Tiers');

      await createProjectVia(
        proprietaire.cookies,
        proprietaire.organizationId,
        'projet privé',
      );

      const list = await request(app.getHttpServer())
        .get('/v1/projects')
        .set('Cookie', etranger.cookies)
        .expect(200);

      expect(list.body).toEqual([]);
    });

    it('refuse de créer dans une organisation dont on n’est pas membre', async () => {
      const proprietaire = await register('Hote');
      const etranger = await register('Intrus');

      await request(app.getHttpServer())
        .post('/v1/projects')
        .set('Cookie', etranger.cookies)
        .send({
          organizationId: proprietaire.organizationId,
          name: 'projet volé',
        })
        // 404 et non 403 : répondre différemment dirait à l'intrus que cette
        // organisation existe.
        .expect(404);
    });
  });

  describe('l’accès aux analytics', () => {
    it('laisse un membre lire les analytics de son projet', async () => {
      const user = await register('Lecteur');
      const project = await createProjectVia(user.cookies, user.organizationId);

      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/analytics`)
        .set('Cookie', user.cookies)
        .query(FENETRE)
        .expect(200);
    });

    it('ne montre rien à un compte étranger, et ne dit pas que le projet existe', async () => {
      // ⬅ Le test de tout le chantier. Avant les organisations, cette requête
      // rendait 200 avec les analytics complètes : la route était publique et
      // l'UUID suffisait.
      const proprietaire = await register('Proprietaire');
      const etranger = await register('Curieux');

      const project = await createProjectVia(
        proprietaire.cookies,
        proprietaire.organizationId,
      );

      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/analytics`)
        .set('Cookie', etranger.cookies)
        .query(FENETRE)
        .expect(404);
    });

    it('refuse sans session du tout', async () => {
      const user = await register('Anonyme');
      const project = await createProjectVia(user.cookies, user.organizationId);

      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/analytics`)
        .query(FENETRE)
        .expect(401);
    });
  });

  describe('renommer et supprimer', () => {
    /** Émet un événement sur le projet, pour qu'il ait quelque chose à perdre. */
    const seedEvent = async (cookies: string[], projectId: string) => {
      const key = await request(app.getHttpServer())
        .post(`/v1/projects/${projectId}/keys`)
        .set('Cookie', cookies)
        .send({ name: 'prod', allowedOrigins: [TEST_ORIGIN] })
        .expect(201);

      await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send({
          apiKey: (key.body as { value: string }).value,
          type: 'projects_e2e_suppression',
          occurredAt: '2026-08-01T10:00:00.000Z',
        })
        .expect(201);
    };

    it('renomme, et le nouveau nom se relit', async () => {
      const user = await register('Renommeur');
      const project = await createProjectVia(user.cookies, user.organizationId);

      const response = await request(app.getHttpServer())
        .patch(`/v1/projects/${project.id}`)
        .set('Cookie', user.cookies)
        .send({ name: 'acme.com' })
        .expect(200);

      const renamed = expectMatchesContract(response.body, projectSchema);

      expect(renamed.name).toBe('acme.com');
      // L'organisation est jointe à la volée : sans le second `SELECT` du
      // service, `returning` ne la rendrait pas et le contrat casserait ici.
      expect(renamed.organizationName).toBe(project.organizationName);
    });

    it('supprime un projet qui porte déjà des événements', async () => {
      // Le cas qui échouerait sans la cascade écrite à la main :
      // `events.projectId` et `sessions.projectId` sont en `restrict`, donc un
      // `DELETE` direct sur le projet serait refusé par Postgres.
      const user = await register('Supprimeur');
      const project = await createProjectVia(user.cookies, user.organizationId);
      await seedEvent(user.cookies, project.id);

      const response = await request(app.getHttpServer())
        .delete(`/v1/projects/${project.id}`)
        .set('Cookie', user.cookies)
        .expect(200);

      expect(expectMatchesContract(response.body, projectSchema).id).toBe(
        project.id,
      );

      // Il ne reste rien, ni le projet ni ce qu'il portait.
      const list = await request(app.getHttpServer())
        .get('/v1/projects')
        .set('Cookie', user.cookies)
        .expect(200);

      expect(list.body as ProjectJson[]).toHaveLength(0);

      const restants = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.projectId, project.id));

      expect(restants).toHaveLength(0);
    });

    it('refuse le renommage et la suppression à un « member »', async () => {
      // C'est ce refus qui rend honnête l'écran de réglages : il n'y montre pas
      // ces boutons, et ce n'est pas seulement une politesse d'affichage.
      const owner = await register('Chef');
      const project = await createProjectVia(
        owner.cookies,
        owner.organizationId,
      );
      const simple = await register('Equipier');

      const invitation = await request(app.getHttpServer())
        .post('/v1/auth/organization/invite-member')
        .set('Cookie', owner.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({
          email: simple.email,
          role: 'member',
          organizationId: owner.organizationId,
        })
        .expect(200);

      await request(app.getHttpServer())
        .post('/v1/auth/organization/accept-invitation')
        .set('Cookie', simple.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({ invitationId: (invitation.body as { id: string }).id })
        .expect(200);

      // Il voit le projet — c'est bien un membre…
      await request(app.getHttpServer())
        .get('/v1/projects')
        .set('Cookie', simple.cookies)
        .expect(200);

      // …mais 403 et non 404 : l'existence n'est plus un secret pour lui, seul
      // le niveau de droit l'est. C'est la règle de `ProjectMemberGuard`.
      await request(app.getHttpServer())
        .patch(`/v1/projects/${project.id}`)
        .set('Cookie', simple.cookies)
        .send({ name: 'renomme-par-un-membre' })
        .expect(403);

      await request(app.getHttpServer())
        .delete(`/v1/projects/${project.id}`)
        .set('Cookie', simple.cookies)
        .expect(403);
    });

    it('ne dit pas qu’un projet existe à un compte étranger', async () => {
      const owner = await register('Interne2');
      const project = await createProjectVia(
        owner.cookies,
        owner.organizationId,
      );
      const etranger = await register('Etranger2');

      await request(app.getHttpServer())
        .delete(`/v1/projects/${project.id}`)
        .set('Cookie', etranger.cookies)
        .expect(404);
    });
  });

  describe('non-régression : l’ingestion reste ouverte', () => {
    it('accepte un événement sans aucune session, avec une clé créée par l’API', async () => {
      // L'ingestion n'est pas concernée par les sessions utilisateur : le SDK
      // tourne chez les visiteurs des sites clients, qui n'ont pas de compte.
      // Ce qui l'authentifie est la clé du projet et l'origine de l'appel.
      //
      // Le parcours complet est joué ici — créer le projet, puis sa clé, puis
      // émettre — parce que c'est celui qu'un client suivra réellement.
      const user = await register('Emetteur');
      const project = await createProjectVia(user.cookies, user.organizationId);

      const key = await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/keys`)
        .set('Cookie', user.cookies)
        .send({ name: 'prod', allowedOrigins: [TEST_ORIGIN] })
        .expect(201);

      const { value } = key.body as { value: string };

      expect(value).toMatch(/^eh_pk_[0-9a-f]{32}$/);

      await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send({
          apiKey: value,
          type: 'projects_e2e_smoke',
          occurredAt: '2026-08-01T10:00:00.000Z',
        })
        .expect(201);
    });
  });
});
