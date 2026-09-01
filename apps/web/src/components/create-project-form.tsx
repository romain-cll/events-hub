import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import type { Project } from '#/lib/projects';

import { Field, fieldValue } from '#/components/field';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Button } from '#/components/ui/button';
import { UNREACHABLE } from '#/lib/auth-errors';
import { parseOrigins } from '#/lib/origins';
import { createProject, createProjectKey } from '#/lib/projects';

/**
 * Créer un projet : deux champs, deux écritures, un seul endroit.
 *
 * ## Pourquoi ce formulaire est partagé
 *
 * Il sert deux parcours qui n'ont en commun que ce geste : l'onboarding
 * (`/projects/new`, qui enchaîne sur l'installation) et le dialogue des
 * réglages (qui reste sur place). Ce qui diffère est **ce qui se passe après**,
 * pas ce qu'on demande — d'où `onCreated`, et rien d'autre en prop de
 * comportement.
 *
 * Le dupliquer aurait dupliqué le piège ci-dessous, qui est la seule partie
 * difficile.
 *
 * ## Pourquoi deux champs et pas un
 *
 * Le nom seul ne suffit pas à produire une installation. Une clé d'ingestion
 * exige au moins une origine autorisée — l'API le refuse autrement, et pour une
 * bonne raison : une clé qui accepterait tout ne protégerait personne du cas
 * fréquent, un snippet copié sur un autre site ou un staging qui déverse ses
 * vrais visiteurs dans le projet.
 *
 * Le demander plus tard donnerait un projet incapable de recevoir quoi que ce
 * soit, et l'écran d'installation n'aurait rien à faire coller.
 *
 * ## L'échec partiel a son état
 *
 * Créer un projet puis sa clé, ce sont deux écritures. Si la seconde échoue —
 * une URL que l'API refuse, une coupure — le projet existe déjà, et resoumettre
 * le formulaire tel quel en créerait un second, sans nom différent, sans que
 * rien ne le signale. D'où `created` : une fois le projet en base, il est
 * conservé, le champ du nom devient inerte, et la nouvelle tentative ne rejoue
 * que ce qui a manqué.
 */
export function CreateProjectForm({
  organizationId,
  organizationName,
  submitLabel = 'Create project',
  actions,
  onCreated,
}: {
  organizationId: string;
  /** Nommée en clair sous le formulaire quand l'écran ne la dit pas déjà. */
  organizationName?: string;
  submitLabel?: string;
  /** Ce qui accompagne le bouton — « Cancel », un lien de retour. */
  actions?: React.ReactNode;
  onCreated: (project: Project) => Promise<void> | void;
}) {
  const queryClient = useQueryClient();

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);

  /**
   * Le projet déjà créé, s'il l'a été.
   *
   * Une `ref` et non un `state` : sa valeur est lue dans le gestionnaire de
   * soumission, jamais rendue. Un `state` provoquerait un rendu de plus sans
   * rien changer à l'écran — sauf pour le champ du nom, qui lit `created` pour
   * se figer, d'où le `state` jumeau ci-dessous.
   */
  const created = useRef<Project | null>(null);
  const [createdName, setCreatedName] = useState('');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const name = created.current?.name ?? fieldValue(form, 'name').trim();
    const parsed = parseOrigins(fieldValue(form, 'origins'));

    const errors: Record<string, string> = {};

    if (!name) errors.name = 'Give your project a name.';

    if (parsed.invalid !== undefined) {
      errors.origins = `“${parsed.invalid}” is not a valid site address.`;
    } else if (parsed.origins.length === 0) {
      errors.origins = 'Enter the address of the site you want to measure.';
    }

    if (Object.keys(errors).length > 0) {
      setFormError('');
      setFieldErrors(errors);

      return;
    }

    setFieldErrors({});
    setFormError('');
    setPending(true);

    try {
      const project =
        created.current ?? (await createProject({ organizationId, name }));

      created.current = project;
      setCreatedName(project.name);

      await createProjectKey(project.id, {
        allowedOrigins: parsed.origins ?? [],
      });

      // La liste est refaite avant de rendre la main : sans ça, l'écran qui
      // suit — la liste des projets, ou celui qu'on ne quitte pas — montrerait
      // encore l'état d'avant et donnerait à croire que rien n'a été créé.
      await queryClient.invalidateQueries({ queryKey: ['projects'] });

      await onCreated(project);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : UNREACHABLE);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
    >
      <Field
        label="Project name"
        name="name"
        required
        maxLength={128}
        defaultValue={createdName}
        // Figé une fois le projet en base : le champ décrirait sinon un nom qui
        // ne serait plus appliqué, et le formulaire mentirait sur ce qu'il va
        // faire.
        disabled={Boolean(createdName)}
        hint={
          createdName
            ? 'Already created — only the site address is missing.'
            : organizationName
              ? `It will live in ${organizationName}.`
              : 'Usually the name of the site you are measuring.'
        }
        error={fieldErrors.name}
      />

      <Field
        label="Site address"
        name="origins"
        placeholder="acme.com, www.acme.com"
        required
        hint="Events are only accepted from these addresses. Separate several with a comma."
        error={fieldErrors.origins}
      />

      {formError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="whitespace-pre-line">
            {formError}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-end gap-3">
        {actions}
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
