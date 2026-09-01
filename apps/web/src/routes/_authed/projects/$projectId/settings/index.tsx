import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/settings` n'est pas un écran, c'est un aiguillage — comme `/projects`.
 *
 * Il faut bien atterrir quelque part, et c'est le **premier élément de la
 * colonne** : celui qu'on lit en haut à gauche est celui qu'on s'attend à voir
 * ouvert. Atterrir plus bas dans la liste ferait passer son ordre pour
 * arbitraire, et donnerait à chercher où l'on est au lieu de le savoir.
 *
 * On avait d'abord visé « Members », au motif qu'on le rouvre plus souvent que
 * les autres. C'était une supposition sur l'usage, et elle ne valait pas de
 * contredire l'ordre affiché.
 *
 * `beforeLoad` et non `loader` : rediriger depuis un `loader` laisserait partir
 * les requêtes de cette route avant de changer d'avis.
 */
export const Route = createFileRoute('/_authed/projects/$projectId/settings/')({
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({
      to: '/projects/$projectId/settings/organization',
      params: { projectId: params.projectId },
    });
  },
});
