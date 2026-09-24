import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { sessions } from '../src/database/schema';
import { VisitorKeyService } from '../src/privacy/visitor-key.service';
import { SESSION_GAP_MS } from '../src/sessions/session-assigner.service';
import {
  TEST_ORIGIN,
  cleanupFixtures,
  cookiesOf,
  createProject,
  type TestProject,
} from './fixtures';
import { createTestApp } from './harness';

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

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
    visitorKeys = app.get(VisitorKeyService);
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  const projetNeuf = async (name: string): Promise<TestProject> => {
    const projet = await createProject(db, { name });

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

  /** Ce que les sessions du projet ont retenu de la réponse au bandeau. */
  const consentements = async (
    projectId: string,
  ): Promise<(boolean | null)[]> => {
    const rows = await db
      .select({ consent: sessions.consent })
      .from(sessions)
      .where(eq(sessions.projectId, projectId));

    return rows.map((row) => row.consent);
  };

  it('ne pose aucun cookie quand le site ne dit rien', async () => {
    const projet = await projetNeuf('e2e consentement — muet');

    const response = await post(evenement(projet)).expect(201);

    // Le défaut est le mode qui ne dépose rien sur le terminal. Un site qui ne
    // câble pas le signal n'a rien à afficher à ses visiteurs.
    expect(poseParLaReponse(response)).toBeUndefined();
    // Et rien à recopier sur son domaine : l'absence du champ dit au SDK
    // d'effacer la copie qu'il tiendrait encore.
    expect(response.body).not.toHaveProperty('visitorId');
    expect(await clesDesSessions(projet.id)).toHaveLength(1);
  });

  it('pose un identifiant durable à l’acceptation, sans couper la visite', async () => {
    const projet = await projetNeuf('e2e consentement — acceptation');

    await post(evenement(projet)).expect(201);
    const accepte = await post(
      evenement(projet, { consent: true, occurredAt: apres(60_000) }),
    ).expect(201);

    expect(poseParLaReponse(accepte)).toBeDefined();
    // Le corps rend le même identifiant que le cookie : c'est la seule voie par
    // laquelle le site peut l'obtenir, notre cookie étant sur notre domaine.
    expect((accepte.body as { visitorId?: string }).visitorId).toBe(
      identifiantPose(accepte),
    );
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
    expect(entete).toContain(`Max-Age=${395 * 24 * 60 * 60}`);
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

  it('ne prolonge pas l’échéance quand le consentement est réaffirmé', async () => {
    const projet = await projetNeuf('e2e consentement — pas de glissement');

    const accepte = await post(evenement(projet, { consent: true })).expect(
      201,
    );
    const identifiant = identifiantPose(accepte);

    // Le signal est le même qu'à la pose, et c'est tout l'intérêt du cas : un
    // site qui câble sa plateforme de consentement renvoie `true` à *chaque*
    // événement. Si cette réponse-là réécrivait le cookie, les 13 mois se
    // rechargeraient indéfiniment et ne borneraient plus rien.
    const reaffirme = await post(
      evenement(projet, { consent: true, occurredAt: apres(60_000) }),
      `${COOKIE}=${identifiant}`,
    ).expect(201);

    expect(poseParLaReponse(reaffirme)).toBeUndefined();
    // L'identité, elle, ne bouge pas : ne rien réécrire n'est pas tout oublier.
    expect((reaffirme.body as { visitorId?: string }).visitorId).toBe(
      identifiant,
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
    // identifier : ni le cookie ni l'identifiant n'ont de sens sur ce chemin.
    expect(poseParLaReponse(response)).toBeUndefined();
    expect(response.body).not.toHaveProperty('visitorId');
  });
  describe('ce que la session retient de la réponse', () => {
    it('laisse la colonne vide quand on n’a rien demandé', async () => {
      const projet = await projetNeuf('e2e consentement — colonne muette');

      await post(evenement(projet)).expect(201);

      // `null`, et surtout pas `false` : la mesure par défaut ne pose aucune
      // question, donc ce visiteur n'a rien refusé. Les confondre ferait passer
      // un site sans bandeau pour un site que tout le monde refuse.
      expect(await consentements(projet.id)).toEqual([null]);
    });

    it('enregistre l’acceptation et le refus', async () => {
      const accepte = await projetNeuf('e2e consentement — colonne oui');
      const refuse = await projetNeuf('e2e consentement — colonne non');

      await post(evenement(accepte, { consent: true })).expect(201);
      await post(evenement(refuse, { consent: false })).expect(201);

      expect(await consentements(accepte.id)).toEqual([true]);
      expect(await consentements(refuse.id)).toEqual([false]);
    });

    it('retient la réponse donnée à la deuxième page', async () => {
      const projet = await projetNeuf('e2e consentement — bandeau tardif');

      // Le cas qui interdit de figer la valeur à l'ouverture : le premier
      // événement d'une visite précède toujours le clic sur le bandeau.
      await post(evenement(projet)).expect(201);

      const accepte = await post(
        evenement(projet, { consent: true, occurredAt: apres(30_000) }),
      ).expect(201);

      expect(await consentements(projet.id)).toEqual([true]);

      // Et le refus qui suit l'emporte à son tour : c'est le dernier signal
      // connu qui fait foi, pas le premier.
      await post(
        evenement(projet, { consent: false, occurredAt: apres(60_000) }),
        `${COOKIE}=${identifiantPose(accepte)}`,
      ).expect(201);

      expect(await consentements(projet.id)).toEqual([false]);
    });

    it('n’efface pas une réponse quand l’événement suivant se tait', async () => {
      const projet = await projetNeuf('e2e consentement — silence après oui');

      const accepte = await post(evenement(projet, { consent: true })).expect(
        201,
      );

      // Un site qui ne câble le bandeau que sur sa page d'accueil envoie le
      // signal une fois, puis plus rien. L'absence n'est pas une rétractation.
      await post(
        evenement(projet, { occurredAt: apres(60_000) }),
        `${COOKIE}=${identifiantPose(accepte)}`,
      ).expect(201);

      expect(await consentements(projet.id)).toEqual([true]);
    });
  });
});
