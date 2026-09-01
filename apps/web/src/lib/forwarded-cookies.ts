import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

/**
 * Le cookie du visiteur, relayé quand le code tourne sur le serveur.
 *
 * ## Pourquoi c'est nécessaire
 *
 * `beforeLoad` s'exécute des deux côtés. Dans le navigateur, `fetch` joint le
 * cookie de session tout seul. **Sur le serveur Start, non** : ce n'est pas le
 * navigateur, il n'a pas de bocal à cookies — il a seulement la requête HTTP
 * entrante, dont il faut recopier l'en-tête `Cookie` à la main.
 *
 * Sans ce relais, le rendu serveur verrait toujours un visiteur déconnecté et
 * renverrait chaque page vers `/login`, que le client corrigerait ensuite. Le
 * symptôme serait un aller-retour visible sur chaque chargement, pas une erreur.
 *
 * ## Pourquoi un `createIsomorphicFn`
 *
 * `@tanstack/react-start/server` ne doit pas atteindre le bundle navigateur.
 * Cette forme donne au *bundler* de quoi supprimer la branche serveur à la
 * compilation — un `typeof window === 'undefined'` ne ferait que la court-
 * circuiter à l'exécution, l'import restant embarqué.
 *
 * ## Ce que ça ne fait pas
 *
 * Aucun filtrage : tout l'en-tête `Cookie` part vers l'API. C'est acceptable
 * parce que la destination est notre propre API. Le jour où ce client
 * s'adressera à un tiers, il faudra n'extraire que le cookie de session.
 *
 * Le nom de l'en-tête est en minuscules à dessein : `Headers` normalise, mais
 * l'objet est aussi lu tel quel par better-fetch.
 */
export const forwardedCookies = createIsomorphicFn()
  .client((): Record<string, string> => ({}))
  .server((): Record<string, string> => {
    const cookie = getRequestHeader('cookie');

    return cookie ? { cookie } : {};
  });
