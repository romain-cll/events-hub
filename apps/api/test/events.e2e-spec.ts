import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import { TEST_ORIGIN, cleanupFixtures, createProject } from './fixtures';
import { createTestApp } from './harness';

/** Un UUID de projet qui n'existe pas : le corps n'a plus le droit d'en porter. */
const PROJET_INEXISTANT = '00000000-0000-4000-8000-000000000000';

/**
 * Le contrat d'ingestion, éprouvé de bout en bout : HTTP réel, Nest réel,
 * Postgres réel.
 *
 * Les tests unitaires du schéma Zod (`create-event.dto.spec.ts`) couvrent déjà
 * la forme du payload. Ce qu'on vérifie *ici* est ce qu'eux ne peuvent pas
 * voir : que le pipe est bien branché sur la route, que le code HTTP rendu est
 * le bon, et surtout que la base refuse d'elle-même les incohérences si jamais
 * on venait à l'écrire sans passer par Zod.
 *
 * Ces tests écrivent réellement : ils créent leur propre projet et suppriment
 * tout ce qu'ils ont inséré. `pnpm test:e2e` demande donc une base accessible,
 * contrairement à `pnpm test`.
 */

/**
 * `response.body` est typé `any` par supertest. Le nommer ici évite de
 * saupoudrer des assertions de type dans chaque test — et fait échouer la
 * compilation si la forme de la réponse change.
 */
interface EventResponse {
  id: string;
  type: string;
  sessionId: string | null;
  attributes: Record<string, unknown>;
  properties: Record<string, unknown>;
}

interface ErrorResponse {
  issues: Array<{ path: string; message: string }>;
}

const asEvent = (response: request.Response) => response.body as EventResponse;
const asError = (response: request.Response) => response.body as ErrorResponse;

