import { createFileRoute, redirect } from '@tanstack/react-router';

import { pickActiveProject } from '#/lib/active-project';
import { projectsQuery } from '#/lib/projects';

/**
 * `/projects` n'est plus un écran, c'est un aiguillage.
 *
 * ## Pourquoi la liste a disparu
 *
 * Elle demandait un clic pour arriver là où on allait de toute façon. Sur un
 * compte à un seul projet — le cas de presque tout le monde — c'était une
 * page à un seul lien ; sur un compte à plusieurs, le sélecteur de la barre
 * latérale fait le même travail depuis n'importe quel écran, sans quitter
 * celui qu'on regarde. L'adresse survit parce qu'elle est le point d'entrée
 * après connexion (`HOME`), et parce que des liens existent peut-être déjà.
 *
 * ## L'ordre des réponses
 *
 * Aucun projet, il n'y a rien à ouvrir : on va le créer. Sinon le projet
 * retenu en cookie s'il est toujours accessible, à défaut le plus récent.
 *
 * ## Pourquoi `beforeLoad` et pas `loader`
 *
 * `beforeLoad` s'exécute avant que les loaders des routes filles ne partent
 * chercher quoi que ce soit. Rediriger depuis un `loader` laisserait le
 * temps à une requête inutile de partir, et à un rendu vide de passer.
 *
 * Ce fichier n'a pas de `component` : rien n'est jamais rendu ici.
 */
export const Route = createFileRoute('/_authed/projects/')({
  beforeLoad: async ({ context }) => {
    const projects = await context.queryClient.ensureQueryData(projectsQuery());
    const target = pickActiveProject(projects);

    if (!target) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: '/projects/new' });
    }

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({
      to: '/projects/$projectId/analytics',
      params: { projectId: target.id },
      search: { days: 7, offset: 0 },
    });
  },
});
