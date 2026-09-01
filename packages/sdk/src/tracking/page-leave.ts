import type { Emit, Teardown } from '../types.ts';

/**
 * Le signal observé, pas une conclusion.
 *
 * `page_hidden` (l'onglet passe en arrière-plan), `pagehide` (le document se
 * décharge ou part en bfcache) et `outbound_click` (un lien emporte la page)
 * sont trois faits distincts du navigateur. Aucun ne prouve un départ
 * définitif : on change d'onglet et on revient. Le SDK rapporte lequel s'est
 * produit et laisse l'interprétation en aval.
 *
 * L'enum est fermé, et c'est le contrat : en aval, `leave.reason` se lit par un
 * GROUP BY, pas par un `LIKE`. Une valeur libre rendrait le champ inexploitable
 * dès le premier site qui inventerait la sienne.
 */
export type LeaveReason = 'page_hidden' | 'pagehide' | 'outbound_click';

export interface PageLeaveTracker {
  /** Signale une perte de présence, au plus une fois par perte. */
  leave: (reason: LeaveReason) => void;
  stop: Teardown;
}

/**
 * Émet un `page_leave` quand la page cesse d'être activement présente.
 *
 * ## Ce que `page_leave` veut dire
 *
 * Une **perte de présence active**, pas une fin de visite. L'onglet est passé
 * derrière, le document se décharge, ou un lien emporte la page : dans les
 * trois cas le visiteur cesse d'être devant *cette* page, et c'est tout ce que
 * le SDK affirme. Il ne dit pas que la visite est finie, ni combien de temps
 * elle a duré — ces conclusions-là appartiennent à l'aval, qui a la séquence
 * complète sous les yeux et peut recoller les allers-retours.
 *
 * Ce que ça exclut, et qui est le point de la définition : **naviguer dans le
 * site ne perd pas la présence**. Une session
 *
 *     page_view /a
 *     page_view /b
 *     page_view /c
 *     page_leave { reason: page_hidden }
 *
 * décrit une seule présence, sur trois pages. Un `page_view` ne provoque jamais
 * de `page_leave` : le visiteur n'est pas parti, il a changé de page.
 *
 * Toujours par beacon : un `fetch` ordinaire lancé depuis `pagehide` meurt avec
 * le document (voir `beaconEvent`).
 *
 * ## Pourquoi trois signaux
 *
 * `pagehide` seul est insuffisant : sur mobile, fermer l'onglet ou basculer
 * d'application ne le déclenche pas de façon fiable, alors que
 * `visibilitychange` → `hidden`, si. Et les deux arrivent trop tard pour un
 * clic sortant, où l'on veut avoir posté *avant* que la navigation parte.
 *
 * ## La déduplication
 *
 * Une même perte de présence produit plusieurs signaux à la file : un clic
 * sortant est suivi de `visibilitychange` puis de `pagehide`. Sans garde, une
 * perte ferait trois `page_leave`. `presenceLost` ne laisse passer que le
 * premier — le plus précoce est aussi le plus informatif, c'est celui qui porte
 * la raison réelle.
 *
 * Le drapeau est remis à zéro quand la page redevient visible, et c'est ce qui
 * lui donne son sens : il déduplique *une perte*, pas la durée de vie de la
 * page. Chaque nouvelle perte de visibilité redonne donc un `page_leave`, et
 * sans cette remise à zéro un aller-retour entre onglets ferait perdre la vraie
 * sortie, une heure plus tard.
 *
 * Le retour à `visible`, lui, n'émet rien : le prochain fait observable est le
 * prochain `page_view`.
 */
export function trackPageLeave(emit: Emit): PageLeaveTracker {
  let presenceLost = false;

  const leave = (reason: LeaveReason) => {
    if (presenceLost) return;

    presenceLost = true;
    emit('page_leave', { 'leave.reason': reason }, { beacon: true });
  };

  const onPageHide = () => {
    leave('pagehide');
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      leave('page_hidden');
      return;
    }

    presenceLost = false;
  };

  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    leave,
    stop: () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
