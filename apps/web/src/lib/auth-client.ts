import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

import { API_URL } from './api';

/**
 * Le client Better Auth du dashboard.
 *
 * Il parle à l'API Nest — Better Auth y est monté en middleware Express sous
 * `/v1/auth` (voir `apps/api/src/app.setup.ts`), sur un autre port que le
 * front. D'où deux conséquences qui ont l'air de détails et n'en sont pas :
 *
 * - `baseURL` doit porter le préfixe complet, `basePath` par défaut valant
 *   `/api/auth` — un chemin qui n'existe pas chez nous.
 * - Les appels sont cross-origin, donc soumis au CORS « tableau de bord » de
 *   l'API : origine nommée + `credentials: true`. Le client pose déjà
 *   `credentials: 'include'` de lui-même, rien à ajouter ici.
 *
 * ## `better-auth/tanstack-start` n'a rien à faire ici
 *
 * Ce plugin existe, et il ne nous concerne pas : il sert à poser les cookies
 * quand Better Auth tourne *dans* le serveur TanStack Start. Le nôtre tourne
 * dans l'API, qui pose ses cookies elle-même.
 *
 * ## ⚠️ Ne jamais appeler `authClient.useSession()`
 *
 * La session du dashboard vit dans le contexte du routeur, alimentée par
 * TanStack Query — voir `session.ts`. `useSession()` s'appuie sur un atome
 * nanostores créé **au chargement du module**, donc partagé par toutes les
 * requêtes que sert le serveur Start : deux visiteurs simultanés liraient le
 * même atome, et l'un pourrait voir la session de l'autre. Le `QueryClient`,
 * lui, est recréé à chaque requête par `getContext()` dans `router.tsx`.
 *
 * Appeler `authClient.getSession()` directement est en revanche sans danger :
 * cette voie passe par `$fetch` et n'écrit pas dans l'atome.
 *
 * ## Pourquoi le plugin organisation dès maintenant
 *
 * Aucun écran ne s'en sert encore. Mais la liste des plugins du client doit
 * refléter celle du serveur pour que les types soient justes : l'ajouter plus
 * tard changerait la forme de `session` partout d'un coup. Il rend au passage
 * `session.activeOrganizationId`, dont les écrans projets auront besoin.
 */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/v1/auth`,
  plugins: [organizationClient()],
});
