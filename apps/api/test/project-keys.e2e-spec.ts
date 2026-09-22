import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { projectKeySchema } from '@events-hub/api-contract';

import {
  TEST_ORIGIN,
  cleanupFixtures,
  expectMatchesContract,
  joinOrganization,
  signUp,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * La gestion des clés depuis le dashboard.
 *
 * Deux choses s'y vérifient qui ne se voient nulle part ailleurs : que
 * l'allowlist ne peut pas être vide — sinon la fonctionnalité ne servirait à
 * personne de ceux qui ne la configurent pas — et que **les rôles autorisent
 * enfin quelque chose**. Jusqu'ici la colonne `role` de `memberships` décrivait
 * sans rien commander.
 */

interface KeyJson {
  id: string;
  value: string;
  name: string | null;
  allowedOrigins: string[];
  revokedAt: string | null;
}

interface ProjectJson {
  id: string;
  organizationId: string;
}

describe('gestion des clés de projet (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  /** Un propriétaire, son organisation personnelle et un projet dedans. */
  const setup = async () => {
    const user = await signUp(app, 'Proprietaire');

    const [organization] = (
      await request(app.getHttpServer())
        .get('/v1/auth/organization/list')
        .set('Cookie', user.cookies)
        .expect(200)
    ).body as Array<{ id: string }>;

    const project = (
      await request(app.getHttpServer())
        .post('/v1/projects')
        .set('Cookie', user.cookies)
        .send({ organizationId: organization.id, name: 'projet clés' })
        .expect(201)
    ).body as ProjectJson;

    return { user, organizationId: organization.id, project };
  };

  describe('créer', () => {
    it('rend une clé préfixée et l’origine déclarée', async () => {
      const { user, project } = await setup();

      const response = await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/keys`)
        .set('Cookie', user.cookies)
        .send({ name: 'prod', allowedOrigins: [TEST_ORIGIN] })
        .expect(201);

      expectMatchesContract(response.body, projectKeySchema);

      const key = response.body as KeyJson;

      expect(key.value).toMatch(/^eh_pk_[0-9a-f]{32}$/);
      expect(key.allowedOrigins).toEqual([TEST_ORIGIN]);
      expect(key.revokedAt).toBeNull();
    });

    it('refuse une allowlist vide', async () => {
      const { user, project } = await setup();

      await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/keys`)
        .set('Cookie', user.cookies)
        .send({ allowedOrigins: [] })
        .expect(400);
    });

    it('refuse une origine qui porte un chemin', async () => {
      // `https://acme.com/track` ne correspondrait jamais à un en-tête
      // `Origin`, qui n'en porte pas. L'accepter en le tronquant en silence
      // laisserait croire à une configuration qui ne s'applique pas.
      const { user, project } = await setup();

      await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/keys`)
        .set('Cookie', user.cookies)
        .send({ allowedOrigins: ['https://acme.com/track'] })
        .expect(400);
    });
  });

  describe('lister et révoquer', () => {
    it('liste, révoque, et la ligne reste avec sa date', async () => {
      const { user, project } = await setup();

      const created = (
        await request(app.getHttpServer())
          .post(`/v1/projects/${project.id}/keys`)
          .set('Cookie', user.cookies)
          .send({ allowedOrigins: [TEST_ORIGIN] })
          .expect(201)
      ).body as KeyJson;

      await request(app.getHttpServer())
        .delete(`/v1/projects/${project.id}/keys/${created.id}`)
        .set('Cookie', user.cookies)
        .expect(200);

      const list = (
        await request(app.getHttpServer())
          .get(`/v1/projects/${project.id}/keys`)
          .set('Cookie', user.cookies)
          .expect(200)
      ).body as KeyJson[];

      const revoked = list.find((k) => k.id === created.id);

      // Révoquer n'efface pas : savoir qu'une clé a existé et quand elle a été
      // coupée vaut mieux qu'un trou dans l'historique du projet.
      expect(revoked).toBeDefined();
      expect(revoked?.revokedAt).not.toBeNull();
    });

    it('modifie les origines autorisées', async () => {
      const { user, project } = await setup();

      const created = (
        await request(app.getHttpServer())
          .post(`/v1/projects/${project.id}/keys`)
          .set('Cookie', user.cookies)
          .send({ allowedOrigins: [TEST_ORIGIN] })
          .expect(201)
      ).body as KeyJson;

      const updated = (
        await request(app.getHttpServer())
          .patch(`/v1/projects/${project.id}/keys/${created.id}`)
          .set('Cookie', user.cookies)
          .send({ allowedOrigins: ['https://acme.com'] })
          .expect(200)
      ).body as KeyJson;

      expect(updated.allowedOrigins).toEqual(['https://acme.com']);
    });
  });

  describe('les rôles, enfin appliqués', () => {
    it('laisse un member lire les clés mais pas en créer', async () => {
      const { organizationId, project } = await setup();

      const membre = await signUp(app, 'Membre');
      await joinOrganization(db, organizationId, membre.id, 'member');

      // Lire : les clés sont publiques par nature, elles sont dans le bundle.
      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/keys`)
        .set('Cookie', membre.cookies)
        .expect(200);

      // Créer : ça ouvre une porte d'écriture, donc owner/admin seulement.
      await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/keys`)
        .set('Cookie', membre.cookies)
        .send({ allowedOrigins: [TEST_ORIGIN] })
        // 403 et non 404 : l'appelant sait déjà que le projet existe, lui
        // rendre 404 sur un défaut de rôle le ferait chercher une faute d'URL.
        .expect(403);
    });

    it('cache le projet à un non-membre, rôle ou pas', async () => {
      const { project } = await setup();

      const etranger = await signUp(app, 'Etranger');

      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/keys`)
        .set('Cookie', etranger.cookies)
        .expect(404);
    });

    it('refuse sans session', async () => {
      const { project } = await setup();

      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/keys`)
        .expect(401);
    });
  });
});
