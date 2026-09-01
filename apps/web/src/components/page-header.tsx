import type { ReactNode } from 'react';

/**
 * L'en-tête d'un écran : un titre, et rien d'autre par défaut.
 *
 * ## Pourquoi il n'y a pas de prop `description`
 *
 * C'est délibéré, et c'est la moitié de l'intérêt du composant. Une phrase
 * sous le titre — « Suivez les événements de votre site en temps réel » — se
 * lit une fois, jamais deux, et coûte une ligne de hauteur sur *tous* les
 * écrans, pour toujours. L'absence de la prop rend la tentation impossible à
 * satisfaire sans ouvrir ce fichier, ce qui est exactement le niveau de
 * friction voulu.
 *
 * Ce qui doit être expliqué se met là où la question se pose : une infobulle
 * sur le contrôle concerné, un `Empty` quand il n'y a rien à montrer, un
 * `Alert` quand quelque chose cloche. Jamais en préambule.
 *
 * `actions` reçoit ce qui agit sur l'écran entier — créer, exporter, filtrer.
 * Une action qui ne concerne qu'un bloc appartient à ce bloc.
 */
export function PageHeader({
  title,
  actions,
}: {
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * Le corps d'un écran, sous la barre du haut.
 *
 * Une seule largeur maximale et un seul rythme vertical pour tout le
 * dashboard : les écrans n'ont pas à se souvenir de leur propre gouttière, et
 * passer de l'un à l'autre ne fait pas sauter le contenu.
 */
export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
  );
}
