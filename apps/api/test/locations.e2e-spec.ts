import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { locationsPageSchema } from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { sessions } from '../src/database/schema';
import {
  TEST_ORIGIN,
  cleanupFixtures,
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * La chaîne géographique, de l'IP au classement.
 *
 * ## Pourquoi `X-Forwarded-For` est au cœur de ce fichier
 *
 * En local comme en e2e, la connexion vient de `::1` : **aucune session ne
 * résoudrait jamais**, et un test qui se contenterait de l'IP de connexion ne
 * vérifierait rien du tout. On passe donc par l'en-tête, ce qui éprouve du même
 * coup le réglage `trust proxy` — le seul endroit du produit où une valeur
 * fournie par le client est promue au rang d'identité.
 *
 * ⚠️ Cela **suppose `TRUST_PROXY_HOPS` ≥ 1** dans l'environnement de test. Si
 * la variable est absente, Express ignore l'en-tête, les sessions restent sans
 * pays, et les cas géographiques se sautent d'eux-mêmes plutôt que d'échouer
 * sur une configuration — voir `avecGeo` plus bas. Ce qui ne se saute jamais,
 * c'est ce qui ne dépend ni de la base ni du proxy : la validation de la
 * requête et le cloisonnement.
 */

const OCCURRED_AT = '2026-08-22T12:00:00.000Z';

const FENETRE = {
  from: '2026-08-22T00:00:00.000Z',
  to: '2026-08-23T00:00:00.000Z',
};

/** Des IP publiques stables, choisies pour tomber dans trois pays distincts. */
const DEPUIS = {
  paris: '80.15.0.1',
  sydney: '1.1.1.1',
  mountainView: '8.8.8.8',
};

/**
 * La géolocalisation peut-elle fonctionner ici ?
 *
 * Deux conditions, et les deux sont des faits d'environnement : la base est
 * installée, et au moins un proxy est déclaré (sans quoi Express ignore
 * `X-Forwarded-For` et toutes les sessions restent à `::1`).
 *
 * ⚠️ La question se pose **au chargement du module**, pas dans un `beforeAll`.
 * Jest exécute les corps de `describe` avant les hooks : une sonde faite après
 * l'ingestion arriverait trop tard pour décider si un `it` doit être sauté, et
 * tous les cas se sauteraient en silence. C'est exactement le piège dans lequel
 * ce fichier est tombé une fois.
 */
const BASE = resolve(__dirname, '../data/dbip-city-lite-2026-08.mmdb');
const PROXY_DECLARE = Number(process.env.TRUST_PROXY_HOPS ?? '0') >= 1;
const avecGeo = existsSync(BASE) && PROXY_DECLARE ? it : it.skip;

interface LocationsResponse {
  from: string;
  to: string;
  grain: string;
  rows: { countryCode: string | null; value: string; visitors: number }[];
  visitors: number;
  unresolved: number;
}

describe('GET /v1/projects/:projectId/analytics/locations (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projectId: string;
  let cookies: string[];

  /**
   * Ingère une vue de page en se déclarant à telle adresse.
   *
   * Le visiteur est identifié par son User-Agent — la clé visiteur dérive de
   * l'IP **et** de l'UA, donc deux UA distincts depuis la même IP font deux
   * visiteurs, ce qui est exactement ce qu'il faut pour compter des visiteurs
   * par pays.
   */
  const vue = (visiteur: string, ip: string, apiKey: string) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', visiteur)
      .set('X-Forwarded-For', ip)
      .send({
        apiKey,
        type: 'page_view',
        occurredAt: OCCURRED_AT,
        attributes: { 'page.path': '/' },
        properties: {},
      })
      .expect(201);

  const locations = async (
    query: Record<string, string> = {},
    project: string = projectId,
  ) => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project}/analytics/locations`)
      .set('Cookie', cookies)
      .query({ ...FENETRE, ...query })
      .expect(200);

    expectMatchesContract(response.body, locationsPageSchema);

    return response.body as LocationsResponse;
  };

  beforeAll(async () => {
    app = await createTestApp();

    db = app.get<DrizzleDatabase>(DRIZZLE);

    const reader = await signUp(app);
    cookies = reader.cookies;
    await joinOrganization(db, await organizationId(db), reader.id);

    const projet = await createProject(db, {
      name: `e2e locations ${new Date().toISOString()}`,
    });
    projectId = projet.id;

    // Deux visiteurs depuis Paris, un depuis Sydney, un depuis Mountain View :
    // de quoi éprouver l'ordre du classement et les trois grains.
    await vue('paris-a', DEPUIS.paris, projet.apiKey);
    await vue('paris-b', DEPUIS.paris, projet.apiKey);
    await vue('sydney', DEPUIS.sydney, projet.apiKey);
    await vue('mountain-view', DEPUIS.mountainView, projet.apiKey);
    // Un visiteur sans adresse publique : c'est lui qui alimente `unresolved`.
    await request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', 'sans-adresse')
      .send({
        apiKey: projet.apiKey,
        type: 'page_view',
        occurredAt: OCCURRED_AT,
        attributes: { 'page.path': '/' },
        properties: {},
      })
      .expect(201);
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  describe('la résolution à l’ingestion', () => {
    avecGeo('écrit le pays sur la session, jamais l’IP', async () => {
      const lignes = await db
        .select({
          countryCode: sessions.countryCode,
          region: sessions.region,
          city: sessions.city,
        })
        .from(sessions)
        .where(eq(sessions.projectId, projectId));

      expect(lignes).toContainEqual({
        countryCode: 'FR',
        region: 'Île-de-France',
        city: 'Aubervilliers',
      });

      // La table n'a aucune colonne où une IP pourrait se ranger : c'est la
      // garantie structurelle, et elle ne tient pas à ce que le code veut bien
      // écrire.
      expect(Object.keys(sessions)).not.toContain('ip');
    });

    avecGeo(
      'laisse la session sans pays quand l’adresse est locale',
      async () => {
        const total = await db
          .select({ countryCode: sessions.countryCode })
          .from(sessions)
          .where(eq(sessions.projectId, projectId));

        expect(total.some((ligne) => ligne.countryCode === null)).toBe(true);
      },
    );
  });

  describe('le classement', () => {
    avecGeo('groupe par pays, du plus visité au moins visité', async () => {
      const { rows, visitors, unresolved } = await locations();

      expect(rows).toEqual([
        { countryCode: 'FR', value: 'FR', visitors: 2, sessions: 2 },
        { countryCode: 'AU', value: 'AU', visitors: 1, sessions: 1 },
        { countryCode: 'US', value: 'US', visitors: 1, sessions: 1 },
      ]);

      // Le total compte **tout le monde**, y compris ceux qu'on n'a pas su
      // placer : c'est ce qui fait que la somme des parts ne vaut pas 100 %, et
      // c'est voulu.
      expect(visitors).toBe(5);
      expect(unresolved).toBe(1);
    });

    avecGeo('descend au grain région, en gardant le pays', async () => {
      const { rows } = await locations({ grain: 'region' });

      // Le pays voyage avec la région : sans lui, deux régions homonymes de
      // deux pays fusionneraient.
      expect(rows[0]).toEqual({
        countryCode: 'FR',
        value: 'Île-de-France',
        visitors: 2,
        sessions: 2,
      });
    });

    avecGeo('descend au grain ville', async () => {
      const { rows } = await locations({ grain: 'city' });

      expect(rows[0]).toEqual({
        countryCode: 'FR',
        value: 'Aubervilliers',
        visitors: 2,
        sessions: 2,
      });
    });

    avecGeo('tronque au `limit` demandé', async () => {
      expect((await locations({ limit: '1' })).rows).toHaveLength(1);
    });

    it('rend la fenêtre et le grain retenus', async () => {
      // Le défaut n'est jamais implicite pour l'appelant : la réponse dit sur
      // quoi elle porte, comme les deux autres routes analytiques.
      const { from, to, grain } = await locations();

      expect({ from, to, grain }).toEqual({ ...FENETRE, grain: 'country' });
    });
  });

  describe('ce que la requête refuse', () => {
    const refuse = (query: Record<string, string>) =>
      request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics/locations`)
        .set('Cookie', cookies)
        .query({ ...FENETRE, ...query })
        .expect(400);

    it('refuse un grain inconnu', async () => {
      // L'enum est ce qui garantit qu'aucune chaîne d'appelant n'atteint le
      // SQL : il doit refuser, pas retomber sur un défaut.
      await refuse({ grain: 'planet' });
    });

    it('refuse une limite hors bornes', async () => {
      await refuse({ limit: '0' });
      await refuse({ limit: '9999' });
      await refuse({ limit: 'beaucoup' });
    });

    it('refuse un paramètre inconnu plutôt que de l’ignorer', async () => {
      // `strictObject` : un filtre silencieusement écarté rendrait un chiffre
      // juste à une question que personne n'a posée.
      await refuse({ country: 'FR' });
    });
  });

  describe('le cloisonnement', () => {
    it('rend 404 à un compte qui n’est membre de rien', async () => {
      const etranger = await signUp(app);

      // 404 et pas 403 : l'existence d'un projet ne doit pas se déduire d'un
      // code de statut. Même règle que les deux autres routes analytiques.
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics/locations`)
        .set('Cookie', etranger.cookies)
        .query(FENETRE)
        .expect(404);
    });

    it('rend 401 sans session', async () => {
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics/locations`)
        .query(FENETRE)
        .expect(401);
    });
  });
});
