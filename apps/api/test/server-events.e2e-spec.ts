import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { eventsPageSchema } from '@events-hub/api-contract';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { eventTypes, events, projects, sessions } from '../src/database/schema';
import {
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
  TEST_ORIGIN,
  type TestProject,
} from './fixtures';

/**
 * L'événement **sans visiteur**, de bout en bout.
 *
 * C'est le fichier qui décrit ce que ce lot ouvre : jusqu'ici, tout événement
 * devait avoir une session, donc un visiteur, donc une IP de navigateur. Un
 * deploy, un webhook de paiement ou une sonde d'uptime n'en ont pas — ils
 * auraient reçu une session rattachée à l'IP du runner qui les émet, et ce faux
 * visiteur aurait compté dans les visiteurs uniques du projet.
 *
 * ## Les quatre promesses éprouvées ici
 *
 * 1. Une clé `eh_sk_` ingère **sans en-tête `Origin`**, et la ligne écrite n'a
 *    pas de session.
 * 2. Cet événement **apparaît** dans le journal brut et **ne bouge pas** les
 *    compteurs d'audience.
 * 3. Un type marqué `serverOnly` rend invisibles les événements du même nom
 *    venus d'un navigateur.
 * 4. Le drapeau est **rétroactif et réversible** : posé après coup, il fait
 *    disparaître ce qui a déjà été écrit ; retiré, il le fait revenir.
 *
 * La quatrième est la raison pour laquelle le drapeau agit à la lecture et pas
 * à l'écriture. Un contrôle à l'ingestion arriverait toujours trop tard : un
 * type n'existe qu'une fois qu'il a été émis, donc la fenêtre où il est encore
 * forgeable ne peut pas être fermée par une vérification à l'écriture.
 *
 * ## Le vocabulaire est inventé exprès
 *
 * `deploiement`, `encaissement` : aucun de ces types n'existe dans le SDK ni
 * nulle part dans `src/`. C'est le cas d'usage même du hub — un client émet ses
 * propres types — et un test écrit avec le vocabulaire du SDK ne prouverait
 * rien de cette promesse.
 */

const FENETRE = {
  from: '2026-08-22T00:00:00.000Z',
  to: '2026-08-23T00:00:00.000Z',
};

const at = (heure: string) => `2026-08-22T${heure}:00.000Z`;

interface EventJson {
  sessionId: string | null;
  sessionStartedAt: string | null;
  type: string;
  source: string;
  occurredAt: string;
  attributes: Record<string, unknown>;
  properties: Record<string, unknown>;
}

