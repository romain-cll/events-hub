import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projectKeys } from '../src/database/schema';
import {
  TEST_ORIGIN,
  cleanupFixtures,
  createProject,
  type TestProject,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * La clé d'ingestion, éprouvée par la route.
 *
 * C'est le fichier qui décrit ce que ce chantier ferme : **le corps de la
 * requête ne choisit plus sa cible**. Avant, `POST /v1/events` acceptait
 * n'importe quel `projectId` — qui devinait un UUID écrivait chez autrui.
 *
 * Ce qu'il ne prouve pas, et qu'aucun test ne pourrait prouver : que la clé
 * protège quoi que ce soit. Elle est publique par construction, et la
 * vérification d'`Origin` ne tient que face à un navigateur. Les tests ci-
 * dessous décrivent une frontière de **routage et d'hygiène**, pas une
 * authentification.
 */

const AUTRE_ORIGINE = 'https://un-autre-site.example';

const eventBody = (apiKey: string, type = 'ingestion_keys_e2e') => ({
  apiKey,
  type,
  occurredAt: '2026-08-22T10:00:00.000Z',
  attributes: {},
  properties: {},
});

describe("clés d'ingestion (e2e)", () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projet: TestProject;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);

    projet = await createProject(db, { name: 'e2e clés' });
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  const post = (
    body: Record<string, unknown>,
    origin: string | null = TEST_ORIGIN,
  ) => {
    const call = request(app.getHttpServer()).post('/v1/events');

    return origin === null
      ? call.send(body)
      : call.set('Origin', origin).send(body);
  };

  describe('le chemin nominal', () => {
    it('accepte une clé valide depuis une origine autorisée', async () => {
      await post(eventBody(projet.apiKey)).expect(201);
    });

    it('écrit dans le projet de la clé, et le corps n’a pas son mot à dire', async () => {
      // Le test central. `projectId` n'existe plus dans le contrat, et
      // `strictObject` fait qu'en glisser un est un 400 — pas une redirection
      // silencieuse vers le projet de quelqu'un d'autre.
      const autre = await createProject(db, { name: 'e2e clés — voisin' });

      await post(eventBody(autre.apiKey, 'chez_le_voisin')).expect(201);

      const chezNous = await db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.projectId, projet.id));

      const chezLautre = await db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.projectId, autre.id));

      expect(chezLautre.map((e) => e.type)).toContain('chez_le_voisin');
      expect(chezNous.map((e) => e.type)).not.toContain('chez_le_voisin');
    });

    it('refuse un projectId glissé dans le corps', async () => {
      await post({
        ...eventBody(projet.apiKey),
        projectId: projet.id,
      }).expect(400);
    });
  });

  describe('la clé', () => {
    it('400 sur une clé malformée', async () => {
      await post(eventBody('pas-une-cle')).expect(400);
    });

    it('401 sur une clé inconnue', async () => {
      await post(eventBody(`eh_pk_${randomBytes(16).toString('hex')}`)).expect(
        401,
      );
    });

    it('401 sur une clé révoquée, avec un message qui le dit', async () => {
      const jetable = await createProject(db, { name: 'e2e clés — révoquée' });

      await post(eventBody(jetable.apiKey)).expect(201);

      await db
        .update(projectKeys)
        .set({ revokedAt: new Date() })
        .where(eq(projectKeys.value, jetable.apiKey));

      const response = await post(eventBody(jetable.apiKey)).expect(401);

      expect(JSON.stringify(response.body)).toContain('révoquée');
    });

    it('laisse tourner une clé : la nouvelle marche, l’ancienne non', async () => {
      // Le scénario qui justifie plusieurs clés par projet. Révoquer sans
      // pouvoir en créer une seconde d'abord obligerait à casser tous les
      // sites déployés d'un coup.
      const rotation = await createProject(db, { name: 'e2e clés — rotation' });

      const [nouvelle] = await db
        .insert(projectKeys)
        .values({
          projectId: rotation.id,
          value: `eh_pk_${randomBytes(16).toString('hex')}`,
          allowedOrigins: [TEST_ORIGIN],
        })
        .returning({ value: projectKeys.value });

      await db
        .update(projectKeys)
        .set({ revokedAt: new Date() })
        .where(eq(projectKeys.value, rotation.apiKey));

      await post(eventBody(rotation.apiKey)).expect(401);
      await post(eventBody(nouvelle.value)).expect(201);
    });
  });

  /**
   * Un refus d'origine rend **204 sans corps**, jamais 4xx.
   *
   * Deux raisons, et la seconde compte plus que la première : un 4xx sur un
   * endpoint de capture fait boucler les SDK clients en retry, donc amplifie le
   * trafic qu'on cherche justement à écarter ; et il dirait à qui essaie des
   * origines au hasard quand il a visé juste.
   *
   * Le prix assumé est qu'un développeur qui a oublié de déclarer son domaine
   * ne voit rien côté client. La trace est côté serveur (log d'avertissement),
   * et alimentera plus tard un panneau « origines rejetées ».
   */
  describe('l’origine', () => {
    /** 204 rendu, et surtout : rien d'écrit. C'est un drop, pas une erreur. */
    const attendUnDrop = async (origine: string | null) => {
      const avant = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.projectId, projet.id));

      const response = await post(eventBody(projet.apiKey), origine).expect(
        204,
      );

      // Un 204 qui porterait un corps serait une contradiction — et trahirait
      // le motif du refus, ce que le silence a précisément pour objet d'éviter.
      expect(response.body).toEqual({});
      expect(response.text).toBe('');

      const apres = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.projectId, projet.id));

      expect(apres).toHaveLength(avant.length);
    };

    it('204 silencieux sans en-tête Origin', async () => {
      // La règle ne tient que parce que le SDK navigateur est la seule source
      // d'événements. Elle devra sauter quand une source serveur, native ou par
      // lot apparaîtra — aucune n'envoie cet en-tête.
      await attendUnDrop(null);
    });

    it('204 silencieux depuis une origine non déclarée', async () => {
      await attendUnDrop(AUTRE_ORIGINE);
    });

    it('ne se laisse pas avoir par un préfixe d’origine', async () => {
      // `https://localhost:3002.evil.io` commence par l'origine autorisée :
      // une comparaison par sous-chaîne le laisserait passer.
      await attendUnDrop(`${TEST_ORIGIN}.evil.io`);
    });

    it('reste bruyant sur la clé, silencieux sur l’origine', async () => {
      // La distinction tient toute la conception : une clé inconnue est une
      // erreur d'intégration, que le développeur doit voir ; une origine non
      // déclarée est un événement qu'on écarte, et le dire ne sert personne.
      await post(eventBody('eh_pk_' + '0'.repeat(32)), TEST_ORIGIN).expect(401);
      await post(eventBody(projet.apiKey), AUTRE_ORIGINE).expect(204);
    });
  });
});
