import type { ReactNode } from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip';

/**
 * Un libellé qui cache une définition, et qui le dit.
 *
 * ## Pourquoi le pointillé
 *
 * C'est l'affordance d'`abbr`, celle que les navigateurs dessinent depuis
 * toujours : elle annonce qu'il y a quelque chose sous le mot sans rien ajouter
 * à la ligne. Une icône d'information à côté coûterait une colonne dans un
 * tableau qui en compte déjà six, et un libellé cliquable promettrait une
 * navigation qui n'existe pas.
 *
 * `cursor: help` double le signal pour qui survole avant de lire.
 *
 * ## Pourquoi ce composant existe
 *
 * Le public de ce produit n'est pas analyste. « Lift », « first touch »,
 * « revenu par visiteur » sont des mots de métier, et un tableau qui les emploie
 * sans les définir laisse son lecteur deviner — ou pire, croire qu'il a compris.
 *
 * La règle du design system reste tenue : **pas de paragraphe explicatif sous
 * une métrique**. La nuance est là, elle n'occupe simplement aucune place tant
 * que personne ne la demande.
 */
export function Hint({
  children,
  title,
}: {
  children: ReactNode;
  title: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        // `asChild` n'irait pas : le déclencheur doit porter le pointillé, et
        // l'enfant est du texte nu dans la plupart des emplois.
        className="cursor-help underline decoration-dotted underline-offset-[3px]"
        // Un en-tête de tableau n'est pas un bouton : sans ça, Radix en fait un
        // et le lecteur d'écran annonce une action qui n'existe pas.
        type="button"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-pretty">{title}</TooltipContent>
    </Tooltip>
  );
}
