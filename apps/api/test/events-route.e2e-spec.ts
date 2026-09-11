import type { INestApplication } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { eventsPageSchema } from '@events-hub/api-contract';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import {
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
  TEST_ORIGIN,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * `GET /v1/projects/:projectId/events`, éprouvée par sa route.
 *
 * `events.list.e2e-spec.ts` fixe la primitive du Core — l'ordre total, la
 * fenêtre semi-ouverte, les sacs `jsonb` rendus intacts. Ce fichier-ci vérifie
 * ce que la primitive seule ne peut pas montrer : la pagination bout à bout, la
 * liste des facettes, la sérialisation JSON, la validation de la query, le
 * guard — et la **généricité**, qui est la promesse la plus fragile de cette
 * route.
 *
 * ## Le vocabulaire est délibérément absent
 *
 * Les types utilisés ici — `alpha`, `beta`, `facture_payee` — ne sont pas ceux
 * du SDK. C'est le sujet : cette route est la seule du projet qui doive rendre
 * un type que personne n'a prévu, et un test écrit avec le vocabulaire du SDK
 * laisserait croire que la route le connaît. La suite « la généricité » en fait
 * une assertion explicite.
 *
 * Elle remplace la vérification de forme qu'`architecture.spec.ts` n'exerce pas
 * ici : ce fichier vit dans `features/`, que le scan exclut. La garantie est
 * donc portée par le comportement, comme elle l'est pour l'ingestion dans
 * `event-stream.e2e-spec.ts`.
 */

const JOUR = '2026-08-22';
const at = (heure: string) => `${JOUR}T${heure}:00.000Z`;

const FENETRE = {
  from: '2026-08-22T00:00:00.000Z',
  to: '2026-08-23T00:00:00.000Z',
};

/** La taille de page du module. Écrite ici pour que la changer casse le test. */
const PAGE = 20;

interface EventJson {
  sessionId: string;
  sessionStartedAt: string;
  type: string;
  occurredAt: string;
  attributes: Record<string, unknown>;
  properties: Record<string, unknown>;
}

interface EventsPageJson {
  from: string;
  to: string;
  types: string[];
  events: EventJson[];
  nextCursor: string | null;
}

describe('GET /v1/projects/:projectId/events (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projectId: string;
  let apiKey: string;
  let cookies: string[];
  const created: string[] = [];

  const newProject = async (label: string) => {
    const project = await createProject(db, {
      name: `e2e events route ${label} ${new Date().toISOString()}`,
    });

    created.push(project.id);
    return project;
  };

  const ingest = (
    visiteur: string,
    type: string,
    heure: string,
    properties: Record<string, unknown> = {},
    cle: string = apiKey,
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
        properties,
      })
      .expect(201);

  const lire = async (
    query: Record<string, string> = FENETRE,
    project: string = projectId,
  ) => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project}/events`)
      .set('Cookie', cookies)
      .query(query)
      .expect(200);

    expectMatchesContract(response.body, eventsPageSchema);

    return response.body as EventsPageJson;
  };

  /** Le journal entier, page après page, comme un lecteur le parcourrait. */
  const parcourir = async (query: Record<string, string> = FENETRE) => {
    const pages: EventsPageJson[] = [];
    let after: string | null = null;

    do {
      const page: EventsPageJson = await lire(
        after === null ? query : { ...query, after },
      );

      pages.push(page);
      after = page.nextCursor;

      // Garde-fou : une pagination qui n'avance pas boucle sans fin, et le
      // test doit échouer sur son propre invariant plutôt que sur un timeout.
      expect(pages.length).toBeLessThan(10);
    } while (after !== null);

    return pages;
  };

  const horodatages = (page: EventsPageJson) =>
    page.events.map((event) => event.occurredAt);

  beforeAll(async () => {
    app = await createTestApp();

    db = app.get<DrizzleDatabase>(DRIZZLE);

    const reader = await signUp(app);
    cookies = reader.cookies;
    await joinOrganization(db, await organizationId(db), reader.id);

    const principal = await newProject('principal');
    projectId = principal.id;
    apiKey = principal.apiKey;

    // Vingt-cinq événements — soit une page pleine, puis cinq. Deux visiteurs
    // qui s'entrelacent, pour que le fil d'une session ne soit pas simplement
    // une tranche contiguë du journal.
    //
    // Les minutes sont uniques : le test porte sur la pagination, pas sur le
    // départage des ex æquo, qui est l'affaire du Core et de son propre test.
    // Ingérés du plus ancien au plus récent — la route les rendra à l'envers.
    for (let index = 0; index < 25; index += 1) {
      const minute = String(index).padStart(2, '0');

      await ingest(
        index % 2 === 0 ? 'alice' : 'bob',
        index % 5 === 0 ? 'beta' : 'alpha',
        `09:${minute}`,
        { rang: index },
      );
    }
  });

  afterAll(async () => {
    await db.delete(events).where(inArray(events.projectId, created));
    await db.delete(sessions).where(inArray(sessions.projectId, created));
    await db.delete(projects).where(inArray(projects.id, created));
    await app.close();
  });

  describe('la forme de la réponse', () => {
    it('renvoie la fenêtre en écho', async () => {
      const body = await lire();

      expect(body.from).toBe(FENETRE.from);
      expect(body.to).toBe(FENETRE.to);
    });

    it('rend les deux sacs jsonb intacts', async () => {
      const [premier] = (await lire()).events;

      expect(premier.attributes['page.path']).toBe('/');
      // Le dernier ingéré : la route rend le plus récent en tête.
      expect(premier.properties.rang).toBe(24);
    });

    it('ne rend ni alias de visiteur ni identifiant d’événement', async () => {
      // Les deux absences sont le contrat, pas un oubli. L'alias serait
      // incohérent d'une page à l'autre — il est tiré à chaque appel ; l'`id`
      // deviendrait une référence durable que le Core ne promet pas.
      for (const event of (await lire()).events) {
        expect(Object.keys(event).sort()).toEqual([
          'attributes',
          'occurredAt',
          'properties',
          'sessionId',
          'sessionStartedAt',
          'source',
          'type',
        ]);
      }
    });

    it('rend le journal du plus récent au plus ancien', async () => {
      const instants = horodatages(await lire());

      expect(instants).toEqual([...instants].sort().reverse());
      // Le vingt-cinquième et dernier ingéré, donc le premier rendu.
      expect(instants[0]).toBe(at('09:24'));
    });
  });

  describe('la pagination', () => {
    it('rend vingt lignes et un curseur, puis le reste et null', async () => {
      const pages = await parcourir();

      expect(pages).toHaveLength(2);
      expect(pages[0].events).toHaveLength(PAGE);
      expect(pages[0].nextCursor).toEqual(expect.any(String));
      expect(pages[1].events).toHaveLength(5);
      expect(pages[1].nextCursor).toBeNull();
    });

    it('ne saute ni ne répète aucun événement', async () => {
      // C'est la propriété que la pagination doit tenir, et la seule qu'un
      // `offset` perdrait dès qu'un événement s'insère pendant la lecture.
      const instants = (await parcourir()).flatMap(horodatages);

      expect(instants).toHaveLength(25);
      expect(new Set(instants).size).toBe(25);
      expect(instants).toEqual([...instants].sort().reverse());
    });

    it('reprend strictement avant le dernier événement rendu', async () => {
      const premiere = await lire();
      const suivante = await lire({
        ...FENETRE,
        after: premiere.nextCursor as string,
      });

      // La lecture descend dans le temps : la page suivante est plus ancienne.
      const dernier = horodatages(premiere).at(-1) as string;

      expect(horodatages(suivante)).not.toContain(dernier);
      expect(horodatages(suivante)[0] < dernier).toBe(true);
    });

    it('rend un curseur nul quand la fenêtre tient sur une page', async () => {
      const body = await lire({
        from: at('09:00'),
        to: at('09:05'),
      });

      expect(body.events).toHaveLength(5);
      expect(body.nextCursor).toBeNull();
    });

    it('refuse un curseur bricolé', async () => {
      // Un jeton illisible est une requête malformée, pas une fin de journal :
      // le rendre en page vide ferait passer un copier-coller tronqué pour
      // « il n'y a plus rien ».
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/events`)
        .set('Cookie', cookies)
        .query({ ...FENETRE, after: 'pas-un-curseur' })
        .expect(400);
    });
  });

  describe('le filtre par type', () => {
    it('ne rend que les types demandés', async () => {
      const body = await lire({ ...FENETRE, types: 'beta' });

      expect(body.events).toHaveLength(5);
      expect(new Set(body.events.map((event) => event.type))).toEqual(
        new Set(['beta']),
      );
    });

    it('accepte plusieurs types', async () => {
      const body = await lire({ ...FENETRE, types: 'alpha,beta' });

      expect(body.events).toHaveLength(PAGE);
      expect(body.nextCursor).toEqual(expect.any(String));
    });

    it('rend une page vide sur un type que la fenêtre ne contient pas', async () => {
      const body = await lire({ ...FENETRE, types: 'jamais-vu' });

      expect(body.events).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });

    it('pagine à l’intérieur du filtre', async () => {
      const pages = await parcourir({ ...FENETRE, types: 'alpha,beta' });

      expect(pages).toHaveLength(2);
      expect(pages.flatMap(horodatages)).toHaveLength(25);
    });

    it('ne promet pas de suite sur une page exactement pleine', async () => {
      // `alpha` fait vingt événements, soit la taille d'une page. La requête en
      // tire vingt et une pour trancher : il n'y a pas de vingt-et-unième, donc
      // pas de curseur. Sans ce garde, le lecteur demanderait une page suivante
      // vide — visible à l'écran comme un pas de pagination qui ne mène nulle
      // part.
      const pages = await parcourir({ ...FENETRE, types: 'alpha' });

      expect(pages).toHaveLength(1);
      expect(pages[0].events).toHaveLength(PAGE);
      expect(pages[0].nextCursor).toBeNull();
    });
  });

  describe('les facettes', () => {
    it('rend les types présents dans la fenêtre, triés', async () => {
      expect((await lire()).types).toEqual(['alpha', 'beta']);
    });

    it('ne les rétrécit pas quand le filtre se resserre', async () => {
      // Le point de tout ce champ. Les filtrer ferait disparaître du menu le
      // type qu'on vient de décocher, donc interdirait de le recocher.
      expect((await lire({ ...FENETRE, types: 'beta' })).types).toEqual([
        'alpha',
        'beta',
      ]);
    });

    it('les calcule sur la fenêtre, pas sur la page', async () => {
      // La fenêtre courte ne contient que des `alpha` et des `beta` en tête de
      // journal ; la liste doit suivre la fenêtre, pas les vingt lignes rendues.
      expect(
        (await lire({ from: at('09:01'), to: at('09:05') })).types,
      ).toEqual(['alpha']);
    });
  });

  describe('la généricité', () => {
    it('rend un type que personne n’a prévu, et le liste', async () => {
      // Aucune ligne du projet ne connaît `facture_payee`. Il doit traverser
      // l'ingestion, la lecture et les facettes sans que rien ne l'ait déclaré
      // — c'est ce qui distingue cette route des deux routes analytiques, qui
      // ne le verraient pas.
      const projet = await newProject('generique');

      await ingest(
        'carol',
        'facture_payee',
        '10:00',
        { montant: 42 },
        projet.apiKey,
      );

      const body = await lire(FENETRE, projet.id);

      expect(body.types).toEqual(['facture_payee']);
      expect(body.events).toHaveLength(1);
      expect(body.events[0].type).toBe('facture_payee');
      expect(body.events[0].properties.montant).toBe(42);
    });
  });

  describe('le cloisonnement et la validation', () => {
    it('ne voit rien d’un autre projet', async () => {
      const voisin = await newProject('voisin');

      await ingest('alice', 'alpha', '09:00', {}, voisin.apiKey);

      expect((await lire(FENETRE, voisin.id)).events).toHaveLength(1);
      expect((await parcourir()).flatMap(horodatages)).toHaveLength(25);

      await db.delete(events).where(eq(events.projectId, voisin.id));
      await db.delete(sessions).where(eq(sessions.projectId, voisin.id));
    });

    it('applique la fenêtre par défaut quand elle est absente', async () => {
      const body = await lire({});

      const largeur =
        new Date(body.to).getTime() - new Date(body.from).getTime();

      expect(largeur).toBe(7 * 24 * 60 * 60_000);
    });

    it('refuse un paramètre inconnu', async () => {
      // `strictObject`, comme les routes analytiques : un filtre ignoré en
      // silence rend une page qui a l'air d'être la bonne.
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/events`)
        .set('Cookie', cookies)
        .query({ ...FENETRE, limit: '5' })
        .expect(400);
    });

    it('refuse une liste de types contenant une valeur vide', async () => {
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/events`)
        .set('Cookie', cookies)
        .query({ ...FENETRE, types: 'alpha,' })
        .expect(400);
    });

    it('refuse une fenêtre à l’envers', async () => {
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/events`)
        .set('Cookie', cookies)
        .query({ from: FENETRE.to, to: FENETRE.from })
        .expect(400);
    });

    it('répond 401 sans session', async () => {
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/events`)
        .query(FENETRE)
        .expect(401);
    });

    it('répond 404 pour un projet inconnu', async () => {
      await request(app.getHttpServer())
        .get('/v1/projects/00000000-0000-4000-8000-000000000000/events')
        .set('Cookie', cookies)
        .query(FENETRE)
        .expect(404);
    });

    it('répond 404 pour un non-membre', async () => {
      // Indiscernable d'un projet inexistant : une session sans appartenance ne
      // doit pas pouvoir distinguer « pas le droit » de « n'existe pas ».
      const etranger = await signUp(app);

      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/events`)
        .set('Cookie', etranger.cookies)
        .query(FENETRE)
        .expect(404);
    });
  });
});
