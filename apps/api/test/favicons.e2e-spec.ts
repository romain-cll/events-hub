import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { signUp } from './fixtures';

/**
 * Le relais de favicons.
 *
 * Ce qui s'éprouve ici est **la validation et le cloisonnement**, pas le rendu
 * d'une icône : appeler DuckDuckGo depuis une suite de tests la rendrait lente
 * et dépendante du réseau. Le chemin passant est couvert par la seule chose
 * qu'on puisse affirmer sans sortir : un hôte bien formé ne rend jamais 400.
 */
describe('GET /v1/favicons/:host (e2e)', () => {
  let app: INestApplication<App>;
  let cookies: string[];

  const demander = (host: string, session = cookies) =>
    request(app.getHttpServer())
      .get(`/v1/favicons/${host}`)
      .set('Cookie', session);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    app.get<DrizzleDatabase>(DRIZZLE);

    cookies = (await signUp(app)).cookies;
  });

  afterAll(async () => {
    await app.close();
  });

  it('exige une session', async () => {
    // Sans ça, la route serait un proxy DuckDuckGo ouvert à tout Internet, à
    // nos frais et sous notre adresse IP.
    await request(app.getHttpServer()).get('/v1/favicons/github.com').expect(401);
  });

  describe('ce que la validation refuse', () => {
    // Chacun de ces hôtes, s'il était interpolé sans contrôle, sortirait du
    // chemin qu'on a écrit ou déguiserait la destination réelle.
    const refuses = [
      ['un hôte sans point', 'localhost'],
      ['une adresse IP', '169.254.169.254'],
      ['une remontée de chemin', '..%2F..%2Fadmin'],
      ['une partie utilisateur', 'evil.test%40github.com'],
      ['un port', 'github.com%3A22'],
      ['un schéma complet', 'http%3A%2F%2Fgithub.com'],
      ['un tiret en tête de label', '-github.com'],
    ];

    it.each(refuses)('refuse %s', async (_, host) => {
      await demander(host).expect(400);
    });
  });

  it('accepte un hôte bien formé, quelle que soit sa casse', async () => {
    // Un hôte est insensible à la casse : refuser `GitHub.com` serait refuser
    // une adresse valide. On n'affirme rien sur le corps — l'amont est un
    // service tiers, et une suite de tests ne doit pas dépendre de sa
    // disponibilité. 204 (pas d'icône) est une réponse aussi correcte que 200.
    const response = await demander('GitHub.com');

    expect([200, 204]).toContain(response.status);
  });

  it('demande au client de garder l’icône longtemps', async () => {
    // Une favicon ne change pas d'un chargement à l'autre. Sans ce cache, une
    // page de dix lignes referait dix requêtes à chaque ouverture d'onglet.
    const response = await demander('github.com');

    expect(response.headers['cache-control']).toContain('max-age=604800');
  });
});
