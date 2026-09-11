import { technologyPageSchema } from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, sessions } from '../src/database/schema';
import {
  TEST_ORIGIN,
  cleanupFixtures,
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
  type SignedUpUser,
  type TestProject,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * La chaîne du User-Agent, de l'en-tête au classement — et ce qu'elle ne
 * conserve pas.
 *
 * Deux promesses s'éprouvent ici, et aucune des deux n'est vérifiable en test
 * unitaire : que l'en-tête ne survit nulle part, et qu'une session de robot
 * disparaît de tous les compteurs sans disparaître du décompte des robots.
 *
 * Contrairement à la chaîne géographique, rien ici ne se saute : il n'y a ni
 * base de 124 Mo ni `trust proxy` dont dépendre. L'en-tête arrive tel quel.
 */

const OCCURRED_AT = '2026-08-22T12:00:00.000Z';

const FENETRE = {
  from: '2026-08-22T00:00:00.000Z',
  to: '2026-08-23T00:00:00.000Z',
};

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const GOOGLEBOT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

describe('technologie (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projet: TestProject;
  let lecteur: SignedUpUser;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);

    projet = await createProject(db, { name: 'e2e technologie' });

    // Les lectures analytiques sont derrière le guard : il faut un membre de
    // l'organisation du projet, pas seulement une session valide.
    lecteur = await signUp(app, 'Lecteur technologie');
    await joinOrganization(db, await organizationId(db), lecteur.id, 'member');

    // Trois visiteurs distincts et un robot. Le User-Agent entre dans la clé
    // visiteur : quatre en-têtes différents font quatre sessions, sans qu'on ait
    // à les fabriquer.
    for (const ua of [
      CHROME_WINDOWS,
      SAFARI_IPHONE,
      FIREFOX_LINUX,
      GOOGLEBOT,
    ]) {
      await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .set('User-Agent', ua)
        .send({
          apiKey: projet.apiKey,
          type: 'page_view',
          occurredAt: OCCURRED_AT,
          attributes: { 'page.path': '/' },
          properties: {},
        })
        .expect(201);
    }
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  const technology = async (query: Record<string, string> = {}) =>
    expectMatchesContract(
      (
        await request(app.getHttpServer())
          .get(`/v1/projects/${projet.id}/analytics/technology`)
          .set('Cookie', lecteur.cookies)
          .query({ ...FENETRE, ...query })
          .expect(200)
      ).body,
      technologyPageSchema,
    );

  const summary = async () =>
    (
      await request(app.getHttpServer())
        .get(`/v1/projects/${projet.id}/analytics`)
        .set('Cookie', lecteur.cookies)
        .query(FENETRE)
        .expect(200)
    ).body as { sessions: number; uniqueVisitors: number; botSessions: number };

  it('ne garde le User-Agent nulle part', async () => {
    // La promesse centrale du lot. L'en-tête entre, quatre libellés en sortent,
    // et lui meurt avec la requête — aucune ligne de `sessions` ni d'`events`
    // ne doit en contenir la moindre sous-chaîne.
    const lignes = JSON.stringify([
      await db.select().from(sessions).where(eq(sessions.projectId, projet.id)),
      await db.select().from(events).where(eq(events.projectId, projet.id)),
    ]);

    expect(lignes).not.toContain('AppleWebKit');
    expect(lignes).not.toContain('Mozilla');
    expect(lignes).not.toContain('Gecko');
    expect(lignes).not.toContain('141.0.0.0');
  });

  it('classe les navigateurs, et jamais leur version', async () => {
    const { rows } = await technology({ grain: 'browser' });
    const noms = rows.map((row) => row.value);

    expect(noms).toEqual(
      expect.arrayContaining(['Chrome', 'Safari', 'Firefox']),
    );
    // Chrome se déclare aussi Safari, et Safari ne se déclare que lui-même :
    // trois en-têtes, trois navigateurs distincts.
    expect(rows).toHaveLength(3);
    expect(noms.join(' ')).not.toMatch(/\d/);
  });

  it('classe les systèmes', async () => {
    const { rows } = await technology({ grain: 'os' });

    expect(rows.map((row) => row.value)).toEqual(
      expect.arrayContaining(['Windows', 'iOS', 'Linux']),
    );
  });

  it('classe les appareils', async () => {
    const { rows } = await technology({ grain: 'device' });
    const parType = Object.fromEntries(
      rows.map((row) => [row.value, row.sessions]),
    );

    expect(parType.mobile).toBe(1);
    expect(parType.desktop).toBe(2);
  });

  it('écarte le robot de tous les classements', async () => {
    // Le test qui vaut le lot. Le robot a une vraie session et une vraie clé
    // visiteur : rien ne l'ignore gratuitement, c'est la condition posée dans
    // `EventStore.where()` qui le retire — et elle vaut pour les neuf lectures.
    const { rows, visitors } = await technology({ grain: 'browser' });

    expect(rows.map((row) => row.value)).not.toContain('Googlebot');
    expect(visitors).toBe(3);
  });

  it('le compte quand même, plutôt que de le taire', async () => {
    const resume = await summary();

    // Sans ce chiffre, une vague de robots et une baisse de trafic se
    // ressembleraient exactement.
    expect(resume.botSessions).toBe(1);
    expect(resume.sessions).toBe(3);
    expect(resume.uniqueVisitors).toBe(3);
  });

  it('refuse un grain qu’il ne connaît pas', async () => {
    // L'enum est fermé au bord HTTP *et* la valeur sert ensuite à choisir une
    // colonne dans une table close : aucune chaîne d'appelant n'atteint le SQL.
    await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/analytics/technology`)
      .set('Cookie', lecteur.cookies)
      .query({ ...FENETRE, grain: 'sessions' })
      .expect(400);
  });
});
