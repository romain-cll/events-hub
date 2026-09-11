import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import {
  events,
  projects,
  sessions,
  stripeWebhookEvents,
} from '../src/database/schema';
import { EventStore } from '../src/events/event-store.service';
import {
  RetentionService,
  SESSION_BATCH,
} from '../src/retention/retention.service';
import { createProject, type TestProject } from './fixtures';

/**
 * La purge à vingt-cinq mois, contre un vrai Postgres.
 *
 * Rien de ce que fait `RetentionService` n'est observable autrement. Un double
 * de Drizzle ne pourrait exercer ni le `NOT EXISTS` corrélé, ni le `RESTRICT`
 * qui refuse de laisser partir une session encore pointée, ni le verrou
 * consultatif qui vit sur une connexion. Ce qu'un test unitaire couvre ici se
 * limite aux deux portes d'entrée — voir `src/retention/retention.service.spec.ts`.
 *
 * ⚠️ **`purge()` est globale : elle ne connaît aucun projet.** C'est délibéré —
 * cloisonner ouvrirait la possibilité qu'un projet y échappe — mais ça veut dire
 * que cette suite **emporte les fixtures de toutes les autres** dès qu'elles
 * sont datées à plus de vingt-cinq mois. Aucune ne l'est aujourd'hui (vérifié :
 * toutes les dates en dur de `test/` et `src/` sont en 2026-2027). C'est une
 * contrainte permanente sur les suites à venir, pas une observation ponctuelle.
 *
 * ## Le cron ne tourne jamais ici
 *
 * `purge()` est appelée explicitement. Passer par `@Cron` demanderait de
 * falsifier l'horloge, et le planificateur ne dit rien de ce qu'on veut
 * éprouver — c'est le SQL qui est en jeu, pas la date de déclenchement.
 */

/**
 * Le 15 du mois, `n` mois avant le mois courant.
 *
 * Une date **relative**, et c'est obligatoire : la borne est calculée par
 * Postgres depuis `now()`, donc une date en dur sortirait de la fenêtre au fil
 * des mois et la suite deviendrait fausse sans que rien ne change dans le code.
 *
 * Le 15 plutôt que le 1er ou le 31 : les fixtures sont ainsi à un demi-mois de
 * toute borne, quel que soit le jour où la suite tourne. `Date.UTC` absorbe les
 * mois négatifs, donc aucun débordement de fin de mois à craindre.
 */
const moisAvant = (n: number): Date => {
  const maintenant = new Date();

  return new Date(
    Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - n, 15, 12),
  );
};

/** Au-delà de la borne : à purger. */
const EXPIRE = moisAvant(26);

/** En deçà de la borne, mais vieux : à garder. */
const GARDE = moisAvant(24);

/** Hier ou presque. */
const RECENT = moisAvant(1);