describe('POST /v1/events (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projectId: string;
  let apiKey: string;

  const payload = () => ({
    apiKey,
    type: 'page_view',
    occurredAt: new Date().toISOString(),
    attributes: { 'page.path': '/pricing' },
    properties: { plan: 'pro' },
  });

  beforeAll(async () => {
    app = await createTestApp();

    db = app.get<DrizzleDatabase>(DRIZZLE);

    const project = await createProject(db, {
      name: `e2e ${new Date().toISOString()}`,
    });
    projectId = project.id;
    apiKey = project.apiKey;
  });

  afterAll(async () => {
    // Les événements d'abord : la FK est en `restrict`, le projet ne partirait
    // pas tant qu'il en porte.
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(sessions).where(eq(sessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await cleanupFixtures(db);
    await app.close();
  });

  describe('ce qui entre', () => {
    it('accepte un événement complet et renvoie la ligne écrite', async () => {
      const body = payload();
      const response = await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send(body)
        .expect(201);

      expect(asEvent(response)).toMatchObject({
        projectId,
        type: 'page_view',
        occurredAt: body.occurredAt,
        attributes: { 'page.path': '/pricing' },
        properties: { plan: 'pro' },
      });
      expect(asEvent(response).id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('ne renvoie jamais la clé visiteur', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send(payload())
        .expect(201);

      expect(asEvent(response)).not.toHaveProperty('visitorKey');
      expect(JSON.stringify(asEvent(response))).not.toContain('visitor');
    });

    it('rend la visite, la même pour deux événements qui se suivent', async () => {
      const envoyer = () =>
        request(app.getHttpServer())
          .post('/v1/events')
          .set('Origin', TEST_ORIGIN)
          .send(payload())
          .expect(201);

      const premier = await envoyer();
      const second = await envoyer();

      expect(asEvent(premier).sessionId).toMatch(/^[0-9a-f-]{36}$/);
      // C'est ce qui la rend utilisable pour rattacher un paiement : le site
      // peut la lire à n'importe quel moment de la visite et obtenir la même
      // valeur.
      expect(asEvent(second).sessionId).toBe(asEvent(premier).sessionId);
    });

    it('accepte un événement sans attributes ni properties', async () => {
      const { apiKey, type, occurredAt } = payload();

      const response = await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send({ apiKey, type, occurredAt })
        .expect(201);

      expect(asEvent(response).attributes).toEqual({});
      expect(asEvent(response).properties).toEqual({});
    });

    it('accepte un type métier arbitraire et des properties JSON variées', async () => {
      const properties = {
        chaine: 'pro',
        decimal: 1.5,
        booleen: false,
        nul: null,
        tableau: [1, 'deux'],
        imbrique: { a: { b: 'c' } },
      };

      const response = await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send({ ...payload(), type: 'panier.abandonné', properties })
        .expect(201);

      // Relu depuis `jsonb` : ce qui ressort est ce qui est entré.
      expect(asEvent(response).properties).toEqual(properties);
      expect(asEvent(response).type).toBe('panier.abandonné');
    });
  });

  describe('ce qui est rejeté', () => {
    it.each([
      ['type absent', { type: undefined }],
      ['type vide', { type: '' }],
      ['type trop long', { type: 'a'.repeat(129) }],
      ['occurredAt invalide', { occurredAt: 'hier' }],
      ['occurredAt non ISO 8601', { occurredAt: '20/08/2026' }],
      ['occurredAt sans timezone', { occurredAt: '2026-08-20T14:30:00' }],
      ['attributes non-objet', { attributes: 'page.path=/pricing' }],
      ['attributes en tableau', { attributes: [] }],
      ['properties non-objet', { properties: 42 }],
      ['apiKey malformée', { apiKey: 'pas-une-cle' }],
      ['apiKey absente', { apiKey: undefined }],
      ['projectId dans le corps', { projectId: PROJET_INEXISTANT }],
      ['champ inconnu', { occuredAt: '2026-08-20T14:30:00.000Z' }],
      ['ip usurpée dans le corps', { ip: '203.0.113.42' }],
      ['clé visiteur forgée dans le corps', { visitorKey: 'a'.repeat(64) }],
    ])('400 sur %s', async (_label, override) => {
      const response = await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send({ ...payload(), ...override })
        .expect(400);

      // Le détail des champs fautifs est rendu au client : un 400 opaque
      // obligerait à deviner.
      expect(asError(response).issues.length).toBeGreaterThan(0);
    });

    it('401 sur une clé inconnue', async () => {
      // C'était un 422 « projet inexistant » tant que le corps portait un
      // `projectId`. Ce chemin n'est plus atteignable par HTTP : la clé
      // garantit que le projet existe. Le 422 reste dans le socle pour la
      // course résiduelle — un projet supprimé entre la résolution de la clé et
      // l'insertion — mais aucune requête ne peut le provoquer volontairement.
      await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send({ ...payload(), apiKey: `eh_pk_${'0'.repeat(32)}` })
        .expect(401);
    });

    it("n'écrit rien quand le payload est refusé", async () => {
      const avant = await db
        .select()
        .from(events)
        .where(eq(events.projectId, projectId));

      await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send({ ...payload(), type: '' })
        .expect(400);

      const apres = await db
        .select()
        .from(events)
        .where(eq(events.projectId, projectId));

      expect(apres).toHaveLength(avant.length);
    });
  });

  /**
   * Zod protège le contrat HTTP. Il ne protège rien de ce qui atteindrait la
   * base autrement : une migration, un script de reprise, un futur consommateur
   * de file. Ces tests écrivent donc *à côté* de la validation, directement en
   * SQL, pour vérifier que Postgres refuse tout seul.
   */
  describe('ce que la base garantit sans Zod', () => {
    /** Une session bien réelle, pour que la clé étrangère ne masque pas le reste. */
    let sessionId: string;

    beforeAll(async () => {
      const [session] = await db
        .insert(sessions)
        .values({ projectId, visitorKey: 'cle', startedAt: new Date() })
        .returning({ id: sessions.id });
      sessionId = session.id;
    });

    const insert = (columns: string, values: string, params: unknown[]) =>
      db.$client.query(
        `insert into events (${columns}) values (${values})`,
        params,
      );

    it('refuse un événement rattaché à un projet inexistant (FK)', async () => {
      await expect(
        insert(
          'project_id, type, source, occurred_at, session_id',
          '$1, $2, $3, $4, $5',
          [
            '00000000-0000-4000-8000-000000000000',
            'page_view',
            'browser',
            new Date(),
            sessionId,
          ],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('refuse un événement rattaché à une session inexistante (FK)', async () => {
      // La contrepartie de la table : un `session_id` ne peut pas désigner du
      // vide. C'est elle qui garantit qu'aucun événement ne devient orphelin,
      // y compris pendant une fusion — déplacer les lignes *puis* supprimer la
      // session absorbée est le seul ordre que Postgres accepte.
      await expect(
        insert(
          'project_id, type, source, occurred_at, session_id',
          '$1, $2, $3, $4, $5',
          [
            projectId,
            'page_view',
            'browser',
            new Date(),
            '00000000-0000-4000-8000-000000000000',
          ],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    // ⚠️ Chaque cas porte **toutes** les autres colonnes `NOT NULL`. C'est ce
    // qui fait que le refus vient bien de celle qu'on retire : en omettre une
    // seconde ferait passer le test pour la mauvaise raison, et il continuerait
    // de passer le jour où la contrainte visée disparaîtrait.
    //
    // `session_id` n'y figure plus : la colonne est nullable depuis qu'un
    // événement peut ne pas avoir de visiteur. C'est `source` qui la remplace.
    it.each([
      ['type', 'project_id, source, occurred_at, session_id', '$1, $2, $3, $4'],
      ['source', 'project_id, type, occurred_at, session_id', '$1, $2, $3, $4'],
      ['occurred_at', 'project_id, type, source, session_id', '$1, $2, $3, $4'],
    ])(
      'refuse un événement sans %s (NOT NULL)',
      async (_col, columns, values) => {
        const params = columns
          .split(', ')
          .map((column) =>
            column === 'project_id'
              ? projectId
              : column === 'type'
                ? 'page_view'
                : column === 'source'
                  ? 'browser'
                  : column === 'occurred_at'
                    ? new Date()
                    : sessionId,
          );

        await expect(insert(columns, values, params)).rejects.toMatchObject({
          code: '23502',
        });
      },
    );

    it('refuse deux événements portant le même id (PK)', async () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const columns = 'id, project_id, type, source, occurred_at, session_id';
      const params = [
        id,
        projectId,
        'page_view',
        'browser',
        new Date(),
        sessionId,
      ];

      await insert(columns, '$1, $2, $3, $4, $5, $6', params);

      await expect(
        insert(columns, '$1, $2, $3, $4, $5, $6', params),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('refuse de supprimer un projet qui porte des événements (RESTRICT)', async () => {
      // La contrepartie du `restrict` : on ne perd pas des données d'ingestion
      // par effet de bord d'une suppression de projet.
      await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .send(payload())
        .expect(201);

      await expect(
        db.$client.query('delete from projects where id = $1', [projectId]),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('borne la précision de occurred_at à la milliseconde, comme la colonne', async () => {
      // Écriture directe, hors du chemin d'ingestion : la session est donc
      // fabriquée à la main, puisque c'est `SessionAssigner` qui s'en charge
      // normalement. Ce qu'on teste ici est la colonne, pas l'attribution.
      const [session] = await db
        .insert(sessions)
        .values({
          projectId,
          visitorKey: 'cle',
          startedAt: new Date('2026-08-20T14:30:00.123Z'),
        })
        .returning({ id: sessions.id });

      const [written] = await db
        .insert(events)
        .values({
          projectId,
          type: 'page_view',
          source: 'browser',
          occurredAt: new Date('2026-08-20T14:30:00.123Z'),
          sessionId: session.id,
        })
        .returning();

      // Ce qui est relu est exactement ce qui a été écrit — c'est ce que la
      // précision `(3)` de la colonne garantit face au `Date` JavaScript.
      expect(written.occurredAt.toISOString()).toBe('2026-08-20T14:30:00.123Z');
    });
  });
});
