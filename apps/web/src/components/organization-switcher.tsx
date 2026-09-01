import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Field, fieldValue } from '#/components/field';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Button } from '#/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '#/components/ui/sidebar';
import { UNREACHABLE } from '#/lib/auth-errors';
import { createOrganization, organizationsQuery } from '#/lib/organizations';
import { projectsQuery } from '#/lib/projects';

/**
 * Le sélecteur d'organisation, en tête de la barre latérale.
 *
 * ## Pourquoi il est dans la bande du haut et pas dans la barre
 *
 * Il occupe une cellule de la même hauteur que la barre de navigation d'à côté,
 * avec le même fond et le même filet bas : un seul trait traverse alors
 * l'écran. Ce qui est au-dessus est le contexte **global** — l'organisation —
 * et ce qui est en dessous appartient au projet ouvert. La séparation est
 * portée par la mise en page plutôt que par un libellé, ce qui la rend vraie
 * même sans la lire.
 *
 * ## L'organisation courante se déduit du projet
 *
 * Elle n'est ni dans l'URL, ni dans un état local, ni dans la session : c'est
 * celle qui possède le projet ouvert, et `projectsQuery` la porte déjà
 * (`organizationName`). Recharger la page ou partager le lien redonne donc
 * exactement la même vue, sans rien à synchroniser — le même raisonnement que
 * pour le sélecteur de projet.
 *
 * Sans projet ouvert — un compte neuf, l'écran de création — on retombe sur la
 * première organisation de la liste, qui est l'organisation personnelle.
 *
 * ## Changer d'organisation, c'est ouvrir un de ses projets
 *
 * Il n'y a pas d'« organisation active » posée quelque part : l'entrée du menu
 * navigue vers le premier projet de la cible. Une organisation sans projet mène
 * à l'écran de création, qui est le seul endroit où il y ait quelque chose à
 * faire.
 */
export function OrganizationSwitcher() {
  const organizations = useQuery(organizationsQuery());
  const projects = useQuery(projectsQuery());
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();

  const [creating, setCreating] = useState(false);

  if (organizations.isPending) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const all = organizations.data ?? [];
  const openProject = projects.data?.find(({ id }) => id === projectId);

  const current =
    all.find(({ id }) => id === openProject?.organizationId) ?? all[0];

  const open = (organizationId: string) => {
    const target = projects.data?.find(
      (project) => project.organizationId === organizationId,
    );

    if (!target) {
      void navigate({ to: '/projects/new' });

      return;
    }

    void navigate({
      to: '/projects/$projectId/analytics',
      params: { projectId: target.id },
      search: { days: 7, offset: 0 },
    });
  };

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="sm"
                className="data-[state=open]:bg-sidebar-accent"
              >
                <span className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-4.5 items-center justify-center rounded-sm text-[9px] font-bold">
                  {initials(current?.name ?? 'events hub')}
                </span>
                <span className="truncate font-semibold">
                  {current?.name ?? 'events-hub'}
                </span>
                <ChevronsUpDownIcon className="ml-auto size-3" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start" className="min-w-60">
              <DropdownMenuLabel className="text-muted-foreground text-2xs font-bold tracking-wide uppercase">
                Organizations
              </DropdownMenuLabel>

              <DropdownMenuGroup>
                {all.map((organization) => (
                  <DropdownMenuItem
                    key={organization.id}
                    onSelect={() => {
                      open(organization.id);
                    }}
                  >
                    <span className="truncate">{organization.name}</span>
                    {organization.id === current?.id ? (
                      <CheckIcon className="text-primary ml-auto" />
                    ) : (
                      <span className="text-muted-foreground ml-auto text-2xs capitalize">
                        {organization.role}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>

              <DropdownMenuSeparator />

              <DropdownMenuGroup>
                <DropdownMenuItem
                  onSelect={() => {
                    setCreating(true);
                  }}
                >
                  <PlusIcon />
                  Create organization
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <CreateOrganizationDialog
        open={creating}
        onOpenChange={setCreating}
        currentName={current?.name}
      />
    </>
  );
}

/** Les deux initiales d'un nom, pour la pastille du sélecteur. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Créer une organisation — un nom, et rien d'autre.
 *
 * ## Ce que le formulaire ne demande pas
 *
 * Le slug, que le plugin exige mais qui n'apparaît dans aucune URL : le faire
 * saisir exposerait une seconde façon de désigner une organisation, qu'il
 * faudrait alors sécuriser aussi. Il est dérivé du nom (voir
 * `createOrganization`).
 *
 * Les invitations non plus. On pourrait les enchaîner ici, et la maquette le
 * proposait ; mais l'écran de réglages sait déjà les faire, et un second temps
 * dans ce dialogue dupliquerait ce formulaire-là pour l'économie d'un clic.
 * Créer, puis inviter depuis Members, est le même parcours en plus lisible.
 *
 * ## Après la création
 *
 * La liste est refaite, et on va créer un projet : une organisation vide n'a
 * aucun écran à montrer — pas d'analytics, pas d'événements — et y arriver sans
 * rien serait la même impasse que celle d'un compte neuf.
 */
function CreateOrganizationDialog({
  open,
  onOpenChange,
  currentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [fieldError, setFieldError] = useState('');

  const create = useMutation({
    mutationFn: (name: string) => createOrganization(name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      onOpenChange(false);
      await navigate({ to: '/projects/new' });
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = fieldValue(new FormData(event.currentTarget), 'name').trim();

    if (!name) {
      setFieldError('Give your organization a name.');

      return;
    }

    setFieldError('');
    create.mutate(name);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setFieldError('');
        create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>
            It gets its own projects, members and invitations. Nothing is shared
            with {currentName ?? 'your current organization'}.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label="Organization name"
            name="name"
            required
            maxLength={64}
            hint="You will be its owner."
            error={fieldError}
          />

          {create.error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="whitespace-pre-line">
                {create.error instanceof Error
                  ? create.error.message
                  : UNREACHABLE}
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