describe('purge à 25 mois (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let retention: RetentionService;
  let store: EventStore;

  let projet: TestProject;
  let autreProjet: TestProject;
  const crees: string[] = [];

  /** Les identifiants posés en `beforeAll`, relus par les cas. */
  let visiteExpiree: string;
  let visiteACheval: string;
  let visiteAutreProjet: string;
  let sansVisiteAncienIdentifie: string;
  let sansVisiteRecentIdentifie: string;
  let sansVisiteAncienAnonyme: string;
  let sansVisiteRecentAnonyme: string;
  const traceWebhook = `evt_e2e_retention_${Date.now()}`;

  const nouveauProjet = async (label: string) => {
    const project = await createProject(db, {
      name: `e2e rétention ${label} ${new Date().toISOString()}`,
    });

    crees.push(project.id);

    return project;
  };

  /** Ouvre une visite et lui accroche des événements, aux instants donnés. */
  const poserVisite = async (
    projectId: string,
    startedAt: Date,
    instants: Date[],
  ): Promise<string> => {
    const [session] = await db
      .insert(sessions)
      .values({ projectId, visitorKey: `vk-${startedAt.getTime()}`, startedAt })
      .returning({ id: sessions.id });

    await db.insert(events).values(
      instants.map((occurredAt) => ({
        projectId,
        type: 'jalon',
        source: 'browser' as const,
        occurredAt,
        sessionId: session.id,
      })),
    );

    return session.id;
  };

  /** Un événement **sans visite** — une ligne rapportée par un serveur. */
  const poserSansVisite = async (
    projectId: string,
    occurredAt: Date,
    visitorKey: string | null,
  ): Promise<string> => {
    const [event] = await db
      .insert(events)
      .values({
        projectId,
        type: 'encaissement',
        source: 'server' as const,
        occurredAt,
        visitorKey,
        properties: { montant: 4200 },
      })
      .returning({ id: events.id });

    return event.id;
  };

  const visitesDe = (projectId: string) =>
    db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.projectId, projectId));

  const evenementsDe = (sessionId: string) =>
    db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.sessionId, sessionId));

  const relire = async (id: string) => {
    const [row] = await db.select().from(events).where(eq(events.id, id));

    return row;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    db = app.get<DrizzleDatabase>(DRIZZLE);
    retention = app.get(RetentionService);
    store = app.get(EventStore);

    projet = await nouveauProjet('principal');
    autreProjet = await nouveauProjet('second');

    visiteExpiree = await poserVisite(projet.id, EXPIRE, [EXPIRE, EXPIRE]);

    // Celle qui justifie tout le module : commencée hors borne, encore vivante
    // aujourd'hui. Une session consentie ne meurt pas à minuit — sa clé ne
    // tourne pas — et son `started_at` peut même reculer sur un événement en
    // retard. La supprimer par sa date de début violerait le `RESTRICT`.
    visiteACheval = await poserVisite(projet.id, EXPIRE, [EXPIRE, RECENT]);

    visiteAutreProjet = await poserVisite(autreProjet.id, EXPIRE, [EXPIRE]);

    sansVisiteAncienIdentifie = await poserSansVisite(
      projet.id,
      EXPIRE,
      'vk-durable-ancien',
    );
    sansVisiteRecentIdentifie = await poserSansVisite(
      projet.id,
      GARDE,
      'vk-durable-recent',
    );
    sansVisiteAncienAnonyme = await poserSansVisite(projet.id, EXPIRE, null);
    sansVisiteRecentAnonyme = await poserSansVisite(projet.id, RECENT, null);

    await db.insert(stripeWebhookEvents).values({
      eventId: traceWebhook,
      projectId: projet.id,
      customerId: 'cus_e2e_retention',
      writtenEventId: sansVisiteAncienIdentifie,
    });

    // Une fois, ici : les six premiers cas décrivent l'état que **cette**
    // exécution laisse derrière elle. Purger dans chaque cas ferait dépendre le
    // résultat de l'ordre des `it`, et masquerait un travail fait deux fois.
    await retention.purge();
  });

  afterAll(async () => {
    if (crees.length > 0) {
      await db
        .delete(stripeWebhookEvents)
        .where(inArray(stripeWebhookEvents.projectId, crees));
      await db.delete(events).where(inArray(events.projectId, crees));
      await db.delete(sessions).where(inArray(sessions.projectId, crees));
      await db.delete(projects).where(inArray(projects.id, crees));
    }

    await app.close();
  });

  it('emporte la visite expirée et tous ses événements', async () => {
    expect(await evenementsDe(visiteExpiree)).toEqual([]);
    expect(
      await db.select().from(sessions).where(eq(sessions.id, visiteExpiree)),
    ).toEqual([]);
  });

  it('laisse la visite à cheval, sans violer la clé étrangère', async () => {
    // Le `beforeAll` aurait échoué sur un 23503 : c'est ce cas-là, et lui seul,
    // qui départage le `NOT EXISTS` de l'implémentation naïve — celle-ci passe
    // tous les autres.
    expect(
      await db.select().from(sessions).where(eq(sessions.id, visiteACheval)),
    ).toHaveLength(1);
    expect(await evenementsDe(visiteACheval)).toHaveLength(2);
  });

  it('ne laisse aucune visite sans événement derrière elle', async () => {
    const orphelines = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          inArray(sessions.projectId, crees),
          sql`not exists (select 1 from ${events} where ${eq(
            events.sessionId,
            sessions.id,
          )})`,
        ),
      );

    expect(orphelines).toEqual([]);
  });

  it('anonymise l’événement sans visite au-delà de la borne, sans le détruire', async () => {
    const ligne = await relire(sansVisiteAncienIdentifie);

    // La promesse du lot, et celle qui se perdrait le plus silencieusement : un
    // `delete` à la place de l'`update` passerait tous les autres cas.
    expect(ligne).toBeDefined();
    expect(ligne.visitorKey).toBeNull();
    expect(ligne.type).toBe('encaissement');
    expect(ligne.occurredAt).toEqual(EXPIRE);
    expect(ligne.properties).toEqual({ montant: 4200 });
  });

  it('laisse sa clé à l’événement sans visite en deçà de la borne', async () => {
    const ligne = await relire(sansVisiteRecentIdentifie);

    expect(ligne.visitorKey).toBe('vk-durable-recent');
  });

  it('ne touche pas à la trace des webhooks', async () => {
    // `stripe_webhook_events.written_event_id` est en `cascade` : si la passe B
    // avait supprimé la ligne au lieu de l'anonymiser, cette trace serait partie
    // avec elle, et la déduplication des rejeux avec.
    const [trace] = await db
      .select()
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.eventId, traceWebhook));

    expect(trace).toBeDefined();
    expect(trace.writtenEventId).toBe(sansVisiteAncienIdentifie);
  });

  it('interdit à l’attribution rétroactive de ré-identifier au-delà de la borne', async () => {
    // Sans la borne dans `EventStore.attribute`, la purge et le rattrapage
    // rétroactif se contrediraient : la première paire client apprise après coup
    // ré-identifierait un paiement de vingt-six mois.
    expect(await store.attribute([sansVisiteAncienAnonyme], 'vk-tardif')).toBe(
      0,
    );
    expect((await relire(sansVisiteAncienAnonyme)).visitorKey).toBeNull();

    // Le témoin : la même écriture, en deçà de la borne, passe toujours. Sans
    // lui, un `attribute` cassé pour une tout autre raison rendrait ce cas vert.
    expect(await store.attribute([sansVisiteRecentAnonyme], 'vk-tardif')).toBe(
      1,
    );
    expect((await relire(sansVisiteRecentAnonyme)).visitorKey).toBe(
      'vk-tardif',
    );
  });

  it('balaie tous les projets, sans cloisonnement', async () => {
    expect(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, visiteAutreProjet)),
    ).toEqual([]);
    expect(await visitesDe(autreProjet.id)).toEqual([]);
  });

  it('est idempotente : la seconde passe ne trouve plus rien', async () => {
    await poserVisite(projet.id, EXPIRE, [EXPIRE]);

    const premiere = await retention.purge();

    expect(premiere.ran).toBe(true);
    expect(premiere.sessionsDeleted).toBeGreaterThanOrEqual(1);

    const seconde = await retention.purge();

    expect(seconde).toMatchObject({
      ran: true,
      sessionsDeleted: 0,
      eventsDeleted: 0,
      eventsAnonymised: 0,
      interrupted: false,
    });
  });

  it('va au bout quand il y a plus de visites que la taille d’un lot', async () => {
    const lot = await nouveauProjet('lots');
    const combien = SESSION_BATCH + 1;

    const posees = await db
      .insert(sessions)
      .values(
        Array.from({ length: combien }, () => ({
          projectId: lot.id,
          visitorKey: 'vk-lot',
          startedAt: EXPIRE,
        })),
      )
      .returning({ id: sessions.id });

    await db.insert(events).values(
      posees.map(({ id }) => ({
        projectId: lot.id,
        type: 'jalon',
        source: 'browser' as const,
        occurredAt: EXPIRE,
        sessionId: id,
      })),
    );

    const rapport = await retention.purge();

    // Une boucle qui ne repasserait pas laisserait exactement une visite
    // derrière elle — l'erreur la plus discrète possible, et la seule que ce
    // dépassement d'une unité puisse révéler.
    expect(await visitesDe(lot.id)).toEqual([]);
    expect(rapport.sessionsDeleted).toBeGreaterThanOrEqual(combien);
    expect(rapport.interrupted).toBe(false);
  }, 60_000);
});
