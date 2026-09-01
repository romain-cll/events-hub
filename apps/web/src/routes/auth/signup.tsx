import { Link, createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';

import { Field } from '#/components/field';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Button } from '#/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import { authClient } from '#/lib/auth-client';
import {
  messageFor,
  MIN_PASSWORD_LENGTH,
  UNREACHABLE,
} from '#/lib/auth-errors';
import { useEnterApp } from '#/lib/enter-app';

/**
 * `/auth/signup`.
 *
 * ## Il n'y a pas d'étape intermédiaire
 *
 * L'API connecte dans la foulée de la création (`autoSignIn` est actif) et la
 * vérification d'adresse est désactivée. On passe donc directement au
 * dashboard : pas d'écran « consultez vos emails », qui mentirait puisque
 * aucun email n'est envoyé.
 *
 * ## Le nom n'est pas décoratif
 *
 * L'API crée une organisation `"<nom>'s org"` au moment de l'inscription. Un
 * nom vide produirait une organisation appelée `'s org` — d'où le `.min(1)`.
 * Ce n'est pas une protection : l'API accepte la chaîne vide et un appel direct
 * passerait. Le vrai correctif est côté serveur, il est noté.
 */
const schema = z.object({
  name: z.string().trim().min(1, { message: 'Renseignez votre nom.' }),
  email: z.email({ message: 'Adresse email invalide.' }),
  password: z.string().min(MIN_PASSWORD_LENGTH, {
    message: `Au moins ${String(MIN_PASSWORD_LENGTH)} caractères.`,
  }),
});

export const Route = createFileRoute('/auth/signup')({ component: Signup });

function Signup() {
  const { redirect } = Route.useSearch();
  const enterApp = useEnterApp();

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const parsed = schema.safeParse(Object.fromEntries(form));

    if (!parsed.success) {
      const { fieldErrors: issues } = z.flattenError(parsed.error);

      setFormError('');
      setFieldErrors(
        Object.fromEntries(
          Object.entries(issues).map(([field, messages]) => [
            field,
            messages[0],
          ]),
        ),
      );

      return;
    }

    setFieldErrors({});
    setFormError('');
    setPending(true);

    try {
      const { error } = await authClient.signUp.email(parsed.data);

      if (error) {
        setFormError(messageFor(error));

        return;
      }

      await enterApp(redirect);
    } catch {
      setFormError(UNREACHABLE);
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Créer un compte</CardTitle>
        <CardDescription>
          Une organisation est créée avec votre compte ; vous pourrez y inviter
          votre équipe.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
        >
          <Field
            label="Nom"
            name="name"
            autoComplete="name"
            required
            hint="Sert à nommer votre organisation."
            error={fieldErrors.name}
          />

          <Field
            label="Adresse email"
            name="email"
            type="email"
            autoComplete="email"
            required
            error={fieldErrors.email}
          />

          <Field
            label="Mot de passe"
            name="password"
            type="password"
            // `new-password` fait proposer une génération par le gestionnaire
            // de mots de passe, là où `current-password` proposerait de remplir.
            autoComplete="new-password"
            required
            // La règle est annoncée **avant** la faute. L'apprendre par un
            // refus, c'est un aller-retour et un mot de passe à retaper.
            hint={`Au moins ${String(MIN_PASSWORD_LENGTH)} caractères.`}
            error={fieldErrors.password}
          />

          {formError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={pending}>
            {pending ? 'Création…' : 'Créer le compte'}
          </Button>
        </form>

        <p className="text-muted-foreground mt-4 text-sm">
          Vous avez déjà un compte ?{' '}
          <Link
            to="/auth/login"
            search={{ redirect }}
            className="underline underline-offset-4"
          >
            Se connecter
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
