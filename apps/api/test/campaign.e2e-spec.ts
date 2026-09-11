import { sessionsPageSchema } from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions, users } from '../src/database/schema';
import {
  TEST_ORIGIN,
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
  type SignedUpUser,
  type TestProject,
} from './fixtures';

/**
 * La campagne, du paramètre d'URL à la ligne de session.
 *
 * Ce que les tests unitaires ne peuvent pas voir, et qui est tout l'enjeu de cet
 * axe : la campagne est posée **à l'ouverture de la session**, une seule fois,
 * et plus rien ne la déplace ensuite. Ni un second événement aux paramètres
 * différents, ni une fusion de deux sessions, ni un événement serveur qui en
 * porterait un. Ces trois-là demandent un vrai Postgres, une vraie transaction
 * et le vrai assigneur — un double les rendrait tous verts.
 */

const FENETRE = {
  from: '2026-08-22T00:00:00.000Z',
  to: '2026-08-23T00:00:00.000Z',
};

const T0 = new Date('2026-08-22T10:00:00.000Z');

/** `T0 + n` minutes, au format du fil. */
const apres = (minutes: number) =>
  new Date(T0.getTime() + minutes * 60_000).toISOString();

// Fixe : la clé visiteur est dérivée de l'IP et du User-Agent, donc deux envois
// qui le partagent sont le même visiteur. C'est ce qui permet de provoquer une
// fusion sans toucher à l'assigneur.
const NAVIGATEUR =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('campagne (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let lecteur: SignedUpUser;
  let projet: TestProject;
  const created: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    db = app.get<DrizzleDatabase>(DRIZZLE);

    lecteur = await signUp(app, 'Lecteur campagne');
    await joinOrganization(db, await organizationId(db), lecteur.id, 'member');
  });

  afterAll(async () => {
    await db.delete(events).where(inArray(events.projectId, created));
    await db.delete(sessions).where(inArray(sessions.projectId, created));
    await db.delete(projects).where(inArray(projects.id, created));
    await db.delete(users).where(eq(users.id, lecteur.id));
    await app.close();
  });

  // Un projet neuf par test : la clé visiteur porte le `projectId`, donc changer
  // de projet suffit à changer de visiteur. Sans ça, le test suivant hériterait
  // de la session du précédent et lirait sa campagne.
  beforeEach(async () => {
    projet = await createProject(db, {
      name: `e2e campagne ${new Date().toISOString()}`,
    });
    created.push(projet.id);
  });

  /** Émet une vue depuis le navigateur, avec ou sans campagne. */
  const visiter = (
    occurredAt: string,
    campaign?: Record<string, string>,
    path = '/',
  ) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', NAVIGATEUR)
      .send({
        apiKey: projet.apiKey,
        type: 'page_view',
        occurredAt,
        attributes: { 'page.path': path },
        properties: {},
        ...(campaign ? { campaign } : {}),
      })
      .expect(201);

  const lignes = async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/analytics/sessions`)
      .set('Cookie', lecteur.cookies)
      .query(FENETRE)
      .expect(200);

    return expectMatchesContract(response.body, sessionsPageSchema).sessions;
  };

  it('porte les trois paramètres jusqu’à la ligne de session', async () => {
    await visiter(apres(0), {
      source: 'google',
      medium: 'cpc',
      name: 'rentree',
    });

    expect(await lignes()).toEqual([
      expect.objectContaining({
        campaign: { source: 'google', medium: 'cpc', name: 'rentree' },
      }),
    ]);
  });

  it('normalise la casse et les espaces, et jamais le SDK', async () => {
    // La normalisation est serveur, et c'est la raison d'être de ce test :
    // deux bundles de dates différentes doivent produire la même campagne.
    await visiter(apres(0), { source: '  Newsletter ', medium: 'EMAIL' });

    expect((await lignes())[0].campaign).toEqual({
      source: 'newsletter',
      medium: 'email',
      // Absent du fil : `null`, pas une chaîne vide — un classement par campagne
      // ne doit pas avoir à distinguer les deux.
      name: null,
    });
  });

  it('laisse une visite sans paramètre sans campagne', async () => {
    await visiter(apres(0));

    // `null` entier, pas trois champs nuls : « pas de campagne » est un état, et
    // il se lit d'un coup d'œil.
    expect((await lignes())[0].campaign).toBeNull();
  });

  it('ne change pas de campagne en cours de visite', async () => {
    // Le cas qui abîmerait tout le classement s'il était pris par événement :
    // les UTM restent dans la barre d'adresse après le premier chargement, donc
    // une visite de trois pages compterait trois arrivées de la même campagne.
    await visiter(apres(0), { source: 'google', medium: 'cpc' });
    await visiter(apres(5), { source: 'facebook', medium: 'social' }, '/prix');

    const lues = await lignes();

    expect(lues).toHaveLength(1);
    expect(lues[0].pageViews).toBe(2);
    expect(lues[0].campaign).toEqual({
      source: 'google',
      medium: 'cpc',
      name: null,
    });
  });

  it('garde la campagne de la survivante quand deux sessions fusionnent', async () => {
    // Deux sessions séparées, puis un événement qui les ponte : l'assigneur les
    // recolle. La survivante est la plus ancienne — c'est sa campagne qui doit
    // rester, sans quoi une fusion réécrirait l'acquisition d'une visite déjà
    // attribuée.
    await visiter(apres(0), { source: 'google', medium: 'cpc' });
    await visiter(apres(50), { source: 'bing', medium: 'cpc' }, '/prix');

    await visiter(apres(25), { source: 'facebook', medium: 'social' }, '/blog');

    const lues = await lignes();

    expect(lues).toHaveLength(1);
    expect(lues[0].campaign).toEqual({
      source: 'google',
      medium: 'cpc',
      name: null,
    });
  });

  it('ignore une campagne annoncée par une source serveur', async () => {
    // Une clé secrète n'ouvre pas de session — un paiement rapporté par un
    // serveur n'arrive de nulle part. Le champ est accepté par le fil et jeté
    // par l'adaptateur HTTP : le contraire fabriquerait des visites.
    await request(app.getHttpServer())
      .post('/v1/events')
      .send({
        apiKey: projet.secretKey,
        type: 'deploiement',
        occurredAt: apres(0),
        attributes: {},
        properties: {},
        campaign: { source: 'google', medium: 'cpc' },
      })
      .expect(201);

    const visites = await db
      .select()
      .from(sessions)
      .where(eq(sessions.projectId, projet.id));

    expect(visites).toHaveLength(0);
    expect(await lignes()).toEqual([]);
  });
});
