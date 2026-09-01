import { useMatches } from '@tanstack/react-router';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '#/components/ui/breadcrumb';

/** Le libellé de la feuille, par identifiant de route. */
const LEAF: Record<string, string> = {
  '/_authed/projects/new': 'New project',
  '/_authed/projects/$projectId/analytics': 'Analytics',
  '/_authed/projects/$projectId/events': 'Events',
  '/_authed/projects/$projectId/setup': 'Setup',
  '/_authed/projects/$projectId/waiting': 'Waiting for events',
  '/_authed/projects/$projectId/settings/organization': 'Settings',
  '/_authed/projects/$projectId/settings/members': 'Settings',
  '/_authed/projects/$projectId/settings/projects': 'Settings',
  '/_authed/projects/$projectId/settings/project': 'Settings',
  '/_authed/projects/$projectId/settings/keys': 'Settings',
  '/_authed/invitations/$invitationId': 'Invitation',
};

/**
 * Le fil d'ariane de la barre du haut.
 *
 * ## Il n'affiche que la page courante
 *
 * Le projet n'y figure pas : la barre latérale le nomme déjà, en permanence et
 * de façon plus visible. Le répéter ici coûtait une place à côté du titre sans
 * rien apprendre. Ne reste donc que l'écran, la seule information que le reste
 * de la coquille ne donne pas.
 *
 * ## Les cinq volets de réglages disent tous « Settings »
 *
 * Ce n'est pas une paresse : la colonne de gauche dit déjà lequel est ouvert, et
 * le répéter ici mettrait la même information à deux endroits — dont l'un se
 * périmerait le jour où un volet est renommé d'un seul côté.
 *
 * ## Pourquoi une table et pas du `staticData` sur chaque route
 *
 * Les deux marchent. Celle-ci garde la formulation des libellés à un seul
 * endroit : renommer « Setup » en « Installation » se fait ici, sans rouvrir
 * quatre fichiers de route ni risquer d'en oublier un. La contrepartie est
 * qu'ajouter un écran demande d'y penser — d'où le repli silencieux plutôt
 * qu'une erreur : un écran non listé n'affiche rien, ce qui est discret et
 * jamais faux.
 */
export function DashboardBreadcrumb() {
  const matches = useMatches();
  const leaf = LEAF[matches[matches.length - 1]?.routeId ?? ''];

  if (!leaf) return null;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbPage>{leaf}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
