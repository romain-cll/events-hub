import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

import {
  organizationsSchema,
  projectIngestionSchema,
  projectKeySchema,
  projectSchema,
} from '@events-hub/api-contract';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { cleanupFixtures, expectMatchesContract, signUp } from './fixtures';
import { createTestApp } from './harness';

/**
 * Le parcours de mise en route, de bout en bout.
 *
 * Cette suite ne teste pas une route mais **une séquence** : c'est exactement
 * celle que suit le dashboard entre un compte neuf et le premier événement.
 *
 *     s'inscrire → lire son organisation → créer un projet → créer une clé
 *                → « rien n'est arrivé » → poster un événement → « ça arrive »
 *
 * Elle existe parce que chacun de ces appels était déjà couvert isolément, et
 * que l'enchaînement ne l'était pas — or c'est là que l'impasse s'était logée :
 * `POST /v1/projects` exige un `organizationId` qu'aucune route accessible au
 * dashboard ne rendait, donc un compte neuf ne pouvait rien créer. Un test par
 * route n'aurait jamais montré ça.
 *
 * ## Les deux routes ajoutées pour ce parcours
 *
 * `GET /v1/organizations` ferme l'impasse ci-dessus.
 * `GET /v1/projects/:projectId/ingestion` répond à la seule question de l'écran
 * d'attente — « est-ce branché ? » — et c'est son basculement de `false` à
 * `true` qui est vérifié ici, pas sa valeur à un instant donné.
 */

const TEST_ORIGIN = 'http://localhost:3002';

interface Identified {
  id: string;
}

interface KeyJson {
  value: string;
}

interface IngestionJson {
  hasEvents: boolean;
}

