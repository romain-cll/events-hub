import { queryOptions } from '@tanstack/react-query';

import { authClient } from './auth-client';
import { forwardedCookies } from './forwarded-cookies';

/** L'utilisateur et sa session, tels que l'API les rend. */
export type Session = typeof authClient.$Infer.Session;

/**
 * Cinq minutes.
 *
 * `beforeLoad` de la racine s'exécute à **chaque** navigation. Sans fraîcheur,
 * chaque clic dans le dashboard déclencherait un aller-retour vers l'API avant
 * d'afficher quoi que ce soit. Les changements d'état passent tous par nos
 * propres actions — connexion, déconnexion — qui invalident explicitement.
 */
const FRESH_FOR = 5 * 60 * 1000;

/**
 * La session du visiteur, source unique de vérité pour le routage.
 *
 * Elle vit dans le `QueryClient`, que `getContext()` recrée à chaque requête
 * servie : deux visiteurs simultanés ne peuvent pas se croiser. C'est la raison
 * de fond pour laquelle on ne passe pas par `authClient.useSession()`, dont
 * l'atome est un singleton de module — le détail est dans `auth-client.ts`.
 *
 * ## Aucun échec ne remonte
 *
 * Session absente, 401, API injoignable : tout rend `null`. Deux effets
 * voulus, et le second est le plus important :
 *
 * - la page publique reste servie même API éteinte, au lieu de casser sur une
 *   requête dont elle n'a que faire ;
 * - le garde-fou est **fail-closed**. Une session qu'on n'a pas pu établir vaut
 *   une session absente, jamais un laissez-passer — exactement la posture du
 *   guard global côté API.
 *
 * La panne réseau est distinguée à la journalisation, parce qu'elle ne se
 * corrige pas comme une déconnexion : sans ça, une API morte se lirait comme un
 * visiteur qui n'est simplement pas connecté.
 *
 * ## Pour la faire rejouer : `removeQueries`, jamais `invalidateQueries`
 *
 * `beforeLoad` la lit avec `ensureQueryData`, qui rend ce qu'il trouve en cache
 * et ne va la chercher que s'il n'y a **rien**. Marquer l'entrée périmée ne
 * suffit donc pas : elle serait relue telle quelle, et le garde-fou déciderait
 * sur une session qui n'existe plus. Toute action changeant l'état de connexion
 * — déconnexion aujourd'hui, connexion demain — doit retirer l'entrée.
 */
export function sessionQuery() {
  return queryOptions({
    queryKey: ['session'],
    staleTime: FRESH_FOR,
    queryFn: async (): Promise<Session | null> => {
      try {
        // `getSession` ne lève pas sur un statut d'erreur : better-fetch rend
        // `{ data, error }`. Un 401 arrive donc ici avec `data` à `null`, ce
        // qui est la réponse attendue pour un visiteur déconnecté.
        const { data } = await authClient.getSession({
          fetchOptions: { headers: forwardedCookies() },
        });

        return data ?? null;
      } catch (error) {
        // Reste le transport : API éteinte, DNS, TLS.
        console.error("Session indéterminée : l'API est injoignable.", error);

        return null;
      }
    },
  });
}
