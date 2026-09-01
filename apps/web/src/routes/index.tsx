import { Link, createFileRoute } from '@tanstack/react-router';

/**
 * La seule page publique.
 *
 * Elle est hors de `_authed` à dessein : c'est ce qu'on sert à quelqu'un qui
 * n'a pas de session, et elle doit tenir même API éteinte — d'où le fait que
 * `sessionQuery` rende `null` au lieu de lever.
 *
 * Elle lit quand même la session, pour proposer la bonne porte plutôt que
 * d'envoyer vers `/login` quelqu'un déjà connecté.
 */
export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { session } = Route.useRouteContext();

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 p-8">
      <h1 className="text-4xl font-bold tracking-tight">events-hub</h1>
      <p className="text-muted-foreground text-lg">
        Privacy-first web analytics. No cookies on your visitors, no cross-site
        tracking.
      </p>

      <Link
        to={session ? '/projects' : '/auth/login'}
        className="hover:bg-accent rounded-md border px-4 py-2 text-sm"
      >
        {session ? 'Open dashboard' : 'Sign in'}
      </Link>
    </div>
  );
}
