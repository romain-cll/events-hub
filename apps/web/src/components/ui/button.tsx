import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2Icon } from 'lucide-react';
import { Slot } from 'radix-ui';

import { cn } from '#/lib/utils.ts';

const buttonVariants = cva(
  // `ring-ring/16` et `opacity-45` : les valeurs de la planche « Actions ».
  // Le stock met 50 % sur les deux — un anneau trois fois trop appuyé, et un
  // état désactivé qui ne descend pas assez.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/16 disabled:pointer-events-none disabled:opacity-45 data-[loading=true]:cursor-progress aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Le survol assombrit (`--primary-hover`), il n'éclaircit pas. Le stock
        // met `bg-primary/90`, qui mélange l'accent au fond de page et donne
        // un bleu plus clair au survol — l'inverse de l'intention.
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        // `--destructive` est calibré dans les deux thèmes : ni `text-white`
        // en dur (illisible sur le rouge clair du thème sombre), ni les
        // surcharges `dark:` du stock.
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:border-destructive focus-visible:ring-destructive/16',
        'destructive-outline':
          'border border-destructive/35 bg-card text-destructive hover:bg-destructive/10 focus-visible:border-destructive focus-visible:ring-destructive/16',
        outline:
          // Écart au stock, aligné sur la planche « Actions » du design
          // system : `#FFFFFF` + `#D6D9E0`, à toutes les tailles. Le stock
          // prend `bg-background` — juste chez shadcn, où le fond de page est
          // blanc ; faux ici, où il vaut `#FAFAFB` et où un bouton s'y noyait.
          // Les surcharges sombres tombent avec : `--card` et `--input`
          // portent déjà les bonnes valeurs dans les deux thèmes.
          // Pas d'ombre non plus : la planche fait porter la hiérarchie par le
          // remplissage, jamais par le volume.
          'border border-input bg-card hover:bg-accent hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        // `ghost` est en retrait au repos et ne prend le texte plein qu'au
        // survol ; sa surface de survol est `--secondary`, un cran plus
        // marqué que l'`--accent` d'`outline`, qui lui reste réservé.
        ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3 has-[>svg]:px-2.5',
        xs: "h-6 gap-1 rounded-md px-2 text-2xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-2.5 has-[>svg]:px-2',
        lg: 'h-10 rounded-md px-4 font-semibold has-[>svg]:px-3.5',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  loading = false,
  onClick,
  children,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    loading?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? 'true' : undefined}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      // `aria-disabled` plutôt que `disabled` : un bouton en cours garde le
      // focus, et n'hérite pas de l'opacité de l'état désactivé — la planche
      // le montre à pleine intensité.
      onClick={
        loading
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
            }
          : onClick
      }
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {/* Le libellé ne bouge pas : on préfixe un spinner, on ne remplace
              pas le texte par « Chargement… », qui ferait sauter la largeur. */}
          {loading ? (
            <Loader2Icon aria-hidden className="animate-spin" />
          ) : null}
          {children}
        </>
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
