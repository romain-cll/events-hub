import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { invitationsSchema, membersPageSchema } from '@events-hub/api-contract';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { memberships, users } from '../src/database/schema';
import { expectMatchesContract, signUp } from './fixtures';
import { createTestApp } from './harness';

/**
 * Les organisations, de l'inscription à l'invitation.
 *
 * On ne teste pas le plugin `organization` de Better Auth — ce n'est pas notre
 * code. On teste **notre configuration** : que les tables portent nos noms, que
 * les routes répondent sous `/v1/auth`, et surtout que le hook d'inscription
 * crée bien l'organisation personnelle, qui est le seul morceau écrit par nous.
 *
 * ## Et depuis que le contrat décrit membres et invitations
 *
 * Une seconde raison s'y ajoute. `members.ts` est la seule partie du contrat qui
 * décrive des routes que nous n'écrivons pas ; `src/contract.spec.ts` la
 * rattache aux types que le plugin infère, mais un type ne dit rien de ce qui
 * sort vraiment sur le fil — qu'un `Date` devienne une chaîne ISO, qu'`image`
 * disparaisse quand il vaut `undefined`, que nos `modelName` n'aient pas
 * renommé une colonne au passage. C'est ici que ça se vérifie, avec
 * `expectMatchesContract` sur les réponses réelles.
 */

interface OrganizationJson {
  id: string;
  name: string;
  slug: string;
}

