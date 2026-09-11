import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import { EventStore } from '../src/events/event-store.service';
import { sessionsOf, type Session } from '../src/features/analytics/sessions';
import { createProject, TEST_ORIGIN } from './fixtures';
import { createTestApp } from './harness';

/**
 * Les sessions, éprouvées de bout en bout.
 *
 * `sessions.spec.ts` fixe la *lecture* sur des journaux écrits à la main ; ce
 * fichier vérifie l'autre moitié — que la chaîne entière produit bien ça sur de
 * vrais événements :
 *
 *     ingestion → session_id persisté → events() → mesures
 *
 * Ce que le test unitaire ne pouvait pas voir, et qui se joue ici : l'ordre. La
 * lecture *suppose* un journal chronologique ; c'est `events()` qui le garantit,
 * et il n'y a qu'en écrivant dans le désordre contre un vrai Postgres qu'on
 * vérifie que la supposition tient. Le fixture est donc entrelacé et écrit hors
 * ordre à dessein — ce qui éprouve du même coup la recherche de voisins de
 * `SessionAssigner`, puisque chaque événement arrive à côté d'événements déjà
 * écrits qui lui sont postérieurs.
 *
 * Aucune route n'est appelée. `GET /analytics/sessions` existe et rend
 * désormais ces sessions-là, mais elle en fait une **forme de sortie** — des
 * champs choisis, sérialisés en JSON — et c'est son contrat, éprouvé dans
 * `sessions-route.e2e-spec.ts`. Ce qui se vérifie ici est en amont : que le
 * repli lui-même est juste sur de vrais événements, `durationMs` compris, que
 * la route ne publie pas.
 *
 * On passe donc par les primitives, dans l'ordre exact où le service les
 * enchaîne — `events()` puis `sessionsOf`. Si ce fichier et la route
 * divergeaient un jour, ce serait que le service a cessé de faire ce qu'il dit
 * faire.
 */

const JOUR = '2026-08-22';
const at = (heure: string) => `${JOUR}T${heure}:00.000Z`;

const MINUTE = 60_000;

const FENETRE = {
  from: new Date('2026-08-22T00:00:00.000Z'),
  to: new Date('2026-08-23T00:00:00.000Z'),
};

