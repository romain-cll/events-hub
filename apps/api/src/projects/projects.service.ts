import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { DRIZZLE, type DrizzleDatabase } from '../database/database.module';
import {
  events,
  memberships,
  organizations,
  projects,
  sessions,
} from '../database/schema';
import type { CreateProjectDto } from './dto/create-project.dto';
import type { UpdateProjectDto } from './dto/update-project.dto';

/**
 * L'état d'ingestion d'un projet, réduit à la seule question de l'installation.
 *
 * `hasEvents` et rien d'autre : pendant qu'on colle le snippet, on ne demande
 * pas « combien », on demande « est-ce que c'est branché ». Voir
 * `projectIngestionSchema` dans le contrat pour ce que ça évite de payer.
 */
export interface ProjectIngestion {
  hasEvents: boolean;
}

/** Un projet tel que le dashboard le lit, avec l'organisation qui le porte. */
export interface ProjectRow {
  id: string;
  name: string;
  createdAt: Date;
  organizationId: string;
  organizationName: string;
}

/**
 * Les projets, vus depuis l'utilisateur connecté.
 *
 * Toutes les méthodes prennent un `userId` et **filtrent par appartenance** :
 * il n'existe pas ici de lecture « tous les projets » qu'un appelant distrait
 * pourrait utiliser. Le cloisonnement n'est pas une politesse rendue par chaque
 * route, c'est la forme du service.
 *
 * `assertExists` a vécu ici jusqu'à l'arrivée des organisations. Elle rendait un
 * 404 sur un projet inconnu, ce que `ProjectMemberGuard` fait désormais — et en
 * mieux, puisqu'il ne distingue pas l'inexistence de l'absence de droit. La
 * garder aurait fait deux vérifications capables de diverger.
 */
