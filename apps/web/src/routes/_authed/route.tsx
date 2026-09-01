import {
  Outlet,
  createFileRoute,
  redirect,
  useParams,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { AppSidebar } from '#/components/app-sidebar';
import { DashboardBreadcrumb } from '#/components/dashboard-breadcrumb';
import { Separator } from '#/components/ui/separator';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '#/components/ui/sidebar';
import { rememberActiveProject } from '#/lib/active-project';
import { projectsQuery } from '#/lib/projects';

/**
 * La frontière entre ce qui est public et ce qui ne l'est pas.
 *
 * Le préfixe `_` fait une route **sans segment d'URL** : tout ce qui vit dans
 * `routes/_authed/` s'adresse sans ce mot — `_authed/projects/index.tsx` est
 * servi en `/projects`. Le dossier range, il ne renomme rien. C'est voulu :
 * l'adresse d'une page ne devrait pas changer selon qu'on décide de la garder
 * ou non.
 *
 * Ce fichier s'appelle `route.tsx` plutôt que `_authed.tsx` à côté du dossier :
 * les deux formes marchent, celle-ci garde le garde-fou et ce qu'il protège au
 * même endroit.
 *
 * ## Un seul endroit
 *
 * Le garde-fou est ici et nulle part ailleurs. Poser le test dans chaque route
 * du dashboard donnerait une protection qui tient à ce que personne n'oublie —
 * or c'est exactement ce qu'on oublie. Ici, protéger un écran consiste à
 * **déposer son fichier dans ce dossier**, et rien de plus ; l'oubli inverse —
 * le poser à côté — se voit à l'œil dans l'arborescence.
 *
 * ## Pourquoi ce n'est pas la vraie protection
 *
 * Ce garde-fou décide de ce qu'on **affiche**, pas de ce à quoi on a droit.
 * Le contournement est trivial : c'est du code qui tourne chez le visiteur.
 * Ce qui protège réellement les données est côté API — le guard global et
 * `ProjectMemberGuard`, qui répondent 401 et 404 quoi qu'affiche le dashboard.
 * Ici on évite une page vide et des cartes en erreur à quelqu'un dont la
 * session a expiré.
 */
export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ context, location }) => {
    if (!context.session) {
      // `redirect` est *levé*, pas retourné : ça interrompt le chargement avant
      // que le moindre loader d'une route fille ne parte chercher des données
      // qui reviendraient en 401.
      //
      // Ce que rend `redirect()` n'est pas une `Error` mais un signal que le
      // routeur intercepte — d'où la règle désactivée ici, et seulement ici.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({
        to: '/auth/login',
        search: { redirect: location.href },
      });
    }

    // Re-déclarée pour la seule raison de la rendre non-nullable : le test
    // ci-dessus ne dit rien au typeur des routes filles, qui devraient sinon
    // toutes refaire un `session!` sans jamais pouvoir échouer.
    return { session: context.session };
  },

  /**
   * La liste des projets est chargée par la coquille, pas par les écrans.
   *
   * Deux éléments permanents en dépendent — le sélecteur de projet et le nom
   * du projet dans le fil d'ariane — et ils sont rendus côté serveur. Sans ce
   * préchargement, le serveur rend une barre latérale sans nom puis le client
   * la remplit après hydratation : le fil d'ariane gagne un segment et pousse
   * ce qui suit. Charger ici met la donnée dans le cache *avant* le premier
   * rendu, et les écrans qui en ont besoin la retrouvent sans re-demander.
   */
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQuery()),

  component: AuthedLayout,
});

/**
 * La coquille du dashboard.
 *
 * ## Trois zones fixes, et rien d'autre
 *
 * Une barre latérale qui répond « où suis-je et où puis-je aller », une barre
 * du haut qui répond « où suis-je précisément », et le reste pour l'écran.
 * Tout ce qui est propre à un écran — titre, actions, filtres — appartient à
 * l'écran et pas ici, sans quoi la coquille finirait par tout connaître.
 *
 * ## La largeur de la barre
 *
 * 13rem au lieu des 16 par défaut de shadcn. À la densité du design system,
 * un lien fait 28px de haut et le libellé le plus long tient largement ;
 * garder 16rem laisserait une colonne de vide à gauche de chaque écran, sur
 * un produit qui affiche surtout des tableaux et des graphiques.
 *
 * La valeur passe par la variable CSS que `SidebarProvider` lit déjà, plutôt
 * que par une classe : le composant s'en sert aussi pour calculer la largeur
 * de l'état replié et celle du décalage du contenu.
 *
 * ## L'état plié/déplié
 *
 * `SidebarProvider` le range dans un cookie. C'est ce qui fait qu'un rendu
 * serveur restitue la barre dans l'état où on l'a laissée, sans le saut
 * qu'aurait produit une lecture de `localStorage` après hydratation.
 */
function AuthedLayout() {
  useRememberActiveProject();

  return (
    <SidebarProvider
      style={{ '--sidebar-width': '13rem' } as React.CSSProperties}
    >
      <AppSidebar />

      <SidebarInset>
        <header className="bg-background sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator
            orientation="vertical"
            className="mr-1 data-[orientation=vertical]:h-4"
          />
          <DashboardBreadcrumb />
        </header>

        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Retient le projet ouvert, à chaque fois qu'il change.
 *
 * ## Pourquoi ici et pas dans le sélecteur
 *
 * Le sélecteur n'est qu'un des chemins qui mènent à un projet : il y a aussi
 * les liens du fil d'ariane, un signet, et l'aiguillage de `/projects`. Écrire
 * le cookie à l'endroit où on *arrive* plutôt qu'à celui d'où on part couvre
 * les quatre d'un coup, et ne peut pas se désynchroniser de l'URL — qui reste
 * la seule source de vérité.
 *
 * ## Pourquoi un effet
 *
 * `document.cookie` est un système extérieur à React, et l'écriture n'a de
 * sens que dans le navigateur. C'est exactement ce à quoi un effet sert : rien
 * n'est lu en retour, aucun état n'est posé, donc aucun rendu en cascade.
 */
function useRememberActiveProject(): void {
  const { projectId } = useParams({ strict: false });

  useEffect(() => {
    if (projectId) rememberActiveProject(projectId);
  }, [projectId]);
}
