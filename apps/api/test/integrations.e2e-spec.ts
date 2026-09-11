import { integrationsSchema } from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { integrations, projects, users } from '../src/database/schema';
import {
  expectMatchesContract,
  joinOrganization,
  signUp,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * Les routes de branchement, par le fil.
 *
 * Ce que la suite éprouve et que rien d'autre ne peut : que la réponse réelle
 * respecte le contrat — `contract.spec.ts` compare des *types*, pas ce qui
 * traverse `JSON.stringify` — et que les rôles s'appliquent où on croit.
 *
 * L'échange OAuth lui-même n'est pas testé ici : il se termine chez Stripe. Ce
 * qui en dépend de nous — la signature et la validité du jeton d'état — l'est
 * dans `stripe-connect.service.spec.ts`, hors ligne.
 */

const ACCOUNT = 'acct_e2e_integrations';

describe('intégrations (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  const createdProjects: string[] = [];
  const createdUsers: string[] = [];

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_e2e';
    process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_e2e';
    // Posée explicitement : sans ça, la suite dépendrait du `.env` de qui la
    // lance, et passerait au rouge le jour où quelqu'un bascule en
    // `read_write` pour débloquer sa connexion locale.
    process.env.STRIPE_CONNECT_SCOPE = 'read_only';

    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
  });

  afterAll(async () => {
    for (const id of createdProjects) {
      await db.delete(projects).where(eq(projects.id, id));
    }
    for (const id of createdUsers) {
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  /** Un propriétaire, son organisation personnelle et un projet dedans. */
  const setup = async () => {
    const user = await signUp(app, 'Proprietaire');
    createdUsers.push(user.id);

    const [organization] = (
      await request(app.getHttpServer())
        .get('/v1/auth/organization/list')
        .set('Cookie', user.cookies)
        .expect(200)
    ).body as { id: string }[];

    const project = (
      await request(app.getHttpServer())
        .post('/v1/projects')
        .set('Cookie', user.cookies)
        .send({ organizationId: organization.id, name: 'projet intégrations' })
        .expect(201)
    ).body as { id: string };

    createdProjects.push(project.id);

    return { user, organizationId: organization.id, project };
  };

  it('ne rend rien tant que rien n’est branché', async () => {
    const { user, project } = await setup();

    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project.id}/integrations`)
      .set('Cookie', user.cookies)
      .expect(200);

    expect(expectMatchesContract(response.body, integrationsSchema)).toEqual([]);
  });

  it('rend la connexion telle que le contrat la décrit', async () => {
    const { user, project } = await setup();

    await db.insert(integrations).values({
      projectId: project.id,
      provider: 'stripe',
      externalAccountId: ACCOUNT,
      scope: 'read_only',
      livemode: false,
    });

    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project.id}/integrations`)
      .set('Cookie', user.cookies)
      .expect(200);

    const [connection] = expectMatchesContract(
      response.body,
      integrationsSchema,
    );

    expect(connection).toMatchObject({
      provider: 'stripe',
      externalAccountId: ACCOUNT,
      scope: 'read_only',
      livemode: false,
    });
  });

  it('rend un lien d’autorisation en read_only', async () => {
    const { user, project } = await setup();

    const response = await request(app.getHttpServer())
      .post(`/v1/projects/${project.id}/integrations/stripe/authorize`)
      .set('Cookie', user.cookies)
      .expect(201);

    const url = new URL((response.body as { url: string }).url);

    // On ne demandera jamais `read_write` : le hub lit des paiements, il n'en
    // crée aucun.
    expect(url.searchParams.get('scope')).toBe('read_only');
    expect(url.searchParams.get('state')).toContain(project.id);
  });

  describe('les rôles', () => {
    it('laisse un simple membre voir ce qui est branché', async () => {
      // Savoir d'où vient le revenu affiché fait partie de la lecture
      // ordinaire.
      const { organizationId, project } = await setup();
      const membre = await signUp(app, 'Membre');
      createdUsers.push(membre.id);
      await joinOrganization(db, organizationId, membre.id, 'member');

      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/integrations`)
        .set('Cookie', membre.cookies)
        .expect(200);
    });

    it('lui refuse de brancher un compte de paiement', async () => {
      // Du même ordre que les clés d'ingestion : ça engage l'organisation
      // entière.
      const { organizationId, project } = await setup();
      const membre = await signUp(app, 'Membre');
      createdUsers.push(membre.id);
      await joinOrganization(db, organizationId, membre.id, 'member');

      await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/integrations/stripe/authorize`)
        .set('Cookie', membre.cookies)
        .expect(403);
    });

    it('reste muet pour qui n’est pas du projet', async () => {
      const { project } = await setup();
      const etranger = await signUp(app, 'Etranger');
      createdUsers.push(etranger.id);

      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/integrations`)
        .set('Cookie', etranger.cookies)
        .expect(404);
    });
  });
});
