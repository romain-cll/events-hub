import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

import { HOME } from '#/lib/enter-app';

/**
 * Le pendant de `_authed` : les écrans qu'on ne voit que **déconnecté**.
 *
 * ## Le garde-fou inverse
 *
 * Quelqu'un de déjà connecté n'a rien à faire sur un formulaire de connexion.
 * Sans ce test, un signet, un bouton « retour » ou un second onglet réaffiche
 * un formulaire vide à quelqu'un qui est authentifié — ce qui se lit comme une
 * déconnexion silencieuse, et le pousse à ressaisir ses identifiants pour rien.
 *
 * Il honore le `redirect` : arriver connecté sur `/auth/login?redirect=/x`
 * emmène sur `/x`, pas sur l'accueil du dashboard.
 *
 * ## `route.tsx` porte la validation de recherche
 *
 * Le paramètre est déclaré ici plutôt que sur `login.tsx` pour que
 * `/auth/signup` en hérite. Quelqu'un qu'on a renvoyé vers la connexion et qui
 * choisit de créer un compte doit finir là où il allait, pas sur l'accueil.
 */

/**
 * Le contrat d'URL du `redirect` — n'accepte que des chemins internes.
 *
 * La valeur finit dans une navigation, donc dans la barre d'adresse : accepter
 * n'importe quelle chaîne ouvrirait une redirection ouverte. Un lien
 * `/auth/login?redirect=https://evil.example` enverrait ailleurs quelqu'un qui
 * vient de s'authentifier — précisément à l'instant où il fait confiance à ce
 * qu'il voit. D'où les deux conditions : commence par `/`, et pas par `//`, qui
 * désigne un autre hôte.
 *
 * `.catch(undefined)` : une valeur refusée **tombe** à « pas de redirection »
 * au lieu de faire échouer la route. Lever afficherait un écran d'erreur,
 * c'est-à-dire empêcher de se connecter la victime d'un lien malveillant — elle
 * paierait l'attaque. Ici le lien perd son effet, l'URL est nettoyée, et la
 * page s'affiche normalement.
 */
const internalPath = z
  .string()
  .refine((value) => value.startsWith('/') && !value.startsWith('//'), {
    message: 'Seuls les chemins internes sont acceptés.',
  });

export const Route = createFileRoute('/auth')({
  validateSearch: z.object({
    redirect: internalPath.optional().catch(undefined),
  }),
  beforeLoad: ({ context, search }) => {
    if (context.session) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ href: search.redirect ?? HOME, replace: true });
    }
  },
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Outlet />
      </div>
    </div>
  );
}
