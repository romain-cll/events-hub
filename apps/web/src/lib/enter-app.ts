import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';

/** Là où l'on atterrit quand rien n'a été demandé. */
export const HOME = '/projects';

/**
 * Entrer dans l'application après une authentification réussie.
 *
 * Partagé par la connexion et l'inscription : les deux finissent exactement de
 * la même façon — l'API vient de poser le cookie, il reste à ce que le reste de
 * l'application s'en aperçoive.
 *
 * ## Les trois étapes, et pourquoi cet ordre
 *
 * 1. **Retirer la session du cache.** `beforeLoad` la lit avec
 *    `ensureQueryData`, qui rend ce qu'il trouve et ne va la chercher que s'il
 *    n'y a rien. L'entrée dit encore « personne » — c'est ce qui nous a amenés
 *    sur cet écran. Sans ce retrait, le garde-fou relirait « personne » juste
 *    après une connexion réussie et nous renverrait au formulaire, en boucle.
 *    `invalidateQueries` ne suffirait pas : il marque périmé sans effacer.
 * 2. **Faire rejouer le routeur**, qui redemande la session et la trouve.
 * 3. **Naviguer**, seulement alors — l'ordre inverse ferait décider le garde-fou
 *    sur l'ancienne valeur.
 *
 * `replace: true` : le formulaire de connexion ne doit pas rester dans
 * l'historique. Un « retour » depuis le dashboard y ramènerait, sur un écran
 * qui n'a plus lieu d'être et que le garde-fou inverse renverrait aussitôt —
 * deux sauts visibles pour rien.
 *
 * `href` et non `to` : la destination vient du paramètre `redirect`, donc c'est
 * un chemin quelconque connu à l'exécution, pas une route nommée. Il a déjà été
 * validé comme interne à l'entrée (voir `routes/auth/route.tsx`).
 */
export function useEnterApp() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();

  return async (destination: string = HOME) => {
    queryClient.removeQueries({ queryKey: ['session'] });
    await router.invalidate();
    await navigate({ href: destination, replace: true });
  };
}
