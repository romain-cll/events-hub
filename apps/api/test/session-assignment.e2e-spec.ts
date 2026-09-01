import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { asc, eq } from 'drizzle-orm';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import {
  SESSION_GAP_MS,
  SessionAssigner,
} from '../src/sessions/session-assigner.service';
import { createProject } from './fixtures';

/**
 * L'attribution de session à l'ingestion, éprouvée contre un vrai Postgres.
 *
 * Rien de ce que fait `SessionAssigner` n'est observable ailleurs : il lit deux
 * voisins, prend un verrou consultatif, et parfois réécrit des lignes déjà
 * écrites. Un double de Drizzle ne pourrait exercer ni le `least()`, ni le
 * `pg_advisory_xact_lock`, ni la clé étrangère qui protège la fusion.
 *
 * Le service est appelé **directement**, dans une transaction, plutôt qu'à
 * travers la route d'ingestion. Deux raisons :
 *
 * - `occurredAt` doit être choisi à la milliseconde pour encadrer le seuil ;
 * - la clé visiteur doit être choisie elle aussi. Par HTTP, elle est dérivée de
 *   l'IP, du User-Agent **et du jour UTC courant** — donc identique pour tous
 *   les événements d'une même exécution, ce qui rend la rotation quotidienne
 *   inobservable. La poser à la main, c'est exactement simuler cette rotation :
 *   une clé qui change, c'est un visiteur qui change.
 *
 * Le chemin testé est malgré tout le vrai : `EventsService.create` fait
 * littéralement ces deux appels dans cette transaction-là.
 */

const T0 = new Date('2026-08-22T15:00:00.000Z');

/** `T0 + n` millisecondes. */
const apres = (ms: number) => new Date(T0.getTime() + ms);

