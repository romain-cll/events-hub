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
import { messageFor, UNREACHABLE } from '#/lib/auth-errors';
import { useEnterApp } from '#/lib/enter-app';

/**
 * `/auth/login`.
 *
 * ## Deux validations, deux autorités
 *
 * Le schéma ci-dessous n'arrête que ce qu'on peut savoir **sans le serveur** :
 * une adresse mal formée, un champ vide. Il n'a pas autorité — c'est l'API qui
 * décide si un compte existe — et il n'est là que pour éviter un aller-retour
 * dont on connaît déjà l'issue.
 *
 * Il n'y a **pas de longueur minimale sur le mot de passe ici**, contrairement
 * à l'inscription. Un compte plus ancien que la règle actuelle doit pouvoir se
 * connecter ; appliquer la règle de création à la connexion enfermerait dehors
 * exactement les gens à qui elle ne s'adresse pas.
 */
const schema = z.object({
  email: z.email({ message: 'Adresse email invalide.' }),
  password: z.string().min(1, { message: 'Renseignez votre mot de passe.' }),
});

export const Route = createFileRoute('/auth/login')({ component: Login });

function Login() {
  const { redirect } = Route.useSearch();
  const enterApp = useEnterApp();

  /** Erreurs par champ, effacées dès qu'on resoumet. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Refus global — identifiants, ou serveur injoignable. */
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const parsed = schema.safeParse(Object.fromEntries(form));

    if (!parsed.success) {
      // `z.flattenError` rend un tableau par champ ; on n'affiche que le
      // premier message. Empiler « invalide » et « trop court » sous le même
      // champ n'aide personne à le corriger.
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
      const { error } = await authClient.signIn.email(parsed.data);

      // `signIn.email` ne lève pas sur un refus : better-fetch rend
      // `{ data, error }`. Un mot de passe faux arrive donc ici, pas dans le
      // `catch` — qui, lui, ne voit que les échecs de transport.
      if (error) {
        setFormError(messageFor(error));

        return;
      }

      await enterApp(redirect);
    } catch {
      setFormError(UNREACHABLE);
    } finally {
      // Dans le `finally` : sans ça, un refus laisserait le bouton désactivé
      // pour toujours et le formulaire deviendrait un cul-de-sac.
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Se connecter</CardTitle>
        <CardDescription>
          Accédez à vos projets et statistiques.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/* `noValidate` : sans lui, les bulles natives du navigateur passent
            avant nos messages, dans une langue qu'on ne choisit pas et à un
            endroit qui masque le nôtre. La validation reste faite, par Zod. */}
        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
        >
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
            // `current-password` et non `new-password` : c'est ce qui décide si
            // le gestionnaire de mots de passe propose de remplir ou de générer.
            autoComplete="current-password"
            required
            error={fieldErrors.password}
          />

          {formError && (
            // `role="alert"` : le message apparaît après coup, donc hors du flux
            // de lecture. Sans ça un lecteur d'écran ne l'annonce jamais et le
            // formulaire semble n'avoir rien fait.
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={pending}>
            {pending ? 'Connexion…' : 'Se connecter'}
          </Button>
        </form>

        <p className="text-muted-foreground mt-4 text-sm">
          Pas encore de compte ?{' '}
          <Link
            to="/auth/signup"
            // Le `redirect` est transmis : quelqu'un qu'on a renvoyé ici depuis
            // une page précise doit y arriver, qu'il se connecte ou s'inscrive.
            search={{ redirect }}
            className="underline underline-offset-4"
          >
            Créer un compte
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
