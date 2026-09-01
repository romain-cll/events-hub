import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '#/components/ui/button';
import { cn } from '#/lib/utils';

/**
 * Ce que les deux boutons partagent, et qui n'appartient qu'à cet assemblage.
 *
 * ## Les angles
 *
 * Intérieurs carrés, extérieurs à 8 px : c'est ce qui fait lire les trois
 * morceaux comme un seul cadre plutôt que comme trois pastilles alignées.
 *
 * ## Le focus passe au-dessus
 *
 * L'anneau déborde du bouton ; sans `z-10` il se fait couper à la jointure par
 * le voisin, qui est peint après lui.
 *
 * ## L'état désactivé, et l'arbitrage qu'il demande
 *
 * La planche pose l'exception et la justifie. Partout ailleurs, désactivé vaut
 * `opacity: .45` sur le bouton **entier** ; appliqué tel quel ici, le fondu
 * emporte la bordure, un tiers du cadre pâlit, et le trait mitoyen se rompt à
 * la jointure — ça se lit comme un défaut d'alignement, pas comme un bouton
 * indisponible.
 *
 * On garde donc la règle et on déplace ce sur quoi elle porte :
 *
 * - **le cadre ne bouge pas.** C'est une structure, pas un état ;
 * - **la surface passe d'actionnable à inerte** — `bg-card` devient `bg-muted`,
 *   exactement le fond que porte déjà la partie centrale, qui se lit et ne se
 *   clique pas. Le bout désactivé rejoint visuellement ce registre-là ;
 * - **le chevron prend les .45** ;
 * - **le curseur devient `not-allowed`**.
 *
 * Ce dernier point oblige à rendre les événements de pointeur au bouton — sans
 * eux le curseur ne change pas. C'est sans risque sur un `<button disabled>`,
 * que le navigateur refuse d'activer de toute façon ; mais le survol
 * redeviendrait actif, d'où le `disabled:hover:bg-muted` qui épingle la
 * surface. Deux pseudo-classes battent le `hover:bg-accent` du variant.
 */
const EDGE = [
  'rounded-none focus-visible:z-10',
  'disabled:opacity-100 disabled:[&_svg]:opacity-45',
  'disabled:bg-muted disabled:hover:bg-muted',
  'disabled:pointer-events-auto disabled:cursor-not-allowed',
].join(' ');

/**
 * Les deux tailles de la planche, et rien entre les deux.
 *
 * Le pas-à-pas n'a pas de hauteur propre : il prend celle de la barre où il se
 * pose. `sm` quand il partage une barre d'outils avec un segmented control ou
 * un bouton `sm` ; `default` seul sur sa ligne, ou à côté d'une action de
 * taille `default`.
 *
 * Le chevron est le seul écart au barème `--spacing` : la planche le donne à
 * 13 px en `sm`, une valeur que la grille de 0,22 rem ne produit pas. C'est
 * aussi, exactement, `--text-sm` — le chevron et le libellé qu'il encadre font
 * la même hauteur. En `default` il vaut 14 px, ce que le bouton donne déjà.
 */
const SIZES = {
  default: { end: 'icon', middle: 'h-9 px-3', chevron: undefined },
  sm: { end: 'icon-sm', middle: 'h-8 px-2.5', chevron: 'size-[0.8125rem]' },
} as const;

/**
 * Un pas-à-pas : reculer, ce qu'on regarde, avancer.
 *
 * Ce n'est pas un composant nouveau — c'est le « button group » de la planche
 * *Actions* appliqué, avec un creux au milieu qui se lit et ne se clique pas.
 *
 * ## Il ne sait pas ce qu'il fait avancer
 *
 * C'est le point de son API. Il ne connaît ni période, ni date, ni décalage —
 * il rend ce qu'on lui donne au milieu et appelle une des deux fonctions quand
 * on clique. Le même composant sert donc à parcourir des semaines, des mois ou
 * des pages de résultats, sans qu'aucune de ces notions n'entre ici.
 *
 * ## Pourquoi `onPrevious` / `onNext` plutôt que `value` / `onValueChange`
 *
 * Le second est la convention Radix, suivie partout ailleurs dans `ui/`, et il
 * aurait été tentant de s'aligner. Mais il suppose que le composant sache
 * **compter** : qu'il existe une valeur, qu'elle soit ordonnée, et que
 * « suivant » veuille dire `+1`. Ici c'est faux dans les trois cas — l'appelant
 * compte en décalages où « suivant » vaut `−1`, et le composant aurait porté
 * une arithmétique à contresens de ses propres libellés.
 *
 * Deux actions nommées ne supposent rien. C'est aussi ce que font les
 * navigations de calendrier les plus répandues, pour la même raison.
 *
 * ## Les bornes sont déclarées, pas devinées
 *
 * `canGoNext` / `canGoPrevious` désactivent au lieu de masquer : un bouton qui
 * disparaît déplace son voisin, et le clic suivant tombe à côté. Désactivé, il
 * dit « on est au bout » et rien ne bouge.
 */
export function PeriodSelector({
  children,
  onPrevious,
  onNext,
  previousLabel,
  nextLabel,
  canGoPrevious = true,
  canGoNext = true,
  size = 'default',
  className,
}: {
  /** Ce qui se lit entre les deux chevrons. */
  children: ReactNode;
  onPrevious: () => void;
  onNext: () => void;
  /**
   * Libellés accessibles des deux boutons.
   *
   * Obligatoires, et sans valeur par défaut : un chevron ne dit rien à qui ne
   * le voit pas, et « Previous » tout court ne dit pas *de combien*. Seul
   * l'appelant sait ce qu'un cran représente.
   */
  previousLabel: string;
  nextLabel: string;
  canGoPrevious?: boolean;
  canGoNext?: boolean;
  /** À choisir sur les voisins de barre, pas sur le composant. */
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const scale = SIZES[size];

  return (
    <div
      role="group"
      // Aucune ombre : comme tout le reste de la planche « Actions », la
      // hiérarchie est portée par le remplissage, jamais par le volume.
      className={cn('flex w-fit items-center', className)}
    >
      <Button
        variant="outline"
        size={scale.end}
        aria-label={previousLabel}
        disabled={!canGoPrevious}
        onClick={onPrevious}
        className={cn(EDGE, 'rounded-l-md')}
      >
        <ChevronLeft className={scale.chevron} />
      </Button>

      {/*
        Que les bordures haute et basse : les verticales appartiennent aux deux
        boutons, et les doubler ferait un trait de 2 px aux jointures.

        Le fond est `--muted` et non celui des boutons : c'est ce que le design
        system prescrit pour un « button group » — côtés blancs, milieu gris,
        bordure `--input` sur les trois. Le creux du milieu dit que cette part
        se lit et ne se clique pas, sans avoir à la désactiver.

        `tabular-nums` n'est pas cosmétique : deux périodes de même forme
        doivent faire la même largeur, sinon le cadre respire à chaque pas.
      */}
      <div
        className={cn(
          'border-input bg-muted text-foreground flex items-center border-y text-sm tabular-nums select-none',
          scale.middle,
        )}
      >
        {children}
      </div>

      <Button
        variant="outline"
        size={scale.end}
        aria-label={nextLabel}
        disabled={!canGoNext}
        onClick={onNext}
        className={cn(EDGE, 'rounded-r-md')}
      >
        <ChevronRight className={scale.chevron} />
      </Button>
    </div>
  );
}
