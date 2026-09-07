import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import { VisitorKeyService } from '../src/privacy/visitor-key.service';
import { SESSION_GAP_MS } from '../src/sessions/session-assigner.service';
import {
  cookiesOf,
  createProject,
  TEST_ORIGIN,
  type TestProject,
} from './fixtures';

/**
 * Les deux modes d'identification, éprouvés par la route.
 *
 * C'est le seul endroit où la bascule est observable de bout en bout : le
 * cookie part dans une réponse HTTP, revient dans une requête suivante, et ce
 * qu'il change se lit dans `sessions.visitor_key`. Ni un test unitaire ni la
 * base seule ne montrent ce trajet.
 *
 * Chaque cas prend un projet neuf. Les clés visiteur du mode dérivé sont
 * cloisonnées par projet et par jour, donc deux cas qui partageraient un projet
 * partageraient aussi leurs sessions — et se contamineraient.
 */

const COOKIE = '__Host-eh_vid';

const T0 = new Date('2026-09-01T10:00:00.000Z');

/** `T0 + n` millisecondes. */
const apres = (ms: number) => new Date(T0.getTime() + ms).toISOString();

/** Au-delà du seuil d'inactivité : une session neuve, donc une clé lisible. */
const PLUS_TARD = apres(SESSION_GAP_MS + 1);

describe('consentement et identité du visiteur (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let visitorKeys: VisitorKeyService;
  const created: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    db = app.get<DrizzleDatabase>(DRIZZLE);
    visitorKeys = app.get(VisitorKeyService);
  });

  afterAll(async () => {
    for (const id of created) {
      await db.delete(events).where(eq(events.projectId, id));
      await db.delete(sessions).where(eq(sessions.projectId, id));
      await db.delete(projects).where(eq(projects.id, id));
    }
    await app.close();
  });

  const projetNeuf = async (name: string): Promise<TestProject> => {
    const projet = await createProject(db, { name });
    created.push(projet.id);

    return projet;
  };

  const post = (
    body: Record<string, unknown>,
    cookie?: string,
  ): request.Test => {
    const call = request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN);

    return cookie ? call.set('Cookie', cookie).send(body) : call.send(body);
  };

  const evenement = (
    projet: TestProject,
    extra: Record<string, unknown> = {},
  ) => ({
    apiKey: projet.apiKey,
    type: 'consent_e2e',
    occurredAt: T0.toISOString(),
    attributes: {},
    properties: {},
    ...extra,
  });

  /** L'en-tête `Set-Cookie` du cookie de visiteur, s'il y en a un. */
  const poseParLaReponse = (response: request.Response): string | undefined =>
    cookiesOf(response).find((entete) => entete.startsWith(`${COOKIE}=`));

  const identifiantPose = (response: request.Response): string => {
    const entete = poseParLaReponse(response);

    if (!entete) throw new Error('aucun cookie de visiteur dans la réponse');

    return entete.slice(COOKIE.length + 1).split(';')[0];
  };

  const clesDesSessions = async (projectId: string): Promise<string[]> => {
    const rows = await db
      .select({ visitorKey: sessions.visitorKey })
      .from(sessions)
      .where(eq(sessions.projectId, projectId));

    return rows.map((row) => row.visitorKey);
  };

  it('ne pose aucun cookie quand le site ne dit rien', async () => {
    const projet = await projetNeuf('e2e consentement — muet');

    const response = await post(evenement(projet)).expect(201);

    // Le défaut est le mode qui ne dépose rien sur le terminal. Un site qui ne
    // câble pas le signal n'a rien à afficher à ses visiteurs.
    expect(poseParLaReponse(response)).toBeUndefined();
    expect(await clesDesSessions(projet.id)).toHaveLength(1);
  });

  it('pose un identifiant durable à l’acceptation, sans couper la visite', async () => {
    const projet = await projetNeuf('e2e consentement — acceptation');

    await post(evenement(projet)).expect(201);
    const accepte = await post(
      evenement(projet, { consent: true, occurredAt: apres(60_000) }),
    ).expect(201);

    expect(poseParLaReponse(accepte)).toBeDefined();
    // Le cœur du repli : la visite commencée sans consentement et celle qui
    // suit l'acceptation sont **la même**. Sans lui, deux pages vues
    // compteraient pour deux visites d'une page.
    expect(await clesDesSessions(projet.id)).toHaveLength(1);
  });

  it('porte les attributs sans lesquels le cookie serait bloqué', async () => {
    const projet = await projetNeuf('e2e consentement — attributs');

    const response = await post(evenement(projet, { consent: true })).expect(
      201,
    );

    const entete = poseParLaReponse(response);

    // Servi depuis le domaine du hub, ce cookie est un cookie tiers : sans
    // `Partitioned` il n'est pas raboté, il est refusé.
    expect(entete).toContain('Partitioned');
    expect(entete).toContain('SameSite=None');
    expect(entete).toContain('Secure');
    expect(entete).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
  });

  it('honore le cookie sans le réécrire quand le signal est absent', async () => {
    const projet = await projetNeuf('e2e consentement — silence');

    const accepte = await post(evenement(projet, { consent: true })).expect(
      201,
    );
    const identifiant = identifiantPose(accepte);

    // Plus tard que le seuil : la session qui s'ouvre porte donc la clé du
    // moment, et la rend lisible.
    const muet = await post(
      evenement(projet, { occurredAt: PLUS_TARD }),
      `${COOKIE}=${identifiant}`,
    ).expect(201);

    // Rien n'est réécrit — il n'y a pas de nouveau signal à enregistrer…
    expect(poseParLaReponse(muet)).toBeUndefined();
    // …mais l'identité est bien celle du cookie : l'absence de signal n'est pas
    // un refus, et le cookie porte la trace du consentement antérieur.
    expect(await clesDesSessions(projet.id)).toContain(
      visitorKeys.computeStable(projet.id, identifiant),
    );
  });

  it('efface le cookie au retrait et repasse à l’identité dérivée', async () => {
    const projet = await projetNeuf('e2e consentement — retrait');

    const accepte = await post(evenement(projet, { consent: true })).expect(
      201,
    );
    const identifiant = identifiantPose(accepte);
    const durable = visitorKeys.computeStable(projet.id, identifiant);

    const retire = await post(
      evenement(projet, { consent: false, occurredAt: PLUS_TARD }),
      `${COOKIE}=${identifiant}`,
    ).expect(201);

    expect(poseParLaReponse(retire)).toContain('Max-Age=0');

    // Le retrait vaut dès cet événement-ci, pas au suivant : la session ouverte
    // après le seuil ne porte plus la clé durable.
    const cles = await clesDesSessions(projet.id);

    expect(cles).toHaveLength(2);
    expect(cles.filter((cle) => cle === durable)).toHaveLength(1);
  });

  it('ne propose jamais de cookie à une source serveur', async () => {
    const projet = await projetNeuf('e2e consentement — serveur');

    const response = await request(app.getHttpServer())
      .post('/v1/events')
      .send({ ...evenement(projet), apiKey: projet.secretKey, consent: true })
      .expect(201);

    // Une source serveur n'a pas de terminal où écrire, et pas de visiteur à
    // identifier : le cookie n'a aucun sens sur ce chemin.
    expect(poseParLaReponse(response)).toBeUndefined();
  });
});