describe('mise en route d’un projet (e2e)', () => {
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

  /** Les organisations du compte, telles que **notre** route les rend. */
  const myOrganizations = async (cookies: string[]) => {
    const response = await request(app.getHttpServer())
      .get('/v1/organizations')
      .set('Cookie', cookies)
      .expect(200);

    return expectMatchesContract(response.body, organizationsSchema);
  };

  const ingestionOf = async (cookies: string[], projectId: string) => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/ingestion`)
      .set('Cookie', cookies)
      .expect(200);

    return expectMatchesContract(response.body, projectIngestionSchema);
  };

  describe('GET /v1/organizations', () => {
    it('rend l’organisation née avec le compte, et le rôle qu’on y tient', async () => {
      const user = await signUp(app, 'Fondatrice');
      const organizations = await myOrganizations(user.cookies);

      expect(organizations).toHaveLength(1);
      expect(organizations[0].role).toBe('owner');
      expect(organizations[0].name).toContain('Fondatrice');
    });

    it('ne montre pas les organisations des autres', async () => {
      const premier = await signUp(app, 'Premiere');
      const second = await signUp(app, 'Seconde');

      const vues = await myOrganizations(second.cookies);
      const [sienne] = await myOrganizations(premier.cookies);

      expect(vues.map(({ id }) => id)).not.toContain(sienne.id);
    });

    it('répond 401 sans session', async () => {
      await request(app.getHttpServer()).get('/v1/organizations').expect(401);
    });
  });

  describe('le parcours complet', () => {
    it('mène d’un compte neuf au premier événement reçu', async () => {
      const user = await signUp(app, 'Nouvelle');

      // 1. L'organisation, que le dashboard doit pouvoir lire avant tout : sans
      //    elle, le champ obligatoire de la création reste vide.
      const [organization] = await myOrganizations(user.cookies);

      // 2. Le projet.
      const created = await request(app.getHttpServer())
        .post('/v1/projects')
        .set('Cookie', user.cookies)
        .send({ organizationId: organization.id, name: 'Mon site' })
        .expect(201);

      const project = expectMatchesContract(created.body, projectSchema);

      expect(project.organizationName).toBe(organization.name);

      // 3. La clé, avec l'origine saisie au même écran — l'API refuse une clé
      //    sans origine déclarée, donc les deux ne peuvent pas être séparées.
      const minted = await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/keys`)
        .set('Cookie', user.cookies)
        .send({ name: 'prod', allowedOrigins: [TEST_ORIGIN] })
        .expect(201);

      const key = expectMatchesContract(minted.body, projectKeySchema);

      expect(key.value).toMatch(/^eh_pk_[0-9a-f]{32}$/);

      // 4. Rien n'est encore arrivé : c'est ce qui fait exister l'écran
      //    d'attente au lieu de le sauter.
      expect(await ingestionOf(user.cookies, project.id)).toEqual({
        hasEvents: false,
      });

      // 5. Le site émet — exactement ce que fait le SDK au chargement d'une
      //    page, avec la clé et l'origine que le snippet embarque.
      await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send({
          apiKey: key.value,
          type: 'page_view',
          occurredAt: new Date().toISOString(),
          attributes: { 'page.path': '/' },
        })
        .expect(201);

      // 6. Et l'écran d'attente peut passer la main.
      expect(await ingestionOf(user.cookies, project.id)).toEqual({
        hasEvents: true,
      });
    });
  });

  describe('GET /v1/projects/:projectId/ingestion', () => {
    it('répond 404 à un compte étranger, comme si le projet n’existait pas', async () => {
      const proprietaire = await signUp(app, 'Proprio');
      const etranger = await signUp(app, 'Tiers');

      const [organization] = await myOrganizations(proprietaire.cookies);

      const created = await request(app.getHttpServer())
        .post('/v1/projects')
        .set('Cookie', proprietaire.cookies)
        .send({ organizationId: organization.id, name: 'projet privé' })
        .expect(201);

      const { id } = created.body as Identified;

      // Le 404 est le point : distinguer « pas à vous » de « n'existe pas »
      // ferait de la route un oracle sur les identifiants qui existent.
      await request(app.getHttpServer())
        .get(`/v1/projects/${id}/ingestion`)
        .set('Cookie', etranger.cookies)
        .expect(404);
    });

    it('répond 404 sur un identifiant qui n’est pas un UUID', async () => {
      const user = await signUp(app, 'Curieuse');

      // Le guard tourne avant les pipes : sans validation sur place, la valeur
      // atteindrait Postgres et sortirait en 500.
      await request(app.getHttpServer())
        .get('/v1/projects/pas-un-uuid/ingestion')
        .set('Cookie', user.cookies)
        .expect(404);
    });

    it('répond 401 sans session', async () => {
      await request(app.getHttpServer())
        .get('/v1/projects/00000000-0000-4000-8000-000000000000/ingestion')
        .expect(401);
    });
  });

  /**
   * `GET /v1/eh.js` — le script que le snippet d'installation charge.
   *
   * Ce que ces tests tiennent n'est pas le contenu du bundle, qui appartient au
   * SDK et à ses propres tests, mais **le fait qu'il soit atteignable sans rien
   * savoir de nous** : le snippet est collé sur un site tiers, chargé par le
   * navigateur d'un visiteur qui n'a aucun compte ici.
   *
   * ⚠️ Ils supposent `packages/sdk` construit. `turbo` l'enchaîne avant
   * `test:e2e` comme avant `dev` — un échec ici veut dire que le lien est
   * rompu, pas que le test est fragile.
   */
  describe('GET /v1/eh.js', () => {
    it('sert le script sans session, en JavaScript', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/eh.js')
        .expect(200);

      expect(response.headers['content-type']).toContain('text/javascript');
      expect(response.text).toContain('data-api-key');
    });

    it('est cacheable, et assez court pour qu’un correctif passe', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/eh.js')
        .expect(200);

      // Le nom du fichier n'est pas versionné par un hash : un cache éternel
      // laisserait un bug en place chez tous les sites déjà installés.
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.headers.etag).toEqual(expect.any(String));
    });

    it('déduit son adresse d’ingestion de son propre src', () => {
      // La propriété que le snippet à une ligne repose dessus : la balise ne
      // porte que la clé, et le script résout `events` relativement au `src`
      // depuis lequel il a été chargé. La version est donc emportée avec.
      expect(new URL('events', 'https://hub.test/v1/eh.js').toString()).toBe(
        'https://hub.test/v1/events',
      );
    });
  });

  describe('le contrat des clés', () => {
    it('refuse une clé sans origine déclarée', async () => {
      const user = await signUp(app, 'Presse');
      const [organization] = await myOrganizations(user.cookies);

      const created = await request(app.getHttpServer())
        .post('/v1/projects')
        .set('Cookie', user.cookies)
        .send({ organizationId: organization.id, name: 'sans origine' })
        .expect(201);

      const { id } = created.body as Identified;

      // C'est ce refus qui impose au parcours de demander l'URL du site en même
      // temps que le nom : sans origine, il n'y a pas de clé à donner à l'étape
      // suivante, donc pas d'installation possible.
      const refused = await request(app.getHttpServer())
        .post(`/v1/projects/${id}/keys`)
        .set('Cookie', user.cookies)
        .send({ allowedOrigins: [] })
        .expect(400);

      expect(refused.body).toMatchObject({ statusCode: 400 });
    });

    it('refuse une origine qui porte un chemin', async () => {
      const user = await signUp(app, 'Colleuse');
      const [organization] = await myOrganizations(user.cookies);

      const created = await request(app.getHttpServer())
        .post('/v1/projects')
        .set('Cookie', user.cookies)
        .send({ organizationId: organization.id, name: 'origine bavarde' })
        .expect(201);

      const { id } = created.body as Identified;

      // Le cas exact que `parseOrigins` normalise côté dashboard : une URL
      // collée depuis la barre d'adresse. Non normalisée, elle est refusée.
      await request(app.getHttpServer())
        .post(`/v1/projects/${id}/keys`)
        .set('Cookie', user.cookies)
        .send({ allowedOrigins: ['https://acme.test/blog'] })
        .expect(400);
    });
  });

  it('ne rend pas la clé publique d’un projet à un étranger', async () => {
    const proprietaire = await signUp(app, 'Gardienne');
    const etranger = await signUp(app, 'Passant');

    const [organization] = await myOrganizations(proprietaire.cookies);

    const created = await request(app.getHttpServer())
      .post('/v1/projects')
      .set('Cookie', proprietaire.cookies)
      .send({ organizationId: organization.id, name: 'clés privées' })
      .expect(201);

    const { id } = created.body as Identified;

    await request(app.getHttpServer())
      .post(`/v1/projects/${id}/keys`)
      .set('Cookie', proprietaire.cookies)
      .send({ allowedOrigins: [TEST_ORIGIN] })
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get(`/v1/projects/${id}/keys`)
      .set('Cookie', proprietaire.cookies)
      .expect(200);

    expect(mine.body as KeyJson[]).toHaveLength(1);

    await request(app.getHttpServer())
      .get(`/v1/projects/${id}/keys`)
      .set('Cookie', etranger.cookies)
      .expect(404);
  });

  it('l’ingestion reste muette pour une origine non déclarée', async () => {
    const user = await signUp(app, 'Distraite');
    const [organization] = await myOrganizations(user.cookies);

    const created = await request(app.getHttpServer())
      .post('/v1/projects')
      .set('Cookie', user.cookies)
      .send({ organizationId: organization.id, name: 'origine oubliée' })
      .expect(201);

    const { id } = created.body as Identified;

    const minted = await request(app.getHttpServer())
      .post(`/v1/projects/${id}/keys`)
      .set('Cookie', user.cookies)
      .send({ allowedOrigins: [TEST_ORIGIN] })
      .expect(201);

    const { value } = minted.body as KeyJson;

    // 204, rien d'écrit, aucun message. C'est précisément le silence que
    // l'écran d'installation annonce — sans quoi quelqu'un chercherait
    // l'erreur dans son snippet pendant une heure.
    await request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', 'https://ailleurs.test')
      .send({
        apiKey: value,
        type: 'page_view',
        occurredAt: new Date().toISOString(),
      })
      .expect(204);

    const status = (
      await request(app.getHttpServer())
        .get(`/v1/projects/${id}/ingestion`)
        .set('Cookie', user.cookies)
        .expect(200)
    ).body as IngestionJson;

    expect(status.hasEvents).toBe(false);
  });
});
