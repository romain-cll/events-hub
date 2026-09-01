import { compact } from '../browser/element.ts';
import type { Emit, Teardown } from '../types.ts';

/**
 * Émet un `submit` à chaque soumission de formulaire.
 *
 * **Aucune valeur de champ n'est lue.** C'est le point entier de ce collecteur :
 * un formulaire contient par construction ce que l'utilisateur a tapé — mail,
 * mot de passe, adresse. On rapporte que le formulaire a été soumis et ce qu'il
 * est, jamais ce qu'il portait.
 *
 * `submit` bulle, donc un écouteur sur `document` suffit, y compris pour les
 * formulaires ajoutés après coup.
 *
 * `form.action` n'est renseignée que si l'auteur a écrit l'attribut : la
 * propriété DOM `action` d'un formulaire sans attribut rend l'URL de la page
 * courante, qu'on enverrait alors une seconde fois — déjà présente dans
 * `page.url`, et avec sa query.
 */
export function trackSubmits(emit: Emit): Teardown {
  const onSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    emit(
      'submit',
      compact({
        'form.id': form.id,
        'form.name': form.getAttribute('name'),
        'form.action': form.hasAttribute('action') ? form.action : undefined,
        'form.method': form.method,
      }),
    );
  };

  document.addEventListener('submit', onSubmit);

  return () => {
    document.removeEventListener('submit', onSubmit);
  };
}
