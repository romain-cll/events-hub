import { useQuery } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  createFileRoute,
  useMatchRoute,
} from '@tanstack/react-router';
import {
  FolderIcon,
  KeyRoundIcon,
  PlugIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  UsersIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { organizationsQuery } from '#/lib/organizations';
import { projectsQuery } from '#/lib/projects';
import { cn } from '#/lib/utils';

/**
 * Les réglages, en un seul endroit et sur deux niveaux.
 *
 * ## Pourquoi tout est ici
 *
 * Il y avait deux entrées dans la barre — « API keys » d'un côté, rien pour
 * l'organisation de l'autre — et chaque nouveau panneau en aurait ajouté une.
 * Une barre latérale qui grossit à chaque réglage finit par ranger les écrans
 * qu'on regarde au milieu de ceux qu'on configure une fois par trimestre.
 *
 * Une seule entrée, et la distinction org/projet portée par les deux groupes de
 * cette colonne — la même distinction que la coquille fait déjà en posant
 * l'organisation dans la bande du haut et le projet dans la barre.
 *
 * ## Pourquoi une colonne et pas des onglets
 *
 * Six panneaux répartis en deux familles. Un `Tabs` les mettrait à plat et
 * perdrait exactement l'information qui compte : que renommer le projet et
 * renommer l'organisation ne touchent pas le même monde ni les mêmes gens.
 *
 * ## Le titre est stable
 *
 * « Settings » ne change pas d'un panneau à l'autre : c'est la colonne qui dit
 * où l'on est, et chaque carte porte son propre titre. Un `h1` qui suivrait le
 * panneau répéterait l'entrée active à deux endroits.
 */
export const Route = createFileRoute('/_authed/projects/$projectId/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { projectId } = Route.useParams();

  const projects = useQuery(projectsQuery());
  const organizations = useQuery(organizationsQuery());

  const project = projects.data?.find(({ id }) => id === projectId);
  const organization = organizations.data?.find(
    ({ id }) => id === project?.organizationId,
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">
          {organization && project
            ? `${organization.name} · ${project.name}`
            : 'Organization and project'}
        </p>
      </div>

      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <nav className="flex shrink-0 flex-col gap-4 md:w-44">
          <NavGroup label="Organization">
            <NavLink to="/projects/$projectId/settings/organization">
              <Settings2Icon />
              General
            </NavLink>
            <NavLink to="/projects/$projectId/settings/members">
              <UsersIcon />
              Members
            </NavLink>
            <NavLink to="/projects/$projectId/settings/projects">
              <FolderIcon />
              Projects
            </NavLink>
          </NavGroup>

          <NavGroup label={project ? `Project · ${project.name}` : 'Project'}>
            <NavLink to="/projects/$projectId/settings/project">
              <SlidersHorizontalIcon />
              General
            </NavLink>
            <NavLink to="/projects/$projectId/settings/keys">
              <KeyRoundIcon />
              API keys
            </NavLink>
            <NavLink to="/projects/$projectId/settings/integrations">
              <PlugIcon />
              Integrations
            </NavLink>
          </NavGroup>
        </nav>

        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/**
 * Un groupe de la colonne, avec son intitulé.
 *
 * L'intitulé est en capitales espacées — `tracking-wide` existe dans le thème
 * pour ça — parce qu'il ne se lit pas, il se repère : ce qu'on cherche dans
 * cette colonne est une entrée, et l'intitulé sert à savoir dans quelle moitié
 * regarder.
 */
function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-subtle-foreground truncate px-2 py-1 text-2xs font-bold tracking-wide uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Une entrée de la colonne.
 *
 * Elle reprend la forme d'un `SidebarMenuButton` — 28 px de rang, `--accent` de
 * marque à l'état actif — parce que c'est la même nature d'objet : un lien de
 * navigation dans une liste. Lui inventer un style le ferait lire comme autre
 * chose.
 *
 * L'état actif vient de `useMatchRoute` et non d'un `activeProps` : le même
 * test sert aussi dans la barre latérale, et les deux doivent s'allumer
 * ensemble.
 */
function NavLink({
  to,
  children,
}: {
  to:
    | '/projects/$projectId/settings/organization'
    | '/projects/$projectId/settings/members'
    | '/projects/$projectId/settings/projects'
    | '/projects/$projectId/settings/project'
    | '/projects/$projectId/settings/keys'
    | '/projects/$projectId/settings/integrations';
  children: ReactNode;
}) {
  const { projectId } = Route.useParams();
  const matchRoute = useMatchRoute();
  const active = Boolean(matchRoute({ to, params: { projectId } }));

  return (
    <Link
      to={to}
      params={{ projectId }}
      className={cn(
        'flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors',
        '[&>svg]:size-4 [&>svg]:shrink-0',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}