describe('organisations (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
  });

  afterAll(async () => {
    // `memberships` et `organizations` partent en cascade avec l'utilisateur.
    for (const id of createdUsers) {
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  const register = async (name?: string) => {
    const user = await signUp(app, name);
    createdUsers.push(user.id);

    return user;
  };

  describe('l’organisation personnelle', () => {
    it('existe dès l’inscription, et le compte en est propriétaire', async () => {
      const user = await register('Romain');

      const response = await request(app.getHttpServer())
        .get('/v1/auth/organization/list')
        .set('Cookie', user.cookies)
        .expect(200);

      const orgs = response.body as OrganizationJson[];

      expect(orgs).toHaveLength(1);
      expect(orgs[0].name).toBe("Romain's org");
      // Le slug est généré et unique, mais il n'apparaît dans aucune URL.
      expect(orgs[0].slug).toMatch(/^romain-[0-9a-f]{6}$/);

      const rows = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userId, user.id));

      expect(rows).toEqual([{ role: 'owner' }]);
    });

    it('donne des slugs distincts à deux comptes homonymes', async () => {
      // Le suffixe aléatoire existe pour ça : `slug` est unique en base, et
      // deux « Romain » qui s'inscrivent ne doivent pas se percuter.
      const premier = await register('Homonyme');
      const second = await register('Homonyme');

      const slugOf = async (cookies: string[]) => {
        const response = await request(app.getHttpServer())
          .get('/v1/auth/organization/list')
          .set('Cookie', cookies)
          .expect(200);

        return (response.body as OrganizationJson[])[0].slug;
      };

      expect(await slugOf(premier.cookies)).not.toBe(
        await slugOf(second.cookies),
      );
    });
  });

  describe('inviter et retirer un membre', () => {
    it('fait entrer un second compte par invitation', async () => {
      const owner = await register('Proprietaire');
      const invite = await register('Invite');

      const [organization] = (
        await request(app.getHttpServer())
          .get('/v1/auth/organization/list')
          .set('Cookie', owner.cookies)
          .expect(200)
      ).body as OrganizationJson[];

      const invitation = await request(app.getHttpServer())
        .post('/v1/auth/organization/invite-member')
        .set('Cookie', owner.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({
          email: invite.email,
          role: 'member',
          organizationId: organization.id,
        })
        .expect(200);

      const { id: invitationId } = invitation.body as { id: string };

      await request(app.getHttpServer())
        .post('/v1/auth/organization/accept-invitation')
        .set('Cookie', invite.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({ invitationId })
        .expect(200);

      const members = await request(app.getHttpServer())
        .get('/v1/auth/organization/list-members')
        .query({ organizationId: organization.id })
        .set('Cookie', owner.cookies)
        .expect(200);

      const { members: rows } = expectMatchesContract(
        members.body,
        membersPageSchema,
      );

      expect(rows.map((m) => m.user.email).sort()).toEqual(
        [owner.email, invite.email].sort(),
      );
    });

    it('rend une invitation en attente conforme au contrat', async () => {
      const owner = await register('Attente');

      const [organization] = (
        await request(app.getHttpServer())
          .get('/v1/auth/organization/list')
          .set('Cookie', owner.cookies)
          .expect(200)
      ).body as OrganizationJson[];

      await request(app.getHttpServer())
        .post('/v1/auth/organization/invite-member')
        .set('Cookie', owner.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({
          email: 'jamais-inscrit@example.test',
          role: 'admin',
          organizationId: organization.id,
        })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get('/v1/auth/organization/list-invitations')
        .query({ organizationId: organization.id })
        .set('Cookie', owner.cookies)
        .expect(200);

      const [invitation] = expectMatchesContract(
        response.body,
        invitationsSchema,
      );

      // Une adresse sans compte : c'est le cas le plus fréquent, et celui qui
      // justifie que `invitations` soit clé sur l'email et non sur un `userId`.
      expect(invitation.email).toBe('jamais-inscrit@example.test');
      expect(invitation.status).toBe('pending');
    });

    it('refuse d’inviter dans une organisation dont on n’est pas membre', async () => {
      const owner = await register('Interne');
      const etranger = await register('Etranger');

      const [organization] = (
        await request(app.getHttpServer())
          .get('/v1/auth/organization/list')
          .set('Cookie', owner.cookies)
          .expect(200)
      ).body as OrganizationJson[];

      const response = await request(app.getHttpServer())
        .post('/v1/auth/organization/invite-member')
        .set('Cookie', etranger.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({
          email: 'quelquun@example.test',
          role: 'member',
          organizationId: organization.id,
        });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  /**
   * Les deux refus sur lesquels reposent les écrans.
   *
   * Ils sont testés ici parce qu'ils décident du dessin : le dashboard ne montre
   * pas de bouton « inviter » à un `member`, et l'écran d'invitation a un état
   * « mauvais compte ». Si ces deux règles n'étaient pas tenues côté serveur, le
   * premier ne serait qu'un décor et le second ne se déclencherait jamais.
   *
   * Ce sont des règles du plugin, pas les nôtres — d'où l'intérêt de les
   * éprouver : rien dans notre code ne les rappellerait si une montée de version
   * les relâchait.
   */
  describe('ce que le rôle et l’adresse interdisent', () => {
    /** Fait entrer `guest` dans l'organisation de `owner`, avec ce rôle. */
    const joinAs = async (
      owner: Awaited<ReturnType<typeof signUp>>,
      guest: Awaited<ReturnType<typeof signUp>>,
      role: string,
    ) => {
      const [organization] = (
        await request(app.getHttpServer())
          .get('/v1/auth/organization/list')
          .set('Cookie', owner.cookies)
          .expect(200)
      ).body as OrganizationJson[];

      const invitation = await request(app.getHttpServer())
        .post('/v1/auth/organization/invite-member')
        .set('Cookie', owner.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({ email: guest.email, role, organizationId: organization.id })
        .expect(200);

      await request(app.getHttpServer())
        .post('/v1/auth/organization/accept-invitation')
        .set('Cookie', guest.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({ invitationId: (invitation.body as { id: string }).id })
        .expect(200);

      return organization;
    };

    it('interdit à un « member » d’inviter', async () => {
      const owner = await register('Patron');
      const simple = await register('Simple');
      const organization = await joinAs(owner, simple, 'member');

      const response = await request(app.getHttpServer())
        .post('/v1/auth/organization/invite-member')
        .set('Cookie', simple.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({
          email: 'tiers@example.test',
          role: 'member',
          organizationId: organization.id,
        });

      expect(response.status).toBe(403);
    });

    it('laisse un « admin » inviter', async () => {
      // Le pendant du test précédent : sans lui, un refus généralisé passerait
      // pour un contrôle de rôle alors qu'il serait une panne.
      const owner = await register('Patronne');
      const admin = await register('Adjoint');
      const organization = await joinAs(owner, admin, 'admin');

      await request(app.getHttpServer())
        .post('/v1/auth/organization/invite-member')
        .set('Cookie', admin.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({
          email: 'recrue@example.test',
          role: 'member',
          organizationId: organization.id,
        })
        .expect(200);
    });

    it('refuse une invitation acceptée sous une autre adresse', async () => {
      const owner = await register('Hote');
      const destinataire = await register('Destinataire');
      const autre = await register('Autre');

      const [organization] = (
        await request(app.getHttpServer())
          .get('/v1/auth/organization/list')
          .set('Cookie', owner.cookies)
          .expect(200)
      ).body as OrganizationJson[];

      const invitation = await request(app.getHttpServer())
        .post('/v1/auth/organization/invite-member')
        .set('Cookie', owner.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({
          email: destinataire.email,
          role: 'member',
          organizationId: organization.id,
        })
        .expect(200);

      const invitationId = (invitation.body as { id: string }).id;

      // Connaître l'identifiant ne suffit pas : c'est la session qui décide.
      // C'est ce qui rend l'état « mauvais compte » du dashboard nécessaire —
      // le lien seul n'autorise rien.
      await request(app.getHttpServer())
        .post('/v1/auth/organization/accept-invitation')
        .set('Cookie', autre.cookies)
        .set('Origin', 'http://localhost:3000')
        .send({ invitationId })
        .expect(403);

      await request(app.getHttpServer())
        .get('/v1/auth/organization/get-invitation')
        .query({ id: invitationId })
        .set('Cookie', autre.cookies)
        .expect(403);

      // Et sans session du tout, c'est un 401 : l'identifiant ne porte rien.
      await request(app.getHttpServer())
        .get('/v1/auth/organization/get-invitation')
        .query({ id: invitationId })
        .expect(401);
    });
  });
});
