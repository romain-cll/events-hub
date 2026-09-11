import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import {
  cookiesOf,
  createProject,
  TEST_ORIGIN,
  type TestProject,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * L'opposition, éprouvée par la route.
 *
 * Le test unitaire couvre la décision ; ce qu'on vérifie ici est ce qu'elle
 * **empêche** — qu'aucune ligne n'atteigne la base. C'est la seule chose qui
 * compte vraiment : une décision correcte sur un chemin mal câblé ne protège
 * personne.
 */

const OPTOUT = '__Host-eh_optout';
const VISITEUR = '__Host-eh_vid';

const T0 = new Date('2026-09-01T10:00:00.000Z');

describe('opposition au traitement (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  const created: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
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
    projet: TestProject,
    extra: Record<string, unknown> = {},
    entetes: Record<string, string> = {},
  ): request.Test => {
    const call = request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN);

    for (const [nom, valeur] of Object.entries(entetes)) call.set(nom, valeur);

    return call.send({
      apiKey: projet.apiKey,
      type: 'optout_e2e',
      occurredAt: T0.toISOString(),
      attributes: {},
      properties: {},
      ...extra,
    });
  };

  const compte = async (projectId: string): Promise<number> => {
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.projectId, projectId));

    return rows.length;
  };

  const pose = (response: request.Response, nom: string): string | undefined =>
    cookiesOf(response).find((entete) => entete.startsWith(`${nom}=`));

  it('écarte l’événement qui porte l’opposition, et pose le cookie', async () => {
    const projet = await projetNeuf('e2e opposition — pose');

    const reponse = await post(projet, { optOut: true }).expect(204);

    expect(pose(reponse, OPTOUT)).toContain(`${OPTOUT}=1`);
    // L'événement porteur n'est pas une mesure : rien n'est écrit.
    expect(await compte(projet.id)).toBe(0);
  });

  it('retire l’identité durable en même temps', async () => {
    const projet = await projetNeuf('e2e opposition — identité');

    const accepte = await post(projet, { consent: true }).expect(201);
    const identifiant = cookiesOf(accepte)
      .find((entete) => entete.startsWith(`${VISITEUR}=`))
      ?.slice(VISITEUR.length + 1)
      .split(';')[0];

    const oppose = await post(
      projet,
      { optOut: true },
      { Cookie: `${VISITEUR}=${identifiant ?? ''}` },
    ).expect(204);

    // S'opposer sans perdre son identifiant serait un demi-geste : il resterait
    // sur le terminal, prêt à resservir si l'opposition tombe.
    expect(pose(oppose, VISITEUR)).toContain('Max-Age=0');
    expect(pose(oppose, OPTOUT)).toContain(`${OPTOUT}=1`);
  });

  it('continue d’écarter aux événements suivants, sur le seul cookie', async () => {
    const projet = await projetNeuf('e2e opposition — persistance');

    await post(projet, {}, { Cookie: `${OPTOUT}=1` }).expect(204);
    await post(projet, {}, { Cookie: `autre=x; ${OPTOUT}=1` }).expect(204);

    expect(await compte(projet.id)).toBe(0);
  });

  it('honore Sec-GPC sans rien poser', async () => {
    const projet = await projetNeuf('e2e opposition — gpc');

    const reponse = await post(projet, {}, { 'Sec-GPC': '1' }).expect(204);

    expect(await compte(projet.id)).toBe(0);
    // Rien à mémoriser : le navigateur renverra l'en-tête à chaque requête.
    expect(pose(reponse, OPTOUT)).toBeUndefined();
  });

  it('ignore un Sec-GPC qui ne vaut pas 1', async () => {
    const projet = await projetNeuf('e2e opposition — gpc muet');

    await post(projet, {}, { 'Sec-GPC': '0' }).expect(201);

    expect(await compte(projet.id)).toBe(1);
  });

  it('laisse la mesure repartir après un retrait', async () => {
    const projet = await projetNeuf('e2e opposition — retrait');

    const retire = await post(
      projet,
      { optOut: false },
      { Cookie: `${OPTOUT}=1` },
    ).expect(204);

    expect(pose(retire, OPTOUT)).toContain('Max-Age=0');
    // Le porteur est jeté lui aussi — mais le suivant, sans cookie, passe.
    expect(await compte(projet.id)).toBe(0);

    await post(projet).expect(201);

    expect(await compte(projet.id)).toBe(1);
  });
});
