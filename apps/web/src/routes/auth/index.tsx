import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/auth` tout seul ne mène nulle part — on renvoie sur la connexion.
 *
 * Sans cette route, l'adresse afficherait la coquille de `route.tsx` avec un
 * `Outlet` vide : une carte blanche, sans message ni moyen d'en sortir. Le
 * `redirect` est en `replace` pour que le retour arrière ne repasse pas par
 * cette adresse morte.
 */
export const Route = createFileRoute('/auth/')({
  beforeLoad: ({ search }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/auth/login', search, replace: true });
  },
});