describe('AnalyticsService.sessions (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let store: EventStore;
  let projectId: string;
  let apiKey: string;

  /** La chaîne du service, sans le service : journal → sessions. */
  const mesurer = async (fenetre: {
    from: Date;
    to: Date;
  }): Promise<Session[]> =>
    sessionsOf(await store.events({ projectId, ...fenetre }));

  /**
   * Les totaux que le lecteur refait lui-même depuis les lignes.
   *
   * Ils vivaient dans un module d'agrégation jusqu'à l'étape 33 ; ils sont
   * désormais le travail de qui affiche. Les écrire ici plutôt que de les
   * importer est donc le bon niveau de fidélité — ce sont exactement les lignes
   * que le dashboard écrira.
   */
  const totaux = (lot: readonly Session[]) => ({
    sessions: lot.length,
    withPageView: lot.filter((s) => s.pageViews > 0).length,
    withoutPageView: lot.filter((s) => s.pageViews === 0).length,
    durationMs: lot.reduce((somme, s) => somme + s.durationMs, 0),
    activeMs: lot.reduce((somme, s) => somme + s.activeMs, 0),
    pageViews: lot.reduce((somme, s) => somme + s.pageViews, 0),
    withOpenPresence: lot.filter((s) => s.presencesStillOpen > 0).length,
  });

  /** `heure` est une heure du jour, ou un instant ISO complet. */
  const ingest = (visiteur: string, type: string, heure: string) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', visiteur)
      .send({
        apiKey,
        type,
        occurredAt: heure.includes('T') ? heure : at(heure),
        attributes: { 'page.path': '/' },
        properties:
          type === 'page_leave' ? { 'leave.reason': 'page_hidden' } : {},
      })
      .expect(201);

  beforeAll(async () => {
    app = await createTestApp();

    db = app.get<DrizzleDatabase>(DRIZZLE);
    store = app.get(EventStore);

    const project = await createProject(db, {
      name: `e2e sessions ${new Date().toISOString()}`,
    });
    projectId = project.id;
    apiKey = project.apiKey;

    // Écrits dans un ordre qui n'est pas le leur, et entrelacés : si quoi que
    // ce soit dans la chaîne dépendait de l'ordre d'insertion plutôt que de
    // `occurredAt`, le découpage serait faux.
    //
    // Tous les événements d'un même visiteur tiennent dans trente minutes de
    // proche en proche, donc **une session par visiteur** — la présence, elle,
    // s'ouvre et se referme plusieurs fois à l'intérieur.
    //
    // `alice`  10:00 vue, 10:02 vue, 10:04 vue, 10:05 sortie → présence 5 min
    //          10:10 vue, 10:13 sortie                        → présence 3 min
    //          → 1 session, 13 min d'étendue, 8 min actives, 4 pages
    // `bob`    10:01 vue, 10:03 clic, 10:04 sortie            → présence 3 min
    //          10:30 vue, jamais fermée                       → présence béante
    //          → 1 session, 29 min d'étendue, 3 min actives, 2 pages
    // `carol`  un clic, rien d'autre
    //          → 1 session sans page vue, ni étendue ni temps actif
    await ingest('bob', 'page_leave', '10:04');
    await ingest('alice', 'page_view', '10:04');
    await ingest('alice', 'page_leave', '10:13');
    await ingest('bob', 'page_view', '10:30');
    await ingest('alice', 'page_view', '10:00');
    await ingest('carol', 'click', '10:15');
    await ingest('bob', 'click', '10:03');
    await ingest('alice', 'page_leave', '10:05');
    await ingest('bob', 'page_view', '10:01');
    await ingest('alice', 'page_view', '10:10');
    await ingest('alice', 'page_view', '10:02');

    // Pile sur la borne haute, donc exclu par `EventStore` avant que la règle
    // le voie. S'il entrait, alice aurait une session ouverte de plus.
    await ingest('alice', 'page_view', FENETRE.to.toISOString());
  });

  afterAll(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(sessions).where(eq(sessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await app.close();
  });

  it('rend une session par visiteur, malgré un ordre d’écriture quelconque', async () => {
    const sessions = await mesurer(FENETRE);

    // Les sessions sortent dans l'ordre où elles se sont ouvertes, visiteurs
    // entrelacés — exactement comme le journal les a livrées.
    expect(
      sessions.map((s) => [
        s.startedAt.toISOString(),
        s.endedAt.toISOString(),
        s.durationMs,
        s.activeMs,
        s.pageViews,
      ]),
    ).toEqual([
      [at('10:00'), at('10:13'), 13 * MINUTE, 8 * MINUTE, 4],
      [at('10:01'), at('10:30'), 29 * MINUTE, 3 * MINUTE, 2],
      [at('10:15'), at('10:15'), 0, 0, 0],
    ]);
  });

  it('ne coupe pas la session quand la présence, elle, se ferme', async () => {
    const [alice] = await mesurer(FENETRE);

    // C'est tout l'objet de l'étape 25.5 : la sortie de 10:05 ferme une
    // présence, pas la session. Deux présences de 5 et 3 minutes à l'intérieur
    // d'une même session de treize.
    expect(alice.activeMs).toBe(8 * MINUTE);
    expect(alice.durationMs).toBe(13 * MINUTE);
    // Les cinq minutes d'écart entre les deux présences sont dans l'étendue et
    // pas dans le temps actif : c'est la distinction qui rend les deux utiles.
    expect(alice.durationMs - alice.activeMs).toBe(5 * MINUTE);
  });

  it('recolle les vues successives sans ouvrir de présence de plus', async () => {
    const [alice] = await mesurer(FENETRE);

    // Trois `page_view` d'alice avant sa sortie, plus celui de 10:10 : quatre
    // pages, et pourtant une seule présence jusqu'à 10:05. Naviguer dans le
    // site, c'est rester — sinon `activeMs` compterait moins que 5 minutes sur
    // la première.
    expect(alice.pageViews).toBe(4);
    expect(alice.activeMs).toBe(8 * MINUTE);
  });

  it('ne laisse pas le clic d’un visiteur toucher la session d’un autre', async () => {
    const [alice, bob] = await mesurer(FENETRE);

    // Le clic de bob à 10:03 tombe au milieu des deux sessions. Il n'en coupe
    // aucune, et la sortie de bob à 10:04 ne ferme pas la présence d'alice.
    expect(alice.sessionId).not.toBe(bob.sessionId);
    expect(alice.activeMs).toBe(8 * MINUTE);
    expect(bob.activeMs).toBe(3 * MINUTE);
  });

  it('rend une session pour un visiteur qui n’a jamais vu de page', async () => {
    const carol = (await mesurer(FENETRE))[2];

    // Carol a cliqué sans qu'aucun `page_view` n'accompagne le clic. Le Core lui
    // a quand même ouvert une session — il ne sait pas ce qu'est une vue de
    // page —, et la lecture la rend telle quelle plutôt que de la masquer.
    expect(carol).toMatchObject({
      pageViews: 0,
      activeMs: 0,
      durationMs: 0,
    });
  });

  it('partitionne les sessions selon qu’elles ont vu une page', async () => {
    const resume = totaux(await mesurer(FENETRE));

    expect(resume.withPageView).toBe(2);
    expect(resume.withoutPageView).toBe(1);
    expect(resume.withPageView + resume.withoutPageView).toBe(resume.sessions);
  });

  it('somme le temps actif et les pages, et signale ce qui manque', async () => {
    const resume = totaux(await mesurer(FENETRE));

    expect(resume.activeMs).toBe(11 * MINUTE);
    expect(resume.pageViews).toBe(6);
    // La vue de bob à 10:30 n'a jamais été suivie d'une sortie : son temps
    // n'est pas inventé, il est compté comme manquant.
    expect(resume.withOpenPresence).toBe(1);
  });

  it('somme les étendues séparément du temps actif', async () => {
    const resume = totaux(await mesurer(FENETRE));

    // 13 + 29 + 0 d'étendue, 8 + 3 + 0 d'actif. Les deux totaux ne se déduisent
    // pas l'un de l'autre : entre eux, il y a l'arrière-plan et les présences
    // dont on n'a pas vu la fin.
    expect(resume.durationMs).toBe(42 * MINUTE);
    expect(resume.activeMs).toBe(11 * MINUTE);
  });

  it('rend le vrai début d’une session que la fenêtre a tronquée', async () => {
    // Le cœur de l'étape 27. La session d'alice court de 10:00 à 10:13 ; cette
    // fenêtre commence à 10:06, donc elle n'en montre que la fin.
    const from = new Date(at('10:06'));
    const [alice] = await mesurer({ from, to: new Date(at('10:20')) });

    // `startedAt` porte 10:00 — la colonne du Core, pas le bord de la fenêtre.
    // Sans ça, cette session serait indiscernable d'une session réellement
    // ouverte à 10:10, et c'est exactement la confusion qu'on voulait fermer.
    expect(alice.startedAt).toEqual(new Date(at('10:00')));
    expect(alice.startedAt.getTime()).toBeLessThan(from.getTime());

    // L'étendue part donc du vrai début : treize minutes, dont trois seulement
    // observées. Ce n'est pas une extrapolation — mais c'est ce qui interdit de
    // sommer deux fenêtres consécutives.
    expect(alice.endedAt).toEqual(new Date(at('10:13')));
    expect(alice.durationMs).toBe(13 * MINUTE);
    expect(alice.activeMs).toBe(3 * MINUTE);
  });

  it('n’a jamais vu l’événement posé exactement sur la borne haute', async () => {
    expect(await mesurer(FENETRE)).toHaveLength(3);

    const elargie = await mesurer({
      from: FENETRE.from,
      to: new Date('2026-08-23T00:00:01.000Z'),
    });

    // La même lecture, la borne décalée d'une seconde : l'événement entre, et
    // une session de plus apparaît — il est à des heures de tout le reste, donc
    // le Core lui en avait bien ouvert une à l'ingestion. C'est la fenêtre qui
    // décide de ce qu'on voit, pas la lecture.
    expect(elargie).toHaveLength(4);
    expect(elargie.at(-1)?.startedAt).toEqual(FENETRE.to);
    expect(totaux(elargie).withOpenPresence).toBe(2);
  });

  it('tronque une session à cheval sur la fenêtre plutôt que de l’étendre', async () => {
    const [alice] = await mesurer({
      from: FENETRE.from,
      to: new Date(at('10:06')),
    });

    // La session d'alice court jusqu'à 10:13, mais la fenêtre s'arrête à 10:06.
    // On rend ce qu'on voit, sans aller chercher au-delà : `totalActiveMs`
    // n'est donc pas additif d'une fenêtre à l'autre, et le README le dit.
    expect(alice.endedAt).toEqual(new Date(at('10:05')));
    expect(alice.activeMs).toBe(5 * MINUTE);
    expect(alice.pageViews).toBe(3);
  });

  it('ne rend aucune session sur une fenêtre sans événement', async () => {
    expect(
      await mesurer({
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-02T00:00:00.000Z'),
      }),
    ).toEqual([]);
  });
});
