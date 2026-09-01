import { useId } from 'react';

import { Input } from '#/components/ui/input';
import { Label } from '#/components/ui/label';

/**
 * Un champ de formulaire, avec son libellé et son erreur.
 *
 * L'intérêt n'est pas d'économiser trois lignes de JSX : c'est de **rendre le
 * câblage d'accessibilité impossible à oublier**. Écrit à la main dans chaque
 * écran, il saute une fois sur deux, et rien ne le signale — la page a l'air
 * correcte, elle est seulement inutilisable au lecteur d'écran.
 *
 * Trois liens que ce composant garantit :
 *
 * - `htmlFor` / `id` — cliquer le libellé met le focus dans le champ, et le
 *   lecteur d'écran annonce lequel il lit.
 * - `aria-describedby` — l'erreur est **rattachée** au champ. Sans ça elle est
 *   à l'écran mais n'est jamais lue à qui n'a que la voix.
 * - `aria-invalid` — dit que le champ est en faute. La couleur rouge seule ne
 *   se transmet ni à la voix ni à quelqu'un qui ne distingue pas le rouge.
 *
 * `useId` plutôt qu'un identifiant passé en prop : deux instances du même
 * formulaire sur une page produiraient des `id` en double, ce qui casse
 * silencieusement l'association. Et il est stable entre serveur et client, donc
 * pas d'erreur d'hydratation.
 */
/**
 * Un champ de formulaire, en chaîne.
 *
 * `FormData.get` rend `string | File | null` — un `<input type="file">` suffit à
 * produire un `File`, et le passer à `String()` donnerait `[object File]` sans
 * que rien ne bronche. Le test de type est donc là pour de bon, même si aucun
 * champ des écrans actuels n'est un fichier.
 *
 * Il vit ici, à côté de `Field`, parce que c'est le pendant en lecture de ce que
 * `Field` écrit : les deux parlent du même champ, et les séparer ferait
 * recopier celui-ci dans chaque formulaire.
 */
export function fieldValue(form: FormData, name: string): string {
  const value = form.get(name);

  return typeof value === 'string' ? value : '';
}

export function Field({
  label,
  error,
  hint,
  ...input
}: {
  label: string;
  /** Message de refus. Vide ou absent : le champ est neutre. */
  error?: string;
  /** Règle annoncée **avant** la faute, pas après. */
  hint?: string;
} & React.ComponentProps<typeof Input>) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  // L'indice disparaît quand l'erreur apparaît : les deux occupent la même
  // place et disent la même chose, l'un au futur, l'autre au passé.
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>

      <Input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        {...input}
      />

      {error ? (
        <p id={errorId} className="text-destructive text-sm">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-muted-foreground text-sm">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