describe('SessionAssigner (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let assigner: SessionAssigner;
  let projectId: string;

  /**
   * Écrit un événement comme l'ingestion le ferait : attribution puis insertion,
   * dans une seule transaction.
   *
   * L'unicité de la transaction n'est pas un détail de confort — c'est elle qui
   * donne sa portée au verrou. Attribuer dans une transaction et insérer dans
   * une autre rouvrirait la course que le verrou existe pour fermer.
   */
  const poser = (
    visitorKey: string,
    occurredAt: Date,
    repere = '',
    fallbackKey?: string,
  ) =>
    db.transaction(async (tx) => {
      const sessionId = await assigner.assign(tx, {
        projectId,
        visitorKey,
        fallbackKey,
        occurredAt,
      });

      await tx.insert(events).values({
        projectId,
        type: 'alpha',
              source: 'browser',
        occurredAt,
        sessionId,
        attributes: { repere },
      });

      return sessionId;
    });

  /** Les sessions du projet, de la plus ancienne à la plus récente. */
  const enBase = () =>
    db
      .select({ id: sessions.id, startedAt: sessions.startedAt })
      .from(sessions)
      .where(eq(sessions.projectId, projectId))
      .orderBy(asc(sessions.startedAt), asc(sessions.id));

  /** Repère -> session, tel que la base le porte après coup. */
  const rattachements = async () => {
    const rows = await db
      .select({
        sessionId: events.sessionId,
        attributes: events.attributes,
      })
      .from(events)
      .where(eq(events.projectId, projectId));

    return new Map(
      rows.map((row) => [String(row.attributes.repere), row.sessionId]),
    );
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    db = app.get<DrizzleDatabase>(DRIZZLE);
    assigner = app.get(SessionAssigner);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Un projet neuf par test : l'attribution lit tout l'historique du visiteur,
    // donc un fixture partagé ferait dépendre chaque test des précédents.
    const project = await createProject(db, {
      name: `e2e assignation ${new Date().toISOString()}`,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(sessions).where(eq(sessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  describe('le seuil', () => {
    it('trente minutes pile restent la même session', async () => {
      const premier = await poser('v', T0);
      const second = await poser('v', apres(SESSION_GAP_MS));

      // Inférieur **ou égal**. La borne est du côté de la continuité : à
      // l'inverse exact du découpage à la lecture qu'on avait avant.
      expect(second).toBe(premier);
      expect(await enBase()).toHaveLength(1);
    });

    it('une milliseconde de plus ouvre une session neuve', async () => {
      const premier = await poser('v', T0);
      const second = await poser('v', apres(SESSION_GAP_MS + 1));

      expect(second).not.toBe(premier);
      expect(await enBase()).toHaveLength(2);
    });

    it('l’écart se mesure au voisin, pas au début de la session', async () => {
      // Trois événements de vingt minutes en vingt minutes : quarante minutes
      // séparent le premier du dernier, et pourtant c'est une seule session.
      // Une session n'a pas de durée maximale, seulement une inactivité
      // maximale.
      const premier = await poser('v', T0);
      const deuxieme = await poser('v', apres(20 * 60_000));
      const troisieme = await poser('v', apres(40 * 60_000));

      expect(deuxieme).toBe(premier);
      expect(troisieme).toBe(premier);
      expect(await enBase()).toHaveLength(1);
    });

    it('deux événements au même instant tombent dans la même session', async () => {
      const premier = await poser('v', T0);
      const second = await poser('v', T0);

      expect(second).toBe(premier);
    });
  });

  describe('le cloisonnement', () => {
    it('deux clés visiteur ne partagent jamais une session', async () => {
      const alice = await poser('alice', T0);
      const bob = await poser('bob', T0);

      expect(bob).not.toBe(alice);
      expect(await enBase()).toHaveLength(2);
    });

    it('une clé qui change, sans repli, coupe la session', async () => {
      // Une clé qui change, c'est un visiteur qui change du point de vue du
      // Core — il ne peut pas savoir que c'est la même personne. C'est le
      // comportement nu de l'assigneur, et c'est bien celui qu'on veut : deux
      // visiteurs distincts ne partagent jamais rien.
      //
      // Ce n'est **pas** ce qui se passe à minuit sur le chemin réel : là,
      // l'ingestion pose un `fallbackKey`. Voir « le tampon de minuit ».
      const veille = await poser('cle-du-21', T0);
      const lendemain = await poser('cle-du-22', apres(2 * 60_000));

      expect(lendemain).not.toBe(veille);
    });

    it('un autre projet n’influence pas l’attribution', async () => {
      const autre = await createProject(db, {
        name: `e2e assignation voisin ${new Date().toISOString()}`,
      });

      const chezNous = await poser('v', T0);

      // Même clé visiteur, même instant, autre projet : le voisin ne doit pas
      // être vu. C'est la même frontière que partout ailleurs dans le Core.
      const [sessionVoisine] = await db
        .insert(sessions)
        .values({ projectId: autre.id, visitorKey: 'v', startedAt: T0 })
        .returning({ id: sessions.id });
      await db.insert(events).values({
        projectId: autre.id,
        type: 'alpha',
              source: 'browser',
        occurredAt: apres(60_000),
        sessionId: sessionVoisine.id,
      });

      const suivant = await poser('v', apres(2 * 60_000));

      expect(suivant).toBe(chezNous);
      expect(await enBase()).toHaveLength(1);

      await db.delete(events).where(eq(events.projectId, autre.id));
      await db.delete(sessions).where(eq(sessions.projectId, autre.id));
      await db.delete(projects).where(eq(projects.id, autre.id));
    });
  });

  /**
   * Le tampon de minuit : le seul endroit où l'assigneur cherche son voisin
   * sous **deux** clés.
   *
   * Ce que la clé de repli achète, c'est qu'une navigation de 23 h 58 à 00 h 02
   * reste une visite. Ce qu'elle n'achète pas, c'est le droit de recoller
   * n'importe quoi : le seuil d'inactivité s'applique aux deux clés de la même
   * façon, et c'est le deuxième test qui le dit.
   */
  describe('le tampon de minuit', () => {
    it('la clé de repli recolle la session que la rotation aurait coupée', async () => {
      const avantMinuit = await poser('cle-du-21', T0, 'veille');

      // Après minuit : la clé du jour a changé, mais l'ingestion passe celle
      // d'il y a trente minutes en repli. Le voisin redevient visible.
      const apresMinuit = await poser(
        'cle-du-22',
        apres(2 * 60_000),
        'lendemain',
        'cle-du-21',
      );

      expect(apresMinuit).toBe(avantMinuit);
      expect(await enBase()).toHaveLength(1);
    });

    it('le repli ne dispense pas du seuil d’inactivité', async () => {
      // Quarante minutes : le voisin est retrouvé sous la clé de la veille, et
      // écarté quand même. Sans quoi le tampon rendrait la session immortelle
      // pour qui traverse minuit — une session neuve à 00 h 40 en est bien une.
      const veille = await poser('cle-du-21', T0, 'veille');
      const tropTard = await poser(
        'cle-du-22',
        apres(40 * 60_000),
        'trop-tard',
        'cle-du-21',
      );

      expect(tropTard).not.toBe(veille);
      expect(await enBase()).toHaveLength(2);
    });

    it('la session recollée garde la clé de la veille', async () => {
      await poser('cle-du-21', T0, 'veille');
      await poser('cle-du-22', apres(2 * 60_000), 'lendemain', 'cle-du-21');

      // La conséquence qui compte pour `countVisitors` : une session ne porte
      // qu'une clé, donc le visiteur n'est pas compté deux fois sur la fenêtre
      // qui contient les deux événements.
      const [session] = await db
        .select({ visitorKey: sessions.visitorKey })
        .from(sessions)
        .where(eq(sessions.projectId, projectId));

      expect(session.visitorKey).toBe('cle-du-21');
    });
  });

  describe('les événements en retard', () => {
    it('rejoint la session de son voisin d’après', async () => {
      // Le cas que « comparer au dernier inséré » rate complètement : un envoi
      // parti en `keepalive` pendant que la page se décharge arrive après des
      // événements qui lui sont postérieurs.
      const tardif = await poser('v', apres(60 * 60_000), 'tardif');
      const retard = await poser('v', apres(59 * 60_000), 'retard');

      expect(retard).toBe(tardif);
      expect(await enBase()).toHaveLength(1);
    });

    it('fait reculer le début de la session qu’il rejoint', async () => {
      await poser('v', apres(10 * 60_000));
      await poser('v', T0);

      const [session] = await enBase();

      // `started_at` n'est pas la date de création de la ligne : c'est le plus
      // ancien événement connu, et un retard peut donc l'avancer.
      expect(session.startedAt).toEqual(T0);
    });

    it('ne fait pas avancer le début quand il arrive après', async () => {
      // Le pendant du test précédent, et il est nécessaire : sans lui, écrire
      // `started_at = occurredAt` au lieu de `least(...)` passerait, parce que
      // tous les cas éprouvés jusque-là voient arriver un événement plus ancien.
      await poser('v', T0);
      await poser('v', apres(10 * 60_000));

      const [session] = await enBase();

      expect(session.startedAt).toEqual(T0);
    });

    it('ouvre une session neuve s’il est loin des deux voisins', async () => {
      await poser('v', T0, 'a');
      await poser('v', apres(4 * 60 * 60_000), 'c');
      await poser('v', apres(2 * 60 * 60_000), 'b');

      const attaches = await rattachements();

      expect(await enBase()).toHaveLength(3);
      expect(attaches.get('b')).not.toBe(attaches.get('a'));
      expect(attaches.get('b')).not.toBe(attaches.get('c'));
    });

    it('l’ordre d’arrivée ne change pas le découpage obtenu', async () => {
      // La même suite, écrite à l'envers : c'est la propriété qui justifie la
      // recherche de voisins plutôt que le « dernier inséré ».
      await poser('v', apres(40 * 60_000), 'd');
      await poser('v', apres(20 * 60_000), 'c');
      await poser('v', apres(10 * 60_000), 'b');
      await poser('v', T0, 'a');

      const attaches = await rattachements();

      expect(new Set(attaches.values()).size).toBe(1);
      expect(await enBase()).toHaveLength(1);
    });
  });

  describe('la fusion', () => {
    it('recolle deux sessions qu’un événement vient ponter', async () => {
      // 15:00 et 15:50 : cinquante minutes d'écart, donc deux sessions. Puis un
      // événement à 15:25 arrive — il est à vingt-cinq minutes des deux, ce qui
      // démontre qu'elles n'auraient jamais dû en faire deux.
      const debut = await poser('v', T0, 'a');
      const fin = await poser('v', apres(50 * 60_000), 'c');
      expect(fin).not.toBe(debut);

      const pont = await poser('v', apres(25 * 60_000), 'b');

      const restantes = await enBase();
      const attaches = await rattachements();

      expect(restantes).toHaveLength(1);
      expect(new Set(attaches.values())).toEqual(new Set([pont]));
      // La survivante est la plus ancienne : un choix arbitraire, mais
      // déterministe, et le seul qui garde `started_at` juste sans recalcul.
      expect(pont).toBe(debut);
      expect(restantes[0].startedAt).toEqual(T0);
    });

    it('ne laisse aucun événement rattaché à la session absorbée', async () => {
      await poser('v', T0, 'a');
      await poser('v', apres(5 * 60_000), 'a2');
      await poser('v', apres(50 * 60_000), 'c');
      await poser('v', apres(45 * 60_000), 'c2');

      await poser('v', apres(25 * 60_000), 'b');

      const attaches = await rattachements();

      // Les cinq événements, des deux côtés du pont, sur une seule session.
      // C'est la clé étrangère qui l'aurait dit sinon : supprimer une session
      // qui porte encore des événements échoue.
      expect(attaches.size).toBe(5);
      expect(new Set(attaches.values()).size).toBe(1);
      expect(await enBase()).toHaveLength(1);
    });

    it('ne fusionne pas au-delà des deux sessions pontées', async () => {
      // Une troisième session, trop loin pour être concernée. La fusion ne peut
      // pas cascader — les deux voisins sont uniques, et recoller ne déplace
      // aucun `occurredAt`.
      await poser('v', T0, 'a');
      await poser('v', apres(50 * 60_000), 'c');
      await poser('v', apres(10 * 60 * 60_000), 'loin');

      await poser('v', apres(25 * 60_000), 'b');

      const attaches = await rattachements();

      expect(await enBase()).toHaveLength(2);
      expect(attaches.get('loin')).not.toBe(attaches.get('a'));
      expect(attaches.get('a')).toBe(attaches.get('c'));
    });

    it('n’essaie pas de fusionner une session avec elle-même', async () => {
      // Les deux voisins sont assez proches, mais c'est déjà la même session :
      // il n'y a rien à recoller, seulement une borne à tenir à jour.
      await poser('v', T0, 'a');
      await poser('v', apres(20 * 60_000), 'c');

      const milieu = await poser('v', apres(10 * 60_000), 'b');

      const attaches = await rattachements();

      expect(await enBase()).toHaveLength(1);
      expect(new Set(attaches.values())).toEqual(new Set([milieu]));
    });
  });

  describe('la concurrence', () => {
    it('n’ouvre qu’une session pour une salve simultanée', async () => {
      // Huit onglets qui postent en même temps. Sans le verrou consultatif, ils
      // liraient tous « aucun voisin » et ouvriraient tous une session : le
      // visiteur en aurait huit au lieu d'une.
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => poser('v', T0, `p${i}`)),
      );

      expect(await enBase()).toHaveLength(1);
      expect((await rattachements()).size).toBe(8);
    });

    it('sérialise par visiteur, pas globalement', async () => {
      // Trois visiteurs en parallèle : chacun sa session, et aucun n'a attendu
      // les autres — le verrou porte sur `(projet, clé)`.
      await Promise.all(
        ['alice', 'bob', 'carol'].flatMap((qui) => [
          poser(qui, T0, `${qui}-1`),
          poser(qui, apres(60_000), `${qui}-2`),
        ]),
      );

      const attaches = await rattachements();

      expect(await enBase()).toHaveLength(3);
      expect(attaches.get('alice-1')).toBe(attaches.get('alice-2'));
      expect(attaches.get('alice-1')).not.toBe(attaches.get('bob-1'));
    });

    it('deux salves concurrentes de part et d’autre du seuil restent séparées', async () => {
      await Promise.all([
        poser('v', T0, 'a'),
        poser('v', apres(SESSION_GAP_MS * 2), 'b'),
      ]);

      // Quel que soit l'ordre dans lequel le verrou les a laissées passer, le
      // résultat est le même : l'attribution ne dépend que des `occurredAt`.
      const attaches = await rattachements();

      expect(await enBase()).toHaveLength(2);
      expect(attaches.get('a')).not.toBe(attaches.get('b'));
    });
  });
});
