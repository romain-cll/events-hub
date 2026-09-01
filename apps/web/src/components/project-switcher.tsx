import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '#/components/ui/sidebar';
import { projectsQuery } from '#/lib/projects';

/** Les deux initiales d'un nom, pour la pastille du sélecteur. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Le sélecteur de projet, en tête de la barre latérale.
 *
 * ## Pourquoi c'est un menu et pas une liste dépliée
 *
 * Changer de projet est fréquent mais bref : on veut y accéder de partout,
 * pas le voir en permanence. Une liste toujours ouverte occuperait la hauteur
 * de la barre en proportion du nombre de projets, ce qui ferait varier la
 * place des liens de navigation d'une organisation à l'autre.
 *
 * ## Où mène chaque entrée
 *
 * Vers l'analytics du projet, pas vers sa racine. Un projet n'a pas d'écran
 * « d'accueil » — le tableau des événements *est* l'écran d'accueil, et
 * ouvrir un projet pour tomber sur un menu serait un clic pour rien.
 *
 * Le projet courant sort de l'URL et non d'un état local : recharger la page
 * ou partager le lien redonne exactement la même vue. Il n'y a donc rien à
 * synchroniser, et pas de « projet sélectionné » qui puisse mentir.
 */
export function ProjectSwitcher() {
  const { data, isPending } = useQuery(projectsQuery());
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();

  if (isPending) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const projects = data ?? [];
  const current = projects.find((project) => project.id === projectId);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent"
            >
              <span className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-6 items-center justify-center rounded-md text-2xs font-bold">
                {current ? initials(current.name) : 'EH'}
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">
                  {current ? current.name : 'events-hub'}
                </span>
                {current ? (
                  <span className="text-muted-foreground truncate text-2xs">
                    {current.organizationName}
                  </span>
                ) : null}
              </span>
              <ChevronsUpDownIcon className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
          >
            {projects.length > 0 ? (
              <>
                <DropdownMenuGroup>
                  {projects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      onSelect={() =>
                        void navigate({
                          to: '/projects/$projectId/analytics',
                          params: { projectId: project.id },
                          search: { days: 7, offset: 0 },
                        })
                      }
                    >
                      <span className="truncate">{project.name}</span>
                      {project.id === projectId ? (
                        <CheckIcon className="ml-auto" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            ) : null}

            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link to="/projects/new">
                  <PlusIcon />
                  New project
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
