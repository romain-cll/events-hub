import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '#/components/ui/button';
import { cn } from '#/lib/utils';

/**
 * Les trois temps de la mise en route d'un projet.
 *
 * Ils sont nommés ici et nulle part ailleurs : les trois écrans les affichent à
 * partir de cette liste, donc en renommer un — ou en ajouter un quatrième — se
 * fait à un seul endroit et ne peut pas laisser deux pages en désaccord sur
 * l'étape où l'on est.
 *
 * Le parcours est visible dès la première étape, avec sa fin. C'est ce qui
 * distingue « remplir un formulaire de plus » de « trois choses à faire, en voici
 * la deuxième » — et ce qui rend acceptable l'écran d'attente, dont on sait
 * alors qu'il est le dernier.
 */
export const SETUP_STEPS = ['Name your project', 'Install', 'First event'];

export type SetupStep = 1 | 2 | 3;

/**
 * Où l'on en est, et ce qu'il reste.
 *
 * `<ol>` plutôt qu'une rangée de `<div>` : c'est une séquence ordonnée, et un
 * lecteur d'écran l'annonce comme telle. L'étape courante porte
 * `aria-current="step"`, qui est la façon dont elle est signalée à qui ne voit
 * pas le contraste.
 */
export function Steps({ current }: { current: SetupStep }) {
  return (
    <ol className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {SETUP_STEPS.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;

        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className="flex items-center gap-2"
          >
            {index > 0 && (
              <span aria-hidden className="text-border">
                →
              </span>
            )}

            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full border text-xs',
                active && 'border-primary bg-primary text-primary-foreground',
                done && 'border-primary/40 text-primary',
              )}
            >
              {done ? <CheckIcon className="size-3" /> : step}
            </span>

            <span className={cn(active && 'text-foreground font-medium')}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Copier une valeur, et le dire.
 *
 * ## L'échec est affiché, pas avalé
 *
 * `navigator.clipboard` n'existe pas partout : il demande un contexte sécurisé,
 * et certains navigateurs le refusent sans interaction reconnue. Un `catch`
 * silencieux donnerait un bouton qui a l'air de marcher et ne colle rien — la
 * personne s'en apercevrait trois écrans plus loin, devant un `apiKey` vide.
 * D'où le troisième état : la valeur reste sélectionnable à la main, et on le
 * dit.
 *
 * `aria-live` sur le libellé : le changement d'icône ne s'annonce pas tout seul,
 * et « Copied » est justement la seule confirmation qu'il se soit passé quelque
 * chose.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** Ce que le bouton annonce au lecteur d'écran — « Copy the API key ». */
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }

    // Le retour à l'état neutre laisse le bouton réutilisable : sans lui, une
    // deuxième copie ne produirait aucun changement visible et passerait pour
    // un clic perdu.
    setTimeout(() => {
      setState('idle');
    }, 2000);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={() => void copy()}
      className={className}
    >
      {state === 'copied' ? (
        <CheckIcon className="text-primary" />
      ) : (
        <CopyIcon />
      )}
      <span aria-live="polite">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Copy failed'
            : 'Copy'}
      </span>
    </Button>
  );
}

/**
 * Un bloc de code, avec de quoi l'emporter.
 *
 * `overflow-x-auto` sur le `pre` et non sur la page : un snippet est long par
 * nature, et laisser la page déborder horizontalement casse tout le reste de la
 * mise en page pour une seule ligne.
 *
 * ## `wrap`, pour la balise et pour elle seule
 *
 * Le défilement convient à du code écrit sur plusieurs lignes : on lit du haut
 * vers le bas, et une ligne un peu longue se pousse. Il ne convient pas à un
 * snippet **d'une seule ligne**, qui disparaît alors à moitié hors de l'écran —
 * on ne voit plus ni la clé ni la fin de la balise, et on ne peut plus vérifier
 * à l'œil ce qu'on est en train de copier.
 *
 * `break-all` plutôt que `break-words` parce qu'il n'y a rien à couper
 * proprement : une URL et une clé hexadécimale n'ont pas de frontière de mot.
 */
export function Snippet({
  code,
  label,
  caption,
  wrap = false,
}: {
  code: string;
  label: string;
  caption?: React.ReactNode;
  /** Replie les lignes trop longues au lieu de les faire défiler. */
  wrap?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        {caption ? (
          <p className="text-muted-foreground text-sm">{caption}</p>
        ) : (
          <span />
        )}
        <CopyButton value={code} label={label} />
      </div>

      <pre
        className={cn(
          'bg-muted rounded-md border p-4 text-xs leading-relaxed',
          wrap ? 'break-all whitespace-pre-wrap' : 'overflow-x-auto',
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
