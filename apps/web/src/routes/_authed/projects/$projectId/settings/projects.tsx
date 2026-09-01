import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { BoxIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { CreateProjectForm } from '#/components/create-project-form';
import { Button } from '#/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog';
import { Skeleton } from '#/components/ui/skeleton';
import { organizationsQuery } from '#/lib/organizations';
import { projectsQuery } from '#/lib/projects';

/**
 * Les projets d'une organisation — la liste qui n'existe plus ailleurs.
 *
 * `/projects` a cessé d'être un écran pour devenir un aiguillage : sur un compte
 * à un seul projet c'était une page à un seul lien, et sur un compte à plusieurs
 * le sélecteur de la barre fait le même travail sans quitter l'écran courant.
 *
 * Ce panneau-ci ne la ressuscite pas. Il répond à une autre question — « que
 * possède cette organisation » — qui se pose quand on s'apprête à la quitter ou
 * à la supprimer, et dont la réponse est justement ce qui bloque la suppression.
 * D'où la date de création plutôt que l'activité récente : on regarde un
 * inventaire, pas un tableau de bord.
 *
 * ## « New project » ouvre un dialogue, il n'emmène nulle part
 *
 * `/projects/new` existe toujours, mais c'est le parcours d'**onboarding** :
 * trois temps annoncés, qui enchaînent sur l'installation et l'attente du
 * premier événement. Y renvoyer depuis les réglages déplacerait quelqu'un qui
 * n'a rien demandé de tel, au milieu d'un écran qu'il était en train de lire.
 *
 * Le dialogue pose les deux mêmes questions — c'est le même composant — et rend
 * la main ici, le projet ajouté à la liste sous les yeux.
 *
 * Il connaît en outre son organisation d'accueil, celle qu'on regarde, là où
 * `/projects/new` retombe sur la première de la liste faute de savoir laquelle
 * viser.
 */
export const Route = createFileRoute(
  '/_authed/projects/$projectId/settings/projects',
)({
  component: OrganizationProjects,
});

const day = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

function OrganizationProjects() {
  const { projectId } = Route.useParams();

  const [creating, setCreating] = useState(false);

  const projects = useQuery(projectsQuery());
  const organizations = useQuery(organizationsQuery());

  const current = projects.data?.find(({ id }) => id === projectId);
  const organization = organizations.data?.find(
    ({ id }) => id === current?.organizationId,
  );

  if (projects.isPending || !organization) {
    return <Skeleton className="h-64 w-full" />;
  }

  const owned = (projects.data ?? []).filter(
    ({ organizationId }) => organizationId === organization.id,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {owned.length} project{owned.length === 1 ? '' : 's'} in{' '}
          {organization.name}
        </CardTitle>
        <CardDescription>
          Every member of the organization can open all of them.
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
            }}
          >
            <PlusIcon />
            New project
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="px-0">
        <div className="flex flex-col">
          {owned.map((project) => (
            <div
              key={project.id}
              className="flex items-center gap-3 border-t px-4 py-2 first:border-t-0"
            >
              <span className="bg-brand-soft text-brand-soft-foreground flex aspect-square size-7 shrink-0 items-center justify-center rounded-md">
                <BoxIcon className="size-3.5" />
              </span>

              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {project.name}
                </span>
                <span className="text-muted-foreground tabular text-2xs">
                  Created {day.format(new Date(project.createdAt))}
                </span>
              </div>

              <Button asChild variant="outline" size="sm">
                <Link
                  to="/projects/$projectId/analytics"
                  params={{ projectId: project.id }}
                  search={{ days: 7, offset: 0 }}
                >
                  Open
                </Link>
              </Button>
            </div>
          ))}
        </div>
      </CardContent>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project in {organization.name}</DialogTitle>
            <DialogDescription>
              It gets its own key right away — the snippet to install is on its
              Setup screen.
            </DialogDescription>
          </DialogHeader>

          <CreateProjectForm
            organizationId={organization.id}
            actions={
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreating(false);
                }}
              >
                Cancel
              </Button>
            }
            onCreated={() => {
              // On ne bouge pas : la liste vient d'être réinvalidée par le
              // formulaire, le projet y apparaît, et c'est tout ce qu'on
              // attendait en cliquant depuis cet écran.
              setCreating(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