@Injectable()
export class ProjectsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * Ce projet a-t-il déjà reçu un événement ?
   *
   * ## Une existence, pas un compte
   *
   * `LIMIT 1` sans `ORDER BY` : la requête s'arrête à la première ligne trouvée
   * par `events_project_id_idx`, donc son coût ne dépend pas du volume du
   * projet. Un `count(*)` — ou un `min(occurred_at)`, qui aurait dit *quand* —
   * parcourrait toutes les lignes du projet, et cette route est appelée en
   * boucle par l'écran d'attente : ce qui est gratuit sur un projet vide
   * deviendrait le poste le plus cher de l'API sur un projet vivant.
   *
   * L'appartenance n'est pas vérifiée ici : `ProjectMemberGuard` a déjà répondu
   * 404 sur un projet qui n'est pas au demandeur. C'est la même règle que pour
   * les clés — la vérifier une seconde fois ferait deux contrôles capables de
   * diverger.
   */
  async ingestionStatus(projectId: string): Promise<ProjectIngestion> {
    const [event] = await this.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.projectId, projectId))
      .limit(1);

    return { hasEvents: Boolean(event) };
  }

  /** Les projets de toutes les organisations dont l'appelant est membre. */
  listForUser(userId: string): Promise<ProjectRow[]> {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        createdAt: projects.createdAt,
        organizationId: projects.organizationId,
        organizationName: organizations.name,
      })
      .from(projects)
      .innerJoin(organizations, eq(organizations.id, projects.organizationId))
      .innerJoin(
        memberships,
        eq(memberships.organizationId, projects.organizationId),
      )
      .where(eq(memberships.userId, userId))
      .orderBy(asc(organizations.name), asc(projects.name));
  }

  /**
   * Crée un projet dans une organisation dont l'appelant est membre.
   *
   * L'appartenance est vérifiée par un `SELECT` préalable plutôt que laissée à
   * la clé étrangère : celle-ci ne garantit que l'existence de l'organisation,
   * pas le droit d'y écrire. Sans ce contrôle, n'importe quel compte pourrait
   * déposer un projet chez n'importe qui.
   *
   * Le refus est un 404 et non un 403, pour la même raison que dans
   * `ProjectMemberGuard` : répondre différemment révélerait quelles
   * organisations existent.
   */
  async createForUser(
    userId: string,
    { organizationId, name }: CreateProjectDto,
  ): Promise<ProjectRow> {
    const [membership] = await this.db
      .select({ id: memberships.id, organizationName: organizations.name })
      .from(memberships)
      .innerJoin(
        organizations,
        eq(organizations.id, memberships.organizationId),
      )
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
        ),
      )
      .limit(1);

    if (!membership) {
      throw new NotFoundException("Cette organisation n'existe pas.");
    }

    const [project] = await this.db
      .insert(projects)
      .values({ organizationId, name })
      .returning({
        id: projects.id,
        name: projects.name,
        createdAt: projects.createdAt,
        organizationId: projects.organizationId,
      });

    return { ...project, organizationName: membership.organizationName };
  }

  /**
   * Renomme un projet.
   *
   * Pas de vérification d'appartenance ici : `ProjectMemberGuard` a déjà rendu
   * 404 sur un projet qui n'est pas au demandeur, et `@ProjectRoles` a déjà
   * refusé un `member`. La refaire donnerait deux contrôles capables de
   * diverger — même raisonnement que pour les clés.
   *
   * Le nom ne touche à rien d'autre : les clés, leurs origines et les
   * événements déjà collectés ne connaissent que `projectId`.
   */
  async rename(
    projectId: string,
    { name }: UpdateProjectDto,
  ): Promise<ProjectRow> {
    const [project] = await this.db
      .update(projects)
      .set({ name })
      .where(eq(projects.id, projectId))
      .returning({
        id: projects.id,
        name: projects.name,
        createdAt: projects.createdAt,
        organizationId: projects.organizationId,
      });

    const [organization] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, project.organizationId))
      .limit(1);

    return { ...project, organizationName: organization.name };
  }

  /**
   * Supprime un projet, et tout ce qu'il porte.
   *
   * ## La cascade est écrite ici, pas dans le schéma
   *
   * `events.projectId` et `sessions.projectId` sont en `onDelete: 'restrict'` :
   * un `DELETE` sur le projet échoue tant qu'une seule ligne subsiste. Ce n'est
   * pas un oubli à corriger, c'est la protection qui empêche qu'une suppression
   * d'organisation, une purge de test ou une future route emportent des données
   * de mesure **par effet de bord**. Passer ces clés en `cascade` la retirerait
   * pour tous les chemins, y compris ceux qui n'ont jamais demandé à détruire.
   *
   * Détruire reste donc possible, mais seulement en le disant : cette méthode
   * est le seul endroit qui l'écrit, et elle l'écrit dans l'ordre.
   *
   * ## L'ordre, et pourquoi il n'est pas interchangeable
   *
   * `events` d'abord : la table référence `sessions` — en `restrict` là aussi —
   * donc une session portant encore un événement ne part pas. Puis `sessions`.
   * Le projet ensuite emporte de lui-même `project_keys` et `event_types`, qui
   * sont en `cascade` : ce sont des dépendances de configuration, pas des
   * données, et personne ne veut les conserver sans leur projet.
   *
   * Le tout dans une transaction : à mi-chemin, un projet aurait perdu ses
   * événements et existerait encore, ce qui est le seul état vraiment
   * indéfendable — des courbes vides sans que rien ne l'explique.
   */
  async remove(projectId: string): Promise<ProjectRow> {
    // Lu avant, parce qu'après il n'y a plus rien à lire — et le nom de
    // l'organisation demande une jointure que `returning` ne fait pas.
    const [project] = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        createdAt: projects.createdAt,
        organizationId: projects.organizationId,
        organizationName: organizations.name,
      })
      .from(projects)
      .innerJoin(organizations, eq(organizations.id, projects.organizationId))
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException("Ce projet n'existe pas.");

    await this.db.transaction(async (tx) => {
      await tx.delete(events).where(eq(events.projectId, projectId));
      await tx.delete(sessions).where(eq(sessions.projectId, projectId));
      await tx.delete(projects).where(eq(projects.id, projectId));
    });

    return project;
  }
}
