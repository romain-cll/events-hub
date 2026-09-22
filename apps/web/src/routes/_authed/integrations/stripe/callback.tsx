import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Button } from '#/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '#/components/ui/empty';
import { completeStripe, takePendingProject } from '#/lib/integrations';

/**
 * Le retour de Stripe, et le seul écran qui n'a rien à montrer quand tout va
 * bien.
 *
 * ## Pourquoi le retour atterrit ici et pas sur l'API
 *
 * Stripe renvoie le navigateur par une navigation de premier niveau. La faire
 * arriver sur l'API demanderait d'y traiter une session de dashboard, puis de
 * rediriger derrière — deux problèmes de cookies pour rien. Le dashboard reçoit
 * le `code`, le relaie par son appel authentifié habituel, et rien ne change
 * ailleurs.
 *
 * ## Une seule URL de retour pour tous les projets
 *
 * Elle est déclarée une fois chez Stripe et ne peut donc pas porter
 * l'identifiant du projet. C'est `sessionStorage` qui s'en souvient — l'onglet
 * qui revient est celui qui est parti. Le jeton d'état le contient aussi, mais
 * il est signé, et le lire ici ferait dépendre le dashboard d'un format que le
 * serveur doit rester libre de changer.
 *
 * ## L'échange n'a lieu qu'une fois
 *
 * Le `code` de Stripe est à usage unique. Un effet qui se rejouerait — un
 * remontage, un rendu concurrent — le brûlerait pour rien et afficherait une
 * erreur à quelqu'un dont la connexion a pourtant réussi. D'où le garde en tête
 * d'effet, et le retrait immédiat du projet retenu.
 */
export const Route = createFileRoute('/_authed/integrations/stripe/callback')({
  // Tout est optionnel : un refus d'autorisation revient avec `error` et sans
  // `code`, et il faut pouvoir l'afficher plutôt que planter sur une forme.
  validateSearch: z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }),
  component: StripeCallback,
});

type Status =
  | { kind: 'working' }
  | { kind: 'failed'; message: string; projectId: string | null };

function StripeCallback() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>({ kind: 'working' });

  useEffect(() => {
    let spent = false;

    const complete = async () => {
      if (spent) return;
      spent = true;

      const projectId = takePendingProject();

      if (search.error) {
        // L'utilisateur a refusé chez Stripe. Ce n'est pas une panne : on le
        // ramène là d'où il vient, sans drame.
        setStatus({
          kind: 'failed',
          message:
            search.error_description ?? 'Stripe authorization was declined.',
          projectId,
        });

        return;
      }

      if (!projectId || !search.code || !search.state) {
        setStatus({
          kind: 'failed',
          message:
            'This connection could not be matched to a project. Start it again from the project settings.',
          projectId,
        });

        return;
      }

      try {
        await completeStripe(projectId, {
          code: search.code,
          state: search.state,
        });

        await queryClient.invalidateQueries({
          queryKey: ['projects', projectId, 'integrations'],
        });

        await navigate({
          to: '/projects/$projectId/settings/integrations',
          params: { projectId },
          replace: true,
        });
      } catch (error) {
        setStatus({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
          projectId,
        });
      }
    };

    void complete();

    return () => {
      spent = true;
    };
  }, [search, navigate, queryClient]);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6 p-8">
      {status.kind === 'working' ? (
        <Empty>
          <EmptyTitle>Connecting Stripe…</EmptyTitle>
          <EmptyDescription>Finishing the authorization.</EmptyDescription>
        </Empty>
      ) : (
        <Empty>
          <EmptyTitle>Stripe was not connected</EmptyTitle>
          <EmptyDescription>{status.message}</EmptyDescription>
          {status.projectId && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void navigate({
                  to: '/projects/$projectId/settings/integrations',
                  params: { projectId: status.projectId as string },
                });
              }}
            >
              Back to integrations
            </Button>
          )}
        </Empty>
      )}
    </div>
  );
}
