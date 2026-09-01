import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { useRouteContext } from '@tanstack/react-router';
import { CheckCircle2Icon, LogOutIcon } from 'lucide-react';

import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import { Skeleton } from '#/components/ui/skeleton';
import { authClient } from '#/lib/auth-client';
import {
  acceptInvitation,
  invitationQuery,
  rejectInvitation,
} from '#/lib/members';

/**
 * L'écran qu'ouvre le lien reçu par email.
 *
 * ## Il est sous `_authed`, et c'est le sujet
 *
 * Le jeton de l'URL **n'authentifie pas**. `get-invitation` appelle
 * `getSessionFromCtx` et rend 401 sans session ; puis il compare l'adresse de
 * l'invitation à celle de la session et rend 403 si elles diffèrent. Connaître
 * l'identifiant ne donne donc aucun droit — c'est éprouvé côté API
 * (`organizations.e2e-spec.ts`).
 *
 * Le ranger sous `_authed` fait tout le travail sans une ligne : le garde-fou
 * renvoie sur `/auth/login?redirect=…` et ramène ici une fois connecté. Le
 * placer ailleurs demanderait de réécrire cette redirection, moins bien.
 *
 * ## Les trois états, et pourquoi le troisième existe
 *
 * En attente, acceptée, et « mauvais compte ». Ce dernier n'est pas une
 * précaution imaginaire : c'est l'affichage du 403 ci-dessus, que déclenche le
 * cas ordinaire de quelqu'un qui a deux adresses, ou d'un poste partagé. Sans
 * lui, la personne verrait « invitation introuvable » et chercherait du côté du
 * lien alors que le problème est la session.
 *
 * L'expiration produit le même 400 que l'inexistence, côté plugin — on ne peut
 * donc pas les distinguer, et le message ne prétend pas le faire.
 */
export const Route = createFileRoute('/_authed/invitations/$invitationId')({
  component: InvitationScreen,
});

function InvitationScreen() {
  const { invitationId } = Route.useParams();
  const { session } = useRouteContext({ from: '/_authed' });
  const invitation = useQuery(invitationQuery(invitationId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();

  const accept = useMutation({
    mutationFn: () => acceptInvitation(invitationId),
    onSuccess: async () => {
      // Tout change d'un coup : la liste des organisations, celle des projets,
      // et ce que la barre latérale montre. `/projects` réaiguille vers le
      // premier projet accessible, qui est maintenant celui de l'organisation
      // qu'on vient de rejoindre.
      queryClient.clear();
      await navigate({ to: '/projects', replace: true });
    },
  });

  const reject = useMutation({
    mutationFn: () => rejectInvitation(invitationId),
    onSuccess: async () => {
      await navigate({ to: '/projects', replace: true });
    },
  });

  const signOut = async () => {
    await authClient.signOut();
    queryClient.removeQueries({ queryKey: ['session'] });
    await router.invalidate();
  };

  if (invitation.isPending) {
    return (
      <Shell>
        <Skeleton className="h-56 w-full" />
      </Shell>
    );
  }

  if (invitation.error) {
    // Le 403 dit précisément qui est attendu ; les autres refus ne disent rien
    // de plus que « ce lien ne mène nulle part ».
    const wrongAccount = invitation.error.message.includes('403');

    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              {wrongAccount ? 'Wrong account' : 'This invitation is not valid'}
            </CardTitle>
            <CardDescription className="whitespace-pre-line">
              {wrongAccount
                ? `This invitation was sent to someone else, and you are signed in as ${session.user.email}. Accepting it here would put the wrong person in the organization.`
                : 'It may have expired, been revoked, or already been used. Ask whoever invited you to send a new one.'}
            </CardDescription>
          </CardHeader>

          <CardContent className="flex items-center gap-3">
            {wrongAccount && (
              <Button onClick={() => void signOut()}>
                <LogOutIcon />
                Sign out and switch
              </Button>
            )}
            <Button
              asChild={false}
              variant={wrongAccount ? 'outline' : 'default'}
              onClick={() => void navigate({ to: '/projects' })}
            >
              Back to your projects
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const { organizationName, role, inviterEmail } = invitation.data;

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Join {organizationName}</CardTitle>
          <CardDescription>
            {inviterEmail} invited you as a {role}. Accepting adds you to the
            organization and opens its projects.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="bg-background flex items-center gap-3 rounded-md border p-3">
            <CheckCircle2Icon className="text-primary size-4 shrink-0" />
            <span className="text-muted-foreground text-sm">
              Sent to{' '}
              <span className="text-foreground">{session.user.email}</span>
            </span>
            <Badge variant="outline" className="ml-auto capitalize">
              {role}
            </Badge>
          </div>

          <div className="flex items-center gap-3">
            <Button
              className="flex-1"
              loading={accept.isPending}
              onClick={() => {
                accept.mutate();
              }}
            >
              Accept invitation
            </Button>
            <Button
              variant="outline"
              loading={reject.isPending}
              onClick={() => {
                reject.mutate();
              }}
            >
              Decline
            </Button>
          </div>

          {(accept.error ?? reject.error) && (
            <p className="text-destructive text-sm whitespace-pre-line">
              {(accept.error ?? reject.error)?.message}
            </p>
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}

/** L'écran est centré et étroit : il n'y a qu'une décision à prendre dessus. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 p-8">
      {children}
    </div>
  );
}
