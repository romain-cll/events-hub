import { useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useMatchRoute,
  useParams,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router';
import {
  ChartNoAxesColumnIcon,
  ListIcon,
  LogOutIcon,
  PlugZapIcon,
  Settings2Icon,
} from 'lucide-react';

import { OrganizationSwitcher } from '#/components/organization-switcher';
import { ProjectSwitcher } from '#/components/project-switcher';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from '#/components/ui/sidebar';
import { authClient } from '#/lib/auth-client';

/**
 * La barre latérale du dashboard.
 *
 * ## Un seul état
 *
 * Il n'y a plus de niveau « global » au-dessus des projets : on est toujours
 * *dans* un projet, et la barre montre ses écrans. Changer de projet passe par
 * le sélecteur en tête, pas par un aller-retour vers une liste — c'est ce qui
 * permet de rester sur Analytics en basculant d'un projet à l'autre.
 *
 * Le groupe est vide dans le seul cas où il n'y a pas encore de projet, à la
 * création du premier. Un lien désactivé demanderait au visiteur de deviner ce
 * qui le débloquerait ; un lien absent ne pose pas la question.
 *
 * ## Pourquoi si peu d'entrées
 *
 * Il y en a exactement autant que d'écrans qui existent. Une barre qui annonce
 * des sections à venir transforme chaque clic en déception et se périme dès
 * qu'on renomme quoi que ce soit. Les entrées arriveront avec les écrans.
 */
export function AppSidebar() {
  const { projectId } = useParams({ strict: false });
  const matchRoute = useMatchRoute();

  return (
    <Sidebar collapsible="icon">
      {/*
        `h-11` et `border-b` alignent cette cellule sur la barre du haut de
        `_authed/route.tsx`, qui a exactement ces valeurs. C'est cet alignement
        qui produit le trait continu — le désaccorder casserait la lecture en
        deux niveaux sans qu'aucune règle ne le signale.
      */}
      <SidebarHeader className="h-11 justify-center border-b p-0 px-1.5">
        <OrganizationSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <ProjectSwitcher />
          </SidebarGroupContent>
        </SidebarGroup>

        {projectId ? (
          <SidebarGroup className="pt-0">
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Analytics"
                    isActive={Boolean(
                      matchRoute({
                        to: '/projects/$projectId/analytics',
                        params: { projectId },
                      }),
                    )}
                  >
                    <Link
                      to="/projects/$projectId/analytics"
                      params={{ projectId }}
                      search={{ days: 7, offset: 0 }}
                    >
                      <ChartNoAxesColumnIcon />
                      <span>Analytics</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>

                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Events"
                    isActive={Boolean(
                      matchRoute({
                        to: '/projects/$projectId/events',
                        params: { projectId },
                      }),
                    )}
                  >
                    <Link
                      to="/projects/$projectId/events"
                      params={{ projectId }}
                      search={{ days: 7, offset: 0 }}
                    >
                      <ListIcon />
                      <span>Events</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>

                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Setup"
                    isActive={Boolean(
                      matchRoute({
                        to: '/projects/$projectId/setup',
                        params: { projectId },
                      }),
                    )}
                  >
                    <Link
                      to="/projects/$projectId/setup"
                      params={{ projectId }}
                    >
                      <PlugZapIcon />
                      <span>Setup</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      {/*
        Le bas de la barre rassemble ce qui **configure** — les réglages, puis
        le compte — là où le haut ne montre que ce qui se parcourt. Le filet
        entre les deux dit que le compte n'est pas un écran de plus.
      */}
      <SidebarFooter>
        {projectId ? (
          <>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Settings"
                  isActive={Boolean(
                    matchRoute({
                      to: '/projects/$projectId/settings',
                      params: { projectId },
                      fuzzy: true,
                    }),
                  )}
                >
                  <Link
                    to="/projects/$projectId/settings/organization"
                    params={{ projectId }}
                  >
                    <Settings2Icon />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>

            <SidebarSeparator className="mx-0" />
          </>
        ) : null}

        <UserMenu />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Le pied de la barre : qui est connecté, et comment partir.
 *
 * L'ordre de la déconnexion est celui du garde-fou (`_authed/route.tsx`) :
 * l'API efface le cookie, on **retire** la session du cache — `removeQueries`
 * et non `invalidateQueries`, sans quoi `ensureQueryData` rendrait la session
 * d'avant — puis on refait jouer le routeur, qui redirige de lui-même. Aucune
 * navigation n'est écrite ici : elle est déjà décrite dans le garde-fou, et la
 * dupliquer ferait deux vérités.
 */
function UserMenu() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const signOut = async () => {
    await authClient.signOut();
    queryClient.removeQueries({ queryKey: ['session'] });
    await router.invalidate();
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="data-[state=open]:bg-sidebar-accent">
              <SessionAvatar />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-52"
          >
            <DropdownMenuGroup>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void signOut()}
              >
                <LogOutIcon />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * Le nom affiché vient du contexte du routeur, pas d'une requête.
 *
 * La session a déjà traversé `beforeLoad` pour que le garde-fou puisse
 * trancher ; la relire ici ferait un aller-retour pour une donnée qu'on tient
 * déjà, et ferait clignoter le pied de la barre au premier rendu.
 */
function SessionAvatar() {
  const { session } = useRouteContext({ from: '/_authed' });
  const label = session.user.name || session.user.email;

  return (
    <>
      <span className="bg-sidebar-accent text-sidebar-accent-foreground flex aspect-square size-6 items-center justify-center rounded-full text-2xs font-bold">
        {label.slice(0, 1).toUpperCase()}
      </span>
      <span className="truncate">{label}</span>
    </>
  );
}