describe('événements sans visiteur (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projet: TestProject;
  let cookies: string[];
  const created: string[] = [];

  const nouveauProjet = async (label: string) => {
    const project = await createProject(db, {
      name: `e2e serveur ${label} ${new Date().toISOString()}`,
    });

    created.push(project.id);

    return project;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    db = app.get<DrizzleDatabase>(DRIZZLE);

    const user = await signUp(app);
    await joinOrganization(db, await organizationId(db), user.id);
    cookies = user.cookies;

    projet = await nouveauProjet('principal');
  });

  afterAll(async () => {
    if (created.length > 0) {
      await db.delete(events).where(inArray(events.projectId, created));
      await db.delete(sessions).where(inArray(sessions.projectId, created));
      await db.delete(eventTypes).where(inArray(eventTypes.projectId, created));
      await db.delete(projects).where(inArray(projects.id, created));
    }

    await app.close();
  });

  /** Émet depuis un serveur : clé secrète, et surtout **pas d'`Origin`**. */
  const depuisLeServeur = (
    type: string,
    heure = '10:00',
    cle: string = projet.secretKey,
  ) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .send({
        apiKey: cle,
        type,
        occurredAt: at(heure),
        attributes: {},
        properties: { 'release.tag': 'v1.4.0' },
      });

  /** Émet depuis un navigateur : clé publique, `Origin` déclarée. */
  const depuisLeNavigateur = (
    type: string,
    heure = '10:00',
    visiteur = 'Mozilla/5.0 (serveur-e2e)',
    cle: string = projet.apiKey,
  ) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', visiteur)
      .send({
        apiKey: cle,
        type,
        occurredAt: at(heure),
        attributes: { 'page.path': '/' },
        properties: {},
      });

  const journal = async (project: string = projet.id) => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project}/events`)
      .set('Cookie', cookies)
      .query(FENETRE)
      .expect(200);

    expectMatchesContract(response.body, eventsPageSchema);

    return response.body as { events: EventJson[]; types: string[] };
  };

  const audience = async (project: string = projet.id) => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project}/analytics`)
      .set('Cookie', cookies)
      .query(FENETRE)
      .expect(200);

    return response.body as { uniqueVisitors: number; sessions: number };
  };

  const typeNomme = async (project: string, name: string) => {
    const [row] = await db
      .select()
      .from(eventTypes)
      .where(eq(eventTypes.projectId, project));

    expect(row).toBeDefined();

    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project}/event-types`)
      .set('Cookie', cookies)
      .expect(200);

    const trouve = (
      response.body as { id: string; name: string; serverOnly: boolean }[]
    ).find((candidat) => candidat.name === name);

    expect(trouve).toBeDefined();

    return trouve!;
  };

  const basculer = (project: string, id: string, serverOnly: boolean) =>
    request(app.getHttpServer())
      .patch(`/v1/projects/${project}/event-types/${id}`)
      .set('Cookie', cookies)
      .send({ serverOnly })
      .expect(200);

  describe("l'ingestion serveur", () => {
    it('accepte une clé secrète sans en-tête Origin', async () => {
      // La règle « pas d'Origin, pas d'événement » ne valait que parce que le
      // SDK navigateur était la seule source. Une clé secrète n'en envoie pas,
      // et ce n'est pas un signal : c'est la normale.
      await depuisLeServeur('deploiement').expect(201);
    });

    it('écrit une ligne sans session, marquée « server »', async () => {
      const projetDuCas = await nouveauProjet('sans-session');

      const reponse = await depuisLeServeur(
        'deploiement',
        '10:00',
        projetDuCas.secretKey,
      ).expect(201);

      const [ligne] = await db
        .select({ sessionId: events.sessionId, source: events.source })
        .from(events)
        .where(eq(events.projectId, projetDuCas.id));

      // `null` n'est pas une valeur manquante : il n'y avait rien à rattacher.
      expect(ligne.sessionId).toBeNull();
      expect(ligne.source).toBe('server');
      // Et la réponse le dit aussi : la clé est présente, sa valeur est `null`.
      // Une source serveur qui lirait une session l'aurait inventée.
      expect((reponse.body as { sessionId: string | null }).sessionId).toBeNull();
    });

    it('n’ouvre aucune session, même en émettant plusieurs fois', async () => {
      const projetDuCas = await nouveauProjet('aucune-session');

      await depuisLeServeur('deploiement', '10:00', projetDuCas.secretKey);
      await depuisLeServeur('deploiement', '10:05', projetDuCas.secretKey);

      const lignes = await db
        .select()
        .from(sessions)
        .where(eq(sessions.projectId, projetDuCas.id));

      // Le point du lot : deux événements serveur ne fabriquent pas un visiteur
      // qui aurait « visité deux fois ».
      expect(lignes).toHaveLength(0);
    });

    it('refuse toujours une clé publique sans Origin', async () => {
      // La règle n'a pas sauté pour tout le monde : elle ne s'applique plus
      // qu'aux clés publiques, qui restent lisibles par n'importe qui.
      await request(app.getHttpServer())
        .post('/v1/events')
        .send({
          apiKey: projet.apiKey,
          type: 'deploiement',
          occurredAt: at('10:00'),
          attributes: {},
          properties: {},
        })
        .expect(204);
    });
  });

  describe('ce que les lectures en font', () => {
    it('le montre dans le journal brut, sans session', async () => {
      const projetDuCas = await nouveauProjet('journal');

      await depuisLeServeur('deploiement', '10:00', projetDuCas.secretKey);

      const page = await journal(projetDuCas.id);

      expect(page.types).toContain('deploiement');
      expect(page.events).toHaveLength(1);
      expect(page.events[0]).toMatchObject({
        type: 'deploiement',
        source: 'server',
        sessionId: null,
        sessionStartedAt: null,
      });
    });

    it('ne le compte ni dans les visiteurs ni dans les sessions', async () => {
      const projetDuCas = await nouveauProjet('audience');

      await depuisLeNavigateur(
        'page_view',
        '10:00',
        'Mozilla/5.0 (audience-e2e)',
        projetDuCas.apiKey,
      ).expect(201);

      const avant = await audience(projetDuCas.id);

      await depuisLeServeur('deploiement', '10:10', projetDuCas.secretKey);
      await depuisLeServeur('encaissement', '10:20', projetDuCas.secretKey);

      // Rien à filtrer côté Analytics : `COUNT(DISTINCT session_id)` ignore les
      // `NULL`, et la jointure interne sur `sessions` écarte ces lignes d'elle-
      // même. C'est structurel, et c'est ce que ce test verrouille.
      expect(await audience(projetDuCas.id)).toEqual(avant);
    });
  });

  describe('le drapeau serverOnly', () => {
    it('inscrit tout type au vocabulaire, sans jamais refuser', async () => {
      const projetDuCas = await nouveauProjet('vocabulaire');

      await depuisLeServeur('encaissement', '10:00', projetDuCas.secretKey)
        .expect(201);

      const inscrit = await typeNomme(projetDuCas.id, 'encaissement');

      // Faux par défaut : un client peut vouloir des funnels web sur ses propres
      // types, et un défaut restrictif casserait le cas courant.
      expect(inscrit.serverOnly).toBe(false);
    });

    it('rend invisible ce qu’un navigateur a écrit sous ce nom', async () => {
      const projetDuCas = await nouveauProjet('forge');

      await depuisLeServeur('encaissement', '10:00', projetDuCas.secretKey);
      const type = await typeNomme(projetDuCas.id, 'encaissement');

      await basculer(projetDuCas.id, type.id, true);

      // Une clé publique traîne dans le bundle de n'importe quel site : forger
      // un encaissement depuis un navigateur est à la portée de tous.
      await depuisLeNavigateur(
        'encaissement',
        '11:00',
        'Mozilla/5.0 (forgeur)',
        projetDuCas.apiKey,
      ).expect(201);

      const page = await journal(projetDuCas.id);

      // La ligne forgée est bien en base — on ne détruit rien — mais aucune
      // lecture ne la rend.
      const enBase = await db
        .select({ source: events.source })
        .from(events)
        .where(eq(events.projectId, projetDuCas.id));

      expect(enBase).toHaveLength(2);
      expect(page.events).toHaveLength(1);
      expect(page.events[0].source).toBe('server');
    });

    it('agit rétroactivement, et se retire', async () => {
      // Le cœur du choix « à la lecture, pas à l'écriture ». Le drapeau ne peut
      // être posé qu'après qu'un type existe, donc après qu'il a pu être forgé :
      // seule une règle rétroactive referme cette fenêtre.
      const projetDuCas = await nouveauProjet('retroactif');

      await depuisLeServeur('encaissement', '10:00', projetDuCas.secretKey);
      await depuisLeNavigateur(
        'encaissement',
        '11:00',
        'Mozilla/5.0 (avant-le-drapeau)',
        projetDuCas.apiKey,
      ).expect(201);

      expect((await journal(projetDuCas.id)).events).toHaveLength(2);

      const type = await typeNomme(projetDuCas.id, 'encaissement');

      await basculer(projetDuCas.id, type.id, true);
      expect((await journal(projetDuCas.id)).events).toHaveLength(1);

      // Réversible : rien n'a été détruit, donc tout revient.
      await basculer(projetDuCas.id, type.id, false);
      expect((await journal(projetDuCas.id)).events).toHaveLength(2);
    });

    it('n’affecte pas les autres types du projet', async () => {
      const projetDuCas = await nouveauProjet('voisinage');

      // Les deux viennent du navigateur : c'est ce qui rend le test probant.
      // Si le drapeau débordait sur les voisins, `page_view` disparaîtrait avec.
      await depuisLeNavigateur(
        'encaissement',
        '10:00',
        'Mozilla/5.0 (voisin)',
        projetDuCas.apiKey,
      ).expect(201);
      await depuisLeNavigateur(
        'page_view',
        '11:00',
        'Mozilla/5.0 (voisin)',
        projetDuCas.apiKey,
      ).expect(201);

      const type = await typeNomme(projetDuCas.id, 'encaissement');

      await basculer(projetDuCas.id, type.id, true);

      const page = await journal(projetDuCas.id);

      expect(page.events.map((evenement) => evenement.type)).toEqual([
        'page_view',
      ]);
    });
  });
});
